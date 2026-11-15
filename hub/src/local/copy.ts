/**
 * `legendary-memory copy --from <hub> --to <hub>`: add one memory's contents to another,
 * for example your computer's memory to your own server, with ids and dates kept.
 *
 * It only adds. Nothing on the destination is deleted, and a row that differs there is kept
 * unless --replace-older is given and the incoming one is newer. Without --apply it
 * reports what would happen and writes nothing. Running it twice changes nothing.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Db } from '../core/db';
import * as store from '../core/store';
import { apiKey, dbPath } from './config';
import { openDatabase } from './sqlite';

type Row = Record<string, unknown>;
export type Group = 'projects' | 'chats' | 'profile';
export const GROUPS: readonly Group[] = ['projects', 'chats', 'profile'];

export interface CopyOptions {
  from: string;
  to: string;
  apply: boolean;
  replaceOlder: boolean;
  only: ReadonlySet<Group>;
}

interface ImportOptions {
  replace: boolean;
  dryRun: boolean;
  idMap: Record<string, string>;
}

interface IngestBody {
  source: string;
  external_id: string;
  title: string;
  url: string;
  started_at: string | null;
  updated_at: string;
  project_id?: string;
  messages: { seq: number; role: string; text: string }[];
}

interface Hub {
  /** Where it is, without any key. */
  label: string;
  exportRows(table: (typeof store.EXPORT_TABLES)[number]): AsyncGenerator<Row[]>;
  importRows(table: store.ImportTable, rows: Row[], options: ImportOptions): Promise<store.ImportResult>;
  ingest(body: IngestBody): Promise<void>;
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
// Rows per request. Small enough for the sign-in-free API's body limit and for D1's batch limits.
const ROWS_PER_REQUEST = 50;
const CHARS_PER_REQUEST = 700_000;
const MESSAGES_PER_REQUEST = 1500;

function httpAllowed(address: URL): boolean {
  return address.protocol === 'https:' || (address.protocol === 'http:' && LOCAL_HOSTS.includes(address.hostname));
}

/** Reads a key without showing it, so it never lands in the terminal's scrollback or history. */
function askHidden(prompt: string): Promise<string> {
  return new Promise((done) => {
    process.stderr.write(prompt);
    const input = process.stdin;
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    let value = '';
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          input.setRawMode(false);
          input.pause();
          input.off('data', onData);
          process.stderr.write('\n');
          return done(value);
        }
        if (char === '\u0003') process.exit(130);
        value = char === '\u007f' ? value.slice(0, -1) : value + char;
      }
    };
    input.on('data', onData);
  });
}

async function keyFor(role: 'from' | 'to', address: URL): Promise<string> {
  const name = `LEGENDARY_MEMORY_${role.toUpperCase()}_KEY`;
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  if (LOCAL_HOSTS.includes(address.hostname)) return apiKey();
  if (!process.stdin.isTTY) throw new Error(`No key for ${address.origin}. Set ${name} in the environment.`);
  return askHidden(`Key for ${address.origin} (typing is hidden): `);
}

function httpHub(address: URL, key: string): Hub {
  const base = address.origin;
  const call = async (path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> => {
    const response = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${key}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    if (response.ok) return response.json();
    const detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 120);
    if (response.status === 401) throw new Error(`${base} refused the key. Check it is that hub's API key (BRIDGE_API_KEY, or the local key from \`info\`).`);
    if (response.status === 503) throw new Error(`${base} has its API turned off. Set an API key on that hub (BRIDGE_API_KEY) first.`);
    if (response.status === 404 && path === '/api/import') {
      throw new Error(`${base} is an older version without the copy endpoint. Update and redeploy it, then run this again.`);
    }
    throw new Error(`${base} answered ${response.status} for ${path}: ${detail}`);
  };
  return {
    label: base,
    async *exportRows(table) {
      let after = 0;
      for (;;) {
        const page = (await call(`/api/export?table=${table}&after=${after}&limit=500`)) as { rows: Row[]; next: number | null };
        if (page.rows.length) yield page.rows;
        if (page.next === null) return;
        after = page.next;
      }
    },
    importRows: (table, rows, options) =>
      call('/api/import', { method: 'POST', body: { table, rows, replace: options.replace, dry_run: options.dryRun, id_map: options.idMap } }) as Promise<store.ImportResult>,
    async ingest(body) {
      await call('/api/ingest/conversation', { method: 'POST', body });
    },
  };
}

