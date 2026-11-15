# legendary-memory

One memory shared across your AI assistants. Start a project in ChatGPT, then tell Claude
"recall the cooling project" and it picks up where you left off.

It is a small program you own. Run it on your own computer with no account at all, on a
server of your own, or on Cloudflare's free plan. Your data stays with you in every case.

> **Status (0.3, November 2026):** the Cloudflare version is in daily use with Claude on
> Mac and iPhone. The one-command local install and the run-it-on-your-own-server version
> pass their tests but have not been tried with the real apps yet. ChatGPT is not connected
> yet. See [docs/PLAN.md](docs/PLAN.md).

## Pick where your memory lives

| | Your computer | Your own server | Your Cloudflare account |
|---|---|---|---|
| Account needed | None | None (a domain or a tunnel for the address) | Free Cloudflare account |
| Setup | `legendary-memory setup` | `docker compose up -d` | `wrangler deploy` |
| Claude Desktop, Claude Code, Cursor, Windsurf, Gemini CLI | Yes | Yes | Yes |
| claude.ai, Claude on iPhone/iPad, ChatGPT (web) | No | Yes | Yes |
| Works with your computer off | No | Yes, if the server is on | Yes |
| Where the data is | One file in your home folder | One file on your server | Your Cloudflare database |

Web and phone apps connect from the internet, so they can only reach a memory that has a
public https address. That is the only reason the second and third columns exist. The
memory logic is the same code in all three.

## Quick start: on your computer, no account

Needs [Node.js](https://nodejs.org) 22.13 or newer.

```sh
git clone https://github.com/akseldan/legendary-memory && cd legendary-memory/hub
npm install && npm run build:local
node dist/legendary-memory.mjs setup --dry-run   # shows what it would change
node dist/legendary-memory.mjs setup             # connects the AI apps it finds
```

`setup` adds Legendary Memory to Claude Desktop, Claude Code, Cursor, Windsurf and Gemini
CLI if they are installed. It keeps everything else in their settings, saves a copy of each
file before changing it, and `setup --undo` takes it out again. Restart the app, then say
"save a checkpoint for this project" in one and "recall the ... project" in another.

Claude Desktop only: `npm run pack:mcpb` builds `dist/legendary-memory.mcpb`, which installs
with a double-click.

Your memory is the file `~/.legendary-memory/memory.db`. Back it up by copying it.

## How it works

- **The hub** (`hub/`) stores a living brief per project, session notes, saved files, facts
  about you, and your chat history, with search over all of it.
- **Claude and ChatGPT** connect to the hub as a connector or local tool and get seven tools: `recall`,
  `search`, `read`, `save_checkpoint`, `save_artifact`, `remember`, `forget`.
- **An importer** loads your old chats from each app's data export. A browser extension for
  automatic capture is planned.

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
  src/local/       your computer or server: SQLite file, the `setup`, `stdio`, `serve` and
                   `host` commands
  src/cloudflare/  Cloudflare target: Worker, OAuth sign-in page, D1 and KV bindings
                   (`host` reuses this handler and sign-in page as they are)
  migrations/      database schema (shared by both targets)
importer/          loads ChatGPT and Claude data exports into the hub
mirror/            copies your memory into an Obsidian vault as Markdown
skills/            a skill that teaches an agent when to recall and what to save
packaging/mcpb/    one-click Claude Desktop install
Dockerfile, docker-compose.yml   run it on your own server
docs/PLAN.md       product plan, architecture, decisions, phases
docs/SELF-HOST.md  running it on your own server
```

## Other local commands

- `legendary-memory info` prints where your data is and settings to paste into an app by hand.
- `legendary-memory serve` starts a server on `127.0.0.1:8787` for tools on this computer
  (the importer, the mirror, the future browser extension). It needs the key `info` prints
  and refuses requests that are not addressed to localhost.

## Run it on your own server (for phone and web apps)

`legendary-memory host` serves the same memory with a sign-in page, so claude.ai, Claude on
your phone and ChatGPT can connect. With Docker and a domain name:

```sh
printf 'DOMAIN=memory.example.com\nPASSPHRASE=at-least-twelve-characters\n' > .env
docker compose up -d
```

Then add `https://memory.example.com/mcp` as a custom connector. No domain? A tunnel works
too. Both routes, and running it without Docker, are in [docs/SELF-HOST.md](docs/SELF-HOST.md).

## Or host it on Cloudflare

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

**Local hub instead of Cloudflare:** run `npm run local` in `hub/`, use the key that
`node hub/dist/legendary-memory.mjs info` prints as `BRIDGE_API_KEY`, and pass
`--url http://127.0.0.1:8787`. Plain `http://` is only accepted for this computer.

## Mirror into Obsidian

Copies your projects, session notes, saved files and facts about you into your vault as
Markdown, so you can read and link them in Obsidian. One way only: the hub is the source,
and the next run overwrites edits made in the vault.

```sh
export BRIDGE_API_KEY='<the same key as the importer>'
node mirror/mirror.mjs ~/path/to/YourVault --url https://<your-url> --dry-run   # preview
node mirror/mirror.mjs ~/path/to/YourVault --url https://<your-url>
```

It writes only inside `YourVault/Legendary Memory/` (change with `--folder`): one note per
project, an `Artifacts/` folder per project, `Projects.md` and `About me.md`. Each note it
writes starts with a `legendary-memory: mirror` line; it never replaces or deletes a note
without that line, so your own notes are safe even inside that folder. Rerun whenever you
like; unchanged notes are left alone, and notes for deleted projects or files are removed.

## Security

- Only someone with your passphrase can connect an app. Five wrong tries pauses sign-in for
  15 minutes.
- Passwords, API keys, tokens and card numbers are stripped from text before it is saved.
- What the hub returns is labelled as stored data so a saved note cannot pose as an
  instruction to the AI.
- This repo holds code only. Your memories live on your computer or in your Cloudflare account, never here.
- The local HTTP server listens on 127.0.0.1 only, requires a random key, and rejects non-local Host headers.
- `host` refuses to start without a passphrase of 12+ characters or with a public address
  that is not https, and counts wrong passphrases by the caller's real address.

## License

MIT
