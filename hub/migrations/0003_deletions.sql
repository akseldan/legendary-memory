-- Deletion ledger (docs/contracts/DATA-CONTRACT.md §6, decided 2026-11-19: kept forever).
--
-- One row per deleted record: its kind and identity, never its content. Imports, restores and
-- copies skip anything listed here, and copies carry the list along, so a memory deleted in one
-- place does not come back from an older backup or another home.
--
-- kind        ref
-- project     projects.id         (its checkpoints and artifacts are listed too)
-- checkpoint  checkpoints.id
-- artifact    artifacts.id
-- profile     profile.key         (a later `remember` of the same key clears it: a new fact)
-- conversation  source || ':' || external_id
CREATE TABLE deletions (
  kind        TEXT NOT NULL,
  ref         TEXT NOT NULL,
  deleted_at  TEXT NOT NULL,
  PRIMARY KEY (kind, ref)
);
