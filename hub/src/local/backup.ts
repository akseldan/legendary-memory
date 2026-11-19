/**
 * `legendary-memory backup --to <file> [--from <hub>]`: a consistent, verified copy of one memory
 * in a single self-contained SQLite file, plus a manifest of what it holds.
 *
 * - From this computer (or a .db file) it uses SQLite's online backup, which gives one
 *   point-in-time copy even while apps are writing. Copying a live WAL-mode file by hand does not.
 * - From a hub (https://...) it exports until two exports in a row hold exactly the same
 *   memories, so a write landing mid-export cannot leave a half-updated backup.
 *
 * It never changes the source, never overwrites an existing file, and only puts the backup in
 * place after its integrity check and manifest pass.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { VERSION } from '../core/constants';
import { dbPath } from './config';
import { runCopy, GROUPS } from './copy';
import { loadSqlite } from './sqlite';

/** Columns that identify a memory across homes, in a stable order. Local autoincrement ids are left out. */
const CANONICAL: Record<string, { cols: string; order: string; from?: string }> = {
  projects: { cols: 'id, slug, name, aliases, status, brief, created_at, updated_at', order: 'id' },
  brief_versions: { cols: 'project_id, brief, replaced_at', order: 'project_id, replaced_at, brief' },
  checkpoints: { cols: 'id, project_id, source, title, summary, decisions, next_steps, created_at', order: 'id' },
  artifacts: { cols: 'id, project_id, name, kind, content, version, source, created_at, updated_at', order: 'id' },
  profile: { cols: 'key, value, updated_at', order: 'key' },
  // A chat's identity is (source, external_id); its local id differs between homes, so it is not hashed.
  conversations: { cols: 'source, external_id, project_id, title, url, started_at, updated_at, message_count', order: 'source, external_id' },
  messages: {
    cols: "(SELECT source || char(0) || external_id FROM conversations c WHERE c.id = m.conversation_id) AS conv, seq, role, text",
    from: 'messages m',
    order: 'conv, seq',
  },
  deletions: { cols: 'kind, ref, deleted_at', order: 'kind, ref' },
};

export interface Manifest {
  format: 2;
  made_by: string;
  created_at: string;
  source: string;
  schema_version: number;
  integrity: string;
  tables: Record<string, { rows: number; sha256: string }>;
  /** One hash over every table's hash: equal values mean the same memories. */
  memory_sha256: string;
}

/** Reads a memory file (read-only) and describes its contents. Same algorithm as hub/scripts/manifest.py. */
export function manifestOf(file: string, source = file): Manifest {
  const db = new (loadSqlite().DatabaseSync)(file, { readOnly: true });
  try {
    const tables: Manifest['tables'] = {};
    const total = createHash('sha256');
    const present = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
    for (const [table, spec] of Object.entries(CANONICAL)) {
      const hash = createHash('sha256');
      let rows = 0;
      // Files from before a table existed (e.g. deletions, schema 3) count it as empty.
      if (!present.has(table)) {
        const digest = hash.digest('hex');
        tables[table] = { rows: 0, sha256: digest };
        total.update(`${table}:${digest}\n`);
        continue;
      }
      const stmt = db.prepare(`SELECT ${spec.cols} FROM ${spec.from ?? table} ORDER BY ${spec.order}`);
      stmt.setReturnArrays?.(true);
      for (const row of stmt.iterate() as Iterable<unknown>) {
        const values = Array.isArray(row) ? row : Object.values(row as object);
        hash.update(JSON.stringify(values.map((v) => (typeof v === 'bigint' ? Number(v) : v))));
        hash.update('\n');
        rows++;
      }
      const digest = hash.digest('hex');
      tables[table] = { rows, sha256: digest };
      total.update(`${table}:${digest}\n`);
    }
    const integrity = String((db.prepare('PRAGMA integrity_check').get() as Record<string, unknown>).integrity_check);
    const schema = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    return {
      format: 2,
      made_by: `legendary-memory ${VERSION}`,
      created_at: new Date().toISOString(),
      source,
      schema_version: schema,
      integrity,
      tables,
      memory_sha256: total.digest('hex'),
    };
  } finally {
    db.close();
  }
}

/** Folds the WAL into the main file so the backup is one file that opens anywhere. */
function settle(file: string): void {
  const db = new (loadSqlite().DatabaseSync)(file);
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;');
  } finally {
    db.close();
  }
}

function removeQuietly(file: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(file + suffix, { force: true });
}

const isRemote = (address: string): boolean => /^[a-z]+:\/\//i.test(address);

/** Hub addresses without any key or path, for the manifest and log. */
function label(address: string): string {
  if (address === 'local') return dbPath();
  if (!isRemote(address)) return resolve(address);
  return new URL(address).origin;
}

export interface BackupOptions {
  from: string;
  to: string;
  /** Exports to try for two matching ones, from a hub. */
  attempts?: number;
}

export async function runBackup(options: BackupOptions, log: (line: string) => void = console.log): Promise<Manifest> {
  const target = resolve(options.to);
  if (existsSync(target)) throw new Error(`${target} already exists. Backups never overwrite; pick a new name.`);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = (n: number) => `${target}.partial-${process.pid}-${n}`;
  const source = label(options.from);
  let made: string | undefined;
  let manifest: Manifest | undefined;

  try {
    if (!isRemote(options.from)) {
      const path = options.from === 'local' ? dbPath() : resolve(options.from);
      if (!existsSync(path)) throw new Error(`There is no memory file at ${path}.`);
      const sqlite = loadSqlite();
      const src = new sqlite.DatabaseSync(path, { readOnly: true });
      try {
        await sqlite.backup(src, temp(0));
      } finally {
        src.close();
      }
      settle(temp(0));
      made = temp(0);
      manifest = manifestOf(made, source);
    } else {
      const attempts = Math.max(2, options.attempts ?? 4);
      let previous: { file: string; manifest: Manifest } | undefined;
      for (let n = 1; n <= attempts && !made; n++) {
        const file = temp(n);
        await runCopy({ from: options.from, to: file, apply: true, replaceOlder: false, only: new Set(GROUPS) }, () => undefined);
        settle(file);
        const current = manifestOf(file, source);
        if (previous && previous.manifest.memory_sha256 === current.memory_sha256) {
          removeQuietly(previous.file);
          made = file;
          manifest = current;
        } else {
          if (previous) {
            log(`  The hub changed during export ${n - 1}; exporting again.`);
            removeQuietly(previous.file);
          }
          previous = { file, manifest: current };
        }
      }
      if (!made) {
        if (previous) removeQuietly(previous.file);
        throw new Error(`The hub kept changing during ${attempts} exports, so no consistent backup was made. Try again when it is quieter.`);
      }
    }

    if (!manifest || manifest.integrity !== 'ok') throw new Error(`The backup failed its integrity check (${manifest?.integrity}). Nothing was kept.`);
    renameSync(made, target);
    made = undefined;
    chmodSync(target, 0o600);
    writeFileSync(`${target}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    log(`Backed up ${source} to ${target}`);
    for (const [table, info] of Object.entries(manifest.tables)) if (info.rows) log(`  ${table.padEnd(15)}${info.rows}`);
    log(`  memory hash    ${manifest.memory_sha256}`);
    log(`To restore: legendary-memory copy --from ${target} --to <empty home> --apply`);
    return manifest;
  } finally {
    if (made) removeQuietly(made);
  }
}
