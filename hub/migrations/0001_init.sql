-- Legendary Memory: initial schema.
-- Canonical data lives in ordinary tables. The search index (search_map + search_fts)
-- is derived from them and can always be rebuilt.

-- A project and its living brief: the one document every AI reads first.
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  aliases     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'paused', 'done', 'archived')),
  brief       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Earlier versions of a brief, kept so a bad rewrite can be undone.
CREATE TABLE brief_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  brief       TEXT NOT NULL,
  replaced_at TEXT NOT NULL
);
CREATE INDEX brief_versions_project ON brief_versions(project_id, id DESC);

-- One entry per work session: what happened, what was decided, what is next.
CREATE TABLE checkpoints (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,
  title       TEXT NOT NULL,
  summary     TEXT NOT NULL,
  decisions   TEXT NOT NULL DEFAULT '',
  next_steps  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX checkpoints_project ON checkpoints(project_id, created_at DESC);

-- Things that were made: code, documents, prompts. Latest version only.
CREATE TABLE artifacts (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'text',
  content     TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  source      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (project_id, name)
);

-- Durable facts about the owner that every AI should know.
CREATE TABLE profile (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Full chat history, synced by the importer and the browser extension.
CREATE TABLE conversations (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title         TEXT NOT NULL DEFAULT '',
  url           TEXT NOT NULL DEFAULT '',
  started_at    TEXT,
  updated_at    TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source, external_id)
);
CREATE INDEX conversations_project ON conversations(project_id, updated_at DESC);

CREATE TABLE messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  role            TEXT NOT NULL,
  text            TEXT NOT NULL,
  UNIQUE (conversation_id, seq)
);

-- Search index. search_map says what each indexed row is; search_fts holds the words.
-- search_fts.rowid = search_map.id.
CREATE TABLE search_map (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,   -- project | checkpoint | artifact | profile | message
  ref_id      TEXT NOT NULL,   -- id of the row it points at (conversation id for messages)
  project_id  TEXT,
  seq         INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX search_map_ref ON search_map(kind, ref_id, seq);
CREATE INDEX search_map_project ON search_map(project_id);

CREATE VIRTUAL TABLE search_fts USING fts5(
  title,
  body,
  tokenize = 'porter unicode61 remove_diacritics 2'
);
