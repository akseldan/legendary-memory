/**
 * `legendary-memory compact`: rewrites this computer's memory file without its free pages.
 * Deleting memories, re-importing and schema upgrades (search index v2) leave freed pages that
 * SQLite reuses but does not return to the disk. VACUUM needs about one more copy of the file in
 * free space while it runs, so this checks first and refuses rather than filling the disk.
 * Apps can stay connected; they wait for the few seconds it takes.
 */
import { statfsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { dbPath } from './config';
import { openDatabase } from './sqlite';
import { loadSqlite } from './sqlite';

const mib = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MiB`;

export function runCompact(log: (line: string) => void = console.log): void {
  const file = dbPath();
  // Opening applies any pending upgrade first, so the space it frees is reclaimed too.
  openDatabase(file).close();
  const db = new (loadSqlite().DatabaseSync)(file);
  try {
    db.exec('PRAGMA busy_timeout = 10000; PRAGMA wal_checkpoint(TRUNCATE)');
    const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
    const free = (db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count * pageSize;
    const size = statSync(file).size;
    if (free < Math.max(1048576, size * 0.05)) {
      log(`Nothing worth compacting: ${mib(free)} free inside a ${mib(size)} file.`);
      return;
    }
    const disk = statfsSync(dirname(file));
    const available = disk.bavail * disk.bsize;
    const needed = size - free + 64 * 1048576;
    if (available < needed) {
      throw new Error(`Compacting needs about ${mib(needed)} of free disk space and ${mib(available)} is available. Nothing was changed.`);
    }
    db.exec('VACUUM');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const after = statSync(file).size;
    log(`Compacted ${file}: ${mib(size)} → ${mib(after)} (${mib(size - after)} returned to the disk).`);
  } finally {
    db.close();
  }
}
