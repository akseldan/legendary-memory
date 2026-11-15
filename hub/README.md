# legendary-memory

One memory shared across your AI assistants (Claude, ChatGPT, Codex, Cursor, Windsurf,
Gemini CLI). Save a checkpoint in one app, recall it in another. It runs on your own
computer with no account, on your own server, or on Cloudflare's free plan, and your data
stays with you.

Needs Node.js 22.20 or newer.

```sh
git clone https://github.com/akseldan/legendary-memory && cd legendary-memory/hub
npm install && npm start
```

This opens a welcome page that finds the AI apps on your computer and connects the ones you
pick. Prefer the terminal?

```sh
legendary-memory setup --dry-run   # show what would change
legendary-memory setup             # connect installed apps
legendary-memory setup --undo      # take it out again
```

`setup` keeps everything else in each app's settings and saves a copy of the file first.
Your memory is one file, `~/.legendary-memory/memory.db`. Back it up by copying it.

Other commands: `serve` (local HTTP), `host` (your own server, with the memory view behind
a passphrase), `copy` (move memory between a file, a server and Cloudflare; report-only
unless you pass `--apply`), `info` (settings to paste into any other MCP app).

Source, docs and the Cloudflare version: https://github.com/akseldan/legendary-memory
MIT license.
