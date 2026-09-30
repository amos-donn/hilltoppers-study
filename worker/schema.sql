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
