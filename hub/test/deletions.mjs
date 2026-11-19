// Deleted stays deleted (docs/contracts/DATA-CONTRACT.md §6): restoring an older backup, copying
// between homes and re-sent chat history never bring a deleted memory back, and deletions travel
// with copies. Temp folders and a 127.0.0.1 port only. Builds are done by `npm run test:deletions`.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../dist/legendary-memory.mjs', import.meta.url));
const KEY = 'd'.repeat(40);
const PORT = 18861;
const BASE = `http://127.0.0.1:${PORT}`;
const root = mkdtempSync(join(tmpdir(), 'lm-deletions-'));
const homeA = join(root, 'a');
const fileA = join(homeA, 'memory.db');

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `\n         ${String(detail).slice(0, 700)}` : ''}`);
};
const clean = (home) => {
  const env = { ...process.env, NODE_NO_WARNINGS: '1', LEGENDARY_MEMORY_DIR: home, LEGENDARY_MEMORY_KEY: KEY };
  for (const name of Object.keys(env)) if (/^(HUB_URL|BRIDGE_API_KEY|LEGENDARY_MEMORY_FROM)/.test(name)) delete env[name];
  return env;
};
const cli = (args) => {
  const run = spawnSync('node', [BIN, ...args], { encoding: 'utf8', timeout: 60_000, env: clean(join(root, 'cli')) });
  return { all: run.stdout + run.stderr, code: run.status };
};
const count = (file, sql, ...args) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).get(...args).n;
  } finally {
    db.close();
  }
};

let id = 0;
async function tool(name, args) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${KEY}`, 'User-Agent': 'claude-desktop' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
  });
  const parsed = JSON.parse(await res.text());
  return parsed.result?.content?.map((c) => c.text).join('\n') ?? JSON.stringify(parsed);
}
const ingest = (body) =>
  fetch(`${BASE}/api/ingest/conversation`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const chat = { source: 'chatgpt', external_id: 'chat-x', title: 'Pump talk', url: '', started_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', messages: [{ seq: 0, role: 'user', text: 'secretive pump plans' }] };
const ref = (text, kind) => text.match(new RegExp(`${kind}:[0-9a-f-]+`))?.[0];

const server = spawn('node', [BIN, 'serve', '--port', String(PORT)], { env: clean(homeA), stdio: ['ignore', 'ignore', 'pipe'] });
try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log('Before deleting');
  const keep = ref(await tool('save_checkpoint', { project: 'Cooling Rig', title: 'Keep me', summary: 'stays' }), 'checkpoint');
  const drop = ref(await tool('save_checkpoint', { project: 'Cooling Rig', title: 'Drop me', summary: 'zebrafish' }), 'checkpoint');
  const file = ref(await tool('save_artifact', { project: 'Cooling Rig', name: 'plan.md', content: 'walrus plan' }), 'artifact');
  await tool('remember', { key: 'editor', value: 'VS Code' });
  await tool('save_checkpoint', { project: 'Old Project', title: 'Old', summary: 'narwhal' });
  const oldFile = ref(await tool('save_artifact', { project: 'Old Project', name: 'old.md', content: 'narwhal file' }), 'artifact');
  await ingest(chat);
  const old = join(root, 'old.db');
  check('a backup is taken before the deletions', cli(['backup', '--from', fileA, '--to', old]).code === 0);

  console.log('Delete');
  const conv = ref(await tool('search', { query: 'secretive' }), 'conversation');
  for (const r of [drop, file, 'profile:editor', conv, 'project:Old Project']) {
    const out = await tool('forget', { ref: r });
    check(`forget ${r.split(':')[0]}`, /Deleted/.test(out) && /will not come back/.test(out), out);
  }
  const ledger = count(fileA, 'SELECT count(*) AS n FROM deletions');
  check('the ledger lists each deletion, including the project\'s own sessions and files', ledger === 7, ledger);
  check('the ledger holds no content', count(fileA, "SELECT count(*) AS n FROM deletions WHERE ref LIKE '%zebrafish%' OR ref LIKE '%walrus%'") === 0);

  console.log('Restore the older backup into the same memory');
  const restore = cli(['copy', '--from', old, '--to', fileA, '--apply']);
  check('restore runs', restore.code === 0, restore.all);
  check('deleted session stays deleted', count(fileA, 'SELECT count(*) AS n FROM checkpoints WHERE id = ?', drop.split(':')[1]) === 0, restore.all);
  check('kept session is still there', count(fileA, 'SELECT count(*) AS n FROM checkpoints WHERE id = ?', keep.split(':')[1]) === 1);
  check('deleted file stays deleted', count(fileA, 'SELECT count(*) AS n FROM artifacts WHERE id = ?', file.split(':')[1]) === 0);
  check('deleted fact stays deleted', count(fileA, "SELECT count(*) AS n FROM profile WHERE key = 'editor'") === 0);
  check('deleted chat stays deleted', count(fileA, "SELECT count(*) AS n FROM conversations WHERE external_id = 'chat-x'") === 0);
  check('deleted project and its files stay deleted', count(fileA, "SELECT count(*) AS n FROM projects WHERE name = 'Old Project'") === 0 && count(fileA, 'SELECT count(*) AS n FROM artifacts WHERE id = ?', oldFile.split(':')[1]) === 0);
  check('the report says what was held back', /not copied \(deleted here\)/.test(restore.all) && /deleted\)/.test(restore.all), restore.all);
  check('search does not find deleted words', /Nothing stored matches/.test(await tool('search', { query: 'zebrafish walrus narwhal secretive' })));

  console.log('Re-sent chat history');
  const resent = await ingest(chat);
  check('an importer re-sending the deleted chat is ignored', resent.deleted === true && count(fileA, "SELECT count(*) AS n FROM conversations WHERE external_id = 'chat-x'") === 0, JSON.stringify(resent));

  console.log('Deletions travel with copies');
  const fileC = join(root, 'c', 'memory.db');
  cli(['copy', '--from', old, '--to', fileC, '--apply']);
  check('an empty home restored from the old backup has the old items (it never saw the deletions)', count(fileC, "SELECT count(*) AS n FROM profile WHERE key = 'editor'") === 1);
  const carry = cli(['copy', '--from', fileA, '--to', fileC, '--apply']);
  check('copying from the memory that deleted them removes them there too', count(fileC, "SELECT count(*) AS n FROM profile WHERE key = 'editor'") === 0 && count(fileC, 'SELECT count(*) AS n FROM checkpoints WHERE id = ?', drop.split(':')[1]) === 0 && count(fileC, "SELECT count(*) AS n FROM conversations WHERE external_id = 'chat-x'") === 0, carry.all);
  check('and reports how many it removed', /removed here/.test(carry.all), carry.all);
  check('and the kept items are there', count(fileC, 'SELECT count(*) AS n FROM checkpoints WHERE id = ?', keep.split(':')[1]) === 1);
  const again = cli(['copy', '--from', old, '--to', fileC, '--apply']);
  check('after that, the old backup cannot bring them back there either', count(fileC, "SELECT count(*) AS n FROM profile WHERE key = 'editor'") === 0 && count(fileC, "SELECT count(*) AS n FROM projects WHERE name = 'Old Project'") === 0, again.all);

  console.log('Saying it again on purpose');
  await tool('remember', { key: 'editor', value: 'Zed' });
  check('remember of a deleted key stores the new fact', /Zed/.test(await tool('recall', {})));
  check('and clears that key from the ledger', count(fileA, "SELECT count(*) AS n FROM deletions WHERE kind = 'profile' AND ref = 'editor'") === 0);

  console.log('Backups describe the ledger');
  const now = join(root, 'now.db');
  cli(['backup', '--from', fileA, '--to', now]);
  const manifest = JSON.parse(readFileSync(`${now}.manifest.json`, 'utf8'));
  check('the manifest (format 2) counts deletions', manifest.format === 2 && manifest.tables.deletions.rows === 6, JSON.stringify(manifest.tables.deletions));
} catch (error) {
  check('suite ran without crashing', false, error?.stack ?? error);
} finally {
  server.kill();
  rmSync(root, { recursive: true, force: true });
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
