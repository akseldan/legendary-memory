/**
 * Local database: a SQLite file opened with Node's built-in node:sqlite (Node 22.5+),
 * wrapped to look like the small Db interface the core uses. No native add-ons to build.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Db, Statement } from '../core/db';
import { MIGRATIONS } from './migrations';

type SqlValue = string | number | bigint | null | Uint8Array;

class LocalStatement implements Statement {
  private values: SqlValue[] = [];
  constructor(
    private readonly stmt: StatementSync,
    readonly sql: string,
  ) {}

  bind(...values: unknown[]): Statement {
    // undefined has no SQL meaning; treat it as NULL like D1 does not, but safely.
    this.values = values.map((v) => (v === undefined ? null : (v as SqlValue)));
    return this;
  }
  async first<T = unknown>(): Promise<T | null> {
    return (this.stmt.get(...this.values) as T | undefined) ?? null;
  }
  async all<T = unknown>(): Promise<{ results: T[] }> {
    return { results: this.stmt.all(...this.values) as T[] };
  }
  async run(): Promise<unknown> {
    return this.stmt.run(...this.values);
  }
  runSync(): void {
    this.stmt.run(...this.values);
  }
}

class LocalDb implements Db {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): Statement {
    return new LocalStatement(this.db.prepare(sql), sql);
  }

  async batch(statements: Statement[]): Promise<unknown[]> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const statement of statements) (statement as LocalStatement).runSync();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return statements.map(() => ({}));
  }
}

/** Opens (creating if needed) the memory database and applies any migrations it lacks. */
export function openDatabase(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (const [index, sql] of MIGRATIONS.entries()) {
    if (index < row.user_version) continue;
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${index + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return new LocalDb(db);
}
