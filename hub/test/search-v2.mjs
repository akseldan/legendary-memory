// Search index v2 (migrations/0002): upgrading a real 1.0.2 memory keeps every record, rebuilds
// the same index a fresh install builds, stores no second copy of the text, and finds words
// anywhere in long text. Temp folders and 127.0.0.1 only. Builds are done by `npm run test:search`.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../dist/legendary-memory.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/v1-memory.db', import.meta.url));
const KEY = 's'.repeat(40);
const root = mkdtempSync(join(tmpdir(), 'lm-search2-'));
const fixtureBytes = readFileSync(FIXTURE);

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `\n         ${String(detail).slice(0, 600)}` : ''}`);
};
const clean = (home) => {
  const env = { ...process.env, NODE_NO_WARNINGS: '1', LEGENDARY_MEMORY_DIR: home, LEGENDARY_MEMORY_KEY: KEY };
  for (const name of Object.keys(env)) if (/^(HUB_URL|BRIDGE_API_KEY|LEGENDARY_MEMORY_FROM)/.test(name)) delete env[name];
  return env;
};
const cli = (home, args) => {
  const run = spawnSync('node', [BIN, ...args], { encoding: 'utf8', timeout: 60_000, env: clean(home) });
  return { all: run.stdout + run.stderr, code: run.status };
};
const peek = (file, sql) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
};

async function withServer(home, port, body) {
  const server = spawn('node', [BIN, 'serve', '--port', String(port)], { env: clean(home), stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  server.stderr.on('data', (d) => (err += d));
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    let id = 0;
    const tool = async (name, args) => {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${KEY}`, 'User-Agent': 'claude-desktop' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
      });
      const parsed = JSON.parse(await res.text());
      return parsed.result?.content?.map((c) => c.text).join('\n') ?? JSON.stringify(parsed);
    };
    return await body(tool);
  } catch (error) {
    throw new Error(`${error?.message}\n${err}`);
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 200));
  }
}

