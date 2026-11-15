// Checks `legendary-memory copy`: one memory added to another with ids and dates kept, safe to
// repeat, nothing deleted, and keys never shown. Everything runs on temp folders and
// 127.0.0.1 ports; no real hub is ever named. Builds are done by `npm run test:copy`.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../dist/legendary-memory.mjs', import.meta.url));
const KEY_A = 'a'.repeat(40);
const KEY_B = 'b'.repeat(40);
const KEY_C = 'c'.repeat(40);
const PASS = 'correct horse battery staple';
const BASE = { A: 'http://127.0.0.1:18801', B: 'http://127.0.0.1:18802', C: 'http://127.0.0.1:18803' };
const root = mkdtempSync(join(tmpdir(), 'lm-copy-'));
const dir = { A: join(root, 'a'), B: join(root, 'b'), C: join(root, 'c'), D: join(root, 'd') };

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `\n         ${String(detail).slice(0, 600)}` : ''}`);
};

// The children never see a real hub's settings, whatever is set in this shell.
const clean = () => {
  const env = { ...process.env, NODE_NO_WARNINGS: '1' };
  for (const name of Object.keys(env)) if (/^(HUB_URL|BRIDGE_API_KEY|LEGENDARY_MEMORY_)/.test(name)) delete env[name];
  return env;
};

const servers = [];
async function serve(which, port, key, args = ['serve', '--port', String(port)], extra = {}) {
  const child = spawn('node', [BIN, ...args], { env: { ...clean(), LEGENDARY_MEMORY_DIR: dir[which], LEGENDARY_MEMORY_KEY: key, ...extra }, stdio: ['ignore', 'ignore', 'pipe'] });
  servers.push(child);
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return child; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server ${which} did not start`);
}