function fileHub(path: string, db: Db): Hub {
  return {
    label: path,
    async *exportRows(table) {
      let after = 0;
      for (;;) {
        const page = await store.exportPage(db, table, after, 500);
        if (page.rows.length) yield page.rows;
        if (page.next === null) return;
        after = page.next;
      }
    },
    importRows: (table, rows, options) => store.importRows(db, table, rows, options),
    async ingest(body) {
      await store.ingestConversation(db, {
        source: body.source,
        externalId: body.external_id,
        title: body.title,
        url: body.url,
        startedAt: body.started_at ?? undefined,
        updatedAt: body.updated_at,
        projectId: body.project_id,
        messages: body.messages,
      });
    },
  };
}

async function open(role: 'from' | 'to', address: string): Promise<Hub> {
  if (address === 'local' || !/^[a-z]+:\/\//i.test(address)) {
    const path = address === 'local' ? dbPath() : resolve(address);
    if (role === 'from' && !existsSync(path)) throw new Error(`There is no memory file at ${path}.`);
    return fileHub(path, openDatabase(path));
  }
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error(`"${address}" is not an address. Use https://..., http://127.0.0.1:PORT, "local", or the path of a .db file.`);
  }
  if (!httpAllowed(url)) throw new Error(`${address} must start with https://. Plain http is allowed only for this computer (127.0.0.1).`);
  return httpHub(url, await keyFor(role, url));
}

/** Splits rows into requests that stay under the row and size limits. */
function chunks(rows: Row[]): Row[][] {
  const out: Row[][] = [];
  let current: Row[] = [];
  let size = 0;
  for (const row of rows) {
    const length = JSON.stringify(row).length;
    if (current.length > 0 && (current.length >= ROWS_PER_REQUEST || size + length > CHARS_PER_REQUEST)) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(row);
    size += length;
  }
  if (current.length > 0) out.push(current);
  return out;
}

const sum = (parts: store.ImportResult[]): store.ImportResult =>
  parts.reduce<store.ImportResult>(
    (all, p) => ({
      inserted: all.inserted + p.inserted,
      same: all.same + p.same,
      replaced: all.replaced + p.replaced,
      kept: all.kept + p.kept,
      skipped: all.skipped + p.skipped,
      notes: [...all.notes, ...p.notes],
      idMap: { ...all.idMap, ...p.idMap },
    }),
    { inserted: 0, same: 0, replaced: 0, kept: 0, skipped: 0, notes: [], idMap: {} },
  );

async function all(hub: Hub, table: (typeof store.EXPORT_TABLES)[number]): Promise<Row[]> {
  const rows: Row[] = [];
  for await (const page of hub.exportRows(table)) rows.push(...page);
  return rows;
}

function describe(r: store.ImportResult): string {
  const parts = [`${r.inserted} new`, `${r.same} already there`];
  if (r.replaced) parts.push(`${r.replaced} replaced`);
  if (r.kept) parts.push(`${r.kept} differ (kept the destination's)`);
  if (r.skipped) parts.push(`${r.skipped} skipped (their project is missing)`);
  return parts.join(', ');
}

