// Checks `legendary-memory backup`: one consistent, self-contained, verified file, made while
// another app keeps writing, that restores into an empty home with the same memories. Runs on
// temp folders and 127.0.0.1 ports only. Builds are done by `npm run test:backup`.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../dist/legendary-memory.mjs', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../scripts/manifest.py', import.meta.url));
const KEY = 'k'.repeat(40);
const PORT = 18811;
const BASE = `http://127.0.0.1:${PORT}`;
const root = mkdtempSync(join(tmpdir(), 'lm-backup-'));
const home = join(root, 'home');
const out = join(root, 'out');

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `\n         ${String(detail).slice(0, 600)}` : ''}`);
};

const clean = () => {
  const env = { ...process.env, NODE_NO_WARNINGS: '1' };
  for (const name of Object.keys(env)) if (/^(HUB_URL|BRIDGE_API_KEY|LEGENDARY_MEMORY_)/.test(name)) delete env[name];
  return env;
};
const cli = (args, env = {}) => {
  const run = spawnSync('node', [BIN, ...args], { encoding: 'utf8', timeout: 120_000, env: { ...clean(), LEGENDARY_MEMORY_DIR: join(root, 'cli'), ...env } });
  return { all: run.stdout + run.stderr, code: run.status };
};
const cliAsync = (args, env = {}) =>
  new Promise((done) => {
    const child = spawn('node', [BIN, ...args], { env: { ...clean(), LEGENDARY_MEMORY_DIR: join(root, 'cli'), ...env } });
    let all = '';
    child.stdout.on('data', (d) => (all += d));
    child.stderr.on('data', (d) => (all += d));
    child.on('close', (code) => done({ all, code }));
  });

let rpcId = 0;
async function tool(name, args) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${KEY}`, 'User-Agent': 'claude-desktop' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  return res.text();
}
const manifest = (file) => JSON.parse(readFileSync(`${file}.manifest.json`, 'utf8'));
const sidecars = (file) => ['-wal', '-shm', '-journal'].filter((s) => existsSync(file + s));
const partials = () => readdirSync(out).filter((f) => f.includes('.partial-'));

