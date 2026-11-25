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
Still to do for P5: Linux arm64 (Daniel's Mac VM), native macOS (Daniel runs it with a temp HOME),
Windows (not supported by `install.sh`; `.mcpb` remains the Windows route), self-host Docker restart.
