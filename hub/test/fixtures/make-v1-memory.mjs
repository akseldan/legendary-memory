// Builds test/fixtures/v1-memory.db: a small synthetic memory written by Legendary Memory 1.0.2
// (schema version 1), used by test/search-v2.mjs to prove the upgrade to search index v2.
// Run once with a 1.0.2 build:  node test/fixtures/make-v1-memory.mjs /path/to/1.0.2/legendary-memory.mjs
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const BIN = process.argv[2];
const OUT = fileURLToPath(new URL('./v1-memory.db', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'lm-v1-'));
const KEY = 'v'.repeat(40);
const PORT = 18831;
const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn('node', [BIN, 'serve', '--port', String(PORT)], {
  env: { ...process.env, NODE_NO_WARNINGS: '1', LEGENDARY_MEMORY_DIR: home, LEGENDARY_MEMORY_KEY: KEY },
  stdio: 'ignore',
});
let id = 0;
const tool = (name, args) =>
  fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${KEY}`, 'User-Agent': 'claude-desktop' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
  }).then((r) => r.text());

// Deterministic filler: words, no randomness.
const filler = (n, word = 'filler') => Array.from({ length: n }, (_, i) => `${word}${i % 97}`).join(' ');

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  await tool('save_checkpoint', { project: 'Cooling Rig', title: 'Pick pump', summary: 'Compared pumps for the heatsink loop.', decisions: ['Use the D5 pump because it is quieter'], next_steps: ['Order fittings'], brief: 'Water-cooling build. Goal: quiet under load.' });
  await tool('save_checkpoint', { project: 'Cooking Club', title: 'Kickoff', summary: 'Planned the first meetup: dumplings.', new_project: true });
  // An artifact longer than 8,000 characters with a phrase only after character 8,000.
  await tool('save_artifact', { project: 'Cooling Rig', name: 'build-log.md', content: `${filler(1500)} The fan curve verdict is zircon-quiet at 40 percent. ${filler(400, 'tail')}` });
  await tool('remember', { key: 'editor', value: 'Uses VS Code with Vim keys' });
  const messages = [
    { seq: 0, role: 'user', text: 'Which radiator fits the case?' },
    { seq: 1, role: 'assistant', text: `${filler(1800, 'word')} Answer: the 360 mm radiator marked obsidianfit fits. ${filler(50, 'end')}` },
    { seq: 2, role: 'user', text: 'Пример: насос тихий. 例え: 静かなポンプ 🚀' },
  ];
  const peek = new DatabaseSync(join(home, 'memory.db'), { readOnly: true });
  const projects = peek.prepare("SELECT id FROM projects WHERE name = 'Cooling Rig'").get();
  peek.close();
  const res = await fetch(`${BASE}/api/ingest/conversation`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'claude', external_id: 'v1-chat-1', title: 'Radiator sizing', url: '', started_at: '2026-01-02T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z', project_id: projects.id, messages }),
  });
  if (!res.ok) throw new Error(await res.text());
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
}
const db = new DatabaseSync(join(home, 'memory.db'));
db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE; VACUUM;');
console.log('schema', db.prepare('PRAGMA user_version').get().user_version, 'index rows', db.prepare('SELECT count(*) AS n FROM search_map').get().n);
db.close();
copyFileSync(join(home, 'memory.db'), OUT);
rmSync(home, { recursive: true, force: true });
console.log(`wrote ${OUT}`);
