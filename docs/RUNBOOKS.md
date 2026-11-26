# When something goes wrong

Step-by-step fixes for the owner of a Legendary Memory hub. Each runbook says how to tell it's happening, what to do first, and how to check the fix worked.

The commands assume:
- the hub source is at `~/legendary-memory/hub`
- the program is at `~/.legendary-memory/bin/legendary-memory.mjs`
- Cloudflare commands run from `~/legendary-memory/hub` with `npx wrangler …`

`HUB` stands for your hub's address. Never paste a key, passphrase or token into a chat with an assistant.

Written 2026-11-26 (execution plan P9.4.2). Review it whenever a command or page changes.

---

## 1. A connected app or its sign-in may be stolen
**Signs:** saves you didn't make appear under **Activity** on the memory page. An app shows a last use you don't recognize on `HUB/connections`. A phone or laptop with a connected app was lost.

1. Open `HUB/connections` and click **Disconnect** on that app, or on every app if you're unsure. The next call from it is refused.
   - Cloudflare may let it through for up to about a minute in other regions.
2. If the *importer key* may be exposed (the key used for backups and chat imports): `npx wrangler secret put BRIDGE_API_KEY` with a new random value. Then update `~/.legendary-memory/cloudflare-api-key` to match.
3. If your *passphrase* may be exposed: `npx wrangler secret put OWNER_PASSPHRASE` with a new one. Changing it signs out every memory-page session.
4. Check **Activity** for what the app did, then go through runbook 3 for anything it saved or changed.
5. Reconnect the apps you trust. Each one asks for the passphrase again.

**Check:** a call from the disconnected app fails with "invalid_token". Activity shows no new entries from it.

## 2. Your Cloudflare or GitHub account is taken over
**Signs:** login alerts, changed settings, a deploy you didn't make, or the hub address answering with something else.

1. Recover the account through the provider: reset the password, remove unknown sessions and API tokens, and turn on two-factor sign-in with an authenticator app or passkey.
2. Treat every secret as exposed. Do runbook 1, steps 2–3. Remove and re-add the hub's custom connector in each app.
3. Compare the hub with your newest local backup:
   ```
   LEGENDARY_MEMORY_FROM_KEY="$(cat ~/.legendary-memory/cloudflare-api-key)" legendary-memory backup --from HUB --to ~/.legendary-memory/backups/after-takeover.db
   ```
   Then compare the two `.manifest.json` files. Different table hashes mean the data changed.
4. If data was damaged or deleted, use runbook 6 or restore from your own backup with runbook 4.
5. GitHub: check the repository's recent commits, releases and Actions secrets. Re-download the installer only from a release whose checksum you've verified.

**Check:** the memory hash after recovery matches a backup you trust.

## 3. Wrong or planted information is in the memory
**Signs:** an assistant repeats something false, or an Activity entry shows a save you don't recognize.

1. Search for it on the memory page. Delete the session or fact, or use **Correct** on a fact.
2. Look at **Activity** around the time it was saved to see which app saved it. If you didn't ask that app to, follow runbook 1 for it.
3. Ask an assistant to recall the project. Stored text is always marked as reference data, but a model can still be misled, so confirm the false item is gone.

**Check:** searching for the wrong text finds nothing.

## 4. The hub is down or Cloudflare has an outage
**Signs:** apps report connection errors, and `HUB/api/health` doesn't answer. The Cloudflare status page shows an incident.

1. Nothing is lost. The hub's database stays with Cloudflare, and you have local backups.
2. To keep working now, restore your newest backup to a separate local memory, then use it in Claude Desktop through the extension:
   ```
   legendary-memory restore --from ~/.legendary-memory/backups/<newest>.db --to ~/lm-outage/memory.db
   LEGENDARY_MEMORY_DIR=~/lm-outage legendary-memory start
   ```
   Or paste a project's **Handoff (Markdown)** from an earlier download into any assistant.
3. When the hub is back, merge what you saved locally:
   ```
   LEGENDARY_MEMORY_TO_KEY="$(cat ~/.legendary-memory/cloudflare-api-key)" legendary-memory copy --from ~/lm-outage/memory.db --to HUB --apply
   ```
   It adds what's missing and never overwrites newer hub data.

**Check:** the recall overview on the hub lists what you saved during the outage.

## 5. An update or migration failed
**Signs:** a deploy script stops with an error, or the hub answers with errors right after an update.

1. The deploy scripts stop at the first error. If the database step failed, the hub is still running the old code against the old data, and nothing else changed.
2. If the new code is live and misbehaving: run `npx wrangler rollback` to go back to the previous version.
3. If the data looks wrong after a migration, roll the database back to the bookmark the script saved:
   ```
   npx wrangler d1 time-travel restore legendary-memory --bookmark <from ~/.legendary-memory/backups/pre-deploy-*.timetravel.txt>
   ```
   Then roll back the code as in step 2. Deletions made after the bookmark stay deleted, because their records are kept outside the database.
4. Check with a fresh `legendary-memory backup --from HUB`: its manifest should match the pre-deploy backup's.

## 6. Something was deleted by mistake
Deletion is final by design. A record of every deletion is kept so that backups, copies and restores never bring the item back. Undoing it is therefore a deliberate, manual step.

1. Find the item in a backup from before the deletion. Note its kind and reference from the backup or an export:
   - a project's or session's id
   - a fact's key
2. Remove that one record of the deletion in both places it's kept.
   - **Local memory:**
     - Stop any app using it.
     - Delete the matching entry from `~/.legendary-memory/deletions-ledger.json`.
     - Then: `sqlite3 ~/.legendary-memory/memory.db "DELETE FROM deletions WHERE kind='checkpoint' AND ref='<id>'"`
   - **Hub:**
     - `npx wrangler d1 execute legendary-memory --remote --command "DELETE FROM deletions WHERE kind='checkpoint' AND ref='<id>'"`
     - Edit the KV key `lm:deletion-ledger` (`npx wrangler kv key get/put --binding OAUTH_KV --remote`) to drop the same entry.
3. Copy it back: `legendary-memory copy --from <backup.db> --to <local or HUB> --apply`. For the hub, set `LEGENDARY_MEMORY_TO_KEY` to the importer key, as in runbook 4.

**Check:** the item is back in recall and on the memory page.

A command that does steps 2–3 for you is still to be built. Until then, this is the only path.

## 7. Memory full or the disk is nearly full
**Signs:** saves fail with "Memory is full" or a disk warning. Reading, searching, exporting and deleting keep working.

1. Delete or archive what you don't need. Large saved files and old imported chats free the most space.
2. Local memory: run `legendary-memory compact` to give the space back to the disk. You can also raise `LEGENDARY_MEMORY_QUOTA_MB`.
3. Hub: raise the `QUOTA_MB` variable, or move to a paid Cloudflare plan for a larger D1 limit.

---

**Reporting a security problem in Legendary Memory itself:** open a private security advisory on the GitHub repository (Security → Report a vulnerability). Don't post details in a public issue.
