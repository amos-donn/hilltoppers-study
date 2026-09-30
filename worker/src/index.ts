// Hilltoppers Study Worker: signs students in with their Hilltoppers account,
// keeps who is free to study, and owns the small session registry that lets two
// classmates find each other. PeerJS carries the WebRTC handshake; chat and
// screen media never pass through here.
//
// Study keeps no passwords and sends no email. A student signs in against the
// Hilltoppers Firebase project in the browser; this Worker only verifies the
// resulting token (see firebase.ts) and never sees a credential.
import {
  hmacHex, json, nowSeconds, randomId, readJson, requireSigningKey, sha256Hex, timingSafeEqual
} from './http';
import { isStudentEmail, nameFromEmail, verifyFirebaseToken } from './firebase';
import { availability, blockAt, loadDaySchedule, STUDY_BLOCK_LETTERS } from './schedule';

export interface Env {
  DB_BINDING: D1Database;
  JOIN_LIMITER: RateLimit;
  SESSION_HMAC_KEY?: string;
  // Comma-separated origins allowed to call /api. Defaults to this Worker's
  // own origin. The Topping is hosted elsewhere, so it is listed here.
  ALLOWED_ORIGINS?: string;
  // Cloudflare Calls TURN. When both are set the Worker hands out short-lived
  // relay credentials, which is what lets two students behind a school network
  // reach each other. With neither set, clients fall back to the public PeerJS
  // cloud and screen sharing only works on open networks.
  TURN_KEY_ID?: string;
  TURN_API_TOKEN?: string;
  // Metered's free plan (the "Open Relay" project): 20 GB/month and no card,
  // only an email signup. Preferred over Cloudflare because it needs no
  // billing details. Set TURN_API_KEY to switch this on.
  TURN_API_KEY?: string;
  // A fixed relay server, for a self-hosted coturn or any provider that hands
  // you a long-lived username and password. TURN_URLS is comma-separated.
  TURN_URLS?: string;
  TURN_USERNAME?: string;
  TURN_CREDENTIAL?: string;
  // Override for the credential endpoint. Only for tests or a self-hosted
  // issuer; leave unset to use Metered.
  TURN_API_BASE?: string;
}

const SESSION_TTL = 2 * 60 * 60;
const IDLE_ACCOUNT_TTL = 6 * 60 * 60;
const MAX_OPEN_SESSIONS = 3;
const TOKEN_TTL = 24 * 60 * 60;
const PEER_PREFIX = 'hilltoppers-study-';

