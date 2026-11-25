-- Activity history (execution plan P8.2.4): which assistant read, saved or deleted what, and when.
--
-- Holds references only, never content: the tool or page action, the app it came from, the
-- project or record it named (an id, a project name, or a fact's key), and whether it worked.
-- Search words are not kept. Only the owner sees it, on the memory page. Entries older than
-- 90 days, and any beyond the newest 5,000, are removed as new ones arrive. It is not part of
-- backups, exports or the memory hash: it describes use of the memory, not the memory itself.
CREATE TABLE activity (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  client  TEXT NOT NULL,
  action  TEXT NOT NULL CHECK (action IN ('read', 'write', 'delete')),
  tool    TEXT NOT NULL,
  target  TEXT,
  ok      INTEGER NOT NULL
);
CREATE INDEX activity_at ON activity (at);
