/**
 * Storage limits for memories kept in a file on this computer or your own server.
 *   LEGENDARY_MEMORY_QUOTA_MB     optional allowance for the memory (unset: none)
 *   LEGENDARY_MEMORY_MIN_FREE_MB  saving pauses below this much free disk (default 256)
 */
import { existsSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { setLimits } from '../core/limits';
import { dbPath } from './config';
import { loadSqlite } from './sqlite';

const MB = 1048576;
const CACHE_MS = 5000;

function cached<T>(read: () => T): () => T {
  let at = 0;
  let value: T;
  return () => {
    if (Date.now() - at > CACHE_MS) {
      value = read();
      at = Date.now();
    }
    return value;
  };
}

const positive = (raw: string | undefined): number | undefined => {
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? n : undefined;
};

export function configureLocalLimits(file = dbPath()): void {
  const quota = positive(process.env.LEGENDARY_MEMORY_QUOTA_MB);
  const minFree = positive(process.env.LEGENDARY_MEMORY_MIN_FREE_MB) ?? 256;
  setLimits({
    quotaBytes: quota ? quota * MB : undefined,
    minFreeBytes: minFree * MB,
    diskFree: cached(() => {
      try {
        const disk = statfsSync(dirname(file));
        return Number(disk.bavail) * Number(disk.bsize);
      } catch {
        return null;
      }
    }),
    // Pages in use, not the file size: space freed by deletions counts as free again at once.
    size: async () => {
      if (!existsSync(file)) return 0;
      const db = new (loadSqlite().DatabaseSync)(file, { readOnly: true });
      try {
        const get = (pragma: string) => Number(Object.values(db.prepare(`PRAGMA ${pragma}`).get() as object)[0]);
        return (get('page_count') - get('freelist_count')) * get('page_size');
      } finally {
        db.close();
      }
    },
  });
}
