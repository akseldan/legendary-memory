# Legendary Memory: plan

Updated 2026-11-15. This is the working plan and the handoff document. Whoever picks the
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
8. **Added 2026-11-15: usable by anyone, and sellable.** No second account to create (no
   "first sign up for Cloudflare"). It should feel like it lives on your computer, or on a
   server you own.

## The one constraint nothing removes

claude.ai, the Claude phone apps and ChatGPT do not talk to your computer. Their company's
servers call your memory over the internet, so for those apps the memory needs a public
https address. That leaves exactly three places a memory can live:

| | Where it lives | Works with | What the user needs |
|---|---|---|---|
| **1. Your computer** | One file in your home folder | Desktop apps: Claude Desktop, Claude Code, Cursor, Windsurf, Gemini CLI, other MCP apps | Nothing. No account, no address. |
| **2. Your own server** | A machine you run (home server, VPS, or your own Cloudflare) | Everything, including phone and web | A way to give it an https address: a domain, or a tunnel |
| **3. Hosted for you** | A service someone runs (not built yet) | Everything, including phone and web | Signing in to that service, nothing else |

No design gets phone and web apps without one of 2 or 3. So the product is: make each of
the three as painless as it can be, keep them the same code, and let people move from one
to the next without losing anything.

## What is sold

The code is MIT and stays free. Options 1 and 2 are free forever; they are also the
marketing. What can be sold is **option 3, the hosted service** ("Legendary Memory Cloud"):
people who want their phone and web apps connected and do not want to run a server pay a
small subscription. This is the usual shape for open-source tools (Obsidian Sync,
Bitwarden, Plausible).

- Price anchor: MemoryPlugin charges $89 a year (Core) and $180 a year (Pro). Basic
  Memory is free locally and from $15 a seat per month hosted. A plain $4 to $5 a month or
  about $40 a year would undercut both.
- Cost to run: each user is a few megabytes of text and a handful of requests a day. On
  Cloudflare that is cents per user per month; the real cost is support and responsibility
  for other people's data.
- Skill marketplaces (the Agensi email): list the skill in `skills/` for free, for reach.
  Do not try to sell an open-source skill; anyone can copy it from the repo.

Do not charge anyone until all of these are true:

1. Ten people other than the owner use the free local version for two weeks and still use it.
2. ChatGPT is proven to work for a normal Plus account (phase 3), or the pitch is honestly
   "for Claude and coding tools".
3. The hosted service has: sign-in, per-user isolation, export, delete-my-account, a
   privacy policy and terms, and a payment provider that handles sales tax (a merchant of
   record such as Lemon Squeezy, Paddle or Polar).

## Where things stand

| Phase | What | Status |
|---|---|---|
| 1 | Hub: storage, tools, sign-in, importer API | **Done.** 40 end-to-end checks, 31 unit tests. |
| 1b | Shared core, local target, Cloudflare target | **Done 2026-11-12.** |
| 2 | Deploy to the owner's Cloudflare, connect Claude | **Done 2026-11-12.** Works from Claude on Mac and iPhone. Production lockout check still open. |
| 3 | Connect ChatGPT (web), confirm Plus runs the tools | Not started. **Biggest open risk, see Risks.** |
| 4 | Import existing history from exports | Importer written and tested on made-up exports. Optional one-time backfill; not run on real exports. |
| 5 | Browser extension for automatic capture | Not started. Needs the owner present to test. |
| 6 | Obsidian mirror | Done 2026-11-12. Not yet run on the real vault. |
| 7 | **One-command install** (`legendary-memory setup`) | **Done 2026-11-15, tested against made-up app folders (18 checks). Not yet tried with the real apps.** |
| 8 | **Run it on your own server** (`legendary-memory host`, Docker) | **Done 2026-11-15. Passes the same 40-check suite as Cloudflare plus 13 of its own. Docker image not built or run yet. Not yet tried with real Claude or ChatGPT.** |
| 9 | **One-click Claude Desktop install** (`.mcpb`) | **Bundle builds and validates. Never installed in Claude Desktop.** |
| 10 | **Skill** (`skills/legendary-memory/SKILL.md`) | **Written. Not yet loaded in an agent.** |
| 11 | Publish: npm, GitHub release, directories | Not started. Needs the owner's npm account. |
| 12 | Copy a memory between homes (local, own server, cloud) | Not started |
| 13 | Dashboard to view, edit and delete memories | Not started |
| 14 | Hosted service | Design sketch only (below) |

