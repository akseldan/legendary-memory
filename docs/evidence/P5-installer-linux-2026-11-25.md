# P5 — installer lifecycle on a clean Linux x64 home — 2026-11-25

`site/install.sh` from draft PR #1, merged onto the full stack (branch `p5-installer`, version
1.1.0). Real Node.js 24.22.3 download from nodejs.org, checked against the pinned SHA-256; the
program served from a local stand-in for the (not yet published) v1.1.0 GitHub release via
`LM_INSTALL_RELEASE_URL`. Empty `HOME`, `env -i` (no Node.js on PATH).

| Step | Result |
|---|---|
| Fresh install | 4 s; adds PATH line to `~/.profile`; no Node.js needed beforehand |
| Installed size | **124 MiB** (runtime 122 MiB, program 2.0 MiB) — target ≤ 150 MiB |
| Use | `legendary-memory version` → 1.1.0; save in one stdio client, recall in another works |
| Update to a new build | under 1 s; runtime reused; program replaced; memory untouched |
| Tampered program (checksum mismatch) | refused, exit 1, installed program unchanged and working |
| Release server gone mid-update | refused, installed program unchanged; no temp files left |
| Re-run with nothing new | "already up to date", nothing downloaded |
| `legendary-memory uninstall` | removes program, runtime and PATH line; **memory.db kept**, says where |
| Reinstall | finds the existing memory; recall works |

Full suite with the installer merged: 19 suites green (installer test 44 checks).
## Linux arm64 (Daniel's MacBook Pro, Claude desktop app's Linux VM)

Same installer from the `p5-installer` branch, release assets from a temporary branch: install 4 s,
**120 MiB**, version 1.1.0, save + search through the installed runtime, uninstall keeps memory.

## Native macOS (Daniel's MacBook Pro, macOS 27.0.1, Apple Silicon)

Run by Daniel with `installer-test-macos.sh` (temp HOME): install 4 s, **119 MiB** (runtime 117 MiB),
PATH added to `.zshrc`, version 1.1.0, save + search through the installed runtime, re-run "already
up to date", uninstall leaves only the memory files. Gatekeeper did not block the private runtime.

## Self-hosting (`host`, what the Docker image runs)

`test/host.mjs` now also checks: a save after restart, a consistent backup taken while the server is
serving, and a new server restored from that backup serves the memory to a newly signed-in app
(16 checks). Restart and refresh-token survival were already covered. The Docker image itself was not
built here (no Docker daemon in the workspace).

## Still to do for P5

- Windows: `install.sh` is POSIX only; the `.mcpb` stays the Windows route until a PowerShell
  installer exists. Not advertised as supported.
- Publish v1.1.0 so the real release URL replaces the test branch; then delete branch
  `installer-test-assets`.
