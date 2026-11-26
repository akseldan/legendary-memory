# Which AI apps work with Legendary Memory

Last checked: **2026-11-25**. Each row says what was actually tested, on which account, and when.
"Documented" means the app's own docs say it should work but we have not tested it ourselves yet.
App makers change plans and menus often; if a row is old, treat it as unconfirmed.

Labels: **Verified** (tested end to end: save in one app, recall in another) · **Documented** (the
app's docs say yes, untested here) · **Unavailable** (the app or plan cannot connect) · **Preview**
(partly works; see notes).

## Remote hub (Cloudflare, your own server) — phones and web apps

| App and surface | Plan tested | Status | Read | Save | Notes |
|---|---|---|---|---|---|
| Claude web (claude.ai) | Paid (owner) | **Verified** 2026-11-25 | yes | yes | Custom connector with the hub's `/mcp` address. Test code CT-CLW-7341. |
| Claude Desktop (Mac) | Paid (owner) | **Verified** 2026-11-25 | yes | yes | Same account connector as the web. CT-CLD-2958. |
| Claude iPhone | Paid (owner) | **Verified** 2026-11-25 | yes | yes | Uses the connector added on web/desktop. CT-CLI-8170, run with the Mac asleep (the app saved the title with angle brackets; stored exactly as sent). |
| ChatGPT web (developer mode) | Plus (owner) | **Verified** 2026-11-25 | yes | yes | Saving works on Plus, even though some OpenAI docs say write actions need Business/Enterprise. CT-GPW-6612. |
| ChatGPT iPhone | Plus (owner) | **Verified** 2026-11-25 | yes | yes | Uses the app enabled on the web. CT-GPI-5523. |
| Codex | Plus (owner) | **Verified** 2026-11-25 | yes | yes | Streamable HTTP server + `codex mcp login <name>`; recorded as source `codex`. CT-CDX-4087. |
| Gemini, Cursor, others | — | Documented / untested | — | — | MCP clients generally can connect; not tested. |

## On this computer (no account) — desktop apps over stdio

| App | OS tested | Status | Notes |
|---|---|---|---|
| Claude Desktop | macOS 27 (arm64) | **Verified** (installer + `setup`) | One-command installer or the `.mcpb` extension. |
| Codex CLI / IDE | — | Documented | `legendary-memory setup` writes the Codex config; untested on a clean machine. |
| Any app on Windows | — | **Preview** | Use the `.mcpb` for Claude Desktop. The one-command installer is macOS/Linux only. |

## If an app cannot connect

Use a portable handoff: in the app that can connect, ask *"Write a handoff for the X project
from Legendary Memory"* and paste it into the other app. Nothing is lost; you just carry it by hand.

## How a row gets verified

1. Connect the app; approve read and save (delete is optional).
2. In app A: "Save a checkpoint to project **Compat Test** titled `CT-<code>` with summary
   `handoff test from <app and surface>`."
3. Fully quit and reopen app B (a different app), then: "Recall the Compat Test project. Which test
   codes are there?" It must name `CT-<code>`.
4. The hub records which app saved it and when; the row is updated with the date and plan.
5. Phone rows are run with the Mac shut down or asleep, so the hub must be reachable on its own.

## Languages and content (tested 2026-11-26, `hub/test/content.mjs`)

Saving, recall, the memory page and the Markdown handoff keep all of these unchanged: Russian, Japanese,
Arabic (right to left), emoji, code and HTML-looking text (shown as text, never run), accented
Latin, and 120-character project names. Times are stored in UTC and shown in your local time.

What search can and cannot do today:

| Content | Search finds | Search misses |
|---|---|---|
| English | the word and its forms (pumps → pump) | — |
| Accented Latin | with or without accents (creme → crème) | — |
| Russian, Arabic and other space-separated scripts | the exact word | other forms of it (насосы does not find насос) |
| Japanese, Chinese (no spaces between words) | a whole run of text up to punctuation | a word inside a longer run (サーミスタ inside サーミスタで制御する) |

Recall by project name works in any script, including one word of a longer name.
