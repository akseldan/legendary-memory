// Baseline benchmark (P1.3 / P2.1 / P2.2): imports a fixture through the real HTTP API, re-imports
// it to measure duplicate work, measures storage by category and tool latency, and scores the
// judged questions. Synthetic data only; temp folder and a 127.0.0.1 port.
//
//   npm run build:local && node bench/fixtures.mjs --messages 10000 --out bench/out/fx-10k
//   node bench/run.mjs --fixture bench/out/fx-10k --repeat 10
//
// Prints a summary and writes <fixture>.report.json.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { cpus, totalmem, tmpdir, platform, arch } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const arg = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const FIXTURE = arg('--fixture', 'bench/out/fx-10000');
const REPEAT = Number(arg('--repeat', '3'));
const PORT = Number(arg('--port', '18899'));
const BIN = fileURLToPath(new URL('../dist/legendary-memory.mjs', import.meta.url));
const KEY = 'b'.repeat(40);
const BASE = `http://127.0.0.1:${PORT}`;
const home = mkdtempSync(join(tmpdir(), 'lm-bench-'));
const DB = join(home, 'memory.db');

const lines = readFileSync(`${FIXTURE}.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const { judgments } = JSON.parse(readFileSync(`${FIXTURE}.judgments.json`, 'utf8'));
const projects = JSON.parse(readFileSync(`${FIXTURE}.projects.json`, 'utf8'));

const env = { ...process.env, NODE_NO_WARNINGS: '1', LEGENDARY_MEMORY_DIR: home, LEGENDARY_MEMORY_KEY: KEY };
for (const name of Object.keys(env)) if (/^(HUB_URL|BRIDGE_API_KEY)/.test(name)) delete env[name];
const server = spawn('node', [BIN, 'serve', '--port', String(PORT)], { env, stdio: ['ignore', 'ignore', 'inherit'] });

const pct = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const ms = (n) => Math.round(n * 10) / 10;

let rpcId = 0;
async function tool(name, args) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${KEY}`, 'User-Agent': 'bench' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = JSON.parse(await res.text());
  return body.result?.content?.map((c) => c.text).join('\n') ?? JSON.stringify(body);
}
async function ingest(body) {
  const res = await fetch(`${BASE}/api/ingest/conversation`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`ingest ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** Bytes per category, read-only, after folding the WAL in. */
function storage() {
  const db = new DatabaseSync(DB);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const rows = db.prepare('SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name').all();
  const pageSize = db.prepare('PRAGMA page_size').get().page_size;
  const free = db.prepare('PRAGMA freelist_count').get().freelist_count * pageSize;
  const counts = Object.fromEntries(['conversations', 'messages', 'search_map'].map((t) => [t, db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n]));
  const maxMap = db.prepare('SELECT coalesce(max(id), 0) AS n FROM search_map').get().n;
  const textBytes = db.prepare('SELECT coalesce(sum(length(CAST(text AS BLOB))), 0) AS n FROM messages').get().n;
  db.close();
  const by = { canonical: 0, search_index: 0, other_index: 0 };
  for (const { name, bytes } of rows) {
    if (name.startsWith('search_fts') || name.startsWith('search_map')) by.search_index += bytes;
    else if (/^(sqlite_autoindex|.*_project$|.*_ref$)/.test(name) || name.startsWith('sqlite_')) by.other_index += bytes;
    else by.canonical += bytes;
  }
  return { file: statSync(DB).size, wal: existsSync(`${DB}-wal`) ? statSync(`${DB}-wal`).size : 0, free, ...by, message_text: textBytes, counts, search_map_max_id: maxMap };
}

async function importAll() {
  const ids = new Map(JSON.parse(readFileSync(join(home, 'project-ids.json'), 'utf8')));
  const t0 = performance.now();
  for (const line of lines) {
    const { project_name, messages, ...rest } = line;
    // Same request limits the copy command uses.
    for (let i = 0; i < messages.length; ) {
      const batch = [];
      let size = 0;
      while (i < messages.length && batch.length < 1500 && (batch.length === 0 || size + messages[i].text.length < 700_000)) {
        size += messages[i].text.length;
        batch.push(messages[i++]);
      }
      await ingest({ ...rest, project_id: ids.get(project_name), messages: batch });
    }
  }
  return performance.now() - t0;
}

const report = { fixture: FIXTURE, machine: { platform: platform(), arch: arch(), cpus: cpus().length, cpu: cpus()[0]?.model, ram_gib: Math.round(totalmem() / 2 ** 30), node: process.version }, date: new Date().toISOString() };
try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const p of projects) await tool('save_checkpoint', { project: p.name, title: 'Start', summary: `Started ${p.name}.`, brief: `Aliases: ${p.aliases}` });
  {
    const db = new DatabaseSync(DB, { readOnly: true });
    const map = db.prepare('SELECT name, id FROM projects').all().map((r) => [r.name, r.id]);
    db.close();
    writeFileSync(join(home, 'project-ids.json'), JSON.stringify(map));
  }
  // Aliases go in through save_checkpoint's brief only; set them directly on this throwaway copy.
  {
    const db = new DatabaseSync(DB);
    for (const p of projects) db.prepare('UPDATE projects SET aliases = ? WHERE name = ?').run(p.aliases, p.name);
    db.close();
  }

  const empty = storage();
  const first = await importAll();
  const afterFirst = storage();
  report.import = { lines: lines.length, first_ms: Math.round(first), empty, after_first: afterFirst };
  const repeats = [];
  for (let r = 0; r < REPEAT; r++) {
    const t = await importAll();
    const s = storage();
    repeats.push({ ms: Math.round(t), file: s.file, search_map_max_id: s.search_map_max_id, messages: s.counts.messages });
  }
  const last = storage();
  report.reimport = {
    passes: REPEAT,
    per_pass_ms: repeats.map((r) => r.ms),
    canonical_rows_stable: repeats.every((r) => r.messages === afterFirst.counts.messages),
    file_growth_bytes: last.file - afterFirst.file,
    index_rows_rewritten_per_pass: REPEAT ? Math.round((last.search_map_max_id - afterFirst.search_map_max_id) / REPEAT) : 0,
  };

  // Latency: warm, through the MCP endpoint (includes HTTP and JSON, excludes any model).
  const words = ['pump', 'backup restore', 'installer', 'фан', 'проект', '検索', 'latency storage', 'SELECT id', 'quiet build', 'token cost'];
  const searchMs = [];
  for (let i = 0; i < 5; i++) for (const q of words) { const t = performance.now(); await tool('search', { query: q }); searchMs.push(performance.now() - t); }
  const recallMs = [];
  for (let i = 0; i < 5; i++) for (const p of projects) { const t = performance.now(); await tool('recall', { project: p.name, question: 'latest decision' }); recallMs.push(performance.now() - t); }
  report.latency_ms = { search: { n: searchMs.length, p50: ms(pct(searchMs, 50)), p95: ms(pct(searchMs, 95)) }, recall: { n: recallMs.length, p50: ms(pct(recallMs, 50)), p95: ms(pct(recallMs, 95)) } };
  const sample = await tool('recall', { project: 'Cooling Rig', question: 'latest decision' });
  report.recall_response_chars = sample.length;

  // Judged questions.
  const db = new DatabaseSync(DB, { readOnly: true });
  const idOf = (ext) => db.prepare('SELECT id FROM conversations WHERE external_id = ?').get(ext)?.id;
  const results = [];
  for (const j of judgments) {
    let pass = false;
    let got = '';
    if (j.kind === 'beyond-8000' || j.kind === 'decision' || j.kind === 'edit') {
      got = await tool('search', { query: j.query });
      pass = got.includes(`conversation:${idOf(j.expect.conversation)} (offset ${j.expect.seq})`);
      if (j.kind === 'edit') {
        const copies = db.prepare("SELECT count(*) AS n FROM messages WHERE text LIKE '%' || ?").get(` ${j.query}`).n;
        pass = pass && copies === 1;
        got += ` [stored copies: ${copies}]`;
      }
    } else if (j.kind === 'project-name') {
      got = await tool('recall', { project: j.query });
      const header = got.split('\n').find((l) => l.startsWith('# ')) ?? got.split('\n').slice(0, 3).join(' ');
      if (j.expect.project === null) pass = !header.startsWith('# ') || /no project/i.test(got);
      else if (j.expect.candidates) {
        const w = await tool('save_checkpoint', { project: j.query, title: 'probe', summary: 'ambiguous write probe' });
        pass = !/^Saved the checkpoint/.test(w) && !/^Started project/.test(w);
        got = `write → ${w.split('\n')[0]}`;
      } else pass = header.includes(`# ${j.expect.project} `);
      if (!j.expect.candidates) got = header;
    }
    results.push({ kind: j.kind, query: j.query, pass, got: got.slice(0, 160) });
  }
  db.close();
  const byKind = {};
  for (const r of results) {
    byKind[r.kind] ??= { pass: 0, total: 0 };
    byKind[r.kind].total++;
    if (r.pass) byKind[r.kind].pass++;
  }
  report.judgments = { by_kind: byKind, failures: results.filter((r) => !r.pass) };
} finally {
  server.kill();
  if (process.env.BENCH_KEEP) console.log(`kept ${home}`);
  else rmSync(home, { recursive: true, force: true });
}

