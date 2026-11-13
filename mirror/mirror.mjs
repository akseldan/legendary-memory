#!/usr/bin/env node
// Copies your Legendary Memory into an Obsidian vault as Markdown, one way: hub → vault.
//
//   BRIDGE_API_KEY=... node mirror/mirror.mjs <vault folder> --url <hub address>
//
// It writes only inside "<vault>/Legendary Memory" (or --folder), and only touches files it
// created itself (they carry a marker line). Your own notes are never changed or deleted.
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { ownedByMirror, render, safeName } from './render.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const OPTION_NAMES = ['--url', '--folder'];
const paths = args.filter((a, i) => !a.startsWith('--') && !OPTION_NAMES.includes(args[i - 1]));

if (paths.length !== 1 || flag('--help')) {
  console.log(`Usage: node mirror/mirror.mjs <vault folder> --url <hub address>
  --url <address>    your hub: https://... (Cloudflare) or http://127.0.0.1:8787 (local)  (or env HUB_URL)
  --folder <name>    folder inside the vault to write to (default: "Legendary Memory")
  --dry-run          show what would change without writing anything
The API key is read from the environment variable BRIDGE_API_KEY, never from the command line.`);
  process.exit(paths.length === 1 ? 0 : 1);
}

const vault = paths[0];
const folder = safeName(option('--folder') ?? 'Legendary Memory', 'Legendary Memory');
const dryRun = flag('--dry-run');
const hub = (option('--url') ?? process.env.HUB_URL ?? '').replace(/\/+$/, '');
const key = process.env.BRIDGE_API_KEY ?? '';

function hubAllowed(address) {
  try {
    const u = new URL(address);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}
const fail = (message) => {
  console.error(`\n${message}`);
  process.exit(1);
};

let vaultInfo;
try {
  vaultInfo = statSync(vault);
} catch {
  fail(`The vault folder "${vault}" does not exist.`);
}
if (!vaultInfo.isDirectory()) fail(`"${vault}" is not a folder.`);
if (!hubAllowed(hub)) fail('Set --url (or HUB_URL): https://... for Cloudflare, or http://127.0.0.1:8787 for the local hub.');
if (key.length < 32) fail('Set the BRIDGE_API_KEY environment variable (32+ characters), the same value stored on the hub.');

async function exportTable(table) {
  const rows = [];
  let after = 0;
  for (;;) {
    const res = await fetch(`${hub}/api/export?table=${table}&after=${after}&limit=500`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.status === 401) fail('The hub refused the key. Check BRIDGE_API_KEY.');
    if (!res.ok) fail(`The hub answered ${res.status} for ${table}: ${(await res.text()).slice(0, 200)}`);
    const page = await res.json();
    rows.push(...page.rows);
    if (page.next == null) return rows;
    after = page.next;
  }
}

const data = {};
for (const table of ['projects', 'checkpoints', 'artifacts', 'profile', 'conversations']) {
  data[table] = await exportTable(table);
}
const files = render(data, folder);

const target = join(vault, folder);
const counts = { created: 0, updated: 0, unchanged: 0, removed: 0, skipped: 0 };

// Existing files in our folder: [relative path] → owned?
const existing = new Map();
const walk = (dir) => {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // never follow or touch links
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && entry.name.endsWith('.md')) {
      const rel = relative(target, full).split(sep).join('/');
      existing.set(rel, ownedByMirror(readFileSync(full, 'utf8')));
    }
  }
};
walk(target);

const isInside = (full) => {
  const rel = relative(target, full);
  return rel && !rel.startsWith('..') && !rel.split(sep).includes('..');
};

for (const [rel, text] of files) {
  const full = join(target, ...rel.split('/'));
  if (!isInside(full)) continue;
  if (existing.has(rel)) {
    if (!existing.get(rel)) {
      counts.skipped++;
      console.log(`  skipped (your own note, not replaced): ${rel}`);
      continue;
    }
    if (readFileSync(full, 'utf8') === text) {
      counts.unchanged++;
      continue;
    }
    counts.updated++;
    console.log(`  updated  ${rel}`);
  } else {
    counts.created++;
    console.log(`  created  ${rel}`);
  }
  if (!dryRun) {
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
}

// Remove notes we made earlier for things that no longer exist (deleted or renamed).
for (const [rel, owned] of existing) {
  if (!owned || files.has(rel)) continue;
  const full = join(target, ...rel.split('/'));
  if (!isInside(full) || lstatSync(full).isSymbolicLink()) continue;
  counts.removed++;
  console.log(`  removed  ${rel}`);
  if (!dryRun) unlinkSync(full);
}

// Tidy folders left empty inside our folder (never the folder itself or anything outside it).
const prune = (dir) => {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink()) prune(join(dir, entry.name));
  if (dir !== target && isInside(dir) && readdirSync(dir).length === 0 && !dryRun) rmdirSync(dir);
};
prune(target);

const { created, updated, unchanged, removed, skipped } = counts;
console.log(
  `\n${dryRun ? 'Dry run, nothing written. Would have: ' : 'Done: '}` +
    `${created} created, ${updated} updated, ${unchanged} unchanged, ${removed} removed` +
    (skipped ? `, ${skipped} skipped because a note of yours already has that name` : '') +
    `.\nFolder: ${target}`,
);
