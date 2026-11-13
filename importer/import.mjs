#!/usr/bin/env node
// Loads ChatGPT and Claude data exports into your Legendary Memory hub.
//
//   node importer/import.mjs <export.zip | folder | conversations.json> [more paths...]
//
// It only reads and reports unless you add --apply. See the README for the full steps.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { detectSource, parseConversations, toRequests } from './parse.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const OPTION_NAMES = ['--url', '--source', '--start', '--limit'];
const paths = args.filter((a, i) => !a.startsWith('--') && !OPTION_NAMES.includes(args[i - 1]));

if (paths.length === 0 || flag('--help')) {
  console.log(`Usage: node importer/import.mjs <export.zip | folder | conversations.json> [...]
  --apply            actually send to the hub (default: report only)
  --url <address>    your hub, e.g. https://legendary-memory.<you>.workers.dev  (or env HUB_URL)
  --source <name>    chatgpt or claude (default: detected from the file)
  --start <n>        skip the first n conversations (to resume after an interruption)
  --limit <n>        only send n conversations (to try a small batch first)
The API key is read from the environment variable BRIDGE_API_KEY, never from the command line.`);
  process.exit(paths.length === 0 ? 1 : 0);
}

const isConversationFile = (name) => /^conversations(-\d+)?\.json$/i.test(basename(name));

/** Returns [{ label, text }] for every conversations file found in a zip, folder or file. */
function loadFiles(path) {
  const info = statSync(path);
  if (info.isDirectory()) {
    const found = [];
    const walk = (dir, depth) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory() && depth < 3) walk(full, depth + 1);
        else if (entry.isFile() && isConversationFile(entry.name)) found.push({ label: full, text: readFileSync(full, 'utf8') });
      }
    };
    walk(path, 0);
    return found;
  }
  if (path.toLowerCase().endsWith('.zip')) {
    const names = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .filter((n) => n && isConversationFile(n));
    return names.map((name) => ({
      label: `${basename(path)}:${name}`,
      text: execFileSync('unzip', ['-p', path, name], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 }),
    }));
  }
  return [{ label: path, text: readFileSync(path, 'utf8') }];
}

const conversations = [];
for (const path of paths) {
  let files;
  try {
    files = loadFiles(path);
  } catch (error) {
    console.error(`Could not read ${path}: ${error.code === 'ENOENT' ? 'not found' : error.message.split('\n')[0]}`);
    process.exit(1);
  }
  if (files.length === 0) console.error(`No conversations.json found in ${path}.`);
  for (const file of files) {
    let data;
    try {
      data = JSON.parse(file.text);
    } catch {
      console.error(`${file.label}: not valid JSON, skipped.`);
      continue;
    }
    const list = Array.isArray(data) ? data : Array.isArray(data?.conversations) ? data.conversations : [];
    const source = option('--source') ?? detectSource(list);
    if (!source) {
      console.error(`${file.label}: format not recognised, skipped.`);
      continue;
    }
    const { parsed, unreadable } = parseConversations(list, source);
    console.log(`${file.label}: ${source}, ${parsed.length} conversations${unreadable ? `, ${unreadable} unreadable` : ''}`);
    conversations.push(...parsed);
  }
}

const withText = conversations.filter((c) => c.messages.length > 0);
const totalMessages = withText.reduce((n, c) => n + c.messages.length, 0);
const dates = withText.map((c) => c.started_at).filter(Boolean).sort();
console.log(`\nReady: ${withText.length} conversations with text (${conversations.length - withText.length} empty), ${totalMessages} messages.`);
if (dates.length) console.log(`Dates: ${dates[0].slice(0, 10)} to ${dates[dates.length - 1].slice(0, 10)}`);
const bySource = {};
for (const c of withText) bySource[c.source] = (bySource[c.source] ?? 0) + 1;
console.log(Object.entries(bySource).map(([s, n]) => `  ${s}: ${n}`).join('\n'));

if (!flag('--apply')) {
  console.log('\nNothing was sent. Add --apply (with --url and BRIDGE_API_KEY set) to import.');
  process.exit(0);
}

const hub = (option('--url') ?? process.env.HUB_URL ?? '').replace(/\/+$/, '');
const key = process.env.BRIDGE_API_KEY ?? '';
// Plain http is allowed only to this computer (the local target); anything else must be https.
function hubAllowed(address) {
  try {
    const u = new URL(address);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}
if (!hubAllowed(hub)) {
  console.error('\n--apply needs --url (or HUB_URL) set to your hub address: https://... for Cloudflare,');
  console.error('or http://127.0.0.1:8787 for the local hub.');
  process.exit(1);
}
if (key.length < 32) {
  console.error('\n--apply needs the BRIDGE_API_KEY environment variable (32+ characters), the same value stored on the hub.');
  process.exit(1);
}

const start = Math.max(0, Number(option('--start') ?? 0) || 0);
const limit = option('--limit') ? Math.max(1, Number(option('--limit'))) : Infinity;
const queue = withText.slice(start, start + limit);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function send(body) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${hub}/api/ingest/conversation`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) return { ok: true };
      if (res.status === 401 || res.status === 503) return { ok: false, fatal: true, why: `${res.status} ${(await res.text()).slice(0, 120)}` };
      if (res.status < 500 && res.status !== 429) return { ok: false, why: `${res.status} ${(await res.text()).slice(0, 120)}` };
    } catch {
      // network hiccup: retry
    }
    await sleep(1000 * attempt * attempt);
  }
  return { ok: false, why: 'gave up after 4 tries' };
}

let done = 0;
const failures = [];
for (const [offset, conversation] of queue.entries()) {
  for (const body of toRequests(conversation)) {
    const result = await send(body);
    if (!result.ok) {
      if (result.fatal) {
        console.error(`\nStopped: the hub refused the request (${result.why}). Check BRIDGE_API_KEY and the address.`);
        process.exit(1);
      }
      failures.push({ index: start + offset, id: conversation.external_id, why: result.why });
      break;
    }
  }
  done++;
  if (done % 25 === 0 || done === queue.length) console.log(`  sent ${done} of ${queue.length}`);
}
console.log(`\nDone: ${done - failures.length} imported, ${failures.length} failed.`);
for (const f of failures.slice(0, 20)) console.log(`  #${f.index} ${f.id}: ${f.why}`);
if (failures.length) console.log(`Rerun with --start ${failures[0].index} to retry from the first failure.`);
process.exit(failures.length ? 1 : 0);
