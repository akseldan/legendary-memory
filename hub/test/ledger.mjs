// Deletion through recovery (execution plan P9.2): the deletion ledger is copied beside the
// database, so restoring a backup from before a deletion does not bring the item back.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../dist/legendary-memory.mjs', import.meta.url));
const KEY = 'l'.repeat(40);
const PORT = 18881;
const home = mkdtempSync(join(tmpdir(), 'lm-ledger-'));
const env = { ...process.env, NODE_NO_WARNINGS: '1', LEGENDARY_MEMORY_DIR: home, LEGENDARY_MEMORY_KEY: KEY };
for (const name of Object.keys(env)) if (/^(HUB_URL|BRIDGE_API_KEY|LEGENDARY_MEMORY_FROM)/.test(name)) delete env[name];

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `\n         ${String(detail).slice(0, 400)}` : ''}`);
};
let rpc = 0;
const tool = async (name, args) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }),
  });
  return JSON.parse(await res.text()).result.content.map((c) => c.text).join('\n');
};
let printed = '';
const running = new Set();
async function serve() {
  const child = spawn(process.execPath, [BIN, 'serve', '--port', String(PORT)], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  running.add(child);
  child.once('exit', () => running.delete(child));
  child.stderr.on('data', (d) => (printed += d));
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return child; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}
const stop = (child) => new Promise((done) => { child.once('exit', done); child.kill(); });

try {
  console.log('Deletion through recovery (P9.2)');
  let server = await serve();
  await tool('save_checkpoint', { project: 'Keep Me', title: 'Stays', summary: 'kept words' });
  await tool('save_checkpoint', { project: 'Delete Me', title: 'Goes', summary: 'zebra-secret words', new_project: true });
  await tool('remember', { key: 'old address', value: 'Somewhere secret' });
  await stop(server);
  const snapshot = join(home, 'before-delete.db');
  const made = spawnSync(process.execPath, [BIN, 'backup', '--to', snapshot], { env, encoding: 'utf8' });
  check('a backup is taken while both projects exist', made.status === 0, made.stderr);

  server = await serve();
  const before = await tool('recall', {});
  check('both projects are listed before the deletion', before.includes('Delete Me') && before.includes('Keep Me'), before.slice(0, 300));
  const gone = await tool('forget', { ref: 'project:Delete Me' });
  await tool('forget', { ref: 'profile:old-address' });
  check('the project and the fact are deleted', /deleted/i.test(gone) && !(await tool('search', { query: 'zebra' })).includes('Goes'), gone);
  await stop(server);
  const ledger = join(home, 'deletions-ledger.json');
  check('a copy of the deletion records sits beside the database', existsSync(ledger));
  const kept = readFileSync(ledger, 'utf8');
  check('the copy names what was deleted but holds no content', kept.includes('"profile"') && kept.includes('old-address') && !kept.includes('zebra') && !kept.includes('Somewhere'), kept.slice(0, 300));

  // Restore the backup from before the deletion over the live memory, as someone might by hand.
  for (const f of ['memory.db', 'memory.db-wal', 'memory.db-shm']) rmSync(join(home, f), { force: true });
  copyFileSync(snapshot, join(home, 'memory.db'));
  printed = '';
  server = await serve();
  check('on start it says it deleted the restored items again', /Deleted again \d+ item/.test(printed), printed);
  const overview = await tool('recall', {});
  check('the deleted project does not come back', !overview.includes('Delete Me') && overview.includes('Keep Me'), overview.slice(0, 400));
  check('its words are not searchable', !(await tool('search', { query: 'zebra' })).includes('Goes'));
  check('the deleted fact does not come back', !overview.includes('Somewhere secret'));
  await stop(server);

  // A second start has nothing left to do.
  printed = '';
  server = await serve();
  check('the next start finds nothing to redo', !/Deleted again/.test(printed), printed);
  await stop(server);
  // The copy also survives a restore that replaces the whole folder's database with an empty one.
  rmSync(ledger);
  server = await serve();
  check('a missing copy is rebuilt from the database', existsSync(ledger) && readFileSync(ledger, 'utf8').includes('old-address'));
  await stop(server);
} finally {
  for (const child of running) child.kill();
  rmSync(home, { recursive: true, force: true });
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
