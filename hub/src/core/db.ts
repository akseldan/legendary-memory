/**
 * The only database surface the core needs. It is the subset of Cloudflare D1's API that
 * the store uses, so D1 satisfies it directly and the local target satisfies it with a
 * thin wrapper over SQLite. Keep SQL here to plain SQLite (numbered ?1 parameters, FTS5).
 */
export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface Db {
  prepare(sql: string): Statement;
  /** Runs every statement in order inside one transaction: all of them apply or none do. */
  batch(statements: Statement[]): Promise<unknown[]>;
}
