// Web Push for Hilltoppers Study, built on WebCrypto alone.
//
// There is deliberately no `web-push` dependency here. That library signs and
// encrypts with Node's `crypto`, which the Workers runtime does not provide, so
// the two standards it wraps are implemented directly:
//
//   VAPID (RFC 8292) — an ES256 JWT in the request's Authorization header that
//     proves the sender to the push service. Without it, anyone who learned a
//     browser's endpoint could push to it.
//   aes128gcm (RFC 8291) — the payload, encrypted to the subscription's own key
//     pair. The push service relays bytes it cannot open, so the text of a
//     notification is never read in the middle.
//
// Nothing in this file is on the request's critical path: it is only ever
// reached from `waitUntil`, so a push service being slow cannot slow down an
// invite.

import { base64url, nowSeconds } from './http';

// How long a VAPID token stays valid. Push services reject anything much
// longer, and a short window limits what a leaked header is worth.
const VAPID_TTL = 12 * 60 * 60;
// RFC 8188 record size. Every message here is a short notification, so one
// record always covers it; encryptPayload refuses anything larger rather than
// silently sending a body the browser cannot decrypt.
const RECORD_SIZE = 4096;
// A push the browser was not awake to receive is still worth delivering when it
// wakes up, so the service keeps it for a while. In seconds.
const DELIVERY_TTL = 600;

export interface PushKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

