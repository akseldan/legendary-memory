# Legendary Memory — tester sheet

Thanks for trying this. Legendary Memory gives your AI assistants a shared memory that you own: a project you start in one app can be picked up in another.

**Before you start**
- Use made-up information only. Don't save anything real or private.
- This is early software. You can remove it completely at the end (step 9).
- Don't ask the person running the test for help unless you're truly stuck. Getting stuck is useful to us. Saying what you're thinking out loud also helps.
- Takes about 20 minutes. You need a Mac or Linux computer with **Claude Desktop** installed and signed in (the free plan works).

**Steps**
1. **Install.** Open Terminal and paste: `curl -fsSL https://akseldan.github.io/legendary-memory/install.sh | sh`
2. **Start it** with the command the installer printed. A page opens in your browser.
3. **Connect Claude Desktop** from that page, following its instructions. Restart Claude Desktop if it asks you to.
4. **Save something.** In a new Claude chat, make up a small project, for example *"Plan a weekend trip to Lisbon for two, budget €600"*. Talk about it for a minute, then ask Claude to save it to your Legendary Memory.
5. **Pick it up somewhere else.** Quit Claude Desktop completely, reopen it, start a new chat and ask: *"Continue my Lisbon trip from Legendary Memory."* Does it know what you decided?
6. **Fix something.** Ask Claude to remember a made-up fact about you, e.g. *"Remember my favorite color is green."* Then change that fact to blue on the memory page. Ask Claude what your favorite color is.
7. **Hand it off.** On the memory page, download the project's **Handoff**. Paste it into any other assistant (ChatGPT, Gemini…). Can that one carry on?
8. **Take your data with you.** Find out how to export your memory to a file and do it. The page and `legendary-memory --help` can tell you.
9. **Disconnect and remove.** Disconnect Claude Desktop on the memory page, then remove the program (`legendary-memory uninstall`).

**Afterwards, answer briefly**
- Which step was the hardest, and why?
- Was there anything you didn't trust, or that worried you?
- Would you use this for real? What would make you?
