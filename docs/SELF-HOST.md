# Run Legendary Memory on your own server

`legendary-memory host` is the full hub on a machine you control: the tools, the sign-in
page and the importer API. Use it when you want claude.ai, Claude on your phone or ChatGPT
to reach your memory and you would rather not use Cloudflare.

> Status: passes the same end-to-end tests as the Cloudflare version. Not yet tried with
> the real Claude and ChatGPT apps, and the Docker image has not been built yet. Expect to
> report a first-run problem or two.

What it needs from you:

- **A passphrase** of 12 or more characters. You type it on the sign-in page each time you
  connect an app. Anyone who has it can read and change your memory, so make it long.
- **An https address** that reaches the machine. AI apps refuse plain http. Three ways to
  get one are below.

The server itself only speaks plain http on port 8787 and, unless told otherwise, only
listens on the machine it runs on. Something in front of it supplies https.

## Option A: Docker with your own domain

Point a domain (or subdomain) at the server and open ports 80 and 443. From the repository
root:

```sh
printf 'DOMAIN=memory.example.com\nPASSPHRASE=at-least-twelve-characters\n' > .env
docker compose up -d
```

Caddy fetches and renews the certificate. Your memory is in the `memory-data` volume; back
it up with `docker compose cp memory:/data ./backup`.

## Option B: a tunnel, no domain and no open ports

Run the hub on any computer at home and let a tunnel give it an address.

- **Tailscale Funnel** gives a stable `https://<machine>.<your-tailnet>.ts.net` address on
  the free personal plan (needs a Tailscale account):
  ```sh
  tailscale funnel 8787
  LEGENDARY_MEMORY_PASSPHRASE='...' node hub/dist/legendary-memory.mjs host \
    --url https://<machine>.<your-tailnet>.ts.net --behind-proxy
  ```
- **A Cloudflare quick tunnel** needs no account at all, but the address changes every
  time it restarts, and each new address has to be added to your apps again. Good for a
  try-out, not for daily use:
  ```sh
  cloudflared tunnel --url http://localhost:8787     # prints a trycloudflare.com address
  LEGENDARY_MEMORY_PASSPHRASE='...' node hub/dist/legendary-memory.mjs host \
    --url https://<printed-address> --behind-proxy
  ```

The computer has to be on and awake for your phone to reach the memory.

## Option C: without Docker, behind your own proxy

```sh
cd hub && npm install && npm run build:local
LEGENDARY_MEMORY_PASSPHRASE='...' node dist/legendary-memory.mjs host \
  --url https://memory.example.com --behind-proxy
```

Point nginx, Caddy or another reverse proxy at `127.0.0.1:8787`.

## Connect your apps

Add `https://<your-address>/mcp` as a custom connector (the `/mcp` is required). The app
opens your sign-in page; check it names the app you expect, type the passphrase, Allow.

## Settings

| Flag | Environment variable | Meaning |
|---|---|---|
| `--url` | `LEGENDARY_MEMORY_URL` | The public https address. Required. |
| | `LEGENDARY_MEMORY_PASSPHRASE` | Your passphrase. Or put it in a file named `passphrase` in the data folder. |
| `--behind-proxy` | `LEGENDARY_MEMORY_BEHIND_PROXY=1` | Say so when a proxy or tunnel forwards the requests, so the wrong-passphrase limit counts real visitors. Leave it off when nothing is in front. |
| `--port` | `PORT` | Default 8787 |
| `--bind` | `LEGENDARY_MEMORY_BIND` | Default `127.0.0.1`. The Docker image uses `0.0.0.0`. |
| | `LEGENDARY_MEMORY_DIR` | Data folder. Default `~/.legendary-memory` (`/data` in Docker). |
| | `LEGENDARY_MEMORY_REDIRECT_HOSTS` | Apps allowed to sign in. Default: Claude, ChatGPT and localhost. |

The data folder holds `memory.db` (your memory), `sign-in.db` (which apps are connected)
and `api-key` (for the importer and the Obsidian mirror). Copy `memory.db` to back up.
Deleting `sign-in.db` disconnects every app without touching your memory.

## How it differs from the Cloudflare version

Same code for the tools and the sign-in. Two deliberate differences: apps identify
themselves by registering, not by a metadata document the server would have to fetch
(that fetch is unsafe on a home network), and the wrong-passphrase limit (five tries per
address, forty overall, per fifteen minutes) uses the connection's address or, with
`--behind-proxy`, the address your proxy reports.

## See and edit your memory in the browser

Open your server's address (the same one apps use, without `/mcp`) in a browser and type the
passphrase you set. You get the same page as `legendary-memory start`: your projects, a search
box, and the options to edit a brief or delete a project or session. The passphrase gives you a
cookie that lasts 12 hours, lives only in that browser, and ends when you sign out or change the
passphrase. Five wrong passphrases from one address lock sign-in for fifteen minutes (this
counter is shared with the app sign-in page). The page never accepts the API key or an app's token.
