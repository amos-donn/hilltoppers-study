-- StudyStream D1 schema.
-- Apply with:
--   npx wrangler d1 execute studystream-sessions --config wrangler.toml --remote --file=schema.sql
-- All statements are idempotent, so re-applying after an update is safe.

-- One logical account. Students share `handle` to find each other; the long
-- `account_id` is the internal PeerJS identity and is never shown or typed.
-- No email or password is stored on the server.
CREATE TABLE IF NOT EXISTS users (
  account_id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  secret_salt TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

-- One active 1:1 study room. The Worker owns the room code and both peer
-- identities, so neither client chooses which peer it connects to. PeerJS
-- carries the WebRTC handshake; this row only records who is in the room.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  host_account TEXT NOT NULL REFERENCES users(account_id) ON DELETE CASCADE,
  host_peer TEXT,
  guest_account TEXT REFERENCES users(account_id) ON DELETE SET NULL,
  guest_peer TEXT,
  -- 0 when the host invited a classmate by code and they have not accepted yet.
  guest_accepted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ended_at INTEGER,
  ended_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_code ON sessions(code);
CREATE INDEX IF NOT EXISTS idx_sessions_host ON sessions(host_account);
CREATE INDEX IF NOT EXISTS idx_sessions_guest ON sessions(guest_account);

-- Bounded operational counters so a public deploy has some abuse visibility
-- without ever storing message content.
CREATE TABLE IF NOT EXISTS counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
