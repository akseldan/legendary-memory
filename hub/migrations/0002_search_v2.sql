-- Search index v2 (execution plan P2.3 + P2.4).
--
-- 1. The full-text table no longer keeps its own copy of every body (contentless FTS5). The words
--    are still indexed; snippets are cut from the original records when a search returns them.
-- 2. The whole text is indexed, not just the first 8,000 characters. Long text is split into
--    chunks of 4,000 characters that overlap by 200, so a phrase of up to 200 characters is
--    found even where it crosses a chunk boundary. search_map.chunk is the chunk number.
--
-- The index is derived data: this migration drops it and rebuilds it from the canonical tables.
-- The body each record type indexes must match reindex() in src/core/store.ts.

DROP TABLE search_fts;
DELETE FROM search_map;
ALTER TABLE search_map ADD COLUMN chunk INTEGER NOT NULL DEFAULT 0;
DROP INDEX search_map_ref;
CREATE INDEX search_map_ref ON search_map(kind, ref_id, seq, chunk);

CREATE VIRTUAL TABLE search_fts USING fts5(
  title,
  body,
  content = '',
  contentless_delete = 1,
  tokenize = 'porter unicode61 remove_diacritics 2'
);

-- REBUILD: everything below rebuilds the index from the canonical tables. Restoring an archive
-- runs the same statements (src/local/archive.ts), so keep them self-contained.
-- What every record indexes, in one place for the rebuild.
CREATE TABLE _search_rebuild (
  kind TEXT NOT NULL, ref_id TEXT NOT NULL, project_id TEXT, seq INTEGER NOT NULL,
  created_at TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL
);
INSERT INTO _search_rebuild
  SELECT 'project', id, id, 0, updated_at, trim(name || ' ' || aliases), brief FROM projects;
INSERT INTO _search_rebuild
  SELECT 'checkpoint', id, project_id, 0, created_at, title,
         summary
         || CASE WHEN decisions != '' THEN (CASE WHEN summary != '' THEN char(10) ELSE '' END) || decisions ELSE '' END
         || CASE WHEN next_steps != '' THEN (CASE WHEN summary != '' OR decisions != '' THEN char(10) ELSE '' END) || next_steps ELSE '' END
  FROM checkpoints;
INSERT INTO _search_rebuild
  SELECT 'artifact', id, project_id, 0, updated_at, name, content FROM artifacts;
INSERT INTO _search_rebuild
  SELECT 'profile', key, NULL, 0, updated_at, replace(key, '-', ' '), value FROM profile;
INSERT INTO _search_rebuild
  SELECT 'message', c.id, c.project_id, m.seq, coalesce(c.started_at, c.updated_at), c.title, m.text
  FROM messages m JOIN conversations c ON c.id = m.conversation_id;
CREATE INDEX _search_rebuild_key ON _search_rebuild(kind, ref_id, seq);

WITH RECURSIVE chunks(kind, ref_id, seq, k) AS (
  SELECT kind, ref_id, seq, 0 FROM _search_rebuild
  UNION ALL
  SELECT c.kind, c.ref_id, c.seq, c.k + 1
  FROM chunks c JOIN _search_rebuild r ON r.kind = c.kind AND r.ref_id = c.ref_id AND r.seq = c.seq
  WHERE length(r.body) > (c.k + 1) * 4000 + 200
)
INSERT INTO search_map (kind, ref_id, project_id, seq, chunk, created_at)
  SELECT c.kind, c.ref_id, r.project_id, c.seq, c.k, r.created_at
  FROM chunks c JOIN _search_rebuild r ON r.kind = c.kind AND r.ref_id = c.ref_id AND r.seq = c.seq;

INSERT INTO search_fts (rowid, title, body)
  SELECT m.id, r.title, substr(r.body, m.chunk * 4000 + 1, 4200)
  FROM search_map m JOIN _search_rebuild r ON r.kind = m.kind AND r.ref_id = m.ref_id AND r.seq = m.seq;

DROP TABLE _search_rebuild;
