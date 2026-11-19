# P1 reference fixtures and baseline benchmark — 2026-11-19

Execution plan P1.3, and the "before" numbers for P2.1–P2.4. Code at `8d7d048` plus the
`backup` command (PR #3), which does not touch import or search. Synthetic data only.

Reproduce:

```sh
cd hub && npm ci && npm run build:local
node bench/fixtures.mjs --messages 10000  --out bench/out/fx-10k
node bench/fixtures.mjs --messages 100000 --out bench/out/fx-100k
node bench/run.mjs --fixture bench/out/fx-10k  --repeat 10
node bench/run.mjs --fixture bench/out/fx-100k --repeat 3
```

Fixtures are deterministic (seed 42; regenerating gives identical bytes). They contain ~2 KiB
messages, 2% long documents (10–30 KB), English with Russian, Japanese and code, chats re-sent
unchanged (every 25th) and re-sent with an edited last message (every 40th), and eight projects
including *Cooling Rig* and *Cooking Club*. Each fixture carries judged questions with expected answers.

Machine: Linux x64, 2 vCPU (Xeon 2.1 GHz), 8 GiB RAM, Node 22.23.5, SQLite 3.54.1.
Latency is warm, measured through the `/mcp` HTTP endpoint of `serve` (includes HTTP + JSON, no model).

## Results

| Measure | 10K messages | 100K messages |
|---|---:|---:|
| Message text stored | 24.1 MiB | 244.1 MiB |
| First import | 2.8 s | 27.3 s |
| Database file | 72.6 MiB | 719.2 MiB |
| — canonical tables | 32.3 MiB | 325.4 MiB |
| — search index (`search_fts` + `search_map`) | **38.8 MiB** | **388.0 MiB** |
| — other indexes | 0.6 MiB | 5.8 MiB |
| Bytes on disk per byte of text | **3.01** | **2.95** |
| Identical re-import, time per pass | ~3.2 s | ~32.5 s |
| Index rows rewritten per identical re-import | **10,777 (all)** | **106,601 (all)** |
| File growth after identical re-imports | +32.1 MiB over 10 | +154.1 MiB over 3 |
| Record counts after re-imports | stable | stable |
| `search` p50 / p95 | 19 / 25 ms | 79 / 121 ms |
| `recall` p50 / p95 | 2.7 / 11 ms | 2.4 / 15 ms |
| Recall reply size | ~890 chars | ~880 chars |

Judged questions:

| Kind | 10K | 100K | Meaning |
|---|---:|---:|---|
| Phrase after character 8,000 | **0/20** | **0/20** | Long documents are only searchable in their first 8,000 chars |
| Edited message, found once | 6/6 | 58/59 | The one miss is an edit inside a 27K-char message (same cause) |
| Saved decision found with its project | 5/5 | 47/47 | |
| Project names | 5/6 | 5/6 | Write to `cookin` filed silently into *Cooking Club*; should ask |

## What this tells P2

1. **The search index is larger than the data.** FTS keeps its own copy of each body, so the store
   costs ~3 bytes per byte of text. External-content FTS (P2.3) should remove most of that copy.
2. **Re-sending history does all the work again.** Records stay correct, but every message is
   rewritten and re-indexed, and freed pages make the file grow. Hash-skip unchanged rows (P2.2).
3. **Long content is invisible past 8,000 characters.** Chunked indexing (P2.4).
4. **Ambiguous project names on writes need confirmation** (DATA-CONTRACT §4).
5. Latency is comfortably inside the plan's targets on this small machine (p95 local recall 15 ms
   vs 200 ms target; search 121 ms vs 300 ms) — so P2 should optimize bytes and write work, not speed.

## Second machine: Daniel's MacBook Pro (M3 Pro)

Measured inside the Claude desktop app's Linux VM on the Mac (aarch64, 4 vCPU, 3 GiB visible RAM),
10K fixture, 3 re-imports. Storage is identical to the table above (72.6 MiB; 3.01 bytes per byte of
text; all 10,777 index rows rewritten per identical re-import; +15.5 MiB after 3). First import 2.1 s,
re-import 2.0 s each. `search` p50/p95 8.7/11.9 ms; `recall` p50/p95 0.9/2.5 ms. Judgments identical.
A native macOS run (outside the VM) remains to be recorded.

Still to do for P1.3: a native macOS run and one low-spec machine; record CPU/RAM
(idle and during import) alongside these numbers.
