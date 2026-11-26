// Failure drills (execution plan P9.3.2): the memory is left in the old or the new coherent state,
// never a broken one, when the process is killed mid-save, a migration fails halfway, a newer
// memory meets an older program, or many apps and an importer write at once.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../dist/legendary-memory.mjs', import.meta.url));
const KEY = 'r'.repeat(40);
const PORT = 18901;
const root = mkdtempSync(join(tmpdir(), 'lm-drills-'));
let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `\n         ${String(detail).slice(0, 400)}` : ''}`);
};
const envFor = (home) => {
  const env = { ...process.env, NODE_NO_WARNINGS: '1', LEGENDARY_MEMORY_DIR: home, LEGENDARY_MEMORY_KEY: KEY };
  for (const name of Object.keys(env)) if (/^(HUB_URL|BRIDGE_API_KEY|LEGENDARY_MEMORY_FROM|LEGENDARY_MEMORY_DB)/.test(name)) delete env[name];
  return env;
};
const running = new Set();
async function serve(home) {
  const child = spawn(process.execPath, [BIN, 'serve', '--port', String(PORT)], { env: envFor(home), stdio: ['ignore', 'ignore', 'pipe'] });
  running.add(child);
  child.once('exit', () => running.delete(child));
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return child; } catch {}
    if (child.exitCode !== null) throw new Error(err);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}
const exited = (child) => new Promise((done) => (child.exitCode !== null || child.signalCode !== null ? done() : child.once('exit', done)));
let rpc = 0;
const tool = async (name, args, app = 'claude-desktop') => {
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${KEY}`, 'User-Agent': app },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }),
  });
  const result = JSON.parse(await res.text()).result;
  return { text: result.content.map((c) => c.text).join('\n'), error: Boolean(result.isError) };
};
const query = (file, sql) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
};
const integrity = (file) => query(file, 'PRAGMA integrity_check')[0].integrity_check;
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

