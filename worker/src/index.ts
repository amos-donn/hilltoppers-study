// StudyStream Worker: authenticates students, owns lookup codes, and keeps the
// small session registry that lets two classmates find each other. PeerJS
// carries the WebRTC handshake; chat and screen media never pass through here.
import {
  hmacHex, json, nowSeconds, randomId, readJson, requireSigningKey, sha256Hex, timingSafeEqual
} from './http';

export interface Env {
  DB_BINDING: D1Database;
  JOIN_LIMITER: RateLimit;
  SESSION_HMAC_KEY?: string;
  // Comma-separated origins allowed to call /api. Defaults to this Worker's
  // own origin. The Topping is hosted elsewhere, so it is listed here.
  ALLOWED_ORIGINS?: string;
}

const SESSION_TTL = 2 * 60 * 60;
const IDLE_ACCOUNT_TTL = 6 * 60 * 60;
const MAX_OPEN_SESSIONS = 3;
const CODE_LENGTH = 6;
const HANDLE_LENGTH = 6;
const TOKEN_TTL = 24 * 60 * 60;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
// Ambiguous characters are omitted so codes and handles can be read aloud.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const PEER_PREFIX = 'studystream-';

function randomCode(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

function normalizeCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

interface SessionRow {
  id: string; code: string; host_account: string; host_peer: string | null;
  guest_account: string | null; guest_peer: string | null; guest_accepted: number;
  created_at: number; expires_at: number; ended_at: number | null; ended_by: string | null;
}

async function tokenFor(accountId: string, key: string): Promise<string> {
  const expires = nowSeconds() + TOKEN_TTL;
  const body = `${accountId}.${expires}`;
  return `${body}.${await hmacHex(key, body)}`;
}

async function verifyToken(request: Request, key: string): Promise<string | null> {
  const header = request.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return null;
  const [accountId, expires, signature] = header.slice(7).split('.');
  if (!accountId || !expires || !signature) return null;
  const expiry = Number(expires);
  if (!Number.isFinite(expiry) || expiry <= nowSeconds()) return null;
  const expected = await hmacHex(key, `${accountId}.${expires}`);
  return timingSafeEqual(expected, signature) ? accountId : null;
}

async function activeSession(db: D1Database, accountId: string, now: number): Promise<SessionRow | null> {
  const row = await db.prepare(
    `SELECT * FROM sessions
      WHERE ended_at IS NULL AND expires_at > ? AND (host_account = ? OR guest_account = ?)
      ORDER BY created_at DESC LIMIT 1`
  ).bind(now, accountId, accountId).first<SessionRow>();
  return row ?? null;
}

function sessionView(row: SessionRow, accountId: string) {
  const isHost = row.host_account === accountId;
  const accepted = row.guest_accepted === 1;
  const other = isHost ? row.guest_account : row.host_account;
  return {
    id: row.id,
    code: row.code,
    role: isHost ? 'host' : 'guest',
    // The host waits while an invited guest has not accepted; the guest is
    // "invited" until they accept. Both connect only once ready.
    state: !row.guest_account ? 'waiting' : accepted ? 'ready' : isHost ? 'waiting' : 'invited',
    peer: other ? PEER_PREFIX + other : null,
    expiresAt: row.expires_at
  };
}

async function bump(db: D1Database, key: string): Promise<void> {
  await db.prepare(
    'INSERT INTO counters (key, value) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = value + 1'
  ).bind(key).run();
}

// Finds a session for this account, idempotently reusing a matching open pair.
async function findOrCreateSession(db: D1Database, me: string, peer: string, now: number): Promise<Response> {
  const [low, high] = [me, peer].sort();
  const existing = await activeSession(db, me, now);
  if (existing) {
    const pair = [existing.host_account, existing.guest_account].filter(Boolean).sort();
    if (pair.length === 2 && pair[0] === low && pair[1] === high) return json(sessionView(existing, me), 200);
    return json({ error: 'Finish your current session first.' }, 409);
  }
  const open = await db.prepare(
    'SELECT COUNT(*) AS n FROM sessions WHERE host_account = ? AND ended_at IS NULL AND expires_at > ?'
  ).bind(me, now).first<{ n: number }>();
  if ((open?.n ?? 0) >= MAX_OPEN_SESSIONS) return json({ error: 'Close an open room first.' }, 429);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = randomId(12);
    const code = randomCode(CODE_LENGTH);
    try {
      await db.prepare(
        `INSERT INTO sessions (id, code, host_account, host_peer, guest_account, guest_peer, guest_accepted, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
      ).bind(id, code, me, PEER_PREFIX + me, peer, PEER_PREFIX + peer, now, now + SESSION_TTL).run();
      await bump(db, 'sessions');
      return json({ id, code, role: 'host', state: 'waiting', peer: PEER_PREFIX + peer, expiresAt: now + SESSION_TTL }, 201);
    } catch {
      // A colliding code is retried with a fresh one.
    }
  }
  return json({ error: 'Could not open a room. Try again.' }, 500);
}

// Returns the matching CORS origin, or null when the request comes from no
// origin (same-origin GET) or from an origin we do not allow.
function allowedOrigin(request: Request, env: Env, url: URL): string | null {
  const origin = request.headers.get('Origin');
  if (!origin) return url.origin;
  if (origin === url.origin) return origin;
  const list = (env.ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  return list.includes(origin) ? origin : null;
}

function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const origin = allowedOrigin(request, env, url);
  const cors: Record<string, string> = origin
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin'
      }
    : {};
  // A preflight only asks whether the origin may call us.
  if (request.method === 'OPTIONS') {
    return Promise.resolve(new Response(null, { status: origin ? 204 : 403, headers: cors }));
  }
  if (!origin) {
    return Promise.resolve(json({ error: 'Open StudyStream to use it.' }, 403));
  }
  return apiResponse(request, env, url).then((response) => {
    for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
    return response;
  });
}

async function apiResponse(request: Request, env: Env, url: URL): Promise<Response> {
  const key = requireSigningKey(env);
  if (!key) return json({ error: 'StudyStream is not configured yet.' }, 503);
  const db = env.DB_BINDING;
  const now = nowSeconds();
  const path = url.pathname.replace(/^\/api/, '') || '/';

  if (path === '/health') return json({ ok: true, configured: true, service: 'studystream' }, 200);

  // Create an account, or sign back into one from a stored secret.
  if (path === '/register' && request.method === 'POST') {
    const body = await readJson(request);
    const accountId = typeof body?.accountId === 'string' ? body.accountId : '';
    const secret = typeof body?.secret === 'string' ? body.secret : '';

    if (accountId && secret) {
      if (!SECRET_PATTERN.test(secret)) return json({ error: 'Sign in again.' }, 401);
      const user = await db.prepare(
        'SELECT secret_salt AS salt, secret_hash AS hash, handle FROM users WHERE account_id = ?'
      ).bind(accountId).first<{ salt: string; hash: string; handle: string }>();
      if (!user || !timingSafeEqual(await sha256Hex(`${user.salt}:${secret}`), user.hash)) {
        return json({ error: 'Sign in again.' }, 401);
      }
      await db.prepare('UPDATE users SET last_seen = ? WHERE account_id = ?').bind(now, accountId).run();
      return json({
        accountId, handle: user.handle, peerId: PEER_PREFIX + accountId, token: await tokenFor(accountId, key)
      }, 200);
    }

    const newSecret = randomId(24);
    const salt = randomId(12);
    const hash = await sha256Hex(`${salt}:${newSecret}`);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = randomId(12);
      try {
        await db.prepare(
          `INSERT INTO users (account_id, handle, secret_salt, secret_hash, created_at, last_seen)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(id, randomCode(HANDLE_LENGTH), salt, hash, now, now).run();
        await bump(db, 'registers');
        const user = await db.prepare('SELECT handle FROM users WHERE account_id = ?').bind(id)
          .first<{ handle: string }>();
        if (!user) continue;
        return json({
          accountId: id, handle: user.handle, secret: newSecret, peerId: PEER_PREFIX + id,
          token: await tokenFor(id, key)
        }, 201);
      } catch {
        // A colliding handle is retried with a fresh one.
      }
    }
    return json({ error: 'Could not create an account. Try again.' }, 500);
  }

  // Everything past this point needs a signed-in account.
  const me = await verifyToken(request, key);
  if (!me) return json({ error: 'Sign in again.' }, 401);
  await db.prepare('UPDATE users SET last_seen = ? WHERE account_id = ?').bind(now, me).run();

  if (path === '/account' && request.method === 'GET') {
    const user = await db.prepare('SELECT handle, display_name AS displayName FROM users WHERE account_id = ?')
      .bind(me).first<{ handle: string; displayName: string }>();
    if (!user) return json({ error: 'Sign in again.' }, 401);
    return json({ ...user, peerId: PEER_PREFIX + me }, 200);
  }

  // Resolve a classmate's lookup code to the peer to invite.
  if (path === '/lookup' && request.method === 'GET') {
    const limit = await env.JOIN_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'local' });
    if (!limit.success) return json({ error: 'Too many lookups. Wait a minute.' }, 429);
    const handle = normalizeCode(url.searchParams.get('handle') ?? '');
    if (handle.length !== HANDLE_LENGTH) return json({ error: 'Enter a 6-character code.' }, 400);
    const user = await db.prepare('SELECT account_id AS accountId FROM users WHERE handle = ?')
      .bind(handle).first<{ accountId: string }>();
    if (!user) return json({ error: 'No student with that code.' }, 404);
    if (user.accountId === me) return json({ error: 'That is your own code.' }, 400);
    return json({ handle, peerId: PEER_PREFIX + user.accountId }, 200);
  }

  // Create (or reuse) a room. Body: { handle } for either direction.
  if (path === '/session' && request.method === 'POST') {
    const body = await readJson(request);
    const handle = normalizeCode(typeof body?.handle === 'string' ? body.handle : '');
    if (handle.length !== HANDLE_LENGTH) return json({ error: 'Enter a 6-character code.' }, 400);
    const target = await db.prepare('SELECT account_id AS accountId FROM users WHERE handle = ?')
      .bind(handle).first<{ accountId: string }>();
    if (!target) return json({ error: 'No student with that code.' }, 404);
    if (target.accountId === me) return json({ error: 'That is your own code.' }, 400);
    return findOrCreateSession(db, me, target.accountId, now);
  }

  // The invited classmate accepts, which activates the room for both sides.
  if (path === '/session/accept' && request.method === 'POST') {
    const body = await readJson(request);
    const id = typeof body?.id === 'string' ? body.id : '';
    const row = id
      ? await db.prepare('SELECT * FROM sessions WHERE id = ? AND ended_at IS NULL AND expires_at > ? LIMIT 1')
        .bind(id, now).first<SessionRow>()
      : null;
    if (!row || row.guest_account !== me) return json({ error: 'That invite is no longer available.' }, 404);
    await db.prepare('UPDATE sessions SET guest_accepted = 1 WHERE id = ?').bind(row.id).run();
    return json(sessionView({ ...row, guest_accepted: 1 }, me), 200);
  }

  if (path === '/session' && request.method === 'GET') {
    const row = await activeSession(db, me, now);
    return json(row ? sessionView(row, me) : { state: 'none' }, 200);
  }

  if (path === '/session/end' && request.method === 'POST') {
    const row = await activeSession(db, me, now);
    if (row) {
      await db.prepare('UPDATE sessions SET ended_at = ?, ended_by = ? WHERE id = ?').bind(now, me, row.id).run();
    }
    return json({ state: 'none' }, 200);
  }

  return json({ error: 'Not found.' }, 404);
}

async function cleanup(env: Env): Promise<void> {
  const now = nowSeconds();
  await env.DB_BINDING.prepare(
    'UPDATE sessions SET ended_at = ?, ended_by = ? WHERE ended_at IS NULL AND expires_at <= ?'
  ).bind(now, 'timeout', now).run();
  await env.DB_BINDING.prepare(
    'DELETE FROM sessions WHERE ended_at IS NOT NULL AND ended_at < ?'
  ).bind(now - 24 * 60 * 60).run();
  // Cascades remove the account's sessions.
  await env.DB_BINDING.prepare('DELETE FROM users WHERE last_seen < ?').bind(now - IDLE_ACCOUNT_TTL).run();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return json({ error: 'Not found.' }, 404);
    }
    const response = await handleApi(request, env, url);
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await cleanup(env);
  }
};
