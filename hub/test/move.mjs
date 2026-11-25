// Moving homes (P3.5): preview changes nothing; a move copies everything into an empty home,
// proves both match, leaves the old home read-only with the new address; undo works only while
// the new home is unchanged. Temp folders and 127.0.0.1 only. Builds: `npm run test:move`.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../dist/legendary-memory.mjs', import.meta.url));
const KEY = 'm'.repeat(40);
const PORT = 18901;
const BASE = `http://127.0.0.1:${PORT}`;
const root = mkdtempSync(join(tmpdir(), 'lm-move-'));
const oldHome = join(root, 'old');
const cliHome = join(root, 'cli');

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `\n         ${String(detail).slice(0, 600)}` : ''}`);
};
const env = (dir) => {
  const e = { ...process.env, NODE_NO_WARNINGS: '1', LEGENDARY_MEMORY_DIR: dir, LEGENDARY_MEMORY_KEY: KEY, LEGENDARY_MEMORY_FROM_KEY: KEY, LEGENDARY_MEMORY_TO_KEY: KEY };
  for (const name of Object.keys(e)) if (/^(HUB_URL|BRIDGE_API_KEY)/.test(name)) delete e[name];
  return e;
};
const cli = (args) => {
  const run = spawnSync('node', [BIN, ...args], { encoding: 'utf8', timeout: 120_000, env: env(cliHome) });
  return { all: run.stdout + run.stderr, code: run.status };
};
let id = 0;
async function tool(name, args) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${KEY}`, 'User-Agent': 'claude-desktop' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
  });
  const parsed = JSON.parse(await res.text());
  return { text: parsed.result?.content?.map((c) => c.text).join('\n') ?? JSON.stringify(parsed), isError: Boolean(parsed.result?.isError) };
}
const count = (file, table) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  } finally {
    db.close();
  }
};

