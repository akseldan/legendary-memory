/**
 * Sign-in state for the `host` target: a small key-value store in its own SQLite file,
 * shaped like the part of Cloudflare KV that the OAuth library uses (get, put with an
 * expiry, delete, list by prefix). It lets the hosted-on-your-own-machine target run the
 * same maintained sign-in code as the Cloudflare target instead of a second implementation.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { loadSqlite } from './sqlite';

interface PutOptions {
  /** Seconds from now. */
  expirationTtl?: number;
  /** Absolute time, seconds since the epoch. */
  expiration?: number;
  metadata?: unknown;
}

interface ListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

interface ListResult {
  keys: { name: string; expiration?: number; metadata?: unknown }[];
  list_complete: boolean;
  cursor?: string;
}

const now = (): number => Math.floor(Date.now() / 1000);

export class SqliteKv {
  private readonly db: DatabaseSync;
  private readonly sweeper: NodeJS.Timeout;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new (loadSqlite().DatabaseSync)(file);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER, metadata TEXT
      ) WITHOUT ROWID;`);
    // Expired rows are already invisible to reads; this only keeps the file from growing.
    this.sweeper = setInterval(() => this.sweep(), 10 * 60 * 1000);
    this.sweeper.unref();
    this.sweep();
  }

  private sweep(): void {
    this.db.prepare('DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now());
  }

  async get(key: string, options?: { type?: string } | string): Promise<unknown> {
    const row = this.db
      .prepare('SELECT value FROM kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)')
      .get(key, now()) as { value: string } | undefined;
    if (!row) return null;
    const type = typeof options === 'string' ? options : options?.type;
    return type === 'json' ? JSON.parse(row.value) : row.value;
  }

  async put(key: string, value: string, options: PutOptions = {}): Promise<void> {
    const expires =
      options.expiration ?? (options.expirationTtl !== undefined ? now() + Math.ceil(options.expirationTtl) : null);
    this.db
      .prepare(
        `INSERT INTO kv (key, value, expires_at, metadata) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at, metadata = excluded.metadata`,
      )
      .run(key, String(value), expires, options.metadata === undefined ? null : JSON.stringify(options.metadata));
  }

  async delete(key: string): Promise<void> {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }

  async list(options: ListOptions = {}): Promise<ListResult> {
    const prefix = options.prefix ?? '';
    const limit = Math.min(Math.max(options.limit ?? 1000, 1), 1000);
    // The cursor is simply the last key of the previous page.
    const after = options.cursor ?? '';
    const rows = this.db
      .prepare(
        `SELECT key, expires_at, metadata FROM kv
         WHERE substr(key, 1, ?) = ? AND key > ? AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY key LIMIT ?`,
      )
      .all(prefix.length, prefix, after, now(), limit + 1) as { key: string; expires_at: number | null; metadata: string | null }[];
    const page = rows.slice(0, limit);
    const complete = rows.length <= limit;
    return {
      keys: page.map((row) => ({
        name: row.key,
        ...(row.expires_at !== null ? { expiration: row.expires_at } : {}),
        ...(row.metadata !== null ? { metadata: JSON.parse(row.metadata) } : {}),
      })),
      list_complete: complete,
      ...(complete ? {} : { cursor: page[page.length - 1]!.key }),
    };
  }

  close(): void {
    clearInterval(this.sweeper);
    this.db.close();
  }
}