Every suite passes as of 2026-11-15, from `hub/`: `npm run test:all` (types, 31 unit, local
26, host 13 including the shared 40, setup 18); importer 11 and mirror 6 from the repo root.
The Cloudflare e2e (`npm run e2e` against `wrangler dev`) was rerun too: 40 of 40. The only
change to Cloudflare code is one optional setting (`DISABLE_CIMD`), unset there.

## Next steps, in order

**A. Try the new pieces for real (owner at the Mac, about an hour).**
Things only a real app can prove, cheapest first:

1. `cd hub && npm install && npm run build:local && node dist/legendary-memory.mjs setup --dry-run`,
   then without `--dry-run`. Check Claude Desktop and Claude Code list the tools. Note: this
   local memory is a *separate, empty* memory from the owner's Cloudflare hub. Use it to
   test the install, then `setup --undo`, or the two will be confused with each other.
2. `npm run pack:mcpb`, double-click `dist/legendary-memory.mcpb`. Unknown: whether the
   Node.js inside Claude Desktop is 22.13 or newer. If it is older the extension fails to
   start with a clear message, and the fix is to ship a small SQLite fallback.
3. Phase 3: connect ChatGPT to the existing Cloudflare hub. Does a Plus account see the
   tools, and can it *save*? This decides how ChatGPT is pitched.
4. `host` behind a tunnel: start a tunnel, start `host --url <tunnel address> --behind-proxy`,
   add it to Claude as a connector. Proves the own-server path with a real app.

**B. Publish 0.3 (owner, 15 minutes, do this early).**
Reserve the npm name `legendary-memory` (free on 2026-11-15) by publishing: remove
`"private": true` in `hub/package.json`, `npm publish`. Until then no instruction anywhere
says `npx legendary-memory`, because whoever registers the name first controls what that
command runs. After publishing, the install line for everyone becomes
`npx legendary-memory setup`. Attach the `.mcpb` to a GitHub release.

**C. Copy a memory between homes (phase 12).**
`legendary-memory copy --from <hub> --to <hub>` built on the existing `/api/export` and
`/api/ingest`. This is what makes "start local, add your phone later" real, and it is the
on-ramp to the hosted service. Also the cure for the owner's own split between local and
Cloudflare memories.

**D. Automatic capture (phase 5, browser extension).** Unchanged from before. Matters more
if phase 3 shows ChatGPT Plus cannot save: then the extension is how ChatGPT work gets in.

**E. Dashboard (phase 13).** A page served by `serve` and `host` to read, edit and delete
what is stored. People will not trust, or pay for, a memory they cannot see.

**F. Hosted beta (phase 14).** Only after A to C. Free, invite-only, ten users.

**G. Charge.** Only after the checklist under "What is sold".

## Hosted service: design sketch

Not built. Written down so the pieces above are shaped to fit it.

- **Isolation: one database per user, not one shared table.** On Cloudflare, a Durable
  Object per user with its own SQLite storage; the core already talks to a five-method
  `Db` interface, so this is a third adapter next to D1 and `node:sqlite`. A bug in a query
  then cannot leak one person's memory to another. (Check current Durable Object SQLite
  limits and pricing before building.)
- **Sign-in without a new password:** an emailed link or a passkey. The existing consent
  page ("which app is asking, allow or deny") stays; the passphrase box becomes the sign-in.