const server = spawn('node', [BIN, 'serve', '--port', String(PORT)], { env: env(oldHome), stdio: ['ignore', 'ignore', 'pipe'] });
try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log('The old home: a running hub with sessions, a file, a fact, a chat and a deletion');
  await tool('save_checkpoint', { project: 'Cooling Rig', title: 'Pick pump', summary: 'D5 pump, quieter' });
  await tool('save_artifact', { project: 'Cooling Rig', name: 'plan.md', content: 'plan' });
  await tool('remember', { key: 'editor', value: 'VS Code' });
  const tmp = (await tool('save_checkpoint', { project: 'Cooling Rig', title: 'Temp', summary: 'temp' })).text.match(/checkpoint:[0-9a-f-]+/)[0];
  await tool('forget', { ref: tmp });
  await fetch(`${BASE}/api/ingest/conversation`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'claude', external_id: 'c1', title: 'Radiator', url: '', started_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', messages: [{ seq: 0, role: 'user', text: 'Which radiator?' }] }),
  });

  console.log('Preview');
  const newHome = join(root, 'new', 'memory.db');
  const preview = cli(['move', '--from', BASE, '--to', newHome]);
  check('shows what would move', preview.code === 0 && /what moves: .*checkpoints/.test(preview.all) && /Nothing was changed/.test(preview.all), preview.all);
  check('and changes nothing: the old home still saves', !(await tool('save_checkpoint', { project: 'Cooling Rig', title: 'Still open', summary: 'ok' })).isError);

  console.log('Move');
  const move = cli(['move', '--from', BASE, '--to', newHome, '--apply']);
  check('the move finishes and verifies', move.code === 0 && /Moved\./.test(move.all) && /both hash/.test(move.all), move.all);
  check('the new home holds everything', count(newHome, 'checkpoints') === 2 && count(newHome, 'artifacts') === 1 && count(newHome, 'profile') === 1 && count(newHome, 'conversations') === 1);
  check('including the deletion record', count(newHome, 'deletions') === 1);
  check('an archive of what moved is kept', readdirSync(join(cliHome, 'backups')).some((f) => f.startsWith('move-') && f.endsWith('.lmarchive')));
  check('no temporary files are left', !readdirSync(tmpdir()).some((f) => f.startsWith(`legendary-memory-move-`) && f.includes(String(process.pid))));

  console.log('The old home is now read-only, pointing at the new one');
  const save = await tool('save_checkpoint', { project: 'Cooling Rig', title: 'Late', summary: 'late' });
  check('a save is refused with the new address', save.isError && save.text.includes(newHome) && /read-only/.test(save.text), save.text);
  const del = await tool('forget', { ref: 'profile:editor' });
  check('a delete is refused too', del.isError && /moved to/.test(del.text), del.text);
  check('recall still works', /Cooling Rig/.test((await tool('recall', { project: 'cooling' })).text));
  const ingest = await fetch(`${BASE}/api/ingest/conversation`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'claude', external_id: 'c2', title: 'x', url: '', messages: [{ seq: 0, role: 'user', text: 'x' }] }) });
  check('the importer API is refused (409)', ingest.status === 409);
  const state = await (await fetch(`${BASE}/api/state`, { headers: { Authorization: `Bearer ${KEY}` } })).json();
  check('its state names the new home and the verified hash', state.moved?.to === newHome && /^[0-9a-f]{64}$/.test(state.moved?.memory_sha256) && !/^0+$/.test(state.moved.memory_sha256), JSON.stringify(state));

  console.log('Refusals');
  check('moving it again is refused', /already moved/.test(cli(['move', '--from', BASE, '--to', join(root, 'x', 'memory.db'), '--apply']).all));
  const full = join(root, 'full', 'memory.db');
  cli(['copy', '--from', newHome, '--to', full, '--apply']);
  const intoFull = cli(['move', '--from', newHome, '--to', full, '--apply']);
  check('moving into a home that already holds memories is refused', intoFull.code !== 0 && /already holds memories/.test(intoFull.all), intoFull.all);
  check('and the source of that refused move stayed writable', !existsSync(newHome) || count(newHome, 'checkpoints') === 2);

  console.log('Undo');
  const undo = cli(['move', '--undo', '--from', BASE]);
  check('undo while the new home is unchanged makes the old one writable', undo.code === 0 && /accepts saves again/.test(undo.all), undo.all);
  check('the old home saves again', !(await tool('save_checkpoint', { project: 'Cooling Rig', title: 'Back', summary: 'back' })).isError);

  console.log('Undo after the new home changed');
  const second = join(root, 'second', 'memory.db');
  const secondMove = cli(['move', '--from', BASE, '--to', second, '--apply']);
  check('a second move works', secondMove.code === 0, secondMove.all);
  // Something new lands in the new home.
  const extra = join(root, 'extra.db');
  const ex = spawnSync('node', [BIN, 'copy', '--from', full, '--to', extra, '--apply'], { env: env(cliHome) });
  const db = new DatabaseSync(second);
  db.prepare("INSERT INTO profile (key, value, updated_at) VALUES ('new-fact', 'added after the move', '2026-11-25T00:00:00.000Z')").run();
  db.close();
  const refused = cli(['move', '--undo', '--from', BASE]);
  check('undo is refused, explaining how to copy the new saves back', refused.code !== 0 && /has changed since the move/.test(refused.all) && /legendary-memory copy --from/.test(refused.all), refused.all);
  check('and the old home stays read-only', (await tool('save_checkpoint', { project: 'Cooling Rig', title: 'No', summary: 'no' })).isError);
  const forced = cli(['move', '--undo', '--from', BASE, '--force']);
  check('--force undoes it anyway', forced.code === 0 && !(await tool('save_checkpoint', { project: 'Cooling Rig', title: 'Yes', summary: 'yes' })).isError, forced.all + ex.status);

  console.log('A failure mid-move');
  const broken = spawnSync('node', [BIN, 'move', '--from', BASE, '--to', join(root, 'broken', 'memory.db'), '--apply'], { encoding: 'utf8', env: { ...env(cliHome), LEGENDARY_MEMORY_TEST_MOVE_FAIL: 'copy' } });
  check('is reported', broken.status !== 0 && /Failure injected/.test(broken.stdout + broken.stderr), broken.stdout + broken.stderr);
  check('says the old home is writable again', /writable again/.test(broken.stdout + broken.stderr));
  check('and it really is', !(await tool('save_checkpoint', { project: 'Cooling Rig', title: 'After failure', summary: 'ok' })).isError);

  console.log('Keys');
  check('a key on the command line is refused', /not accepted on the command line/.test(cli(['move', '--from', BASE, '--to', join(root, 'k.db'), '--key', KEY]).all));
} catch (error) {
  check('suite ran without crashing', false, error?.stack ?? error);
} finally {
  server.kill();
  rmSync(root, { recursive: true, force: true });
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