let server;
try {
  server = spawn('node', [BIN, 'serve', '--port', String(PORT)], { env: { ...clean(), LEGENDARY_MEMORY_DIR: home, LEGENDARY_MEMORY_KEY: KEY }, stdio: ['ignore', 'ignore', 'pipe'] });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log('Seed');
  for (let i = 0; i < 20; i++) {
    await tool('save_checkpoint', { project: i % 2 ? 'Cooling Rig' : 'Cooking Club', title: `Session ${i}`, summary: `Work item ${i}. ${'x'.repeat(2000)}`, decisions: [`Decision ${i}`] });
  }
  await tool('save_artifact', { project: 'Cooling Rig', name: 'notes.md', content: 'Пример текста, 例え, emoji 🚀 and code `x = 1`' });
  await tool('remember', { key: 'editor', value: 'VS Code' });

  console.log('Why: a plain copy of a live file');
  const naive = join(root, 'naive.db');
  copyFileSync(join(home, 'memory.db'), naive);
  const naiveMeta = cli(['copy', '--from', naive, '--to', join(root, 'naive-restored.db'), '--apply']);
  console.log(`  info a plain copy of memory.db without its -wal file restores as: ${(naiveMeta.all.match(/sessions\s+\d+ new/) ?? ['(unreadable)'])[0]}`);

  console.log('Backup of this computer while an app keeps writing');
  let writing = true;
  let written = 0;
  const writer = (async () => {
    while (writing) {
      await tool('save_checkpoint', { project: 'Cooling Rig', title: `Live ${written}`, summary: 'written during backup' });
      written++;
    }
  })();
  const local1 = join(out, 'local-1.db');
  const r1 = await cliAsync(['backup', '--from', join(home, 'memory.db'), '--to', local1]);
  writing = false;
  await writer;
  check('backup finishes', r1.code === 0, r1.all);
  check('writes kept landing during it', written > 0, written);
  check('the backup is one self-contained file', existsSync(local1) && sidecars(local1).length === 0, sidecars(local1));
  check('only the owner can read it', (statSync(local1).mode & 0o077) === 0, (statSync(local1).mode & 0o777).toString(8));
  const m1 = manifest(local1);
  check('it passes the integrity check', m1.integrity === 'ok', m1.integrity);
  check('it holds the seeded memories', m1.tables.checkpoints.rows >= 20 && m1.tables.artifacts.rows === 1 && m1.tables.profile.rows === 1, JSON.stringify(m1.tables));
  check('no partial files are left', partials().length === 0, partials());

  console.log('Restore into an empty home');
  const restored = join(root, 'restored', 'memory.db');
  const rr = cli(['copy', '--from', local1, '--to', restored, '--apply']);
  check('restore runs', rr.code === 0, rr.all);
  const again = join(out, 'restored-check.db');
  cli(['backup', '--from', restored, '--to', again]);
  check('the restored home holds exactly the same memories', manifest(again).memory_sha256 === m1.memory_sha256, `${manifest(again).memory_sha256} vs ${m1.memory_sha256}`);
  if (spawnSync('python3', ['--version']).status === 0) {
    const py = spawnSync('python3', ['-I', SCRIPT, local1, '--json'], { encoding: 'utf8' });
    const pyHash = py.status === 0 ? JSON.parse(py.stdout).memory_sha256 : py.stderr;
    check('scripts/manifest.py computes the same hash', pyHash === m1.memory_sha256, `${pyHash} vs ${m1.memory_sha256}`);
  }

  console.log('Backup of a hub over HTTP');
  const remote1 = join(out, 'remote-1.db');
  const r2 = cli(['backup', '--from', BASE, '--to', remote1], { LEGENDARY_MEMORY_FROM_KEY: KEY });
  check('backup from a quiet hub finishes', r2.code === 0, r2.all);
  const local2 = join(out, 'local-2.db');
  cli(['backup', '--from', join(home, 'memory.db'), '--to', local2]);
  check('it matches a backup of the same memory taken on the machine', manifest(remote1).memory_sha256 === manifest(local2).memory_sha256);
  check('the key is not printed', !r2.all.includes(KEY));

  writing = true;
  const writer2 = (async () => {
    while (writing) await tool('save_checkpoint', { project: 'Cooling Rig', title: 'busy', summary: 'busy' });
  })();
  const remote2 = join(out, 'remote-2.db');
  const r3 = cli(['backup', '--from', BASE, '--to', remote2], { LEGENDARY_MEMORY_FROM_KEY: KEY });
  writing = false;
  await writer2;
  const consistent = r3.code === 0 ? manifest(remote2).integrity === 'ok' : /kept changing/.test(r3.all) && !existsSync(remote2);
  check('a hub that keeps changing gives a verified file or a clear refusal, never a partial one', consistent, r3.all);
  check('no partial files are left after a busy hub', partials().length === 0, partials());

  console.log('Refusals');
  const over = cli(['backup', '--to', local1, '--from', join(home, 'memory.db')]);
  check('an existing file is never overwritten', over.code !== 0 && /already exists/.test(over.all), over.all);
  const keyed = cli(['backup', '--from', BASE, '--to', join(out, 'x.db'), '--key', KEY]);
  check('a key on the command line is refused', keyed.code !== 0 && /not accepted on the command line/.test(keyed.all), keyed.all);
  const missing = cli(['backup', '--from', join(root, 'nope.db'), '--to', join(out, 'y.db')]);
  check('a missing source is reported in plain words', missing.code !== 0 && /no memory file/.test(missing.all), missing.all);
} catch (error) {
  check('suite ran without crashing', false, error?.stack ?? error);
} finally {
  server?.kill();
  rmSync(root, { recursive: true, force: true });
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
