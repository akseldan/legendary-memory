// Deterministic reference fixtures for P1.3: chat history of a chosen size with the awkward cases
// the plan names (duplicates, edits, long artifacts, code, multilingual text, two projects whose
// names differ by one letter) plus a judged set of recall questions with their expected answers.
//
//   node bench/fixtures.mjs --messages 10000 --out bench/out/fx-10k
//
// Writes <out>.jsonl (one /api/ingest/conversation body per line, in import order, duplicates and
// edits included), <out>.judgments.json and <out>.projects.json. Same arguments, same bytes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const arg = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const TARGET = Number(arg('--messages', '10000'));
const OUT = arg('--out', `bench/out/fx-${TARGET}`);
const SEED = Number(arg('--seed', '42'));

// mulberry32: small, fast, reproducible.
let state = SEED >>> 0;
const rand = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(rand() * list.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const EN = 'the we should then maybe pump fan curve quiet loud test build order parts budget schedule plan draft review notes because after before decide keep drop try measure compare latency storage backup restore import export project memory assistant summary checkpoint release installer window linux mac phone tablet sync search index token cost price user account session'.split(' ');
const RU = 'проект память помощник решение тест сборка план бюджет заметки поиск резервная копия восстановление импорт экспорт пользователь'.split(' ');
const JA = 'プロジェクト 記憶 アシスタント 決定 テスト 計画 検索 バックアップ 復元 ユーザー'.split(' ');
const CODE = [
  'function add(a, b) {\n  return a + b;\n}',
  'SELECT id, name FROM projects WHERE status = \'active\' ORDER BY updated_at DESC;',
  'const fan = (t) => Math.min(100, Math.max(20, (t - 30) * 4));',
  'for i in range(10):\n    print(i ** 2)',
];

function sentence(words, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(pick(words));
  const s = out.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

/** About `chars` characters of mixed text: mostly English, some Russian/Japanese, some code. */
function text(chars) {
  const parts = [];
  let length = 0;
  while (length < chars) {
    const r = rand();
    const part = r < 0.8 ? sentence(EN, int(6, 18)) : r < 0.88 ? sentence(RU, int(4, 10)) : r < 0.93 ? JA.slice(0, int(3, 8)).join('、') + '。' : '```\n' + pick(CODE) + '\n```';
    parts.push(part);
    length += part.length + 1;
  }
  return parts.join(' ').slice(0, chars);
}

const PROJECTS = [
  { name: 'Cooling Rig', aliases: 'pc cooling, water loop' },
  { name: 'Cooking Club', aliases: 'club meetups' },
  { name: 'Legendary Memory', aliases: 'legendary-memory, memory hub' },
  { name: 'Calc 3 Homework', aliases: 'TMATH 126, calc' },
  { name: 'Internship Search', aliases: 'internships' },
  { name: 'Smart Home', aliases: 'govee, voice assistant' },
  { name: 'Portfolio Site', aliases: 'portfolio, website' },
  { name: 'Rocket Club', aliases: 'flight computer' },
];

const judgments = [];
const lines = [];
let messages = 0;
let conversationNo = 0;
const start = Date.UTC(2025, 0, 1);

while (messages < TARGET) {
  conversationNo++;
  const project = PROJECTS[conversationNo % PROJECTS.length];
  const count = Math.min(int(4, 80), TARGET - messages);
  const started = new Date(start + conversationNo * 3_600_000 * 7).toISOString();
  const body = {
    source: pick(['claude', 'chatgpt', 'gemini']),
    external_id: `fx-${SEED}-${conversationNo}`,
    title: `${project.name}: ${sentence(EN, 4).slice(0, -1)}`,
    url: '',
    started_at: started,
    updated_at: started,
    project_name: project.name,
    messages: [],
  };
  for (let seq = 0; seq < count; seq++) {
    // Mostly ~2 KiB; 2% are long documents (10–30 KB) to exercise the index cut-off.
    const long = rand() < 0.02;
    let t = text(long ? int(10_000, 30_000) : int(400, 3_600));
    if (long && judgments.filter((j) => j.kind === 'beyond-8000').length < 20) {
      const needle = `needle${conversationNo}x${seq}`;
      t = `${t.slice(0, 9_000)} The deciding detail is ${needle} for this build. ${t.slice(9_000)}`;
      judgments.push({ kind: 'beyond-8000', query: needle, expect: { conversation: body.external_id, seq }, note: 'phrase sits after character 8,000' });
    }
    if (seq === 1 && conversationNo % 50 === 0) {
      const needle = `decision${conversationNo}`;
      t = `We decided ${needle}: use the quieter part. ${t}`;
      judgments.push({ kind: 'decision', query: needle, expect: { conversation: body.external_id, seq, project: project.name } });
    }
    body.messages.push({ seq, role: seq % 2 ? 'assistant' : 'user', text: t });
  }
  messages += count;
  lines.push(body);

  // Every 25th chat appears twice in the export unchanged (re-sent history).
  if (conversationNo % 25 === 0) lines.push(structuredClone(body));
  // Every 40th chat is re-sent later with its last message edited.
  if (conversationNo % 40 === 0 && body.messages.length > 0) {
    const edited = structuredClone(body);
    const last = edited.messages[edited.messages.length - 1];
    last.text = `${last.text} EDITED-${conversationNo}`;
    edited.updated_at = new Date(Date.parse(started) + 86_400_000).toISOString();
    lines.push(edited);
    judgments.push({ kind: 'edit', query: `EDITED-${conversationNo}`, expect: { conversation: body.external_id, seq: last.seq }, note: 'only the edited text should be stored once' });
  }
}

// Project-name resolution cases from the owner's example.
judgments.push(
  { kind: 'project-name', query: 'cooling rig', expect: { project: 'Cooling Rig', confirm: false } },
  { kind: 'project-name', query: 'cooking', expect: { project: 'Cooking Club', confirm: false }, note: 'whole word of exactly one project' },
  { kind: 'project-name', query: 'cookin', expect: { candidates: ['Cooking Club', 'Cooling Rig'], confirm: true }, note: 'a write must ask which one' },
  { kind: 'project-name', query: 'cooling', expect: { project: 'Cooling Rig', confirm: false } },
  { kind: 'project-name', query: 'legendery memory', expect: { project: 'Legendary Memory', confirm: false } },
  { kind: 'project-name', query: 'basket weaving', expect: { project: null }, note: 'missing result: say so, do not guess' },
);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(`${OUT}.jsonl`, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
writeFileSync(`${OUT}.judgments.json`, JSON.stringify({ seed: SEED, messages, conversations: conversationNo, lines: lines.length, judgments }, null, 2));
writeFileSync(`${OUT}.projects.json`, JSON.stringify(PROJECTS, null, 2));
const bytes = lines.reduce((n, l) => n + l.messages.reduce((m, x) => m + Buffer.byteLength(x.text), 0), 0);
console.log(`${OUT}: ${messages} unique messages in ${conversationNo} chats, ${lines.length} import lines (with duplicates and edits), ${(bytes / 1048576).toFixed(1)} MiB of message text, ${judgments.length} judged questions`);