try {
  console.log('Killed in the middle of saving');
  const home = join(root, 'kill');
  let server = await serve(home);
  await tool('save_checkpoint', { project: 'Crash Test', title: 'first', summary: 'before the crash', new_project: true });
  const acknowledged = [];
  let sent = 0;
  const inflight = Array.from({ length: 5 }, async (_, a) => {
    for (let n = 0; n < 25; n++) {
      const title = `save ${a}-${n}`;
      sent++;
      try {
        const r = await tool('save_checkpoint', { project: 'Crash Test', title, summary: 'x'.repeat(5000) }, `app-${a}`);
        if (!r.error) acknowledged.push(title);
        else if (n === 0) console.log('    refused:', r.text.slice(0, 200));
      } catch {
        return; // the server is gone
      }
    }
  });
  // Kill once saves are flowing, so some are confirmed and some are mid-write.
  for (let t = 0; acknowledged.length < 10 && t < 2000; t++) await new Promise((r) => setTimeout(r, 5));
  server.kill('SIGKILL');
  await Promise.allSettled(inflight);
  await exited(server);
  const file = join(home, 'memory.db');
  check('the file opens and passes its integrity check after a hard kill', integrity(file) === 'ok');
  const titles = new Set(query(file, 'SELECT title FROM checkpoints').map((r) => r.title));
  check('the kill landed while saves were flowing', acknowledged.length >= 10 && sent > acknowledged.length, `${acknowledged.length} confirmed of ${sent}`);
  check('every save that was confirmed to an app is there', acknowledged.every((t) => titles.has(t)), `${acknowledged.length} confirmed, missing ${acknowledged.filter((t) => !titles.has(t))}`);
  const orphans = query(file, "SELECT COUNT(*) AS n FROM search_map m WHERE m.kind = 'checkpoint' AND NOT EXISTS (SELECT 1 FROM checkpoints c WHERE c.id = m.ref_id)")[0].n;
  console.log(`  note ${acknowledged.length} saves confirmed and ${sent} sent before the kill; ${titles.size - 1} are in the file`);
  check('no half-saved item: the search index has no rows without their record', orphans === 0, `${orphans} orphans`);
  server = await serve(home);
  { const r = await tool('recall', { project: 'Crash Test' }); check('it starts again and answers', !r.error && r.text.includes('# Crash Test'), r.text.slice(0, 200)); }
  server.kill();
  await exited(server);

  console.log('A migration that fails halfway');
  const mig = join(root, 'migration');
  // A memory at schema 5 (before the activity table), with data in it.
  server = await serve(mig);
  await tool('save_checkpoint', { project: 'Upgrade Me', title: 'kept', summary: 'data before the upgrade', new_project: true });
  server.kill();
  await exited(server);
  const migFile = join(mig, 'memory.db');
  {
    const db = new DatabaseSync(migFile);
    db.exec('DROP TABLE activity; PRAGMA user_version = 5;');
    // Something in the way of migration 6, so it fails after it has started.
    db.exec('CREATE VIEW activity AS SELECT 1 AS id');
    db.close();
  }
  const before = query(migFile, 'SELECT COUNT(*) AS n FROM checkpoints')[0].n;
  const broken = spawnSync(process.execPath, [BIN, 'serve', '--port', String(PORT)], { env: envFor(mig), encoding: 'utf8', timeout: 15_000 });
  check('the program stops with an error instead of running half-upgraded', broken.status !== 0, broken.stderr.slice(0, 300));
  check('the memory is still at the old version', query(migFile, 'PRAGMA user_version')[0].user_version === 5);
  check('its data is untouched and intact', query(migFile, 'SELECT COUNT(*) AS n FROM checkpoints')[0].n === before && integrity(migFile) === 'ok');
  {
    const db = new DatabaseSync(migFile);
    db.exec('DROP VIEW activity');
    db.close();
  }
  server = await serve(mig);
  check('once the obstacle is gone, the upgrade completes', query(migFile, 'PRAGMA user_version')[0].user_version >= 6 && (await tool('recall', { project: 'Upgrade Me' })).text.includes('kept'));
  server.kill();
  await exited(server);

  console.log('A newer memory meets an older program');
  const newer = join(root, 'newer');
  copyFileSync(migFile, join(root, 'newer.db'));
  {
    const db = new DatabaseSync(join(root, 'newer.db'));
    db.exec('PRAGMA user_version = 99');
    db.close();
  }
  const { mkdirSync } = await import('node:fs');
  mkdirSync(newer, { recursive: true });
  copyFileSync(join(root, 'newer.db'), join(newer, 'memory.db'));
  const hashBefore = sha(join(newer, 'memory.db'));
  const old = spawnSync(process.execPath, [BIN, 'serve', '--port', String(PORT)], { env: envFor(newer), encoding: 'utf8', timeout: 15_000 });
  check('the older program refuses and says to update', old.status !== 0 && /newer Legendary Memory/.test(old.stderr), old.stderr.slice(0, 300));
  check('and does not change the file', sha(join(newer, 'memory.db')) === hashBefore);

  console.log('Many apps and an importer at once');
  const busy = join(root, 'busy');
  server = await serve(busy);
  await tool('save_checkpoint', { project: 'Busy', title: 'start', summary: 'start', new_project: true });
  const started = Date.now();
  const errors = [];
  let writes = 0;
  let reads = 0;
  let imports = 0;
  const apps = Array.from({ length: 6 }, (_, i) => `busy-app-${i}`);
  const work = apps.map(async (app, i) => {
    for (let n = 0; n < 25; n++) {
      const w = await tool('save_checkpoint', { project: 'Busy', title: `${app} ${n}`, summary: `note ${n} from ${app}` }, app);
      w.error ? errors.push(w.text) : writes++;
      const r = await tool(n % 2 ? 'search' : 'recall', n % 2 ? { query: `note ${n}` } : { project: 'Busy' }, app);
      r.error ? errors.push(r.text) : reads++;
    }
  });
  const importer = (async () => {
    for (let n = 0; n < 20; n++) {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/ingest/conversation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ source: 'chatgpt', external_id: `soak-${n}`, title: `Chat ${n}`, url: '', started_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', messages: Array.from({ length: 30 }, (_, k) => ({ seq: k, role: k % 2 ? 'assistant' : 'user', text: `message ${k} of chat ${n}` })) }),
      });
      res.ok ? imports++ : errors.push(`ingest ${res.status}`);
    }
  })();
  await Promise.all([...work, importer]);
  const seconds = (Date.now() - started) / 1000;
  check('no errors under load', errors.length === 0, errors.slice(0, 3).join(' | '));
  check('every write landed', writes === 150 && imports === 20, `${writes} saves, ${imports} imports`);
  const busyFile = join(busy, 'memory.db');
  check('counts match what was confirmed', query(busyFile, "SELECT COUNT(*) AS n FROM checkpoints")[0].n === 151 && query(busyFile, 'SELECT COUNT(*) AS n FROM conversations')[0].n === 20);
  const status = await (await fetch(`http://127.0.0.1:${PORT}/api/status`, { headers: { Authorization: `Bearer ${KEY}` } })).json();
  check('the status endpoint reports counts and the last day, with no content', status.counts.sessions === 151 && status.last_24h.writes >= 151 && status.deletion_ledger.copy === true && !JSON.stringify(status).includes('note 1 from'), JSON.stringify(status));
  check('the status endpoint needs the key', (await fetch(`http://127.0.0.1:${PORT}/api/status`)).status === 401);
  server.kill();
  await exited(server);
  check('integrity holds afterwards', integrity(busyFile) === 'ok');
  console.log(`  note ${writes} saves, ${reads} reads and ${imports} chat imports (600 messages) from 7 writers in ${seconds.toFixed(1)} s`);
} finally {
  for (const child of running) child.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
