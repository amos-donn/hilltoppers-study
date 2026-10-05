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
import { readVapidKeys, sendPush } from './push';
import type { PushMessage } from './push';

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
  // Web Push (VAPID). The public half is handed to the browser so it can
  // subscribe; the private half signs every push and never leaves the Worker.
  // Both are base64url, exactly as a VAPID generator writes them: 65 bytes for
  // the public point and 32 for the private scalar. Set them the same way as
  // SESSION_HMAC_KEY. While they are unset, /api/push/key answers
  // configured:false, subscribing is refused, and invites stay poll-only — the
  // site works exactly as it did before.
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  // Contact address for the VAPID `sub` claim, which a push service uses to
  // reach the operator about a sender that misbehaves. A mailto: or https: URL.
  // Defaults to the site's own origin, which ALLOWED_ORIGINS already supplies.
  VAPID_SUBJECT?: string;
}

const SESSION_TTL = 2 * 60 * 60;
const IDLE_ACCOUNT_TTL = 6 * 60 * 60;
const MAX_OPEN_SESSIONS = 3;
const TOKEN_TTL = 24 * 60 * 60;
const PEER_PREFIX = 'hilltoppers-study-';

// Mirrors worker/schema.sql. The Worker creates its own tables on first use so
// a deploy needs only the binding, not a `wrangler d1 execute` step. Every
// statement is idempotent, so this is safe to repeat.
const COUNTERS_TABLE = `CREATE TABLE IF NOT EXISTS counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
)`;

const SCHEMA_STATEMENTS = [
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
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    uid TEXT NOT NULL REFERENCES students(uid) ON DELETE CASCADE,
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_push_subscriptions_uid ON push_subscriptions(uid)'
];

// One-time cleanup of the prototype's tables. The old shape keyed accounts by a
// random id with a 6-character code; the account is the school email now.
//
// This runs at most once per database, guarded by a marker row, because D1
// spins up new isolates constantly and a bare `DROP TABLE IF EXISTS sessions`
// would delete every live room on each cold start. A version marker makes it a
// migration instead of a routine. It runs before the tables are created, so a
// fresh database is not dropped right after being built.
const MIGRATION_KEY = 'schema:v2';

let schemaReady: Promise<void> | null = null;

// Runs once per isolate; a failure clears the cache so the next request retries.
async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    // The marker lives in counters, so that table has to exist first.
    await db.prepare(COUNTERS_TABLE).run();
    const applied = await db.prepare('SELECT value FROM counters WHERE key = ?').bind(MIGRATION_KEY).first();
    if (!applied) {
      await db.batch(['DROP TABLE IF EXISTS users', 'DROP TABLE IF EXISTS sessions'].map((sql) => db.prepare(sql)));
      await db.prepare('INSERT INTO counters (key, value) VALUES (?, ?)').bind(MIGRATION_KEY, 1).run();
    }
    await db.batch(SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)));
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
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

// Sends one notification to every browser a student has switched them on in.
//
// Only ever called from waitUntil, so a push service being slow or down can
// never delay the invite or the accept that triggered it. A subscription the
// service reports as gone is deleted here rather than retried on every later
// invite.
async function notifyStudent(db: D1Database, env: Env, uid: string, message: PushMessage): Promise<void> {
  const keys = readVapidKeys(env);
  if (!keys) return;
  const rows = await db.prepare(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE uid = ?'
  ).bind(uid).all<{ endpoint: string; p256dh: string; auth: string }>();
  const targets = rows.results ?? [];
  if (targets.length === 0) return;
  await Promise.all(targets.map(async (target) => {
    const outcome = await sendPush(keys, target, message);
    if (outcome === 'gone') {
      await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(target.endpoint).run();
    }
  }));
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

function handleApi(request: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
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
  return apiResponse(request, env, url, ctx).then((response) => {
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

async function apiResponse(request: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
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

  // -- Push notifications (Web Push / VAPID) ------------------------------
  // The VAPID public key is not a secret: it is the half a browser hands to its
  // push service so the service can check our signature. It is still served
  // only to a signed-in student, so there is no anonymous endpoint to probe.
  if (path === '/push/key' && request.method === 'GET') {
    const keys = readVapidKeys(env);
    return json({ configured: Boolean(keys), publicKey: keys?.publicKey ?? '' }, 200);
  }

  // A browser that just subscribed. The row is keyed by the endpoint, so
  // re-subscribing on the same browser updates it instead of piling up rows,
  // and a student with a Chromebook and a phone simply has one row each.
  if (path === '/push/subscribe' && request.method === 'POST') {
    const body = await readJson(request);
    const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : '';
    const supplied = (body?.keys ?? {}) as { p256dh?: unknown; auth?: unknown };
    const p256dh = typeof supplied.p256dh === 'string' ? supplied.p256dh : '';
    const auth = typeof supplied.auth === 'string' ? supplied.auth : '';
    // Every real push endpoint is https:, so refusing anything else keeps a
    // half-built subscription (or a probe) out of the table.
    if (!/^https:\/\//i.test(endpoint) || !p256dh || !auth) {
      return json({ error: 'That subscription is not usable.' }, 400);
    }
    await db.prepare(
      `INSERT INTO push_subscriptions (uid, endpoint, p256dh, auth, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         uid = excluded.uid, p256dh = excluded.p256dh, auth = excluded.auth`
    ).bind(me, endpoint, p256dh, auth, now).run();
    await bump(db, 'push_subscriptions');
    return json({ ok: true, configured: Boolean(readVapidKeys(env)) }, 200);
  }

  // Switching notifications off, or a browser saying it is going away.
  if (path === '/push/unsubscribe' && request.method === 'POST') {
    const body = await readJson(request);
    const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : '';
    if (endpoint) {
      // Scoped to this student, so one account cannot clear another's row by
      // naming its endpoint.
      await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND uid = ?')
        .bind(endpoint, me).run();
    }
    return json({ ok: true }, 200);
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
    const response = await findOrCreateSession(db, me, target.uid, now);
    // Only a brand-new room is worth notifying about. A row that already
    // existed is either a room the pair is already in or an invite the guest
    // has already seen, and re-sending on every retry would just be noise.
    if (response.status === 201) {
      ctx.waitUntil(notifyStudent(db, env, target.uid, {
        title: 'Study invite',
        body: `${student.name} wants to study with you.`,
        url: './',
        tag: 'hilltoppers-study-invite'
      }).catch(() => { /* a push problem must not fail the invite */ }));
    }
    return response;
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
    const accepted = await sessionPayload(db, { ...row, guest_accepted: 1 }, me);
    // The host is the one sitting on the waiting screen, often with the popup
    // shut, so this is the notification that saves them refreshing. `student`
    // here is the guest who just accepted.
    ctx.waitUntil(notifyStudent(db, env, row.host_uid, {
      title: 'Invite accepted',
      body: `${student.name} accepted. Your study room is ready.`,
      url: './',
      tag: 'hilltoppers-study-accepted'
    }).catch(() => { /* ignore */ }));
    return json(accepted, 200);
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
  // Cascades remove the student's sessions and push subscriptions with them.
  await env.DB_BINDING.prepare('DELETE FROM students WHERE last_seen < ?').bind(now - IDLE_ACCOUNT_TTL).run();
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return json({ error: 'Not found.' }, 404);
    }
    const response = await handleApi(request, env, url, ctx);
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await cleanup(env);
  }
};
