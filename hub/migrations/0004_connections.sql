-- When each connected app last used the hub (execution plan P4.3, P8.2).
--
-- Operational data, not memory: one row per OAuth grant, no content. It is not exported, backed
-- up or copied. The hub updates a row at most once every few minutes, so a busy assistant costs
-- one write per interval, not one per request. Revoking a connection deletes its row.
CREATE TABLE connection_use (
  grant_id      TEXT PRIMARY KEY,
  client        TEXT NOT NULL,
  first_used_at TEXT NOT NULL,
  last_used_at  TEXT NOT NULL
);
