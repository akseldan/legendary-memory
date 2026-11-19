/**
 * Portable archives (execution plan P3.3/P3.4).
 *
 *   legendary-memory export --to memory.lmarchive [--from local|file.db|https://hub]
 *   legendary-memory restore --from memory.lmarchive --to <new folder or new .db file>
 *
 * An archive is gzip-compressed JSON Lines:
 *   line 1        {"archive":"legendary-memory","archive_version":1,"schema_version":N,...}
 *   lines 2..n-1  {"t":"<table>","r":{...row...}}           every canonical row, ids and dates kept
 *   last line     {"end":{"rows":{...},"body_sha256":"...","manifest":{...}}}
 *
 * The search index is not in the archive; restore rebuilds it. Export reads a consistent backup
 * (see backup.ts), so it is safe while apps write. Restore only ever creates a new memory, checks
 * the archive's checksum and that the restored memory hashes the same as the archive's manifest,
 * and removes the half-made file on any failure. It never changes an existing memory: to merge a
 * restored memory into a live one, `copy` from it (which also honors deletions).
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { createGunzip, createGzip } from 'node:zlib';
import { VERSION } from '../core/constants';
import searchV2 from '../../migrations/0002_search_v2.sql';
import { type Manifest, manifestOf, runBackup } from './backup';
import { MIGRATIONS } from './migrations';
import { loadSqlite, openDatabase } from './sqlite';

export const ARCHIVE_VERSION = 1;
/** Canonical tables, in an order that satisfies foreign keys on restore. */
const TABLES = ['projects', 'brief_versions', 'checkpoints', 'artifacts', 'profile', 'conversations', 'messages', 'deletions'] as const;
type Table = (typeof TABLES)[number];
/** A single row larger than this is refused on restore: no real memory row is near it. */
const MAX_LINE_CHARS = 64 * 1024 * 1024;
/** Restore refuses archives that expand beyond this, so a hostile file cannot fill the disk. */
const MAX_EXPANDED_BYTES = 50 * 1024 ** 3;

/** The statements that rebuild the search index from canonical tables (shared with migration 0002). */
const REBUILD_SQL = searchV2.slice(searchV2.indexOf('-- REBUILD'));

