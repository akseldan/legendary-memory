/**
 * The deletion ledger copy for a local memory: a small JSON file next to memory.db, outside the
 * database that backups and restores replace. See store.syncLedger.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Db } from '../core/db';
import { type DeletionRow, type LedgerMirror, setLedgerMirror, syncLedger } from '../core/store';

export const LEDGER_FILE = 'deletions-ledger.json';

export function fileMirror(dbFile: string): LedgerMirror {
  const file = join(dirname(dbFile), LEDGER_FILE);
  return {
    async read() {
      if (!existsSync(file)) return null;
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { deletions?: DeletionRow[] };
      return Array.isArray(parsed.deletions) ? parsed.deletions : [];
    },
    async write(rows) {
      const temp = `${file}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ note: 'Legendary Memory deletion records (kind, reference, time; no content). Keep this file: it stops restored backups from bringing deleted items back.', deletions: rows }, null, 1)}\n`, { mode: 0o600 });
      renameSync(temp, file);
    },
  };
}

/** Binds the copy to this memory and applies it; says so if a restore had brought deletions back. */
export async function keepLedger(db: Db, dbFile: string, log: (line: string) => void = (line) => console.error(line)): Promise<void> {
  setLedgerMirror(fileMirror(dbFile), db);
  try {
    const { restored } = await syncLedger(db);
    if (restored) log(`Deleted again ${restored} item(s) that a restored backup had brought back (your deletion records said so).`);
  } catch (error) {
    log(`Could not check the deletion records: ${error instanceof Error ? error.message : 'unknown error'}. Nothing was changed.`);
  }
}