writeFileSync(`${FIXTURE}.report.json`, JSON.stringify(report, null, 2));
const f = (b) => `${(b / 1048576).toFixed(1)} MiB`;
const a = report.import.after_first;
console.log(`Fixture ${FIXTURE}: ${a.counts.messages} messages, ${f(a.message_text)} of text`);
console.log(`  first import ${(report.import.first_ms / 1000).toFixed(1)} s; database ${f(a.file)} = canonical ${f(a.canonical)} + search index ${f(a.search_index)} + other indexes ${f(a.other_index)}`);
console.log(`  bytes on disk per byte of text: ${(a.file / a.message_text).toFixed(2)}`);
console.log(`  ${REPEAT} identical re-imports: ${report.reimport.per_pass_ms.map((x) => (x / 1000).toFixed(1) + ' s').join(', ')}; rows stable: ${report.reimport.canonical_rows_stable}; file grew ${f(report.reimport.file_growth_bytes)}; index rows rewritten per pass: ${report.reimport.index_rows_rewritten_per_pass}`);
console.log(`  search p50/p95 ${report.latency_ms.search.p50}/${report.latency_ms.search.p95} ms; recall p50/p95 ${report.latency_ms.recall.p50}/${report.latency_ms.recall.p95} ms; recall reply ${report.recall_response_chars} chars`);
for (const [k, v] of Object.entries(report.judgments.by_kind)) console.log(`  judged ${k.padEnd(13)} ${v.pass}/${v.total}`);
for (const r of report.judgments.failures.slice(0, 8)) console.log(`    miss ${r.kind} "${r.query}": ${r.got}`);
