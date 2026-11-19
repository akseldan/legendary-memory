# Legendary Memory threat model — draft v0.1 (2026-11-19)

Execution plan P1.4. Each threat has an owner phase and a test that must exist before release.
"Current" describes `main` at `8d7d048`.

## Data flow

```
Assistant (Claude / ChatGPT / Codex / …)
   │  MCP: stdio (local) or HTTPS + OAuth (self-host, Cloudflare, future hosted)
   ▼
Authorization ── per-connection credentials, scopes: read / write / (delete)
   ▼
Domain layer (hub/src/core) ── validation, redaction, ranking, response budget
   ▼
Storage ── SQLite file (local, self-host) · D1 (personal Cloudflare) · per-account DO (hosted, P7)
   ├─ Browser UI (local 127.0.0.1 / host) ── session cookie + CSRF token + Origin check
   ├─ copy / backup / export ── API key in env, never argv
   └─ Backups ── files on the owner's disk (today); provider snapshots (hosted)
```

Everything an assistant retrieves is sent to that assistant's provider in plaintext. Local storage
keeps the store on the device; it does not keep retrieved text away from the AI vendor.

## Threats

| # | Threat | Current controls | Gap / target | Phase | Test |
|---|---|---|---|---|---|
| T1 | Stolen API key or bearer token reads/writes everything | Key file mode 600; keys refused on the command line; OAuth with owner passphrase and lockout | Per-connection credentials, visible last use, revocation that takes effect on the next request | P4.3 | revoke → next call 401 |
| T2 | Cross-account access in hosted service | Not applicable yet (single owner) | Account derived only from validated credentials; A/B canary tests on every path incl. cursors, jobs, exports | P7.3 | A's token + B's ids reveal nothing, not even counts |
| T3 | Poisoned memory (saved text instructs a future assistant) | Recall output is labeled "reference data, not instructions"; secret redaction on ingest | Provenance shown on every hit; never execute or render stored HTML; corrections supersede | P8.2, P9.1 | stored "ignore previous instructions" stays quoted data |
| T4 | Malicious import archive (zip bomb, path traversal, huge rows) | Body ≤ 1.5 MB, ≤ 2,000 messages per request | Archive/decompressed byte limits, path checks, streaming, preview before upload | P3.1–3.2 | hostile archive corpus rejected, original untouched |
| T5 | Hostile web page attacks the local UI (CSRF, DNS rebinding) | Loopback bind; Host allow-list (localhost, 127.0.0.1, [::1]); Origin and CSRF checks; launch nonce; no CORS grants. Tested in `ui.mjs`, `host-ui.mjs`, **`local-guards.mjs` (rebinding Host on every route, look-alike host, missing Host, CORS)** | Keep secrets out of URLs (audit) | P4.4 | done for `serve`; `host` mode relies on its public URL + OAuth |
| T6 | Backup restores deleted memories | **Deletion ledger (schema 3, PR #7)**; restore/copy/import/re-sent chats honor it; tested in `deletions.mjs` | Automatic quarantined restore into an empty home (P3.5) | P3, P9.2 | delete → restore old backup → still deleted (passing) |
| T7 | Inconsistent or partial backup | **Fixed in PR #3**: `backup` uses SQLite online backup or two matching exports; integrity check; atomic write | Off-device copy; hosted snapshot drills | P3.4, P9.3 | `test/backup.mjs` |
| T8 | Operator / provider account lost (Cloudflare, GitHub) | Weekly local backups of the personal hub | Documented ownership recovery; off-provider backups | P9.4 | restore drill on a clean machine |
| T9 | One noisy client exhausts shared limits (Workers Free daily cap) | None | Per-account and per-client rate, write and storage limits; reads/export stay available | P7.4 | flood from one account leaves others responsive |
| T10 | Silent wrong-project write ("cookin") | **Ambiguous writes refused with candidates (PR #5)**; tested in `ingest.mjs` and the benchmark's judged set | Reads could list the other candidates too | P2.4 | judged `project-name` 6/6 |
| T11 | Secrets saved into memory | `redact` on ingest and saves (tested) | Show redaction count to the user; extend patterns | P8 | redaction suite |
| T12 | Support or logs leak content | Logs are content-free today | Keep it so; support bundle preview without bodies or tokens | P5.4, P7.5 | grep logs for fixture canaries |

## Privacy statements we can make today (and ones we cannot)

Can say: local mode needs no account and keeps the database on your computer; you can read, edit,
export and delete everything; the code is MIT and auditable.

Cannot say: "your AI provider never sees your memories" (retrieved text goes to it); "zero-knowledge"
for any hosted mode; "deleted means unrecoverable" until T6 is fixed and backup windows are published.