const mib = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MiB`;
const isRemote = (address: string) => /^[a-z]+:\/\//i.test(address);

interface Header {
  archive: 'legendary-memory';
  archive_version: number;
  schema_version: number;
  created_at: string;
  made_by: string;
  source: string;
  tables: string[];
}

export async function runExport(options: { from: string; to: string }, log: (line: string) => void = console.log): Promise<Manifest> {
  const target = resolve(options.to);
  if (existsSync(target)) throw new Error(`${target} already exists. Exports never overwrite; pick a new name.`);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  // A verified, consistent snapshot first; the archive is written from it.
  const snapshot = join(tmpdir(), `legendary-memory-export-${process.pid}-${Date.now()}.db`);
  const partial = `${target}.partial-${process.pid}`;
  try {
    const manifest = await runBackup({ from: options.from, to: snapshot }, () => undefined);
    const db = new (loadSqlite().DatabaseSync)(snapshot, { readOnly: true });
    const gzip = createGzip({ level: 9 });
    const out = createWriteStream(partial, { mode: 0o600 });
    gzip.pipe(out);
    const body = createHash('sha256');
    const rows: Record<string, number> = {};
    const write = async (line: string, hashed: boolean) => {
      if (hashed) body.update(`${line}\n`);
      if (!gzip.write(`${line}\n`)) await once(gzip, 'drain');
    };
    try {
      const present = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
      const tables = TABLES.filter((t) => present.has(t));
      const header: Header = {
        archive: 'legendary-memory',
        archive_version: ARCHIVE_VERSION,
        schema_version: manifest.schema_version,
        created_at: new Date().toISOString(),
        made_by: `legendary-memory ${VERSION}`,
        source: manifest.source,
        tables,
      };
      await write(JSON.stringify(header), true);
      for (const table of tables) {
        rows[table] = 0;
        for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate() as Iterable<Record<string, unknown>>) {
          await write(JSON.stringify({ t: table, r: row }), true);
          rows[table]++;
        }
      }
      await write(JSON.stringify({ end: { rows, body_sha256: body.digest('hex'), manifest } }), false);
    } finally {
      db.close();
      gzip.end();
      await once(out, 'close');
    }
    renameSync(partial, target);
    chmodSync(target, 0o600);
    log(`Exported ${manifest.source} to ${target} (${mib(statSync(target).size)})`);
    for (const [table, info] of Object.entries(manifest.tables)) if (info.rows) log(`  ${table.padEnd(15)}${info.rows}`);
    log(`  memory hash    ${manifest.memory_sha256}`);
    log(`To restore: legendary-memory restore --from ${target} --to <new folder>`);
    return manifest;
  } finally {
    rmSync(partial, { force: true });
    for (const suffix of ['', '-wal', '-shm', '-journal', '.manifest.json']) rmSync(snapshot + suffix, { force: true });
  }
}

export async function runRestore(options: { from: string; to: string }, log: (line: string) => void = console.log): Promise<Manifest> {
  const source = resolve(options.from);
  if (isRemote(options.from) || !existsSync(source)) throw new Error(`There is no archive at ${source}.`);
  const to = resolve(options.to);
  const target = to.endsWith('.db') ? to : join(to, 'memory.db');
  if (existsSync(target)) throw new Error(`${target} already exists. Restore only creates a new memory; pick an empty place.`);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });

  const remove = () => {
    for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(target + suffix, { force: true });
  };
  try {
    // An empty memory at the current schema, then the rows go in as they were.
    openDatabase(target).close();
    const sqlite = loadSqlite();
    const db = new sqlite.DatabaseSync(target);
    let header: Header | undefined;
    let end: { rows: Record<string, number>; body_sha256: string; manifest: Manifest } | undefined;
    const body = createHash('sha256');
    const counts: Record<string, number> = {};
    let expanded = 0;
    try {
      const columns = new Map<string, Set<string>>();
      for (const table of TABLES) {
        columns.set(table, new Set((db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map((c) => c.name)));
      }
      const statements = new Map<string, ReturnType<typeof db.prepare>>();
      db.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE');
      const lines = createInterface({ input: createReadStream(source).pipe(createGunzip()), crlfDelay: Infinity });
      for await (const line of lines) {
        expanded += line.length + 1;
        if (expanded > MAX_EXPANDED_BYTES) throw new Error('The archive expands beyond 50 GiB; refusing it.');
        if (line.length > MAX_LINE_CHARS) throw new Error('The archive has a line too long to be a memory row; refusing it.');
        if (!line) continue;
        if (end) throw new Error('The archive has data after its end marker; it is damaged.');
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (!header) {
          header = parsed as unknown as Header;
          if (header.archive !== 'legendary-memory') throw new Error('This is not a Legendary Memory archive.');
          if (header.archive_version > ARCHIVE_VERSION) {
            throw new Error(`This archive (format ${header.archive_version}) was made by a newer Legendary Memory. Update this copy (${VERSION}) to restore it.`);
          }
          if (header.schema_version > MIGRATIONS.length) {
            throw new Error(`This archive holds a newer data format (${header.schema_version}; this copy understands ${MIGRATIONS.length}). Update this copy to restore it.`);
          }
          body.update(`${line}\n`);
          continue;
        }
        if ('end' in parsed) {
          end = parsed.end as typeof end;
          continue;
        }
        body.update(`${line}\n`);
        const table = parsed.t as Table;
        const row = parsed.r as Record<string, unknown>;
        const allowed = columns.get(table);
        if (!allowed || !header.tables.includes(table) || typeof row !== 'object' || row === null) {
          throw new Error(`The archive has a row for an unknown table "${String(table)}"; refusing it.`);
        }
        const names = Object.keys(row);
        for (const name of names) if (!allowed.has(name)) throw new Error(`The archive has an unknown column ${table}.${name}; refusing it.`);
        const key = `${table}:${names.join(',')}`;
        let insert = statements.get(key);
        if (!insert) {
          insert = db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`);
          statements.set(key, insert);
        }
        insert.run(...(names.map((n) => row[n]) as never[]));
        counts[table] = (counts[table] ?? 0) + 1;
      }
      if (!header) throw new Error('The archive is empty.');
      if (!end) throw new Error('The archive ends early (no end marker); it is incomplete.');
      if (body.digest('hex') !== end.body_sha256) throw new Error('The archive checksum does not match; it is damaged.');
      for (const [table, n] of Object.entries(end.rows)) {
        if ((counts[table] ?? 0) !== n) throw new Error(`The archive lists ${n} ${table} rows but holds ${counts[table] ?? 0}; it is damaged.`);
      }
      // The index is derived: rebuild it from what was restored.
      db.exec(`INSERT INTO search_fts(search_fts) VALUES('delete-all'); DELETE FROM search_map; ${REBUILD_SQL}`);
      db.exec('COMMIT');
      const problems = db.prepare('PRAGMA foreign_key_check').all();
      if (problems.length > 0) throw new Error(`The archive has ${problems.length} rows whose project or chat is missing; it is damaged.`);
      // Rebuilding the index used a work table; give that space back so the new file is compact.
      db.exec('PRAGMA foreign_keys = ON; PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    } finally {
      db.close();
    }

    const restored = manifestOf(target, target);
    if (restored.integrity !== 'ok') throw new Error(`The restored memory failed its integrity check (${restored.integrity}).`);
    if (restored.memory_sha256 !== end.manifest.memory_sha256) {
      throw new Error('The restored memory does not hash the same as the archive says it should. Nothing was kept.');
    }
    chmodSync(target, 0o600);
    log(`Restored ${source} to ${target}`);
    for (const [table, info] of Object.entries(restored.tables)) if (info.rows) log(`  ${table.padEnd(15)}${info.rows}`);
    log(`  memory hash    ${restored.memory_sha256} (matches the archive)`);
    log('It is a separate memory. To use it: point LEGENDARY_MEMORY_DIR at its folder, or merge it into');
    log(`another memory with: legendary-memory copy --from ${target} --to <memory> --apply`);
    return restored;
  } catch (error) {
    remove();
    throw error;
  }
}