try {
  console.log('Upgrade a 1.0.2 memory');
  const before = join(root, 'before.db');
  const beforeBackup = cli(root, ['backup', '--from', FIXTURE, '--to', before]);
  check('the 1.0.2 fixture reads as schema 1', peek(FIXTURE, 'PRAGMA user_version')[0].user_version === 1, beforeBackup.all);
  const hashBefore = JSON.parse(readFileSync(`${before}.manifest.json`, 'utf8')).memory_sha256;

  const homeA = join(root, 'upgraded');
  mkdirSync(homeA);
  copyFileSync(FIXTURE, join(homeA, 'memory.db'));
  const fileA = join(homeA, 'memory.db');

  await withServer(homeA, 18851, async (tool) => {
    check('the upgraded memory opens and recalls', /Cooling Rig/.test(await tool('recall', { project: 'cooling rig' })));

    const zircon = await tool('search', { query: 'zircon' });
    check('a phrase after character 8,000 of a saved file is found', /build-log\.md/.test(zircon) && /zircon/i.test(zircon), zircon);
    const obsidian = await tool('search', { query: 'obsidianfit' });
    check('a phrase after character 8,000 of a chat message is found, at its message', /offset 1\)/.test(obsidian) && /obsidianfit/.test(obsidian), obsidian);
    const heatsink = await tool('search', { query: 'heatsink' });
    check('short records are still found, with their titles', /Pick pump/.test(heatsink), heatsink);
    const stem = await tool('search', { query: 'pumps' });
    check('stemming still works (pumps → pump)', /Pick pump/.test(stem), stem);
    const ru = await tool('search', { query: 'насос' });
    check('Russian text is found', /offset 2\)/.test(ru), ru);
    const many = await tool('search', { query: 'filler5' });
    const lines = many.split('\n').filter((l) => l.includes('build-log.md'));
    check('a long file matching in every chunk is listed once', lines.length === 1, many);
    check('its snippet shows the matched word', /filler5/.test(lines[0] ?? ''), lines[0]);

    // Edits after the upgrade keep the index right.
    await tool('save_artifact', { project: 'Cooling Rig', name: 'build-log.md', content: 'Short now.' });
    const gone = await tool('search', { query: 'zircon' });
    check('an edit removes the old words of every chunk', /Nothing stored matches/.test(gone), gone);
    check('the edited file has one index row', peek(fileA, "SELECT count(*) AS n FROM search_map WHERE kind = 'artifact'")[0].n === 1);
  });

  const CURRENT = (await import('node:fs')).readdirSync(fileURLToPath(new URL('../migrations/', import.meta.url))).filter((f) => f.endsWith('.sql')).length;
  check(`the upgraded file is at the current schema (${CURRENT})`, peek(fileA, 'PRAGMA user_version')[0].user_version === CURRENT);
  const ftsSql = peek(fileA, "SELECT sql FROM sqlite_master WHERE name = 'search_fts'")[0]?.sql ?? '';
  check('the index keeps no copy of the text (contentless)', /content\s*=\s*''/.test(ftsSql) && peek(fileA, "SELECT count(*) AS n FROM sqlite_master WHERE name = 'search_fts_content'")[0].n === 0, ftsSql);
  check('the rebuild left no work table behind', peek(fileA, "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE '_search_rebuild%'")[0].n === 0);

  console.log('The migration builds the index a fresh install builds');
  // Upgrade an untouched copy and import the same fixture into a fresh v2 home, then compare.
  const homeB = join(root, 'upgraded-untouched');
  mkdirSync(homeB);
  copyFileSync(FIXTURE, join(homeB, 'memory.db'));
  await withServer(homeB, 18852, async (tool) => tool('recall', {}));
  const fresh = join(root, 'fresh', 'memory.db');
  const copied = cli(root, ['copy', '--from', FIXTURE, '--to', fresh, '--apply']);
  check('a fresh install imports the 1.0.2 memory', copied.code === 0, copied.all);
  const shape = (file) =>
    // Chats are identified by (source, external_id); their local id differs between homes.
    JSON.stringify(
      peek(
        file,
        `SELECT m.kind, CASE m.kind WHEN 'message' THEN c.source || ':' || c.external_id ELSE m.ref_id END AS ref, m.seq, m.chunk, m.project_id
         FROM search_map m LEFT JOIN conversations c ON m.kind = 'message' AND c.id = m.ref_id ORDER BY 1, 2, 3, 4`,
      ).map((r) => ({ ...r })),
    );
  const upgraded = shape(join(homeB, 'memory.db'));
  check('same index rows (kind, record, message, chunk, project)', upgraded === shape(fresh), `${upgraded.slice(0, 300)}\nvs\n${shape(fresh).slice(0, 300)}`);
  check('long text is split into several chunks', peek(fresh, 'SELECT max(chunk) AS k FROM search_map')[0].k >= 2);
  const words = (file, q) =>
    peek(
      file,
      `SELECT m.kind, CASE m.kind WHEN 'message' THEN c.external_id ELSE m.ref_id END AS ref, m.seq, m.chunk
       FROM search_fts JOIN search_map m ON m.id = search_fts.rowid LEFT JOIN conversations c ON m.kind = 'message' AND c.id = m.ref_id
       WHERE search_fts MATCH '${q}' ORDER BY 1, 2, 3, 4`,
    ).map((r) => ({ ...r }));
  for (const q of ['zircon', 'obsidianfit', 'filler5', 'dumplings', 'radiator', 'editor']) {
    check(`"${q}" matches the same rows in both`, JSON.stringify(words(join(homeB, 'memory.db'), q)) === JSON.stringify(words(fresh, q)));
  }

  console.log('Compact');
  const compacted = cli(homeB, ['compact']);
  check('compact runs on the upgraded memory', compacted.code === 0 && /Compacted|Nothing worth compacting/.test(compacted.all), compacted.all);
  check('a second compact has nothing to do', /Nothing worth compacting/.test(cli(homeB, ['compact']).all));

  console.log('Records are untouched');
  const after = join(root, 'after.db');
  cli(root, ['backup', '--from', join(homeB, 'memory.db'), '--to', after]);
  check('the memories hash the same before and after the upgrade', JSON.parse(readFileSync(`${after}.manifest.json`, 'utf8')).memory_sha256 === hashBefore);
  check('restoring from the 1.0.2 file never changed that file', Buffer.compare(fixtureBytes, readFileSync(FIXTURE)) === 0);
} catch (error) {
  check('suite ran without crashing', false, error?.stack ?? error);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
