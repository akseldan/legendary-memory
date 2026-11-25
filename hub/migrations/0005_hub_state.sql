-- Small settings about this memory as a whole (execution plan P3.5).
--
-- key "moved": set by `legendary-memory move` once this memory has been copied to a new home and
-- verified. Its value is JSON {"to": "<new home, no key>", "at": "<time>", "memory_sha256": "..."}.
-- While it is set, this memory is read-only: apps can still recall and search, and every save,
-- delete or import is refused with the new address. `move --undo` clears it.
CREATE TABLE hub_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
