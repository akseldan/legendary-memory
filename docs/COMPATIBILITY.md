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
| Claude web (claude.ai) | Paid (owner) | **Verified** 2026-11-17 → 11-25 | yes | yes | Custom connector with the hub's `/mcp` address. 43 saves recorded from Claude since 2026-11-12. |
| Claude Desktop (Mac) | Paid (owner) | **Verified** 2026-11-25 | yes | yes | Same account connector as the web; this release was tested from it. |
| Claude iPhone / iPad | Paid (owner) | Verified for the owner on 2026-11-16; **retest pending** with the Mac off | — | — | Claude's docs: phones use connectors added on web or desktop; adding one on the phone is not the main path. |
| ChatGPT web (developer mode) | Plus (owner) | **Preview**: saves recorded 2026-11-15; **retest pending** | — | — | OpenAI's docs disagree about whether Plus can save (write) or only read. Test on the plan you have. |
| ChatGPT iPhone | Plus (owner) | **Retest pending** | — | — | Developer-mode apps are documented for the web. |
| Codex (CLI / IDE / ChatGPT desktop app) | Plus (owner) | **Retest pending**: connected 2026-11-16, no saves recorded | — | — | Add the hub as a Streamable HTTP server, then `codex mcp login <name>`. One config is shared by the CLI, IDE extension and ChatGPT desktop app. |
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