// Mirrors worker/schema.sql. The Worker creates its own tables on first use so
// a deploy needs only the binding, not a `wrangler d1 execute` step. Every
// statement is idempotent, so this is safe to repeat.
//
// The earlier prototype keyed accounts by a random id with a 6-character code
// to share. Both are gone: the account is the school email now. The old tables
// are dropped so a deploy on an existing database lands on the new shape
// instead of keeping the dead columns. Sessions are short-lived, so nothing of
// value is lost.
const SCHEMA_STATEMENTS = [
  'DROP TABLE IF EXISTS sessions',
  'DROP TABLE IF EXISTS users',
  `CREATE TABLE IF NOT EXISTS students (
    uid TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    study_blocks TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    host_uid TEXT NOT NULL REFERENCES students(uid) ON DELETE CASCADE,
    host_peer TEXT,
    guest_uid TEXT REFERENCES students(uid) ON DELETE SET NULL,
    guest_peer TEXT,
    guest_accepted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ended_at INTEGER,
    ended_by TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS idx_sessions_host ON sessions(host_uid)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_guest ON sessions(guest_uid)',
  `CREATE TABLE IF NOT EXISTS counters (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
  )`
];

let schemaReady: Promise<void> | null = null;

// Runs once per isolate; a failure clears the cache so the next request retries.
function ensureSchema(db: D1Database): Promise<void> {
  if (!schemaReady) {
    schemaReady = db.batch(SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)))
      .then(() => undefined)
      .catch((error) => {
        schemaReady = null;
        throw error;
      });
  }
  return schemaReady;
}

const TURN_TTL = 4 * 60 * 60;
const METERED_CREDENTIALS = 'https://a.metered.live/api/v1/turn/credentials';

// Short-lived relay credentials for the browser. The browser needs these to
// reach a classmate when the school network blocks peer-to-peer; the provider
// key stays here and is never sent to a student.
//
// Three shapes are supported, checked in order:
//   1. a fixed relay server (self-hosted coturn, or any long-lived credentials)
//   2. Metered's free plan, which needs only an email signup and no card
//   3. Cloudflare Calls TURN, which requires billing details on the account
// With none configured this is not an error: the site keeps working over the
// public PeerJS cloud, though screen sharing then only works on open networks.
async function turnCredentials(env: Env): Promise<Response> {
  const fixed = fixedIceServers(env);
  if (fixed.length > 0) return relayResponse(fixed, 'TURN_URLS');

  if (env.TURN_API_KEY) {
    const url = `${env.TURN_API_BASE || METERED_CREDENTIALS}?apiKey=${encodeURIComponent(env.TURN_API_KEY)}`;
    const response = await fetch(url);
    if (!response.ok) return json({ error: 'Could not get relay credentials.' }, 502);
    const data = (await response.json()) as unknown;
    // Metered returns the iceServers array directly; older shapes wrap it.
    const list = Array.isArray(data) ? data : (data as { iceServers?: unknown })?.iceServers;
    const iceServers = Array.isArray(list) ? list : [];
    return relayResponse(iceServers, 'TURN_API_KEY');
  }

  const keyId = env.TURN_KEY_ID;
  const token = env.TURN_API_TOKEN;
  if (!keyId || !token) return json({ configured: false, iceServers: [] }, 200);

  const base = env.TURN_API_BASE || 'https://rtc.live.cloudflare.com/v1/turn/keys';
  const response = await fetch(
    `${base}/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TURN_TTL })
    }
  );
  if (!response.ok) return json({ error: 'Could not get relay credentials.' }, 502);
  const data = (await response.json()) as { iceServers?: unknown };
  const iceServers = Array.isArray(data?.iceServers) ? data.iceServers : [];
  return relayResponse(iceServers, 'TURN_KEY_ID');
}

// A provider that returns only STUN cannot relay, so reporting configured:true
// would be a lie: the app would show itself as ready and still fail on a school
// network. A relay counts only when it has a turn:/turns: url *and* something to
// authenticate with.
function relayProblem(iceServers: unknown[]): string | null {
  let sawTurn = false;
  let sawCredentials = false;
  for (const server of iceServers) {
    if (!server || typeof server !== 'object') continue;
    const value = server as { urls?: unknown; username?: unknown; credential?: unknown };
    const urls = Array.isArray(value.urls) ? value.urls : [value.urls];
    if (urls.some((url) => typeof url === 'string' && /^turns?:/i.test(url.trim()))) {
      sawTurn = true;
      if (value.username || value.credential) return null;
    }
    if (value.username || value.credential) sawCredentials = true;
  }
  if (!sawTurn) return 'no turn: url to relay through. Use the turn: entries from the provider, not the stun: one.';
  if (!sawCredentials) return 'the turn: url has no username or credential, so the relay would refuse it.';
  return 'no usable entry.';
}

function relayResponse(iceServers: unknown[], source: string): Response {
  const problem = relayProblem(iceServers);
  if (!problem) return json({ configured: true, iceServers }, 200);
  // Handing back a STUN-only list would quietly disable the app's fallback, so
  // return nothing and say why. The reason is for whoever is setting secrets up.
  return json({ configured: false, iceServers: [], reason: `${source} is set but ${problem}` }, 200);
}

