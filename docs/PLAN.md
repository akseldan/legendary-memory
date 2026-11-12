# Legendary Memory: plan

Written 2026-11-12. This is the working plan and the handoff document. Whoever picks the
project up next (a person or an AI) should read "Where things stand" first.

## Goal

Start work in one AI app and continue it in another with no re-explaining. "Recall the
cooling project" in Claude should return the project's state, decisions and files even if
all the work happened in ChatGPT.

Requirements, from the owner:

1. Switch between AI apps without supplying context by hand.
2. Low token use. Low CPU and memory use on the Mac.
3. Apps share context about the user, what was made, and the artifacts.
4. Existing memory and existing projects get synced and organized.
5. Open source on GitHub. Secure.
6. Works on a Mac. Bonus: iPhone and iPad without the Mac being on.
7. Mainly Claude and ChatGPT (both on the base paid plans). Gemini is optional and must not
   be a dependency, because the owner's Gemini access ends after a one-year student trial.

## Where things stand

| Phase | What | Status |
|---|---|---|
| 1 | Hub: storage, tools, sign-in, importer API | **Done. Passes locally: 40 end-to-end checks and 31 unit tests.** |
| 2 | Deploy, connect Claude, test on Mac and iPhone | **Done 2026-11-12. Save and recall work from Claude on Mac and iPhone. Production lockout check and custom instruction still open.** |
| 3 | Connect ChatGPT (web), confirm Plus runs the tools | Not started |
| 4 | Import existing history from both apps' exports | **Importer written and tested on made-up exports. Not yet run on your real exports.** |
| 5 | Browser extension for automatic capture on the Mac | Not started |
| 6 | Dashboard, Obsidian mirror, smarter search | Not started |

**Next action (needs Daniel at the keyboard): Phase 3, connect ChatGPT. Phase 4's importer is ready to try on real exports.** Phase 1 was run on
2026-11-12 against `wrangler dev` (local D1 and KV): `npm run typecheck`, `npm test`
(31 unit tests) and `npm run e2e` (40 checks) all pass. Findings:

- The compatibility date `2026-10-01` was accepted.
- The MCP SDK loads and serves in the Workers runtime with `CfWorkerJsonSchemaValidator`;
  no `nodejs_compat` flag and no hand-written handler were needed.
- Local KV and D1 work without ids in `wrangler.jsonc`.
- Not covered locally: the sign-in limit is keyed on the `CF-Connecting-IP` header. The test
  could not show that per-address counting separates different visitors, so re-check the
  lockout after deploying. Real Claude and ChatGPT sign-in can only be tested after
  deploying (phases 2 and 3).

## Architecture

```
 Claude (web, Mac, iPhone, iPad) ─┐
 ChatGPT (web)  ──────────────────┼──► hub /mcp ──► D1 database (your Cloudflare account)
 Browser extension (Mac) ─────────┤       ▲
 Importer script (one-time) ──────┘       │
                                    /api/ingest
```

One Cloudflare Worker, one D1 database, one KV namespace. Nothing runs on the Mac except
the browser extension (phase 5).

### Why these choices

- **A remote MCP server instead of a local app.** Both Claude and ChatGPT reach custom
  connectors from their own cloud, so the server must be on the public internet. This is
  also what makes the phone work with the Mac off.
- **Cloudflare free tier.** 100k requests a day, 5 GB of database, no server to maintain.
  Far above one person's use.
- **A project brief, not just chat history.** Existing tools (MemoryPlugin and others)
  store facts and replay chat excerpts. For a big project the useful thing is its current
  state: goal, decisions and why, what is next. Each project has one living brief that every
  AI reads first and rewrites when the state changes. This is the project's distinguishing
  idea and what `recall` returns.
- **The AI you are already talking to writes the summaries.** `save_checkpoint` takes a
  summary the assistant composed. No extra model, no API bill, no dependence on Gemini.
- **Keyword search first.** SQLite full-text search (FTS5) is built into D1, costs nothing
  and needs no embedding model. Vector search is a later upgrade only if recall quality
  demands it.
