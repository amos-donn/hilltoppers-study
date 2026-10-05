-- Hilltoppers Study D1 schema.
--
-- The Worker applies these statements itself on its first request, so usually
-- nothing needs to run here. `worker/src/index.ts` keeps its own copy in
-- SCHEMA_STATEMENTS; keep the two in sync when this file changes.
--
-- To apply it by hand (optional), from the worker/ folder:
--   npx wrangler d1 execute studystream-sessions --config ../wrangler.toml --remote --file=schema.sql
-- Every statement here is `IF NOT EXISTS`, so re-applying is safe.
--
-- The one-time cleanup of the prototype's old `users`/`sessions` tables is done
-- by the Worker, not here: it is guarded by the `schema:v2` marker row and runs
-- at most once per database. A bare DROP in this file would wipe every live
-- room each time someone re-ran it.

-- Bounded operational counters so a public deploy has some abuse visibility
-- without ever storing message content. It also carries the schema version
-- marker used by the Worker's one-time migration.
CREATE TABLE IF NOT EXISTS counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

-- One student, keyed by the school email they signed in with. The Firebase uid
-- is the primary key; the email is the account name a classmate types. No
-- password is ever stored here: sign-in happens against the Hilltoppers
-- Firebase project and only the resulting token reaches this Worker.
--
-- study_blocks is a comma-separated list of block letters (A,B,C,D,E,CP) the
-- student marked as their study hall. Empty means they have not said yet.
CREATE TABLE IF NOT EXISTS students (
  uid TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  study_blocks TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

-- One active 1:1 study room. The Worker owns both peer identities, so neither
-- client chooses which peer it connects to. PeerJS carries the WebRTC
-- handshake; this row only records who is in the room.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  host_uid TEXT NOT NULL REFERENCES students(uid) ON DELETE CASCADE,
  host_peer TEXT,
  guest_uid TEXT REFERENCES students(uid) ON DELETE SET NULL,
  guest_peer TEXT,
  -- 0 when the host invited a classmate by email and they have not accepted yet.
  guest_accepted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ended_at INTEGER,
  ended_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_host ON sessions(host_uid);
CREATE INDEX IF NOT EXISTS idx_sessions_guest ON sessions(guest_uid);

-- One Web Push subscription per browser a student turned notifications on in.
-- The endpoint and its two key halves come from the browser's PushManager and
-- are the only way to reach that browser; nothing here identifies a device, so
-- a student who signs in on a Chromebook and a phone simply has two rows.
--
-- The endpoint is the primary key rather than (uid, endpoint) because a browser
-- hands back the same endpoint when it re-subscribes, and the Worker's upsert
-- relies on that to update a row instead of adding a second one.
--
-- ON DELETE CASCADE means the hourly sweep in cleanup() clears a departed
-- student's subscriptions along with their account. Nothing is ever sent
-- without a matching row: with no VAPID pair configured, or no row here, an
-- invite is simply not pushed.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  uid TEXT NOT NULL REFERENCES students(uid) ON DELETE CASCADE,
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_uid ON push_subscriptions(uid);
