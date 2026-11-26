// Diverse content (execution plan P8.4.2): non-Latin scripts, emoji, code, right-to-left text and
// very long titles survive a save, come back from recall, search and the memory page unchanged,
// and appear correctly in the Markdown handoff. Results also document what search cannot do.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../dist/legendary-memory.mjs', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'lm-content-'));
const KEY = 'k'.repeat(40);
const PORT = 18861;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `\n         ${String(detail).slice(0, 400)}` : ''}`);
};

const child = spawn(process.execPath, [BIN, 'start', '--no-open', '--port', String(PORT)], {
  env: { HOME: home, LEGENDARY_MEMORY_DIR: join(home, '.legendary-memory'), LEGENDARY_MEMORY_KEY: KEY, PATH: '/usr/bin:/bin', NODE_NO_WARNINGS: '1' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let printed = '';
child.stderr.on('data', (d) => (printed += d));
for (let i = 0; i < 50 && !/#t=[0-9a-f]+/.test(printed); i++) await new Promise((r) => setTimeout(r, 100));
const token = printed.match(/#t=([0-9a-f]+)/)?.[1] ?? '';
const ui = (path) => fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
let rpc = 0;
const tool = async (name, args) => {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${KEY}`, 'User-Agent': 'claude-desktop' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data: ')) ?? text;
  const body = JSON.parse(line.replace(/^data: /, ''));
  return body.result?.content?.map((c) => c.text).join('\n') ?? JSON.stringify(body);
};

const SAMPLES = [
  { project: 'Охлаждение двигателя', title: 'Выбрали насос', summary: 'Сравнили два насоса; второй тише.', search: 'насос', why: 'Russian', also: 'насосы' },
  { project: '冷却システム', title: 'ファン曲線を決定', summary: 'サーミスタで制御する。', search: 'ファン曲線を決定', why: 'Japanese', also: 'サーミスタ' },
  { project: 'مشروع التبريد', title: 'اخترنا المضخة', summary: 'المضخة الثانية أهدأ.', search: 'المضخة', why: 'Arabic (right to left)' },
  { project: 'Emoji 🚀 Launch', title: 'Shipped 🎉 v2', summary: 'Team was 😴 after the launch; next: fix 🐛 in auth.', search: 'launch', why: 'emoji around words' },
  { project: 'Code Notes', title: 'Fixed `parseInt` bug', summary: 'Use `Number.parseInt(x, 10)` not `parseInt(x)`; see src/util.ts line 42 <script>alert(1)</script>', search: 'parseInt', why: 'code and HTML-looking text' },
  { project: 'Café Résumé', title: 'Naïve façade', summary: 'Accents: crème brûlée, jalapeño.', search: 'creme', why: 'accents (search without them)' },
];
const LONG = `A very long project title ${'that keeps going '.repeat(8)}end`.slice(0, 120);

try {
  console.log('Diverse content (P8.4.2)');
  for (const s of SAMPLES) {
    const saved = await tool('save_checkpoint', { project: s.project, title: s.title, summary: s.summary, new_project: true });
    check(`saves: ${s.why}`, !/error|could not/i.test(saved), saved);
  }
  await tool('save_checkpoint', { project: LONG, title: 'Long title test', summary: 'Checks wrapping.', new_project: true });

  for (const s of SAMPLES) {
    const back = await tool('recall', { project: s.project });
    check(`recall returns it unchanged: ${s.why}`, back.includes(s.title) && back.includes(s.summary), back.slice(0, 300));
  }
  const limits = [];
  for (const s of SAMPLES) {
    const hits = await tool('search', { query: s.search });
    const found = hits.includes(s.title);
    if (s.search === 'creme') limits.push(`accent-free search ("creme" for "crème"): ${found ? 'found' : 'not found'}`);
    else check(`search finds it: ${s.why}`, found, hits.slice(0, 300));
    if (s.also) limits.push(`${s.why} "${s.also}": ${(await tool('search', { query: s.also })).includes(s.title) ? 'found' : 'not found'}`);
  }
  console.log('Non-Latin names');
  const again = await tool('save_checkpoint', { project: 'مشروع التبريد', title: 'Second Arabic session', summary: 'Same project, no new_project flag.' });
  check('a second save to a non-Latin project goes to that project, not another', again.includes('مشروع التبريد') && !again.includes('Охлаждение'), again.slice(0, 300));
  check('one word of a non-Latin name recalls the project', (await tool('recall', { project: 'охлаждение' })).includes('Выбрали насос'));
  await tool('remember', { key: 'любимый редактор', value: 'Vim' });
  await tool('remember', { key: '好きなエディタ', value: 'Emacs' });
  const facts = (await (await ui('/ui/memory')).json()).facts;
  check('non-Latin fact keys stay separate', facts.length === 2 && new Set(facts.map((f) => f.key)).size === 2, JSON.stringify(facts));
  const view = await (await ui('/ui/memory')).json();
  for (const s of SAMPLES) {
    const p = view.projects.find((x) => x.name === s.project);
    check(`the page shows it unchanged: ${s.why}`, p && p.sessions.some((x) => x.title === s.title), JSON.stringify(view.projects.map((x) => x.name)));
  }
  check('a 120-character project name is kept whole', view.projects.some((x) => x.name === LONG));
  const code = view.projects.find((x) => x.name === 'Code Notes');
  const md = await (await ui(`/ui/handoff?id=${encodeURIComponent(code.id)}`)).text();
  check('the handoff keeps code and HTML-looking text as plain text', md.includes('`Number.parseInt(x, 10)`') && md.includes('<script>alert(1)</script>'));
  const ru = view.projects.find((x) => x.name === SAMPLES[0].project);
  const res = await ui(`/ui/handoff?id=${encodeURIComponent(ru.id)}`);
  check('a non-Latin project gets a usable handoff file name', /filename\*=UTF-8''%D0%9E/.test(res.headers.get('content-disposition') ?? '') && (await res.text()).startsWith(`# ${SAMPLES[0].project}`), res.headers.get('content-disposition'));
  check('times are stored in UTC (the page shows them in local time)', view.latest && /Z$/.test(view.latest.at), view.latest?.at);
  console.log(`  note ${limits.join('; ')}`);
} finally {
  child.kill();
  rmSync(home, { recursive: true, force: true });
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
