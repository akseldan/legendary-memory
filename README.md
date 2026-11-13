# legendary-memory

One memory shared across your AI assistants. Start a project in ChatGPT, then tell Claude
"recall the cooling project" and it picks up where you left off.

It is a small server you own. Run it on your own computer with no account at all, or host
it for free on Cloudflare so your phone and web apps can reach it. Your data stays with you
either way.

> **Status:** deployed on Cloudflare and connected to Claude (web, Mac, iPhone); save and
> recall work. The local target passes its tests but has not been tried with the real Claude
> Desktop app yet. ChatGPT is not connected yet. See [docs/PLAN.md](docs/PLAN.md).

## Pick how to run it

| | Local (no account) | Cloudflare (free account) |
|---|---|---|
| Setup | `npm run local`, nothing else | `wrangler deploy` once |
| Claude Desktop, Claude Code | Yes, over stdio | Yes |
| claude.ai, Claude on iPhone/iPad | No | Yes |
| ChatGPT (web) | No | Yes |
| Works with the computer off | No | Yes |
| Where the data lives | One SQLite file on your computer | Your Cloudflare account |

Web apps like claude.ai and ChatGPT connect from the internet, so they can only reach a
server with a public address. That is the only reason the Cloudflare target exists. Anyone
can start local and add Cloudflare later; the memory logic is identical.

## How it works

- **The hub** (`hub/`) stores a living brief per project, session notes, saved files, facts
  about you, and your chat history, with search over all of it.
- **Claude and ChatGPT** connect to the hub as a connector or local tool and get seven tools: `recall`,
  `search`, `read`, `save_checkpoint`, `save_artifact`, `remember`, `forget`.
- **A browser extension and an importer** (not built yet) feed in full chat history.

## What works where

| | Claude | ChatGPT |
|---|---|---|
| Mac (web or desktop app) | Yes | Yes, in the browser, with Developer mode on |
| iPhone and iPad apps | Yes, after adding the connector on the web | No. ChatGPT custom connectors are web only |

## Layout

```
hub/
  src/core/        the memory logic, runtime-agnostic: store (database), mcp (the tools),
                   api (importer endpoints), redact (secret filter), db (the interface)
  src/local/       local target: SQLite file, stdio + localhost HTTP, CLI
  src/cloudflare/  Cloudflare target: Worker, OAuth sign-in page, D1 and KV bindings
  migrations/      database schema (shared by both targets)
docs/PLAN.md       architecture, decisions, phases, test checklist
```

## Run it locally (no account)

Needs Node.js 22.5 or newer.

```sh
cd hub
npm install
npm run build:local
node dist/legendary-memory.mjs info     # prints your data folder and connector settings
```

- **Claude Desktop / Claude Code:** `info` prints the exact lines to paste (a stdio
  command, no sign-in needed because nothing leaves your computer).
- **Other local tools** (importer, browser extension): `npm run local` starts a server on
  `127.0.0.1:8787`. It needs the key `info` prints, and refuses requests that are not
  addressed to localhost.

Your memory is `~/.legendary-memory/memory.db`. Back it up by copying that file.

## Host it on Cloudflare (for phone and web apps)

You need a free Cloudflare account and Node.js 22 or newer.

```sh
cd hub
npm install
npx wrangler login
npx wrangler deploy                       # creates the database and key store, prints your URL
npx wrangler d1 migrations apply DB --remote
npx wrangler secret put OWNER_PASSPHRASE  # 12+ characters; you type this to approve an app
```

Then add `https://<your-url>/mcp` as a custom connector. The address must end in `/mcp`;
without it the app cannot find the server and sign-in fails.

- **Claude:** Customize → Connectors → + → Add custom connector. Then add to Claude's custom
  instructions: "Use Legendary Memory: recall a project before working on it and save a
  checkpoint when we finish a session." Without it Claude may search past chats instead.
- **ChatGPT:** Settings → Security and login → turn on Developer mode, then create an app
  from the + button on chatgpt.com/plugins. In each chat, pick Developer mode from the +
  menu and select the app.

## Import your old chats

Ask each app for its data export (ChatGPT: Settings → Data controls → Export data; Claude:
Settings → Privacy → Export data). You get an emailed link to a ZIP. Then, from this folder:

```sh
# 1. Look first. This only reads the files and prints counts; nothing is sent.
node importer/import.mjs ~/Downloads/chatgpt-export.zip ~/Downloads/claude-export.zip

# 2. One-time: give the hub a key for the importer (32+ characters, keep it in your
#    password manager, never paste it into a chat).
cd hub && npx wrangler secret put BRIDGE_API_KEY && cd ..

# 3. Try a small batch, then everything. Same key in your terminal for this session only.
export BRIDGE_API_KEY='<the same key>'
node importer/import.mjs ~/Downloads/chatgpt-export.zip --apply --limit 5 --url https://<your-url>
node importer/import.mjs ~/Downloads/chatgpt-export.zip ~/Downloads/claude-export.zip --apply --url https://<your-url>
```

Safe to rerun: the same chat is updated, not duplicated. If it stops, rerun with
`--start <n>` as it suggests. Imported chats are searchable straight away but arrive
unfiled, because neither export says which project a chat belonged to. Known secret formats
(API keys, tokens, card numbers) are removed before anything is stored, but ordinary
personal details in your chats are stored as written, in your own Cloudflare account.

## Security

- Only someone with your passphrase can connect an app. Five wrong tries pauses sign-in for
  15 minutes.
- Passwords, API keys, tokens and card numbers are stripped from text before it is saved.
- What the hub returns is labelled as stored data so a saved note cannot pose as an
  instruction to the AI.
- This repo holds code only. Your memories live on your computer or in your Cloudflare account, never here.
- The local HTTP server listens on 127.0.0.1 only, requires a random key, and rejects non-local Host headers.

## License

MIT