- **The user's address:** one shared connector address for everyone; the sign-in decides
  whose memory it is. Nothing personal in the URL.
- **Promises that have to be true from day one:** export everything (the mirror and
  `/api/export` already do this), delete the account and all data, never read user content
  for any purpose, never log it (already the rule in the hub).
- **A cheaper variant worth considering first: relay only.** The memory stays on the user's
  computer running `host`; the service only gives it a stable public address and forwards
  traffic, storing nothing. Much less responsibility, but the computer must be on. Could be
  the free tier, with hosted storage as the paid one.

## Risks, plainly

1. **ChatGPT may not let Plus accounts save.** OpenAI's own pages disagree on whether
   personal plans get write tools in Developer mode, and several 2026 write-ups report
   Plus as read-only or flaky. Custom connectors are web only (no phone app), must be
   switched on per chat, and are not used by agent mode. If Plus cannot save, ChatGPT
   becomes "recall works, saving goes through the extension". Test before building more.
2. **Built-in memory keeps improving.** Claude and Gemini can now import memory from other
   apps. What they do not do is hold a *project's state* (brief, decisions, next steps,
   files) that any assistant can pick up. Keep the product about that, not about facts.
3. **Others are ahead on reach.** MemoryPlugin reports about 8,000 users and covers 20+
   apps through a browser extension. Basic Memory owns "local Markdown files". Mem0 and
   Supermemory sell to developers. An opening: none of them lead with cross-assistant
   project handoff, and one 2026 comparison says Mem0 removed its local server in July
   (other write-ups still list it, so check before leaning on that).
4. **Hosting other people's chats is a real responsibility:** a leak would be personal for
   every user. Local-first keeps most users out of your custody; the relay variant keeps
   all of them out.
5. **MIT lets anyone sell hosting of this code.** AGPL (what Basic Memory uses) would make
   a competitor publish their changes. Changing license is easy now, with one author, and
   hard later.
6. **One maintainer.** Web-page layouts (extension) and app config formats (`setup`) change
   and break things. Keep the surface small.

## Decisions for the owner

- License: stay MIT or move to AGPL before anyone else contributes.
- Whether to run a hosted service at all, or keep this a free tool (it is already a strong
  portfolio project for the internship search either way).
- If hosted: relay-only first, or stored memory first.
- Reply to Agensi: nothing to do until B is done; then a free listing of the skill.

## Architecture

### Three targets, one core

The project is open source, so it cannot require every user to make a Cloudflare account.
The memory logic therefore sits in `hub/src/core/` and talks to a tiny `Db` interface
(`prepare/bind/first/all/run/batch`, which is the subset of D1 the store uses). Three thin
targets plug into it:

- **`src/local/`**: Node 22.5+, `node:sqlite` (built in, no native add-on), one file at
  `~/.legendary-memory/memory.db`. Entry points: stdio MCP for Claude Desktop and Claude
  Code (no auth, nothing leaves the machine) and an HTTP server bound to 127.0.0.1 with a
  random key and a Host-header check, for the importer and extension. Built into one file
  with esbuild (`npm run build:local`).
- **`src/cloudflare/`**: the Worker, OAuth sign-in page, and D1/KV bindings. One way to
  serve claude.ai, Claude mobile and ChatGPT web, which can only reach a public address.
- **`host` (in `src/local/host.ts`, added 2026-11-15)**: the other way. It runs the
  Cloudflare target's request handler unchanged on Node: same sign-in library, same consent
  page, same routes. Only storage differs: `memory.db` for data and a small SQLite
  key-value file (`sign-in.db`, `src/local/kv.ts`) where Cloudflare uses KV. Joined at
  build time by two esbuild aliases (`hub-worker`, and a one-line stand-in for
  `cloudflare:workers`), so each side keeps its own type-checking. Plain HTTP on
  127.0.0.1:8787; HTTPS comes from a proxy or tunnel in front. `Dockerfile` and
  `docker-compose.yml` (with Caddy) are at the repo root; see `docs/SELF-HOST.md`.

