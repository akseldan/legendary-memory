# Execution status — updated 2026-11-19

Tracks the [execution checklist](../../) items against evidence. "Draft PR" means built and
tested, not merged.

**Deployed 2026-11-24 (Daniel ran `deploy-2026-11-19.sh`):** the personal Cloudflare hub runs the
#9 build (Worker version `b208c58e`), D1 at schema 3 (migrations 0002, 0003 applied in 18 ms).
Rollback point: D1 Time Travel bookmark `00000057-00000000-0000512e-60dceb3ff45f887a65a08a7034d65621`.
Verified: every checkpoint, artifact, project and brief revision from the pre-deploy backup is present
unchanged (33 → 37 checkpoints: 4 new since); recall, fuzzy recall and search via the Claude connector
work, including text past character 8,000; backups and `copy` from the hub work; the hub now carries
deletion records. Contentless FTS5 confirmed working on production D1.

| Item | Status | Evidence |
|---|---|---|
| P0 Identify the active home | **Done** | `P0-baseline-2026-11-19.md` (hub v1.0.2, D1 483 KB, launchd job loaded) |
| P0 Prove recovery | **Done** | Same file: two matching exports, restore into empty home, identical hashes, recall works |
| P1 Data contract | **Done, approved by Daniel** | `../contracts/DATA-CONTRACT.md` §10 decisions; `../contracts/THREAT-MODEL.md` |
| P1 Fixtures + judged recall set | **Done** | `hub/bench/fixtures.mjs`, `P1-baseline-benchmark-2026-11-19.md` (10K/100K, Linux + M3 Pro VM) |
| First package #2 Backup correctness | **Done** (draft PR #3; running on Daniel's Mac) | `hub/test/backup.mjs`; weekly `backup.sh` uses it |
| P2 Measure growth and speed | **Done** for local | Benchmarks in P1/P2 evidence; hosted footprint pending P7 |
| P2 Duplicate work + incomplete search | **Done** (draft PRs #5, #6) | `P2-incremental-import-…`, `P2-search-index-v2-…`: 100K DB 719 → 430 MiB, re-import rewrites 106,601 → 130 rows, text past 8,000 chars 0/20 → 20/20 |
| P2.5 Bounded caches/logs, low disk | Partly | `compact` refuses when disk is short; quota admission not started |
| P3 Deletions survive restore/copy | **Done** (draft PR #7) | `hub/test/deletions.mjs` |
| P3 Portable archive + verified restore | **Done** (draft PR #9) | `P3-portable-archive-2026-11-19.md`, `hub/test/archive.mjs` |
| P3 Verified home transfer (`move`, `move --undo`) | **Done** (draft PR #11; hub part not deployed) | `hub/test/move.mjs` (25) |
| P3 Import preview / cancel / resume | Deferred by Daniel (2026-11-24) | — |
| P4 Local browser UI guards | **Done** for `serve` (draft PR #8) | `hub/test/local-guards.mjs` + existing `ui.mjs`, `host-ui.mjs` |
| P4 Per-connection permissions, last use, disconnect | **Done and deployed 2026-11-24** (PR #10, Worker 02fcc751) | `hub/test/connections.mjs` (19), e2e permission checks (47 total), `permissions.test.ts` |
| P5–P13 | Not started | — |

## Draft PR stack (merge in order)

#2 P0 evidence → #3 backup → #4 P1 contract/fixtures → #5 incremental import → #6 search v2 →
#7 deletion ledger → #8 local guards → #9 portable archive → #10 permissions and connections page → #11 move.

## Deploying to the personal Cloudflare hub (done 2026-11-24; kept for the next deploy)

Schema goes 1 → 3. Steps: fresh `legendary-memory backup` of the hub; `wrangler d1 migrations apply
DB --remote`; `wrangler deploy` of the same build; recall/search from Claude and ChatGPT; second
backup and compare. Update `~/.legendary-memory/bin` to the same build at the same time (older CLIs
refuse newer schemas). Contentless FTS5 was verified on wrangler's local D1 engine, not yet on
production D1.
