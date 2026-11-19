// Checks how the local database is opened: two programs starting at once on a new machine
// must both work, and an older copy must refuse a database a newer one has changed.
// Builds are done by `npm run test:db`.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../dist/legendary-memory.mjs', import.meta.url));
const INIT = readFileSync(fileURLToPath(new URL('../migrations/0001_init.sql', import.meta.url)), 'utf8');
const root = mkdtempSync(join(tmpdir(), 'lm-db-'));
const envFor = (dir) => {
  const env = { ...process.env, NODE_NO_WARNINGS: '1', LEGENDARY_MEMORY_DIR: dir };
  for (const name of Object.keys(env)) if (/^(HUB_URL|BRIDGE_API_KEY)/.test(name)) delete env[name];
  return env;
};

// The schema version this build ends at: one per file in migrations/.
const CURRENT = (await import('node:fs')).readdirSync(fileURLToPath(new URL('../migrations/', import.meta.url))).filter((f) => f.endsWith('.sql')).length;
let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `\n         ${String(detail).slice(0, 500)}` : ''}`);
};
const INIT_MSG = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-desktop', version: '1' } } }) + '\n';

try {
  console.log('Starting together on a new machine');
  const dir = join(root, 'race');
  const file = join(dir, 'memory.db');
  spawnSync('mkdir', ['-p', dir]);
  // The first program to arrive takes the write lock and builds the tables, slowly.
  const first = new DatabaseSync(file);
  first.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;');
  const children = Array.from({ length: 8 }, () => {
    const child = spawn('node', [BIN, 'stdio'], { env: envFor(dir), stdio: ['pipe', 'pipe', 'pipe'] });
    const seen = { out: '', err: '' };
    child.stdout.on('data', (d) => (seen.out += d));
    child.stderr.on('data', (d) => (seen.err += d));
    return { child, seen };
  });
  // Long enough for every child to start and reach the lock, which it has to wait for.
  await new Promise((r) => setTimeout(r, 1500));
  first.exec(`${INIT}; PRAGMA user_version = 1; COMMIT;`);
  first.close();
  for (const { child } of children) child.stdin.write(INIT_MSG);
  for (let i = 0; i < 100 && !children.every(({ seen }) => seen.out.includes('"result"') || seen.err); i++) await new Promise((r) => setTimeout(r, 100));
  const failures = children.filter(({ seen }) => !seen.out.includes('"result"'));
  check('all eight programs start and answer', failures.length === 0, failures.map(({ seen }) => seen.err).join(' | '));
  for (const { child } of children) child.kill();
  const after = new DatabaseSync(file);
  check(`a version-1 database is upgraded to version ${CURRENT} once, with its tables`, after.prepare('PRAGMA user_version').get().user_version === CURRENT && after.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'projects'").get().n === 1);
  after.close();

  console.log('\nA database from a newer version');
  const newer = join(root, 'newer');
  const made = spawn('node', [BIN, 'stdio'], { env: envFor(newer), stdio: ['pipe', 'pipe', 'pipe'] });
  made.stdin.write(INIT_MSG);
  await new Promise((resolve) => made.stdout.once('data', resolve));
  made.kill();
  await new Promise((r) => setTimeout(r, 300));
  const future = new DatabaseSync(join(newer, 'memory.db'));
  future.exec(`PRAGMA user_version = ${CURRENT + 1}; ALTER TABLE projects ADD COLUMN rehearsal TEXT;`);
  future.close();
  for (const command of ['stdio', 'serve']) {
    const run = spawnSync('node', [BIN, command, ...(command === 'serve' ? ['--port', '18841'] : [])], { env: envFor(newer), encoding: 'utf8', input: '', timeout: 15000 });
    check(`${command} refuses to open it, in plain words`, run.status === 1 && /newer Legendary Memory/.test(run.stderr) && /Update this copy/.test(run.stderr), `${run.status} ${run.stderr}`);
  }
  const copyRun = spawnSync('node', [BIN, 'copy', '--from', join(newer, 'memory.db'), '--to', join(root, 'elsewhere.db')], { env: envFor(root), encoding: 'utf8', timeout: 15000 });
  check('copy refuses to read it too', copyRun.status === 1 && /newer Legendary Memory/.test(copyRun.stderr), copyRun.stderr);
  const kept = new DatabaseSync(join(newer, 'memory.db'));
  check('nothing was changed: still the newer version with its extra column', kept.prepare('PRAGMA user_version').get().user_version === CURRENT + 1 && kept.prepare("SELECT count(*) AS n FROM pragma_table_info('projects') WHERE name = 'rehearsal'").get().n === 1);
  kept.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