// One row of push_subscriptions, as far as this module cares.
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushMessage {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

// `gone` is not a failure: the browser threw the subscription away (uninstalled,
// cleared, profile removed) and the row should be deleted rather than retried.
export type PushOutcome = 'sent' | 'gone' | 'failed';

const encoder = new TextEncoder();

// Same job as the private helper in firebase.ts: a base64url segment back to
// bytes. Returns null rather than throwing, because every caller here is
// validating operator-supplied or browser-supplied input.
function base64UrlBytes(value: string): Uint8Array | null {
  const normalized = value.trim().replaceAll('-', '+').replaceAll('_', '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null;
  try {
    const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

// HKDF-Extract plus HKDF-Expand in one call, which is what WebCrypto's 'HKDF'
// does. Both RFC 8291 derivations below are written in those terms.
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

// ---------------------------------------------------------------------------
// VAPID keys
// ---------------------------------------------------------------------------

// Push services use the `sub` claim to reach the operator about a sender that
// misbehaves, which is why the spec wants a real mailto: or https: address
// there. Rather than invent a contact that does not exist, this falls back to
// the site's own origin — the Worker is already told that in ALLOWED_ORIGINS —
// and only refuses when neither is available.
function vapidSubject(env: { VAPID_SUBJECT?: string; ALLOWED_ORIGINS?: string }): string {
  const configured = (env.VAPID_SUBJECT ?? '').trim();
  if (/^(mailto:|https?:)/i.test(configured)) return configured;
  return (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .find((value) => /^https?:/i.test(value)) ?? '';
}

// Reads and *checks* the pair, in the same spirit as requireSigningKey: a key
// of the wrong shape would otherwise fail deep inside crypto.subtle with an
// opaque error, on a code path nobody is watching. Returns null when push is
// simply not configured, which callers treat as "stay poll-only" rather than as
// an error.
export function readVapidKeys(env: {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  ALLOWED_ORIGINS?: string;
}): PushKeys | null {
  const publicKey = (env.VAPID_PUBLIC_KEY ?? '').trim();
  const privateKey = (env.VAPID_PRIVATE_KEY ?? '').trim();
  if (!publicKey || !privateKey) return null;

  // The public half of a VAPID pair is the uncompressed P-256 point
  // (0x04 || X || Y), 65 bytes. The private half is the 32-byte scalar.
  const point = base64UrlBytes(publicKey);
  if (!point || point.length !== 65 || point[0] !== 0x04) return null;
  const scalar = base64UrlBytes(privateKey);
  if (!scalar || scalar.length !== 32) return null;

  const subject = vapidSubject(env);
  if (!subject) return null;
  return { publicKey, privateKey, subject };
}

// Importing the key costs a little, and every push in a burst needs the same
// one, so it is cached per isolate the way firebase.ts caches Google's keys.
let cachedSigningKey: { fingerprint: string; key: CryptoKey } | null = null;

async function signingKey(keys: PushKeys, point: Uint8Array): Promise<CryptoKey> {
  if (cachedSigningKey?.fingerprint === keys.publicKey) return cachedSigningKey.key;
  // WebCrypto will not build an EC private key from `d` alone; it wants the
  // matching x and y as well, which are the two halves of the public point.
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    ext: true,
    d: keys.privateKey,
    x: base64url(point.slice(1, 33)),
    y: base64url(point.slice(33, 65))
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  cachedSigningKey = { fingerprint: keys.publicKey, key };
  return key;
}

// The Authorization header of RFC 8292. The audience is the push service's own
// origin, so a token minted for one service is useless at another.
async function vapidAuthorization(keys: PushKeys, point: Uint8Array, endpoint: string): Promise<string | null> {
  let audience: string;
  try {
    audience = new URL(endpoint).origin;
  } catch {
    return null;
  }
  const header = base64url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = base64url(encoder.encode(JSON.stringify({
    aud: audience,
    exp: nowSeconds() + VAPID_TTL,
    sub: keys.subject
  })));
  const signingInput = `${header}.${payload}`;
  // WebCrypto returns ECDSA signatures as r || s, which is already the JWS
  // encoding, so no DER conversion is needed.
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    await signingKey(keys, point),
    encoder.encode(signingInput)
  );
  return `vapid t=${signingInput}.${base64url(new Uint8Array(signature))}, k=${keys.publicKey}`;
}

// ---------------------------------------------------------------------------
// Payload encryption
// ---------------------------------------------------------------------------

// RFC 8188's aes128gcm body, with the key derivation from RFC 8291:
//
//   salt(16) || rs(4) || idlen(1) || keyid(65) || AES-128-GCM(plaintext || 0x02)
//
// Returns null on a subscription that is not the shape the spec says, or a
// message too large for the single record this sends.
async function encryptPayload(target: PushTarget, plaintext: Uint8Array): Promise<Uint8Array | null> {
  const clientPoint = base64UrlBytes(target.p256dh);
  const authSecret = base64UrlBytes(target.auth);
  if (!clientPoint || clientPoint.length !== 65 || clientPoint[0] !== 0x04) return null;
  if (!authSecret || authSecret.length !== 16) return null;
  if (plaintext.length + 1 > RECORD_SIZE - 16) return null;

  const clientKey = await crypto.subtle.importKey(
    'raw', clientPoint, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  // The Workers crypto typings are looser than the browser's: generateKey() is
  // typed as returning `CryptoKey | CryptoKeyPair` and exportKey() as
  // `ArrayBuffer | JsonWebKey`, because one signature serves several
  // algorithms. For a P-256 ECDH pair both calls have exactly one possible
  // shape, so the two assertions below only tell the compiler what the runtime
  // already guarantees.
  const ephemeral = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  ) as CryptoKeyPair;
  const serverPoint = new Uint8Array(
    await crypto.subtle.exportKey('raw', ephemeral.publicKey) as ArrayBuffer
  );
  // The same typings spell ECDH's `public` as `$public`, so the standard
  // parameter object is asserted rather than passed inline.
  const ecdhParams = { name: 'ECDH', public: clientKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(ecdhParams, ephemeral.privateKey, 256)
  );

  // The subscription's auth secret salts this first derivation, and both public
  // points are mixed into the info, so the result is bound to this exact pair.
  const ikm = await hkdf(
    authSecret,
    sharedSecret,
    concat(encoder.encode('WebPush: info'), new Uint8Array([0]), clientPoint, serverPoint),
    32
  );

  // A fresh salt per message, so two identical notifications do not share keys.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const contentKey = await hkdf(
    salt, ikm, concat(encoder.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16
  );
  const nonce = await hkdf(
    salt, ikm, concat(encoder.encode('Content-Encoding: nonce'), new Uint8Array([0])), 12
  );

  const key = await crypto.subtle.importKey('raw', contentKey, 'AES-GCM', false, ['encrypt']);
  // 0x02 marks the last (here, only) record. Its absence is what makes a push
  // service answer 400 with no useful explanation.
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    concat(plaintext, new Uint8Array([2]))
  ));

  const header = new Uint8Array(16 + 4 + 1 + serverPoint.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = serverPoint.length;
  header.set(serverPoint, 21);
  return concat(header, ciphertext);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

// One notification to one browser. The caller reads `gone` as "forget this
// subscription" and everything else as "try again later if it matters".
export async function sendPush(keys: PushKeys, target: PushTarget, message: PushMessage): Promise<PushOutcome> {
  const point = base64UrlBytes(keys.publicKey);
  if (!point) return 'failed';
  const authorization = await vapidAuthorization(keys, point, target.endpoint);
  if (!authorization) return 'failed';

  const body = await encryptPayload(target, encoder.encode(JSON.stringify(message)));
  if (!body) return 'failed';

  try {
    const response = await fetch(target.endpoint, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(DELIVERY_TTL),
        Urgency: 'high'
      },
      body,
      signal: AbortSignal.timeout(10000)
    });
    // 404 and 410 are how every push service says the subscription is dead.
    if (response.status === 404 || response.status === 410) return 'gone';
    return response.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}
