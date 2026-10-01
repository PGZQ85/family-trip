// SQLite schema. Runs on startup (every statement is idempotent), on both Cloudflare D1 and node:sqlite.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS trip (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  name        TEXT NOT NULL,
  start_date  TEXT NOT NULL DEFAULT '',
  days        INTEGER NOT NULL DEFAULT 10,
  households  TEXT NOT NULL,              -- JSON array of 3 names
  code        TEXT NOT NULL,              -- family code, shown to the organiser for sharing
  version     INTEGER NOT NULL DEFAULT 1  -- bumped on every write, clients poll it
);
CREATE TABLE IF NOT EXISTS members (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  household    INTEGER NOT NULL,
  pin_hash     TEXT NOT NULL,
  pin_salt     TEXT NOT NULL,
  is_owner     INTEGER NOT NULL DEFAULT 0,
  removed      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  member_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS throttle (
  key       TEXT PRIMARY KEY,
  count     INTEGER NOT NULL,
  reset_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ideas (
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,
  category    TEXT NOT NULL,
  notes       TEXT NOT NULL DEFAULT '',
  place       TEXT NOT NULL DEFAULT '',
  link        TEXT NOT NULL DEFAULT '',
  cost        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'idea',
  day         INTEGER NOT NULL DEFAULT 0,
  slot        TEXT NOT NULL DEFAULT '',
  created_by  INTEGER NOT NULL REFERENCES members(id),
  created_at  TEXT NOT NULL,
  updated_by  INTEGER NOT NULL REFERENCES members(id),
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS votes (
  idea_id    INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  member_id  INTEGER NOT NULL REFERENCES members(id),
  value      INTEGER NOT NULL CHECK (value IN (-1, 1)),
  PRIMARY KEY (idea_id, member_id)
);
CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY,
  idea_id     INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  member_id   INTEGER NOT NULL REFERENCES members(id),
  text        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS history (
  id          INTEGER PRIMARY KEY,
  idea_id     INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  member_id   INTEGER NOT NULL REFERENCES members(id),
  changes     TEXT NOT NULL,              -- JSON {field: [from, to]}
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_idea ON comments(idea_id);
CREATE INDEX IF NOT EXISTS history_idea ON history(idea_id);
CREATE INDEX IF NOT EXISTS sessions_member ON sessions(member_id)
`;

export const statements = () => SCHEMA.split(";").map((s) => s.trim()).filter(Boolean);