- **Seven tools, short descriptions.** Tool definitions are sent with every chat, so they
  are a fixed token cost. `recall` answers in about 1,500 tokens by default.

### Sign-in

OAuth 2.1 through `@cloudflare/workers-oauth-provider` (Cloudflare's maintained library;
auth is not hand-rolled). The one custom piece is the consent page in `src/auth.ts`: it
shows which app is asking, where access will be sent, and takes the owner's passphrase.

- Both Dynamic Client Registration and Client ID Metadata Documents are on, because Claude
  and ChatGPT use different ones.
- Self-registration is refused unless every redirect address is on the allowlist
  (`ALLOWED_REDIRECT_HOSTS`: claude.ai, claude.com, chatgpt.com, localhost).
- Scopes: `memory:read`, `memory:write`. Unticking write on the consent page makes a
  read-only connection.
- A connection stays valid while used and lapses after 90 idle days.

### Data model (`hub/migrations/0001_init.sql`)

| Table | Holds |
|---|---|
| `projects` | name, status, aliases, the living brief |
| `brief_versions` | last 10 replaced briefs per project, for undo |
| `checkpoints` | one per work session: summary, decisions, next steps, which AI wrote it |
| `artifacts` | saved files (code, documents, prompts), latest version only |
| `profile` | lasting facts about the owner |
| `conversations`, `messages` | full chat history from the importer and extension |
| `search_map`, `search_fts` | derived search index, rebuildable from the tables above |

### Tools (`hub/src/mcp.ts`)

| Tool | Does | Writes? |
|---|---|---|
| `recall` | Project brief, recent sessions, files. No project = overview of everything | No |
| `search` | Keyword search across all stored text | No |
| `read` | Open one artifact, checkpoint or chat in full, paged | No |
| `save_checkpoint` | Save a session; optionally replace the brief; creates the project | Yes |
| `save_artifact` | Save or replace a file in a project | Yes |
| `remember` | Store a fact about the owner | Yes |
| `forget` | Delete one item (only on explicit request) | Yes, destructive |

Project names are matched loosely ("the cooling project" finds "Cooling System"). A typo
match is allowed for reading and flagged in the result; writes and deletes require an exact
match so nothing lands in the wrong project.

### Security

- Passphrase check is constant-time; 5 failures per address (40 overall) pause sign-in for
  15 minutes; the hub refuses to run with a passphrase under 12 characters.
- `src/redact.ts` strips API keys, tokens, private keys, password assignments, card numbers
  and SSNs from all text before storage.
- Tool results are prefixed as stored data, and the server instructions say stored content
  is never instructions (guards against a saved note hijacking a later chat).
- `/api/*` is off until a `BRIDGE_API_KEY` secret of 32+ characters is set.
- Tool errors are logged without content. Stored text is never logged.
- Known gap: someone who learns the hub's URL could spam the registration endpoint to use
  up the free KV write quota (a nuisance, not a data risk). Fix later with a rate limit.

## Phase 1 test checklist (completed 2026-11-12)

Run from `hub/`. A `.dev.vars` file with local-only values is needed (copy
`.dev.vars.example`).

1. `npm install`, then `npx wrangler d1 migrations apply DB --local`.
2. `npx wrangler dev`. Things to watch for on first start:
   - the compatibility date (`2026-10-01`) being rejected as too new; lower it if so;
   - the MCP SDK failing to load in the Workers runtime. It imports Ajv, which uses
     `new Function`. `mcp.ts` passes `CfWorkerJsonSchemaValidator` to avoid this, but it is
     unverified. If it fails, add the `nodejs_compat` flag or replace the SDK with a small
     hand-written JSON-RPC handler;
   - local KV and D1 working without ids in `wrangler.jsonc`.
3. `test/e2e.mjs` (run with `npm run e2e` while `wrangler dev` is up; the lockout test runs
   last and blocks sign-in for 15 minutes, so a rerun needs a fresh local state). It does: register a client at `/oauth/register` with a `http://localhost` redirect; GET
   `/authorize` with PKCE; POST the form with the passphrase; exchange the code at
   `/oauth/token`; then POST JSON-RPC to `/mcp`: `initialize`, `tools/list`, and
   `tools/call` for each tool.