export async function runCopy(options: CopyOptions, log: (line: string) => void = console.log): Promise<void> {
  const from = await open('from', options.from);
  const to = await open('to', options.to);
  if (from.label === to.label) throw new Error('--from and --to are the same place. Pick two different memories.');

  log(`Copy from ${from.label} to ${to.label}`);
  log(options.apply ? 'Writing to the destination.' : 'Report only: nothing is written. Add --apply to copy.');
  log('');

  // Fails early, in plain words, if the destination cannot take a copy.
  await to.importRows('profile', [], { replace: false, dryRun: true, idMap: {} });

  const write = options.apply;
  const replace = options.replaceOlder;
  const idMap: Record<string, string> = {};
  const importTable = async (table: store.ImportTable, dryRun: boolean): Promise<store.ImportResult> => {
    const parts: store.ImportResult[] = [];
    for (const chunk of chunks(await all(from, table))) {
      const part = await to.importRows(table, chunk, { replace, dryRun, idMap });
      Object.assign(idMap, part.idMap);
      parts.push(part);
    }
    return sum(parts);
  };
  const notes: string[] = [];
  const report = (label: string, result: store.ImportResult) => {
    log(`  ${label.padEnd(10)}${describe(result)}`);
    notes.push(...result.notes);
  };

  const wantsChats = options.only.has('chats');
  // Chats are filed under the destination's project ids, so those are always worked out,
  // but only written when projects were asked for.
  if (options.only.has('projects') || wantsChats) {
    const projects = await importTable('projects', !(write && options.only.has('projects')));
    if (options.only.has('projects')) {
      report('projects', projects);
      report('history', await importTable('brief_versions', !write));
      report('sessions', await importTable('checkpoints', !write));
      report('files', await importTable('artifacts', !write));
    }
  }
  if (options.only.has('profile')) report('facts', await importTable('profile', !write));

  if (wantsChats) {
    const there = new Map<string, { message_count: number; updated_at: string; project_id: string | null }>();
    for (const row of await all(to, 'conversations')) {
      there.set(`${row.source}\u0000${row.external_id}`, row as never);
    }
    const toSend = new Map<string, { row: Row; messages: IngestBody['messages']; filed: string | undefined }>();
    let same = 0;
    let updated = 0;
    for (const row of await all(from, 'conversations')) {
      const stored = there.get(`${row.source}\u0000${row.external_id}`);
      if (stored && stored.message_count >= Number(row.message_count) && Date.parse(stored.updated_at) >= Date.parse(String(row.updated_at))) {
        same++;
        continue;
      }
      if (stored) updated++;
      const filed = stored?.project_id ? undefined : idMap[String(row.project_id ?? '')];
      toSend.set(String(row.id), { row, messages: [], filed });
    }
    if (toSend.size > 0) {
      for await (const page of from.exportRows('messages')) {
        for (const m of page) toSend.get(String(m.conversation_id))?.messages.push({ seq: Number(m.seq), role: String(m.role), text: String(m.text) });
      }
    }
    let sent = 0;
    for (const { row, messages, filed } of toSend.values()) {
      if (write) {
        messages.sort((a, b) => a.seq - b.seq);
        // A long chat goes in several requests; the hub joins them by (source, external id).
        let batch: IngestBody['messages'] = [];
        let size = 0;
        const flush = () =>
          to.ingest({
            source: String(row.source),
            external_id: String(row.external_id),
            title: String(row.title ?? ''),
            url: String(row.url ?? ''),
            started_at: row.started_at ? String(row.started_at) : null,
            updated_at: String(row.updated_at),
            ...(filed ? { project_id: filed } : {}),
            messages: batch,
          });
        for (const message of messages) {
          if (batch.length > 0 && (batch.length >= MESSAGES_PER_REQUEST || size + message.text.length > CHARS_PER_REQUEST)) {
            await flush();
            batch = [];
            size = 0;
          }
          batch.push(message);
          size += message.text.length;
        }
        await flush();
      }
      if (++sent % 25 === 0) log(`  chats     ${sent} of ${toSend.size}...`);
    }
    log(`  ${'chats'.padEnd(10)}${toSend.size - updated} new, ${updated} extended, ${same} already there`);
  }

  for (const line of notes.slice(0, 50)) log(`  note: ${line}`);
  log('');
  log(write ? 'Done. Run it again any time: what is already there is skipped.' : 'Nothing was written. Run again with --apply to copy.');
  log('Copy only adds. Anything you deleted on the source stays on the destination.');
}
