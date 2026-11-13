// End-to-end check of the local target (no account). Builds are done by `npm run test:local`.
// Starts the bundled server on a temp database, then also drives the stdio entry point.
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../dist/legendary-memory.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'lm-'));
const KEY = 'k'.repeat(40);
const PORT = 18787;
const BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, LEGENDARY_MEMORY_DIR: dir, LEGENDARY_MEMORY_KEY: KEY, NODE_NO_WARNINGS: '1' };

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `\n         ${String(detail).slice(0, 400)}` : ''}`);
};

const server = spawn('node', [BIN, 'serve', '--port', String(PORT)], { env, stdio: ['ignore', 'ignore', 'pipe'] });
let serverErr = '';
server.stderr.on('data', (d) => (serverErr += d));
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 100));
}

let id = 0;
const rpc = (method, params) => ({ jsonrpc: '2.0', id: ++id, method, params });
async function mcp(method, params, key = KEY) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(rpc(method, params)),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { res, body };
}
const call = async (name, args) => (await mcp('tools/call', { name, arguments: args })).body.result;
const text = (r) => r?.content?.map((c) => c.text).join('\n') ?? '';

try {
  console.log('HTTP target');
  check('server starts', (await fetch(`${BASE}/api/health`)).ok, serverErr);
  check('no key -> 401', (await mcp('tools/list', {}, '')).res.status === 401);
  check('wrong key -> 401', (await mcp('tools/list', {}, 'x'.repeat(40))).res.status === 401);
  const hostStatus = (host) => new Promise((resolve) => {
    const r = httpRequest({ host: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST', headers: { Host: host, Authorization: `Bearer ${KEY}` } }, (res) => { res.resume(); resolve(res.statusCode); });
    r.on('error', () => resolve(0)); r.end('{}');
  });
  check('non-local Host header refused (DNS-rebinding guard)', (await hostStatus('evil.example')) === 403);
  check('local Host header accepted', (await hostStatus(`localhost:${PORT}`)) !== 403);

  const init = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } });
  check('initialize works', init.body.result?.serverInfo?.name === 'legendary-memory', JSON.stringify(init.body));
  const tools = (await mcp('tools/list', {})).body.result?.tools ?? [];
  check('seven tools listed', tools.length === 7, tools.map((t) => t.name).join());

  const saved = await call('save_checkpoint', {
    project: 'Cooling System', title: 'First session', summary: 'Chose a quartzite heatsink for the zebrafish rig.',
    decisions: ['Use quartzite because it is cheap'], next_steps: ['Order parts'], brief: 'Goal: cool the rig.',
  });
  check('save_checkpoint creates project', !saved.isError && /Cooling System/.test(text(saved)), text(saved));
  check('recall by loose name', /quartzite/.test(text(await call('recall', { project: 'the cooling project' }))));
  check('recall with typo', /quartzite/.test(text(await call('recall', { project: 'Coolng System' }))));
  check('search finds a word', /quartzite|Cooling/.test(text(await call('search', { query: 'heatsink' }))));
  check('overview lists project', /Cooling System/.test(text(await call('recall', {}))));

  const secret = await call('save_artifact', { project: 'Cooling System', name: 'notes.txt', content: 'key sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD end' });
  const art = text(secret);
  const artRef = art.match(/artifact:[0-9a-f-]+/)?.[0];
  check('artifact saved', !secret.isError && artRef, art);
  const readBack = text(await call('read', { ref: artRef }));
  check('secret redacted on save', !/sk-abcdefghijkl/.test(readBack) && /end/.test(readBack), readBack);

  await call('remember', { key: 'answer-style', value: 'short and direct' });
  check('remember + overview shows fact', /short and direct/.test(text(await call('recall', {}))));
  const gone = await call('forget', { ref: 'profile:answer-style' });
  check('forget removes fact', !/short and direct/.test(text(await call('recall', {}))) && !gone.isError, text(gone));
  check('forget removes search rows', !/answer-style/.test(text(await call('search', { query: 'direct' }))));

  console.log('API');
  const api = (path, init = {}) => fetch(`${BASE}${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}`, ...init.headers } });
  check('api without key -> 401', (await fetch(`${BASE}/api/ingest/conversation`, { method: 'POST', body: '{}' })).status === 401);
  const payload = (t) => JSON.stringify({ source: 'chatgpt', external_id: 'abc', title: 'Chat', messages: [{ seq: 0, role: 'user', text: t }] });
  check('ingest ok', (await api('/api/ingest/conversation', { method: 'POST', body: payload('the narwhal protocol') })).status === 200);
  check('ingest again updates', (await api('/api/ingest/conversation', { method: 'POST', body: payload('the narwhal revision') })).status === 200);
  const convos = (await api('/api/export?table=conversations').then((r) => r.json()));
  check('no duplicate conversation', (convos.rows ?? convos.results ?? []).length === 1, JSON.stringify(convos).slice(0, 200));
  check('search finds chat text', /narwhal/.test(text(await call('search', { query: 'narwhal' }))));

  console.log('stdio');
  const child = spawn('node', [BIN, 'stdio'], { env: { ...env, LEGENDARY_MEMORY_DIR: dir }, stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      try { const m = JSON.parse(line); pending.get(m.id)?.(m); } catch {}
    }
  });
  const send = (method, params) => new Promise((resolve) => {
    const m = rpc(method, params); pending.set(m.id, resolve); child.stdin.write(JSON.stringify(m) + '\n');
  });
  const sinit = await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Claude Desktop', version: '1' } });
  check('stdio initialize', sinit.result?.serverInfo?.name === 'legendary-memory');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const srec = await send('tools/call', { name: 'recall', arguments: { project: 'Cooling System' } });
  check('stdio sees same database', /quartzite/.test(text(srec.result)));
  const ssave = await send('tools/call', { name: 'save_checkpoint', arguments: { project: 'Cooling System', title: 'From desktop', summary: 'Ordered the parts.' } });
  check('stdio can save', !ssave.result?.isError, text(ssave.result));
  check('stdio labels source from client name', /claude/.test(text(await call('recall', { project: 'Cooling System' }))) && /· claude ·/.test(text(await call('recall', { project: 'Cooling System' }))));
  child.kill();
} finally {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