// A relay the operator configured by hand. URLs are comma-separated so a
// provider can offer several endpoints at once.
function fixedIceServers(env: Env): unknown[] {
  const urls = (env.TURN_URLS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (urls.length === 0) return [];
  const server: Record<string, unknown> = { urls: urls.length === 1 ? urls[0] : urls };
  if (env.TURN_USERNAME) server.username = env.TURN_USERNAME;
  if (env.TURN_CREDENTIAL) server.credential = env.TURN_CREDENTIAL;
  return [server];
}

interface StudentRow {
  uid: string; email: string; name: string; study_blocks: string;
  created_at: number; last_seen: number;
}

interface SessionRow {
  id: string; host_uid: string; host_peer: string | null;
  guest_uid: string | null; guest_peer: string | null; guest_accepted: number;
  created_at: number; expires_at: number; ended_at: number | null; ended_by: string | null;
}

function studyBlocksOf(row: { study_blocks: string }): string[] {
  return row.study_blocks ? row.study_blocks.split(',').filter(Boolean) : [];
}

// The PeerJS identity is derived from the account, not chosen by the client, so
// a student cannot claim to be someone else's peer. It is a hash, so the
// Firebase uid is not exposed on the signalling network.
async function peerIdOf(uid: string): Promise<string> {
  return PEER_PREFIX + (await sha256Hex('peer:' + uid)).slice(0, 24);
}

async function tokenFor(uid: string, key: string): Promise<string> {
  const expires = nowSeconds() + TOKEN_TTL;
  const body = `${uid}.${expires}`;
  return `${body}.${await hmacHex(key, body)}`;
}

async function verifyToken(request: Request, key: string): Promise<string | null> {
  const header = request.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return null;
  const [uid, expires, signature] = header.slice(7).split('.');
  if (!uid || !expires || !signature) return null;
  const expiry = Number(expires);
  if (!Number.isFinite(expiry) || expiry <= nowSeconds()) return null;
  const expected = await hmacHex(key, `${uid}.${expires}`);
  return timingSafeEqual(expected, signature) ? uid : null;
}

async function activeSession(db: D1Database, uid: string, now: number): Promise<SessionRow | null> {
  const row = await db.prepare(
    `SELECT * FROM sessions
      WHERE ended_at IS NULL AND expires_at > ? AND (host_uid = ? OR guest_uid = ?)
      ORDER BY created_at DESC LIMIT 1`
  ).bind(now, uid, uid).first<SessionRow>();
  return row ?? null;
}

function sessionView(row: SessionRow, uid: string) {
  const isHost = row.host_uid === uid;
  const accepted = row.guest_accepted === 1;
  return {
    id: row.id,
    role: isHost ? 'host' : 'guest',
    // The host waits while an invited guest has not accepted; the guest is
    // "invited" until they accept. Both connect only once ready.
    state: !row.guest_uid ? 'waiting' : accepted ? 'ready' : isHost ? 'waiting' : 'invited',
    peer: isHost ? row.guest_peer : row.host_peer,
    expiresAt: row.expires_at
  };
}

// The session view plus the other student's name, so the waiting screen can say
// who is being waited on instead of showing a code.
async function sessionPayload(db: D1Database, row: SessionRow, uid: string) {
  const view = sessionView(row, uid);
  const other = row.host_uid === uid ? row.guest_uid : row.host_uid;
  const student = other
    ? await db.prepare('SELECT name FROM students WHERE uid = ?').bind(other).first<{ name: string }>()
    : null;
  return { ...view, withName: student?.name ?? '' };
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
    const pair = [existing.host_uid, existing.guest_uid].filter(Boolean).sort();
    if (pair.length === 2 && pair[0] === low && pair[1] === high) return json(await sessionPayload(db, existing, me), 200);
    return json({ error: 'Finish your current session first.' }, 409);
  }
  const open = await db.prepare(
    'SELECT COUNT(*) AS n FROM sessions WHERE host_uid = ? AND ended_at IS NULL AND expires_at > ?'
  ).bind(me, now).first<{ n: number }>();
  if ((open?.n ?? 0) >= MAX_OPEN_SESSIONS) return json({ error: 'Close an open room first.' }, 429);

  const myPeer = await peerIdOf(me);
  const theirPeer = await peerIdOf(peer);
  const id = randomId(12);
  await db.prepare(
    `INSERT INTO sessions (id, host_uid, host_peer, guest_uid, guest_peer, guest_accepted, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
  ).bind(id, me, myPeer, peer, theirPeer, now, now + SESSION_TTL).run();
  await bump(db, 'sessions');
  const row: SessionRow = {
    id, host_uid: me, host_peer: myPeer, guest_uid: peer, guest_peer: theirPeer,
    guest_accepted: 0, created_at: now, expires_at: now + SESSION_TTL, ended_at: null, ended_by: null
  };
  return json(await sessionPayload(db, row, me), 201);
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
    return Promise.resolve(json({ error: 'Open Hilltoppers Study to use it.' }, 403));
  }
  return apiResponse(request, env, url).then((response) => {
    for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
    return response;
  });
}

// The signed-in student's own view of themselves.
async function profileView(db: D1Database, uid: string) {
  const student = await db.prepare(
    'SELECT uid, email, name, study_blocks FROM students WHERE uid = ?'
  ).bind(uid).first<StudentRow>();
  if (!student) return null;
  const now = new Date();
  const schedule = await loadDaySchedule(now);
  const blocks = studyBlocksOf(student);
  const current = blockAt(schedule, now);
  return {
    email: student.email,
    name: student.name,
    studyBlocks: blocks,
    peerId: await peerIdOf(uid),
    dayType: schedule.dayType,
    block: current ? { letter: current.letter, name: current.name, start: current.start, end: current.end } : null,
    availability: availability(schedule, blocks, now)
  };
}

async function apiResponse(request: Request, env: Env, url: URL): Promise<Response> {
  const key = requireSigningKey(env);
  if (!key) return json({ error: 'Hilltoppers Study is not configured yet.' }, 503);
  const db = env.DB_BINDING;
  const now = nowSeconds();
  const path = url.pathname.replace(/^\/api/, '') || '/';

  // Sets up the tables on first hit so a fresh deploy needs no CLI step.
  if (path === '/setup') {
    try {
      await ensureSchema(db);
      return json({ ok: true, service: 'hilltoppers-study', tables: 'ready' }, 200);
    } catch (error) {
      return json({ error: 'Could not set up the database.', detail: String(error) }, 500);
    }
  }

  await ensureSchema(db);

  if (path === '/health') return json({ ok: true, configured: true, service: 'hilltoppers-study' }, 200);

  // Relay credentials for the WebRTC handshake. No account needed: this is
  // called before sign-in so a slow network is fixed before a room opens.
  if (path === '/turn') return turnCredentials(env);

  // "Sign In with Hilltoppers". The browser already signed in against the
  // school's Firebase project; this verifies that token and creates or updates
  // the matching Study student. No password is sent or stored here.
  if (path === '/auth' && request.method === 'POST') {
    const body = await readJson(request);
    const idToken = typeof body?.idToken === 'string' ? body.idToken : '';
    if (!idToken) return json({ error: 'Sign in again.' }, 400);

    let account;
    try {
      account = await verifyFirebaseToken(idToken);
    } catch {
      return json({ error: 'Could not check your sign-in. Try again.' }, 502);
    }
    if (!account) return json({ error: 'Sign in again.' }, 401);
    if (!isStudentEmail(account.email)) {
      return json({ error: 'Sign in with your @student.stjacademy.org school account.' }, 403);
    }

    const name = nameFromEmail(account.email);
    // The email is the account, so a returning student updates the row they
    // already have rather than getting a second one. The conflict is keyed on
    // email, not uid, because a recreated Firebase account keeps its email but
    // gets a new uid. A student who already picked study-hall blocks keeps them.
    await db.prepare(
      `INSERT INTO students (uid, email, name, study_blocks, created_at, last_seen)
       VALUES (?, ?, ?, '', ?, ?)
       ON CONFLICT(email) DO UPDATE SET uid = excluded.uid, name = excluded.name, last_seen = excluded.last_seen`
    ).bind(account.uid, account.email, name, now, now).run();

    const profile = await profileView(db, account.uid);
    return json({ token: await tokenFor(account.uid, key), ...profile }, 200);
  }

  // Everything past this point needs a signed-in account.
  const me = await verifyToken(request, key);
  if (!me) return json({ error: 'Sign in again.' }, 401);
  const student = await db.prepare('SELECT * FROM students WHERE uid = ?').bind(me).first<StudentRow>();
  if (!student) return json({ error: 'Sign in again.' }, 401);
  await db.prepare('UPDATE students SET last_seen = ? WHERE uid = ?').bind(now, me).run();

  if (path === '/profile' && request.method === 'GET') {
    return json(await profileView(db, me), 200);
  }

  // Which blocks are this student's study hall. Any of A-E and CP, more than
  // one allowed.
  if (path === '/profile' && request.method === 'POST') {
    const body = await readJson(request);
    const requested = Array.isArray(body?.blocks) ? body.blocks : [];
    const blocks = STUDY_BLOCK_LETTERS.filter((letter) => requested.includes(letter));
    await db.prepare('UPDATE students SET study_blocks = ? WHERE uid = ?').bind(blocks.join(','), me).run();
    return json(await profileView(db, me), 200);
  }

  // Who is free to study right now. During a study-hall block this is the
  // student's own block; after the last block the school day is over and
  // everyone who has marked study halls is listed.
  if (path === '/students' && request.method === 'GET') {
    const limit = await env.JOIN_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'local' });
    if (!limit.success) return json({ error: 'Too many lookups. Wait a minute.' }, 429);
    const nowDate = new Date();
    const schedule = await loadDaySchedule(nowDate);
    const current = blockAt(schedule, nowDate);
    const mode = schedule.blocks.length === 0
      ? 'no-school'
      : current ? 'during-school' : 'after-school';
    const rows = await db.prepare(
      "SELECT uid, email, name, study_blocks FROM students WHERE study_blocks != '' ORDER BY name"
    ).all<StudentRow>();
    const students = (rows.results ?? []).map((row) => {
      const blocks = studyBlocksOf(row);
      const state = availability(schedule, blocks, nowDate);
      return {
        name: row.name,
        email: row.email,
        blocks,
        available: state === 'study-hall',
        freeNow: mode !== 'during-school' && blocks.length > 0
      };
    });
    return json({
      dayType: schedule.dayType,
      mode,
      block: current ? { letter: current.letter, name: current.name, start: current.start, end: current.end } : null,
      students
    }, 200);
  }

  // Find a classmate by school email, so a session can be started at any time.
  if (path === '/directory' && request.method === 'GET') {
    const limit = await env.JOIN_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'local' });
    if (!limit.success) return json({ error: 'Too many lookups. Wait a minute.' }, 429);
    const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    if (query.length < 3) return json({ error: 'Type at least three letters of an email or name.' }, 400);
    const rows = await db.prepare(
      'SELECT email, name FROM students WHERE email = ? OR lower(name) LIKE ? ORDER BY name LIMIT 20'
    ).bind(query, query + '%').all<{ email: string; name: string }>();
    return json({ results: rows.results ?? [] }, 200);
  }

  // Start (or reuse) a room with a classmate, by their school email.
  if (path === '/session' && request.method === 'POST') {
    const body = await readJson(request);
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!isStudentEmail(email)) return json({ error: 'Enter a school email like firstname.lastname@student.stjacademy.org.' }, 400);
    if (email === student.email) return json({ error: 'That is your own email.' }, 400);
    const target = await db.prepare('SELECT uid FROM students WHERE email = ?')
      .bind(email).first<{ uid: string }>();
    if (!target) return json({ error: 'No student with that email has signed in yet.' }, 404);
    return findOrCreateSession(db, me, target.uid, now);
  }

  // The invited classmate accepts, which activates the room for both sides.
  if (path === '/session/accept' && request.method === 'POST') {
    const body = await readJson(request);
    const id = typeof body?.id === 'string' ? body.id : '';
    const row = id
      ? await db.prepare('SELECT * FROM sessions WHERE id = ? AND ended_at IS NULL AND expires_at > ? LIMIT 1')
        .bind(id, now).first<SessionRow>()
      : null;
    if (!row || row.guest_uid !== me) return json({ error: 'That invite is no longer available.' }, 404);
    await db.prepare('UPDATE sessions SET guest_accepted = 1 WHERE id = ?').bind(row.id).run();
    return json(await sessionPayload(db, { ...row, guest_accepted: 1 }, me), 200);
  }

  if (path === '/session' && request.method === 'GET') {
    const row = await activeSession(db, me, now);
    return json(row ? await sessionPayload(db, row, me) : { state: 'none' }, 200);
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
  // Cascades remove the student's sessions.
  await env.DB_BINDING.prepare('DELETE FROM students WHERE last_seen < ?').bind(now - IDLE_ACCOUNT_TTL).run();
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
