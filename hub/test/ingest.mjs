// Checks the data-contract rules for chat import and project names (docs/contracts/DATA-CONTRACT.md
// §3, §4): re-sending identical history writes nothing, one edit re-indexes one message, a title
// change re-indexes the chat, ambiguous names never write, and codex/cursor are valid sources.
// Temp folder and a 127.0.0.1 port only. Builds are done by `npm run test:ingest`.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../dist/legendary-memory.mjs', import.meta.url));
const KEY = 'i'.repeat(40);
const PORT = 18821;
const BASE = `http://127.0.0.1:${PORT}`;
const home = mkdtempSync(join(tmpdir(), 'lm-ingest-'));

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `\n         ${String(detail).slice(0, 600)}` : ''}`);
};
const env = { ...process.env, NODE_NO_WARNINGS: '1', LEGENDARY_MEMORY_DIR: home, LEGENDARY_MEMORY_KEY: KEY };
for (const name of Object.keys(env)) if (/^(HUB_URL|BRIDGE_API_KEY)/.test(name)) delete env[name];

let rpcId = 0;
async function tool(name, args) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${KEY}`, 'User-Agent': 'claude-desktop' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = JSON.parse(await res.text());
  return body.result?.content?.map((c) => c.text).join('\n') ?? JSON.stringify(body);
}
const ingest = (body) =>
  fetch(`${BASE}/api/ingest/conversation`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const peek = (sql, ...args) => {
  const db = new DatabaseSync(join(home, 'memory.db'), { readOnly: true });
  try {
    return db.prepare(sql).get(...args);
  } finally {
    db.close();
  }
};
const indexState = () => peek("SELECT count(*) AS n, coalesce(max(id), 0) AS max FROM search_map WHERE kind = 'message'");
const changes = () => peek('SELECT total_changes() AS n');

const server = spawn('node', [BIN, 'serve', '--port', String(PORT)], { env, stdio: ['ignore', 'ignore', 'pipe'] });
try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log('Re-sending history');
  const chat = {
    source: 'codex',
    external_id: 'thread-1',
    title: 'Pump choice',
    url: '',
    started_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    messages: Array.from({ length: 30 }, (_, seq) => ({ seq, role: seq % 2 ? 'assistant' : 'user', text: `Message ${seq} about the quiet pump.` })),
  };
  const first = await ingest(chat);
  check('codex is an accepted chat source', first.ok, await first.clone().text());
  check('cursor is an accepted chat source', (await ingest({ ...chat, source: 'cursor', external_id: 'c-1' })).ok);
  const before = indexState();
  check('every message of both chats is indexed', before.n === 60, before.n);
  for (let i = 0; i < 10; i++) await ingest(chat);
  const after = indexState();
  check('ten identical re-sends add or replace no index rows', after.n === before.n && after.max === before.max, `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  check('the messages are stored once', peek("SELECT count(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.external_id = 'thread-1'").n === 30);

  console.log('One edit');
  const edited = structuredClone(chat);
  edited.messages[7].text = 'Message 7 now says the loud pump. ZEBRA';
  await ingest(edited);
  const afterEdit = indexState();
  check('exactly one index row is replaced', afterEdit.n === before.n && afterEdit.max === before.max + 1, `${JSON.stringify(before)} → ${JSON.stringify(afterEdit)}`);
  const found = await tool('search', { query: 'zebra' });
  check('the edited text is searchable', /offset 7/.test(found), found);
  const stale = peek(
    "SELECT count(*) AS n FROM search_fts f JOIN search_map m ON m.id = f.rowid JOIN conversations c ON c.id = m.ref_id WHERE c.external_id = 'thread-1' AND m.seq = 7 AND f.body LIKE '%quiet%'",
  ).n;
  check('the old text of that message is gone from the index', stale === 0, stale);

  console.log('Appending and renaming');
  const longer = structuredClone(edited);
  longer.messages.push({ seq: 30, role: 'user', text: 'Order the fittings.' });
  await ingest(longer);
  const afterAppend = indexState();
  check('appending one message adds one index row', afterAppend.n === before.n + 1 && afterAppend.max === afterEdit.max + 1, JSON.stringify(afterAppend));
  check('message_count follows', peek("SELECT message_count AS n FROM conversations WHERE external_id = 'thread-1'").n === 31);
  await ingest({ ...longer, title: 'Pump decision', messages: [] });
  const titled = await tool('search', { query: 'decision' });
  check('a new title re-indexes the chat under it', /Pump decision/.test(titled), titled);

  console.log('Project names on writes');
  await tool('save_checkpoint', { project: 'Cooling Rig', title: 'a', summary: 'a' });
  await tool('save_checkpoint', { project: 'Cooking Club', title: 'b', summary: 'b', new_project: true });
  const count = () => peek('SELECT count(*) AS n FROM checkpoints').n;
  const n0 = count();
  const amb = await tool('save_checkpoint', { project: 'cookin', title: 'c', summary: 'c' });
  check('an ambiguous name ("cookin") saves nothing', count() === n0, amb);
  check('and lists both candidates', /Cooking Club/.test(amb) && /Cooling Rig/.test(amb), amb);
  const whole = await tool('save_checkpoint', { project: 'cooling', title: 'd', summary: 'd' });
  check('a whole-word name ("cooling") saves to Cooling Rig', /Cooling Rig/.test(whole) && count() === n0 + 1, whole);
  const word2 = await tool('save_checkpoint', { project: 'cooking', title: 'e', summary: 'e' });
  check('a whole-word name ("cooking") saves to Cooking Club', /Cooking Club/.test(word2) && count() === n0 + 2, word2);
  const read = await tool('recall', { project: 'cookin' });
  check('reads still answer an ambiguous name', /^# |Several projects/m.test(read), read);
} catch (error) {
  check('suite ran without crashing', false, error?.stack ?? error);
} finally {
  server.kill();
  rmSync(home, { recursive: true, force: true });
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
