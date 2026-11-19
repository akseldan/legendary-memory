# P3.3 / P3.4 — portable archive, verified restore — 2026-11-19

New commands (branch `p3-portable-archive`):

```sh
legendary-memory export  --to memory.lmarchive [--from local | file.db | https://hub]
legendary-memory restore --from memory.lmarchive --to <new folder>
```

Format (archive_version 1): gzip-compressed JSON Lines — a header (archive and schema versions,
tables, source), every canonical row with ids and dates, and an end line with per-table counts, a
SHA-256 of the body and the backup manifest. The search index is not exported; restore rebuilds it
with the same SQL as migration 0002. Export reads a consistent, verified backup first, so it is
safe while apps write and works from a hub over HTTP.

Restore only creates a new memory. It checks the header and versions, refuses unknown tables and
columns, caps line length and expanded size, verifies the checksum and row counts, rebuilds search,
checks foreign keys and integrity, compacts the file, and requires the restored memory to hash
exactly like the archive's manifest. On any failure the half-made file is removed. Merging into a
live memory goes through `copy`, which honors the deletion ledger.

## Measured (100K-message fixture, 2 vCPU Linux)

| | |
|---|---:|
| Memory file | 451 MB |
| Archive | **50 MiB** (≈ 9× smaller) |
| Export | 21 s |
| Restore incl. index rebuild, checks and compaction | 19 s |
| Restored file | 448 MB, hash matches |

## Tests — `hub/test/archive.mjs` (29 checks, in `test:all`)

Export from a running memory and from a hub over HTTP (same hash, key not printed); header,
ledger, no index, end marker; never overwrites. Restore: hash matches, recall works, search past
character 8,000 works, chats and unicode intact, deleted items stay deleted, never writes into an
existing memory. Refused with nothing left behind: a changed row, a cut-off file, a newer archive
format, a newer schema, an unknown column, an unknown table, a non-archive.

## Bug found and fixed on the way

A backup of a hub **with chats** always failed ("the hub kept changing"): `copy` gives chats new
local ids, and the manifest hashed that id, so two identical exports never matched. Chats are
identified by (source, external_id) per the contract; the manifest (format 2) no longer hashes the
local id. Daniel's live hub has no imported chats yet, so his weekly backups were not affected.