All read the same `migrations/`.

Differences in `host`, on purpose:

- Apps are not verified by fetching their metadata document (CIMD is off). That fetch is
  only safe where outbound requests cannot reach private addresses, which Cloudflare
  guarantees and a home network does not. Apps register themselves instead, limited to the
  allowed redirect hosts. To confirm with real Claude and ChatGPT.
- The address used for the wrong-passphrase limit is the connection's own address, or the
  last `X-Forwarded-For` entry with `--behind-proxy`. A caller cannot choose it.
- It will not start without a 12+ character passphrase, or with a public `http://` address.

`setup` (`src/local/setup.ts`): copies the bundle to `~/.legendary-memory/bin/` and adds a
`legendary-memory` entry to the config of each installed app (Claude Desktop, Cursor,
Windsurf, Gemini CLI by JSON file; Claude Code through its own `claude mcp add`). It only
touches installed apps, keeps everything else in the file, saves a
`.before-legendary-memory` copy, leaves files it cannot parse alone, and has `--dry-run`
and `--undo`. It writes the full path of the Node binary, because apps started from the
Dock do not see a shell's PATH.

Behavioral notes: the core's search uses FTS5, present in both D1 and `node:sqlite`.
`crypto.subtle.timingSafeEqual` (Workers only) was replaced with a portable comparison.
The local stdio target learns the client's name from `initialize` to label saved sessions.

Old single-target diagram, still accurate for the Cloudflare target:

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
auth is not hand-rolled). The one custom piece is the consent page in `src/cloudflare/auth.ts`: it
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

### Tools (`hub/src/core/mcp.ts`)

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
- `src/core/redact.ts` strips API keys, tokens, private keys, password assignments, card numbers
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

## Phase notes (details for phases 2 to 6, written 2026-11-12)

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
of briefs into the Obsidian vault as Markdown (done: `mirror/`, see below); vector search and artifact version history
if needed. Optional: Gemini's free API as a swappable summarizer for bulk import. Its free
tier may use requests to improve Google's products, so keep sensitive chats out of it.

## Merge and mirror notes (2026-11-12)

- `refactor/local-first-core` was merged with `main` (they had diverged: main had the
  importer and phase 2 notes). Only the README and this plan conflicted. After the merge:
  Cloudflare e2e 40/40, unit 31/31, local 26/26, importer 11/11.
- The importer now accepts `http://` for localhost, 127.0.0.1 and [::1] only, so it can
  feed the local hub. Tested: a fake export imported into the local hub, rerun without
  duplicates, and `http://localhost.evil.com` rejected.
- Imported chat messages are now indexed under the chat's own start date, not the import
  time, so search shows when a chat really happened.
- `mirror/` (no dependencies) pages through `/api/export` and writes Markdown into
  `<vault>/Legendary Memory/`. It owns only files whose first frontmatter line is
  `legendary-memory: mirror`; any other file at the same path is skipped, never replaced,
  and nothing outside its folder is touched. Writes only changed files, so Obsidian and
  iCloud sync see no churn. Tested: 6 unit tests, plus a local-hub run covering a dry run,
  skipping a hand-written note, a no-change rerun, removal after `forget`, empty-folder
  cleanup and a wrong key. Dates are UTC, so a late-evening save in Tacoma shows the next
  day.
- Not done: running it automatically. On the Mac a launchd job or Shortcuts automation could
  run it hourly; left for when the manual run has been tried on the real vault.

## Limits to be upfront about

- The ChatGPT iPhone and iPad apps cannot use custom connectors. Chats made there reach the
  hub only when opened later on the Mac (extension) or through an export.
- Claude on mobile uses a connector only after it has been added on the web.
- Capture is not fully automatic without the extension: the assistant has to call
  `save_checkpoint`, which it does when asked or when custom instructions tell it to.
