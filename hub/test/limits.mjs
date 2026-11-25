// Storage limits (P2.5): an allowance warns from 80% and refuses new saves at 100%; a nearly full
// disk pauses saving; reading, searching, exporting and deleting always keep working, and
// deleting makes room again. Temp folders and 127.0.0.1 only. Builds: `npm run test:limits`.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../dist/legendary-memory.mjs', import.meta.url));
const KEY = 'q'.repeat(40);
const root = mkdtempSync(join(tmpdir(), 'lm-limits-'));

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `\n         ${String(detail).slice(0, 500)}` : ''}`);
};
const envFor = (dir, extra) => {
  const e = { ...process.env, NODE_NO_WARNINGS: '1', LEGENDARY_MEMORY_DIR: dir, LEGENDARY_MEMORY_KEY: KEY, ...extra };
  for (const name of Object.keys(e)) if (/^(HUB_URL|BRIDGE_API_KEY)/.test(name)) delete e[name];
  return e;
};
async function start(port, extra) {
  const dir = join(root, String(port));
  const child = spawn('node', [BIN, 'serve', '--port', String(port)], { env: envFor(dir, extra), stdio: ['ignore', 'ignore', 'pipe'] });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  let id = 0;
  const tool = async (name, args) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
    });
    const parsed = JSON.parse(await res.text());
    return { text: parsed.result?.content?.map((c) => c.text).join('\n') ?? JSON.stringify(parsed), isError: Boolean(parsed.result?.isError) };
  };
  // As big as the save that was just refused, so the answer does not depend on how much room the last save left.
  const ingest = () =>
    fetch(`${base}/api/ingest/conversation`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'claude', external_id: `c${Date.now()}`, title: 'x', url: '', messages: [{ seq: 0, role: 'user', text: filler(6000, 'chat') }] }),
    });
  return { child, dir, tool, ingest };
}
// Distinct words, so the search index grows with the text as it would for real notes.
const filler = (n, salt) => Array.from({ length: n }, (_, i) => `w${salt}x${i}`).join(' ');

try {
  console.log('A 2 MB allowance');
  const q = await start(18911, { LEGENDARY_MEMORY_QUOTA_MB: '2' });
  try {
    let note = '';
    let full = null;
    const saved = [];
    for (let i = 0; i < 60 && !full; i++) {
      const r = await q.tool('save_artifact', { project: 'Big Project', name: `notes-${i}.md`, content: filler(6000, i) });
      if (r.isError) full = r;
      else {
        saved.push(r.text.match(/artifact:[0-9a-f-]+/)?.[0]);
        if (/% of its 2 MB allowance/.test(r.text)) note ||= r.text.split('\n').pop();
      }
    }
    check('saves near the limit carry a note', /Memory is at (8\d|9\d|100)% of its 2 MB allowance/.test(note), note);
    check('at the limit a save is refused in plain words', full && /Memory is full: .* of its 2 MB allowance/.test(full.text) && /nothing new was saved/.test(full.text), full?.text);
    check('and the reply says what still works and how to make room', full && /Reading, searching, exporting and deleting still work/.test(full.text) && /delete or archive/.test(full.text));
    check('recall still works', /Big Project/.test((await q.tool('recall', { project: 'big project' })).text));
    check('search still works', !(await q.tool('search', { query: 'notes' })).isError);
    { const r = await q.ingest(); check('the importer API answers 507 with the reason', r.status === 507, `${r.status} ${await r.text()}`); }
    const exp = spawnSync('node', [BIN, 'export', '--from', join(q.dir, 'memory.db'), '--to', join(root, 'full.lmarchive')], { encoding: 'utf8', env: envFor(join(root, 'cli'), {}) });
    check('export still works', exp.status === 0 && existsSync(join(root, 'full.lmarchive')), exp.stderr);
    let freed = true;
    for (const ref of saved.slice(0, 6)) freed = freed && /Deleted/.test((await q.tool('forget', { ref })).text);
    check('deleting still works when full', freed);
    const again = await q.tool('save_artifact', { project: 'Big Project', name: 'after.md', content: 'small note' });
    check('after deleting, there is room to save again', !again.isError, again.text);
  } finally {
    q.child.kill();
  }

  console.log('A nearly full disk');
  const d = await start(18912, { LEGENDARY_MEMORY_MIN_FREE_MB: String(1024 * 1024 * 1024) });
  try {
    const r = await d.tool('save_checkpoint', { project: 'P', title: 't', summary: 's' });
    check('saving pauses with the reason and how much is free', r.isError && /Saving is paused: the disk .* has only .* free/.test(r.text), r.text);
    check('recall still works', !(await d.tool('recall', {})).isError);
    check('deleting is never refused for space', !/Saving is paused/.test((await d.tool('forget', { ref: 'profile:none' })).text));
  } finally {
    d.child.kill();
  }

  console.log('No limits set');
  const n = await start(18913, {});
  try {
    const r = await n.tool('save_artifact', { project: 'P', name: 'n.md', content: filler(6000, 'n') });
    check('saving works with no note', !r.isError && !/allowance/.test(r.text), r.text);
  } finally {
    n.child.kill();
  }
} catch (error) {
  check('suite ran without crashing', false, error?.stack ?? error);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
