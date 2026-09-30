// Verifies a Firebase ID token, the way "Sign In with Hilltoppers" needs.
//
// Study does not keep passwords. The browser signs in against the Hilltoppers
// Firebase project and sends the resulting ID token; this module proves the
// token really came from that project before any account is touched. Only a
// public key is used, so no service account or shared secret is involved.

const PROJECT_ID = 'schedule-59d28';
const ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;
const CERT_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
// Firebase tokens live for an hour. This tolerance only covers a clock that is
// a few seconds off, not a stale token.
const CLOCK_SKEW = 60;

interface FirebaseClaims {
  sub?: unknown;
  aud?: unknown;
  iss?: unknown;
  exp?: unknown;
  iat?: unknown;
  email?: unknown;
}

export interface FirebaseUser {
  uid: string;
  email: string;
}

// A key is good for hours; refetching it on every request would add latency to
// every call. Cached per isolate and refetched every 30 minutes. A token naming
// a key we do not have is refused instead of triggering a fetch, so a burst of
// forged tokens cannot turn into a burst of requests to Google.
interface Jwk { kid?: string; kty?: string; n?: string; e?: string; alg?: string; use?: string }
let cachedKeys: { keys: Record<string, JsonWebKey>; fetchedAt: number } | null = null;

async function keys(): Promise<Record<string, JsonWebKey>> {
  if (cachedKeys && Date.now() - cachedKeys.fetchedAt < 30 * 60 * 1000) return cachedKeys.keys;
  const response = await fetch(CERT_URL, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Could not load token keys.');
  const body = (await response.json()) as { keys?: Jwk[] };
  const map: Record<string, JsonWebKey> = {};
  for (const key of body.keys ?? []) {
    if (key.kid && key.kty === 'RSA' && key.n && key.e) {
      map[key.kid] = { kty: 'RSA', n: key.n, e: key.e, alg: 'RS256', ext: true };
    }
  }
  cachedKeys = { keys: map, fetchedAt: Date.now() };
  return map;
}

function base64UrlBytes(segment: string): Uint8Array {
  const padded = segment.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlBytes(segment)));
}

export async function verifyFirebaseToken(token: string): Promise<FirebaseUser | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerSegment, payloadSegment, signatureSegment] = parts;

  let header: { alg?: string; kid?: string };
  let claims: FirebaseClaims;
  try {
    header = decodeSegment(headerSegment) as { alg?: string; kid?: string };
    claims = decodeSegment(payloadSegment) as FirebaseClaims;
  } catch {
    return null;
  }
  // Only RS256 is issued for this project. Accepting `none` or a caller-chosen
  // algorithm is the classic JWT forgery, so anything else is refused outright.
  if (header.alg !== 'RS256' || !header.kid) return null;

  const jwk = (await keys())[header.kid];
  if (!jwk) return null;

  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const signature = base64UrlBytes(signatureSegment);
  const signed = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed);
  if (!valid) return null;

  const now = Math.floor(Date.now() / 1000);
  const exp = typeof claims.exp === 'number' ? claims.exp : 0;
  const iat = typeof claims.iat === 'number' ? claims.iat : 0;
  if (exp < now - CLOCK_SKEW) return null;
  if (iat > now + CLOCK_SKEW) return null;
  if (claims.aud !== PROJECT_ID) return null;
  if (claims.iss !== ISSUER) return null;

  const uid = typeof claims.sub === 'string' ? claims.sub : '';
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!uid || !email) return null;
  return { uid, email };
}

// The one domain a Study account may use. Staff addresses (@stjacademy.org)
// are deliberately excluded: this is a student tool.
export const STUDENT_DOMAIN = 'student.stjacademy.org';

export function isStudentEmail(email: string): boolean {
  return email.endsWith('@' + STUDENT_DOMAIN) && email.length > STUDENT_DOMAIN.length + 1;
}

// firstname.lastname@student.stjacademy.org -> "Firstname Lastname". Everyone
// already knows each other's school email, so the name is derived rather than
// typed: there is nothing to fake and nothing extra to store.
export function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
