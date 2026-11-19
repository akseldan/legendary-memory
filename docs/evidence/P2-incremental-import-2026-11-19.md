# P2.2 / P2.4 — incremental import and safe project names — 2026-11-19

Same fixtures, machine and commands as `P1-baseline-benchmark-2026-11-19.md` (2 vCPU Linux).
Change: commit "P2.2/P2.4: skip unchanged messages on import…" on branch `p2-incremental-import`.

| Measure | Before | After |
|---|---:|---:|
| **10K** — index rows rewritten per identical re-import | 10,777 | **12** |
| 10K — file growth after 10 identical re-imports | +32.1 MiB | **+1.1 MiB** |
| 10K — time per identical re-import | ~3.2 s | **~1.8 s** |
| **100K** — index rows rewritten per identical re-import | 106,601 | **118** |
| 100K — file growth after 3 identical re-imports | +154.1 MiB | **+0.5 MiB** |
| 100K — time per identical re-import | ~32.5 s | **~17 s** |
| First import, database size, latency | — | unchanged (within noise) |
| Judged project names | 5/6 | **6/6** |
| Judged edits / decisions | pass | pass |
| Phrases after char 8,000 | 0/20 | 0/20 (P2.4 chunking, next) |

The remaining rewrites are real changes: every 40th fixture chat is sent in an original and an
edited version, so each pass flips those messages back and forth (6 at 10K → 12 rows; 59 at 100K → 118).

Acceptance from the plan (P2.2): "Import identical history ten times, then import one edit. Verify
stable counts, a single changed record and correct results after a delete." Covered by
`hub/test/ingest.mjs` (16 checks): ten identical re-sends add or replace no index rows; one edit
replaces exactly one index row and removes the old text from the index; an appended message adds one
row; a new title re-indexes the chat; `cookin` saves nothing and lists both projects; `cooling` and
`cooking` save directly; `codex` and `cursor` are accepted sources.

Not yet deployed: this changes shared core code also used by the Cloudflare Worker. Deploying to the
personal hub is a separate, owner-approved step.
