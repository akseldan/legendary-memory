// Portable archives (P3.3/P3.4): export from a running memory or a hub, restore into a new place
// with identical memories and working search; damaged, truncated, newer or hostile archives are
// refused and leave nothing behind. Temp folders and 127.0.0.1 only. Builds: `npm run test:archive`.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../dist/legendary-memory.mjs', import.meta.url));
const KEY = 'a'.repeat(40);
const PORT = 18881;
const BASE = `http://127.0.0.1:${PORT}`;
const root = mkdtempSync(join(tmpdir(), 'lm-archive-'));
const home = join(root, 'home');

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `\n         ${String(detail).slice(0, 600)}` : ''}`);
};
const clean = (dir) => {
  const env = { ...process.env, NODE_NO_WARNINGS: '1', LEGENDARY_MEMORY_DIR: dir, LEGENDARY_MEMORY_KEY: KEY };
  for (const name of Object.keys(env)) if (/^(HUB_URL|BRIDGE_API_KEY|LEGENDARY_MEMORY_FROM)/.test(name)) delete env[name];
  return env;
};
const cli = (args, extra = {}) => {
  const run = spawnSync('node', [BIN, ...args], { encoding: 'utf8', timeout: 120_000, env: { ...clean(join(root, 'cli')), ...extra } });
  return { all: run.stdout + run.stderr, code: run.status };
};
const hashOf = (text) => text.match(/memory hash\s+([0-9a-f]{64})/)?.[1];

let id = 0;
async function tool(base, name, args) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${KEY}`, 'User-Agent': 'claude-desktop' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
  });
  const parsed = JSON.parse(await res.text());
  return parsed.result?.content?.map((c) => c.text).join('\n') ?? JSON.stringify(parsed);
}
const start = async (dir, port) => {
  const child = spawn('node', [BIN, 'serve', '--port', String(port)], { env: clean(dir), stdio: ['ignore', 'ignore', 'pipe'] });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return child;
};
/** Rewrites an archive's lines with `edit` and writes it under a new name. */
const tamper = (from, name, edit) => {
  const lines = gunzipSync(readFileSync(from)).toString('utf8').split('\n');
  const file = join(root, name);
  writeFileSync(file, gzipSync(edit(lines).join('\n')));
  return file;
};

