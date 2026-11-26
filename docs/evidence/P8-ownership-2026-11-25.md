# P8 ownership, first slice: evidence (2026-11-25)

Code: PR #15, squash-merged into main as 6af231a. CI ran green on ubuntu and macOS, each with Node 22.20.0 and Node 24.

## What shipped
- **Activity history** (migration 0006). Each tool call or memory-page action records:
  - the time and the app it came from
  - whether it read, saved or deleted
  - the tool, and a reference (a project name, an item ref or `fact:<key>`)
  - whether it worked

  No content and no search words are stored. Entries are kept for 90 days, newest 5,000. The history is not copied, exported, backed up or included in the memory hash (DATA-CONTRACT §1).
- **Memory page**:
  - where the memory lives, the last save, a note on backups, storage used (and the allowance or free disk, where they apply) and connected apps
  - facts listed with Correct and Delete
  - a Markdown handoff for each project, downloaded and also copied to the clipboard
- **Cloudflare hub**: `/` now serves the memory page behind `OWNER_PASSPHRASE`, with the same session and CSRF design as `host`. The page code moved to `src/core` and uses only Web Crypto.

## Tests (local `test:all`: 18 suites, 0 failed)
`test/ui.mjs` gained 20 P8 checks:
- a fact saved by an assistant shows on the page
- a correction needs the key; an empty one is refused
- after a correction, recall returns the new wording and never the old
- the activity history shows the assistant's save, the page's correction and reads
- the history never contains saved text or search words
- the history states its retention
- the handoff is Markdown with the brief and the sessions, needs the key, and returns 404 for an unknown project
- a fact can be deleted

Also changed:
- `test/limits.mjs`: the importer-full check now sends a body as large as the save that was just refused. The check used to depend on how much room the last save happened to leave.
- Worker smoke test with `wrangler dev --local`. After applying migration 0006, a wrong session gets 401 from `/ui/memory`, the passphrase login sets an HttpOnly, SameSite=Strict cookie, and `/ui/memory` returns the summary.

## Deploy to the Cloudflare hub (Daniel ran deploy-p8-2026-11-25.sh)
- Verified backup before the deploy: `pre-deploy-p8-2026-11-25.db`, plus a manifest and a Time Travel bookmark.
- Deployed Worker version 270bd1fa-eee6-4f85-997a-be8073858ccd.
- Backup after the deploy: the per-table manifest is identical to the one before (7 projects, 53 checkpoints, 2 artifacts …). No memory data changed.
- `GET /` answers 200 `text/html` (the memory page).
- A second run of the script stopped safely at step 1 ("Backups never overwrite").

## Follow-ups merged the same evening (#16, #17; no migration)
- **#16:** adds Archive and Unarchive. Archived projects go to the end of the page and are left out of the recall overview, which says how many are archived. Recalling one by name still works. The backup note is shorter, and the duplicate "Kept in" line is gone.
- **#17, accessibility:**
  - Ran axe-core 4 with the WCAG 2.2 AA and best-practice rules on the signed-in page, at 375 and 1280 px, in light and dark mode: 0 violations in all four.
  - A keyboard pass in Chrome found that focus fell back to the page itself after every change. It now returns to the same control.
  - A polite live region announces each change (checked: "Saved: favorite editor is now "Neovim"."; "Cooling System archived. It moved to the end of the list.").
  - A delete question takes focus, and Cancel returns focus to the Delete button.
  - Project rows read as "Name, status, updated …".
  - Each session's Delete button names its session.

## Pending
- Daniel checked the live page after #15: the Activity list shows entries and the handoff downloads. Still to do: a VoiceOver pass on a real Mac, after #16 and #17 are deployed.
- Not built yet: earlier wordings of a corrected fact (open in DATA-CONTRACT §5), storage by category, and first-run polish (P8.3). Fact history was deferred on purpose: no facts are stored yet, and it adds a canonical table that would change exports, copies and the memory hash.