let rpcId = 0;
async function tool(base, key, name, args) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${key}`, 'User-Agent': 'claude-desktop' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = JSON.parse(await res.text());
  return body.result?.content?.map((c) => c.text).join('\n') ?? JSON.stringify(body);
}
const api = (base, key, path, body) =>
  fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
const exported = async (base, key, table) => {
  const rows = [];
  for (let after = 0; ; ) {
    const page = await (await api(base, key, `/api/export?table=${table}&after=${after}&limit=500`)).json();
    rows.push(...page.rows);
    if (page.next === null) return rows;
    after = page.next;
  }
};
const strip = (rows) => rows.map(({ _rowid, ...rest }) => rest);

/** Runs the copy command. Keys travel in the environment, as documented. */
function copy(args, env = {}) {
  const run = spawnSync('node', [BIN, 'copy', ...args], { encoding: 'utf8', timeout: 120_000, env: { ...clean(), LEGENDARY_MEMORY_FROM_KEY: KEY_A, LEGENDARY_MEMORY_TO_KEY: KEY_B, LEGENDARY_MEMORY_DIR: join(root, 'cli'), ...env } });
  return { out: run.stdout, err: run.stderr, all: run.stdout + run.stderr, code: run.status };
};

try {
  const a = await serve('A', 18801, KEY_A);
  await serve('B', 18802, KEY_B);

  console.log('Seed the source');
  const OLD = '2024-03-01T10:00:00.000Z';
  await tool(BASE.A, KEY_A, 'save_checkpoint', { project: 'Cooling System', title: 'Chose the fan curve', summary: 'Thermistor-driven curve for the quiet build.', decisions: ['Use a curve'], next_steps: ['Test under load'], brief: 'Goal: quiet cooling.' });
  await tool(BASE.A, KEY_A, 'save_checkpoint', { project: 'Cooling System', title: 'Compared pumps', summary: 'Two pumps tested.' });
  await tool(BASE.A, KEY_A, 'save_artifact', { project: 'Cooling System', name: 'fan.py', content: 'def curve(t): return t * 2  # zephyrword', kind: 'code' });
  await tool(BASE.A, KEY_A, 'remember', { key: 'answer-style', value: 'Short answers, plain words, quillfact.' });
  const chat = (n) => Array.from({ length: n }, (_, i) => ({ seq: i, role: i % 2 ? 'assistant' : 'user', text: i === 0 ? 'The marmalade protocol for chat one' : `message ${i}` }));
  const ingest = (external_id, n, extra = {}) => api(BASE.A, KEY_A, '/api/ingest/conversation', { source: 'chatgpt', external_id, title: `Chat ${external_id}`, started_at: '2024-02-01T09:00:00Z', messages: chat(n), ...extra });
  check('seeded a small chat filed under the project', (await ingest('c1', 6, { project: 'Cooling System' })).status === 200);
  check('seeded a long chat', (await ingest('long', 0, { messages: chat(2500).slice(0, 1500) })).status === 200 && (await ingest('long', 0, { messages: chat(2500).slice(1500) })).status === 200);
  // Give the source old dates, as a long-lived memory would have, and plant a secret directly.
  const sa = new DatabaseSync(join(dir.A, 'memory.db'));
  sa.exec(`UPDATE checkpoints SET created_at = '${OLD}'; UPDATE projects SET created_at = '${OLD}', updated_at = '${OLD}'; UPDATE conversations SET updated_at = '2024-02-02T09:00:00.000Z'`);
  sa.exec("UPDATE checkpoints SET summary = summary || ' key ghp_abcdefghijklmnopqrstuvwxyz0123456789' WHERE title = 'Compared pumps'");
  sa.close();

  console.log('\nReport only');
  const dry = copy(['--from', BASE.A, '--to', BASE.B]);
  check('a dry run exits cleanly and says nothing was written', dry.code === 0 && /Nothing was written/.test(dry.out), dry.all);
  check('it reports what would be copied', /projects\s+1 new/.test(dry.out) && /sessions\s+2 new/.test(dry.out) && /facts\s+1 new/.test(dry.out) && /chats\s+2 new/.test(dry.out), dry.out);
  for (const table of ['projects', 'checkpoints', 'artifacts', 'profile', 'conversations', 'messages']) {
    if ((await exported(BASE.B, KEY_B, table)).length) check(`dry run left ${table} empty`, false);
  }
  check('dry run left the destination empty', true);

  console.log('\nCopy');
  const run = copy(['--from', BASE.A, '--to', BASE.B, '--apply']);
  check('apply exits cleanly', run.code === 0 && /Done/.test(run.out), run.all);
  for (const table of ['projects', 'checkpoints', 'artifacts', 'profile', 'conversations']) {
    const [x, y] = await Promise.all([exported(BASE.A, KEY_A, table), exported(BASE.B, KEY_B, table)]);
    // Same rows including ids and dates; a conversation's own id is minted by the destination.
    const ident = (r) => ({ id: r.id, project_id: r.project_id, source: r.source, title: r.title, created_at: r.created_at });
    const same = table === 'checkpoints' ? JSON.stringify(x.map(ident)) === JSON.stringify(y.map(ident)) : table === 'conversations' ? x.length === y.length && x.every((r, i) => r.updated_at === y[i].updated_at && r.started_at === y[i].started_at && r.external_id === y[i].external_id && r.message_count === y[i].message_count) : JSON.stringify(strip(x)) === JSON.stringify(strip(y));
    check(`${table} match the source (ids, text and dates)`, same && x.length > 0, `${x.length} vs ${y.length}`);
  }
  const messagesB = await exported(BASE.B, KEY_B, 'messages');
  check('a 2,500-message chat arrives whole across requests', messagesB.length === 2506, String(messagesB.length));
  const convB = await exported(BASE.B, KEY_B, 'conversations');
  const projB = await exported(BASE.B, KEY_B, 'projects');
  check('a filed chat is filed under the same project', convB.find((c) => c.external_id === 'c1')?.project_id === projB[0].id && convB.find((c) => c.external_id === 'long')?.project_id === null);
  for (const [word, kind] of [['thermistor', 'checkpoint'], ['zephyrword', 'artifact'], ['quillfact', 'profile'], ['marmalade', 'message']]) {
    check(`search on the destination finds a ${kind}`, /Cooling|answer-style|marmalade|fan\.py|Chat/i.test(await tool(BASE.B, KEY_B, 'search', { query: word })) && !/No matches|nothing/i.test(await tool(BASE.B, KEY_B, 'search', { query: word })), await tool(BASE.B, KEY_B, 'search', { query: word }));
  }
  const pumps = (await exported(BASE.B, KEY_B, 'checkpoints')).find((c) => c.title === 'Compared pumps');
  check('a secret on the source is redacted on the destination', !pumps.summary.includes('ghp_abcdef') && /REDACTED/i.test(pumps.summary), pumps.summary);
  check('the key is never printed', ![KEY_A, KEY_B].some((k) => run.all.includes(k) || dry.all.includes(k)));

  console.log('\nRepeat and differ');
  const before = JSON.stringify(strip(await exported(BASE.B, KEY_B, 'checkpoints'))) + JSON.stringify(strip(await exported(BASE.B, KEY_B, 'messages')));
  const again = copy(['--from', BASE.A, '--to', BASE.B, '--apply']);
  check('a second apply adds nothing', again.code === 0 && /projects\s+0 new/.test(again.out) && /sessions\s+0 new/.test(again.out) && /chats\s+0 new, 0 extended/.test(again.out), again.out);
  check('and changes no data', before === JSON.stringify(strip(await exported(BASE.B, KEY_B, 'checkpoints'))) + JSON.stringify(strip(await exported(BASE.B, KEY_B, 'messages'))));
  // The destination edits a file and a brief; the source has older versions of both.
  await tool(BASE.B, KEY_B, 'save_artifact', { project: 'Cooling System', name: 'fan.py', content: 'def curve(t): return t * 3  # edited on B', kind: 'code' });
  const differ = copy(['--from', BASE.A, '--to', BASE.B, '--apply']);
  check('a file that differs is kept as the destination has it and reported', /file fan\.py: differs, kept the destination's/.test(differ.out) && /1 differ/.test(differ.out), differ.out);
  const kept = (await exported(BASE.B, KEY_B, 'artifacts'))[0];
  check('the destination file is untouched', kept.content.includes('edited on B'));
  // The source gets a newer edit than B's; --replace-older takes it.
  await tool(BASE.A, KEY_A, 'save_artifact', { project: 'Cooling System', name: 'fan.py', content: 'def curve(t): return t * 4  # newest on A', kind: 'code' });
  const replaced = copy(['--from', BASE.A, '--to', BASE.B, '--apply', '--replace-older']);
  check('--replace-older takes the newer file and lists it', /file fan\.py: replaced/.test(replaced.out) && (await exported(BASE.B, KEY_B, 'artifacts'))[0].content.includes('newest on A'), replaced.out);

  console.log('\nExisting project on the destination');
  await serve('C', 18803, KEY_C);
  await tool(BASE.C, KEY_C, 'save_checkpoint', { project: 'cooling system', title: 'Started on C', summary: 'Own history.', brief: 'Goal: something else entirely.' });
  const merge = copy(['--from', BASE.A, '--to', BASE.C, '--apply'], { LEGENDARY_MEMORY_TO_KEY: KEY_C });
  const projC = await exported(BASE.C, KEY_C, 'projects');
  const sessionsC = await exported(BASE.C, KEY_C, 'checkpoints');
  check('a same-named project is merged, not duplicated', projC.length === 1 && sessionsC.length === 3 && sessionsC.every((c) => c.project_id === projC[0].id), `${projC.length} projects, ${sessionsC.length} sessions`);
  check('its brief is kept and the difference is reported', projC[0].brief === 'Goal: something else entirely.' && /brief differs, kept the destination's/.test(merge.out), merge.out);
  check('the other brief is kept in history, not lost', (await exported(BASE.C, KEY_C, 'brief_versions')).some((v) => v.brief === 'Goal: quiet cooling.'));
  check('chats from a merged project are filed under the destination project', (await exported(BASE.C, KEY_C, 'conversations')).find((c) => c.external_id === 'c1')?.project_id === projC[0].id);

  console.log('\nFiles, local and the third target');
  const toFile = copy(['--from', BASE.A, '--to', join(dir.D, 'copy.db'), '--apply']);
  check('a source hub can be copied into a .db file', toFile.code === 0 && /sessions\s+2 new/.test(toFile.out), toFile.all);
  const fromFile = copy(['--from', join(dir.D, 'copy.db'), '--to', BASE.B]);
  check('and a .db file read as a source', fromFile.code === 0 && /projects\s+0 new, 1 already there/.test(fromFile.out), fromFile.all);
  const host = spawn('node', [BIN, 'host', '--url', BASE.C.replace('18803', '18804'), '--port', '18804'], { env: { ...clean(), LEGENDARY_MEMORY_DIR: join(root, 'h'), LEGENDARY_MEMORY_PASSPHRASE: PASS, LEGENDARY_MEMORY_KEY: 'h'.repeat(40) }, stdio: ['ignore', 'ignore', 'pipe'] });
  servers.push(host);
  for (let i = 0; i < 60; i++) { try { if ((await fetch('http://127.0.0.1:18804/api/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  const toHost = copy(['--from', BASE.A, '--to', 'http://127.0.0.1:18804', '--apply'], { LEGENDARY_MEMORY_TO_KEY: 'h'.repeat(40) });
  check('the own-server target accepts a copy', toHost.code === 0 && (await exported('http://127.0.0.1:18804', 'h'.repeat(40), 'checkpoints')).length === 2, toHost.all);

  console.log('\nRefusals');
  check('--key is refused with the reason', copy(['--from', BASE.A, '--to', BASE.B, '--key', 'x']).code === 1 && /shell history/.test(copy(['--from', BASE.A, '--to', BASE.B, '--key', 'x']).all));
  check('the same place twice is refused', /same place/.test(copy(['--from', BASE.A, '--to', BASE.A]).all));
  check('plain http to another machine is refused', /https/.test(copy(['--from', BASE.A, '--to', 'http://example.com']).all));
  check('a wrong key is reported without printing it', (() => { const r = copy(['--from', BASE.A, '--to', BASE.B], { LEGENDARY_MEMORY_TO_KEY: 'z'.repeat(40) }); return r.code === 1 && /refused the key/.test(r.all) && !r.all.includes('z'.repeat(40)); })());
  check('a missing source file is reported', /no memory file/.test(copy(['--from', join(dir.D, 'nope.db'), '--to', BASE.B]).all));
  check('an unknown --only group is refused', /--only takes/.test(copy(['--from', BASE.A, '--to', BASE.B, '--only', 'everything']).all));
  void a;
} finally {
  for (const child of servers) child.kill();
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