const server = await start(home, PORT);
try {
  console.log('A memory with awkward content');
  await tool(BASE, 'save_checkpoint', { project: 'Cooling Rig', title: 'Pick pump', summary: 'Quiet pump. Пример 例え 🚀', decisions: ['D5 pump'] });
  await tool(BASE, 'save_artifact', { project: 'Cooling Rig', name: 'log.md', content: `${'x'.repeat(9000)} the verdict is zircon ${'y'.repeat(5000)}` });
  await tool(BASE, 'remember', { key: 'editor', value: 'VS Code' });
  const gone = (await tool(BASE, 'save_checkpoint', { project: 'Cooling Rig', title: 'Drop', summary: 'temporary' })).match(/checkpoint:[0-9a-f-]+/)[0];
  await tool(BASE, 'forget', { ref: gone });
  await fetch(`${BASE}/api/ingest/conversation`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'claude', external_id: 'c1', title: 'Radiator', url: '', started_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', messages: [{ seq: 0, role: 'user', text: 'Which radiator?' }, { seq: 1, role: 'assistant', text: '360 mm obsidianfit' }] }),
  });

  console.log('Export');
  const archive = join(root, 'memory.lmarchive');
  const exp = cli(['export', '--from', join(home, 'memory.db'), '--to', archive]);
  check('export from the running memory finishes', exp.code === 0 && existsSync(archive), exp.all);
  const lines = gunzipSync(readFileSync(archive)).toString('utf8').trim().split('\n');
  const header = JSON.parse(lines[0]);
  check('the archive starts with a versioned header', header.archive === 'legendary-memory' && header.archive_version === 1 && header.schema_version >= 3, lines[0]);
  check('it carries the deletion ledger', lines.some((l) => l.includes('"t":"deletions"')));
  check('it carries no search index', !lines.some((l) => /"t":"search_/.test(l)));
  check('it ends with counts, a checksum and the manifest', /"end":\{"rows"/.test(lines[lines.length - 1]) && /body_sha256/.test(lines[lines.length - 1]));
  const remoteArchive = join(root, 'remote.lmarchive');
  const rexp = cli(['export', '--from', BASE, '--to', remoteArchive], { LEGENDARY_MEMORY_FROM_KEY: KEY });
  check('export from a hub over HTTP finishes with the same memories', rexp.code === 0 && hashOf(rexp.all) === hashOf(exp.all), rexp.all);
  check('the key is not printed', !rexp.all.includes(KEY));
  check('an existing file is never overwritten', /already exists/.test(cli(['export', '--from', join(home, 'memory.db'), '--to', archive]).all));

  console.log('Restore');
  const target = join(root, 'restored');
  const res = cli(['restore', '--from', archive, '--to', target]);
  check('restore finishes and verifies against the archive', res.code === 0 && /matches the archive/.test(res.all) && hashOf(res.all) === hashOf(exp.all), res.all);
  const restoredServer = await start(target, PORT + 1);
  try {
    const r = `http://127.0.0.1:${PORT + 1}`;
    check('the restored memory recalls the project', /Cooling Rig/.test(await tool(r, 'recall', { project: 'cooling rig' })));
    check('search works again, past character 8,000', /log\.md/.test(await tool(r, 'search', { query: 'zircon' })));
    check('chats came back', /offset 1/.test(await tool(r, 'search', { query: 'obsidianfit' })));
    check('unicode came back intact', /Пример 例え 🚀/.test(await tool(r, 'recall', { project: 'cooling rig', detail: 'full' })));
    check('deleted items stay deleted', !/temporary/.test(await tool(r, 'search', { query: 'temporary' })) || /Nothing stored/.test(await tool(r, 'search', { query: 'temporary' })));
  } finally {
    restoredServer.kill();
  }
  check('restore never writes into an existing memory', /already exists/.test(cli(['restore', '--from', archive, '--to', target]).all));

  console.log('Damaged and hostile archives');
  const cases = [
    ['a changed row', tamper(archive, 'changed.lmarchive', (l) => l.map((x) => x.replace('VS Code', 'VS C0de'))), /checksum does not match/],
    ['a cut-off file', tamper(archive, 'cut.lmarchive', (l) => l.slice(0, -2)), /ends early/],
    ['a newer format', tamper(archive, 'newer.lmarchive', (l) => [l[0].replace('"archive_version":1', '"archive_version":99'), ...l.slice(1)]), /newer Legendary Memory/],
    ['a newer schema', tamper(archive, 'schema.lmarchive', (l) => [l[0].replace(/"schema_version":\d+/, '"schema_version":99'), ...l.slice(1)]), /newer data format/],
    ['an unknown column', tamper(archive, 'column.lmarchive', (l) => l.map((x, i) => (i === 1 ? x.replace('{"t":"projects","r":{', '{"t":"projects","r":{"evil":"x",') : x))), /unknown column/],
    ['an unknown table', tamper(archive, 'table.lmarchive', (l) => [l[0], '{"t":"sqlite_master","r":{"x":1}}', ...l.slice(1)]), /unknown table/],
    ['not an archive', (() => { const f = join(root, 'junk.lmarchive'); writeFileSync(f, gzipSync('{"hello":1}\n')); return f; })(), /not a Legendary Memory archive/],
  ];
  for (const [name, file, expected] of cases) {
    const dest = join(root, `bad-${name.replace(/\W+/g, '-')}`);
    const run = cli(['restore', '--from', file, '--to', dest]);
    check(`${name} is refused in plain words`, run.code !== 0 && expected.test(run.all), run.all);
    check(`${name} leaves no memory behind`, !existsSync(join(dest, 'memory.db')));
  }
} catch (error) {
  check('suite ran without crashing', false, error?.stack ?? error);
} finally {
  server.kill();
  rmSync(root, { recursive: true, force: true });
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