4. Check, in order: wrong passphrase gives 401 and the sixth try gives 429; a registration
   with an off-list redirect is refused; a call without a token gets 401 with a
   `WWW-Authenticate` header; `save_checkpoint` creates a project; `recall` with a loose
   name and with a one-letter typo both find it; `search` finds a word from the summary;
   a saved text containing a fake `sk-...` key comes back redacted; `forget` removes the
   item and its search rows; a read-only connection cannot save.
5. `POST /api/ingest/conversation` twice with the same `external_id`: the second call must
   update, not duplicate. Then `search` must find a word from a message.
6. Add unit tests (vitest is installed) for `redact.ts` and the project matcher in
   `store.ts`. Check that ordinary code such as `token = getToken()` is not redacted.

## Phase 2 notes (2026-11-12)

- Connector address must end in `/mcp`. Entered without it, Claude's server check says
  "Not found", the sign-in settings cannot be discovered, and the flow breaks.
- A password manager's fill-and-submit arrow on the consent page may submit the form twice;
  the second submit fails with "This authorization was not started in this browser". Fill the
  field, then click Allow once. (Likely cause, not confirmed.)
- Left to itself, Claude may answer "recall the X project" by searching past chats instead of
  calling the hub. Naming the tool, or the custom instruction in the README, fixes it.

## Later phases

**Phase 2: deploy and connect Claude.** Steps are in the README. Add to Claude's custom
instructions: "Use Legendary Memory: recall a project before working on it and save a
checkpoint when we finish a session."

**Phase 3: ChatGPT.** Developer mode is documented for Plus, but one dated report (August
2026) found a Plus account completing sign-in and then listing no tools. Test before
building further on it. Expect friction that cannot be removed from our side: Developer
mode and the app must be selected in each new chat, and saves ask for confirmation each
conversation. If Plus cannot run the tools, ChatGPT falls back to the extension (phase 5)
for capture and a paste button for recall.

**Phase 4: import.** `importer/` (no dependencies) reads the official export ZIPs, folders
or `conversations.json` files and posts each chat to `/api/ingest/conversation`. ChatGPT's
tree is walked from `current_node` so abandoned branches are dropped; hidden, empty and
tool messages are skipped; long chats are split into several requests. Dry run by default;
`--apply` needs `BRIDGE_API_KEY` in the environment and the same secret on the hub. Tested
with 11 unit tests and a local import of made-up exports (zip and folder, a 3,100-message chat,
a rerun with no duplicates, wrong and missing key). Not tested on real exports, whose formats
were checked only against public descriptions; expect small surprises on the first real run
and use `--limit 5` first. Still to do: a proposed sorting of chats into projects for you to
approve (neither export says which project a chat belonged to, and Claude's reportedly omits
Projects), and moving each app's built-in memory in by asking it to list what it remembers
and saving that with `remember`.

**Phase 5: browser extension.** A WebExtension (works in Zen/Firefox and Chrome) that reads
the open chat on chatgpt.com, claude.ai and gemini.google.com from the page and posts it to
the hub in the background, plus an "insert project context" button for Gemini and for
ChatGPT if needed. It reads only what the page shows; it does not call the apps' private
APIs. Page layouts change, so expect occasional fixes.

**Phase 6: polish.** A small dashboard to view, edit and delete memories; a one-way mirror
of briefs into the Obsidian vault as Markdown; vector search and artifact version history
if needed. Optional: Gemini's free API as a swappable summarizer for bulk import. Its free
tier may use requests to improve Google's products, so keep sensitive chats out of it.

## Limits to be upfront about

- The ChatGPT iPhone and iPad apps cannot use custom connectors. Chats made there reach the
  hub only when opened later on the Mac (extension) or through an export.
- Claude on mobile uses a connector only after it has been added on the web.
- Capture is not fully automatic without the extension: the assistant has to call
  `save_checkpoint`, which it does when asked or when custom instructions tell it to.
