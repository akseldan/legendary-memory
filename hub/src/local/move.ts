/**
 * `legendary-memory move --from <home> --to <home> [--apply]` and `move --undo --from <home>`
 * (execution plan P3.5): change which home your memory lives in without losing or forking it.
 *
 * A home is "local", a .db file, or a hub address (https://..., http://127.0.0.1:PORT).
 *
 *   1. Check both homes: the new one must be empty (use `copy` to merge into one that is not).
 *   2. Make the old home read-only, so nothing lands there mid-move. Apps can still recall.
 *   3. Take a consistent backup of it, copy that into the new home, back the new home up, and
 *      require both to hold exactly the same memories (same memory hash).
 *   4. Only then leave the old home read-only for good, pointing at the new one. Any failure
 *      before that makes the old home writable again; nothing was lost.
 *
 * `--undo` makes the old home writable again, but only while the new home still holds exactly
 * what was moved. Once the new home has new saves, undoing would split your memory, so it
 * refuses and says how to copy those saves back first.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as store from '../core/store';
import { dataDir, dbPath } from './config';
import { type Manifest, runBackup } from './backup';
import { runExport } from './archive';
import { GROUPS, httpAllowed, keyFor, runCopy } from './copy';
import { openDatabase } from './sqlite';

interface Home {
  label: string;
  getMoved(): Promise<store.Moved | null>;
  setMoved(moved: store.Moved | null): Promise<void>;
  /** Rows that would make it not empty, per table. */
  contents(): Promise<Record<string, number>>;
}

const PENDING = '0'.repeat(64);
const COUNTED = ['projects', 'checkpoints', 'artifacts', 'profile', 'conversations'] as const;
const isRemote = (address: string) => /^[a-z]+:\/\//i.test(address);

async function home(role: 'from' | 'to', address: string): Promise<Home> {
  if (!isRemote(address)) {
    const path = address === 'local' ? dbPath() : resolve(address);
    if (role === 'from' && !existsSync(path)) throw new Error(`There is no memory at ${path}.`);
    const withDb = async <T>(work: (db: ReturnType<typeof openDatabase>) => Promise<T>): Promise<T> => {
      const db = openDatabase(path);
      try {
        return await work(db);
      } finally {
        db.close();
      }
    };
    return {
      label: path,
      getMoved: () => withDb((db) => store.getMoved(db)),
      setMoved: (moved) => withDb((db) => store.setMoved(db, moved)),
      contents: () =>
        withDb(async (db) => {
          const out: Record<string, number> = {};
          for (const table of COUNTED) out[table] = (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;
          return out;
        }),
    };
  }
  const url = new URL(address);
  if (!httpAllowed(url)) throw new Error(`${url.origin} must use https (plain http only for this computer).`);
  const key = await keyFor(role, url);
  const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const response = await fetch(`${url.origin}${path}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${key}`, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (response.status === 404 && path.startsWith('/api/state')) {
      throw new Error(`${url.origin} is an older version that cannot be made read-only. Update it before moving.`);
    }
    if (!response.ok) throw new Error(`${url.origin} answered ${response.status}: ${(await response.text()).slice(0, 160)}`);
    return response.json() as Promise<Record<string, unknown>>;
  };
  return {
    label: url.origin,
    getMoved: async () => ((await call('/api/state')).moved as store.Moved | null) ?? null,
    setMoved: async (moved) => void (await call('/api/state', { method: 'POST', body: { moved } })),
    contents: async () => {
      const out: Record<string, number> = {};
      for (const table of COUNTED) {
        const page = (await call(`/api/export?table=${table}&limit=1`)) as { rows?: unknown[] };
        out[table] = page.rows?.length ?? 0;
      }
      return out;
    },
  };
}

const temp = (name: string) => join(tmpdir(), `legendary-memory-move-${process.pid}-${Date.now()}-${name}.db`);
function removeFile(file: string) {
  for (const suffix of ['', '-wal', '-shm', '-journal', '.manifest.json']) rmSync(file + suffix, { force: true });
}
const quiet = () => undefined;
const summary = (m: Manifest) =>
  Object.entries(m.tables)
    .filter(([, v]) => v.rows)
    .map(([t, v]) => `${v.rows} ${t}`)
    .join(', ') || 'nothing';

export async function runMove(options: { from: string; to: string; apply: boolean }, log: (line: string) => void = console.log): Promise<void> {
  const from = await home('from', options.from);
  const to = await home('to', options.to);
  if (from.label === to.label) throw new Error('The old and new home are the same place.');

  const fromMoved = await from.getMoved();
  if (fromMoved && fromMoved.memory_sha256 !== PENDING) {
    throw new Error(`${from.label} was already moved to ${fromMoved.to}. To move it back, run: legendary-memory move --undo --from ${options.from}`);
  }
  if (await to.getMoved()) throw new Error(`${to.label} is itself a home that was moved away (read-only). Pick another place.`);
  const held = await to.contents();
  const nonEmpty = Object.entries(held).filter(([, n]) => n > 0);
  if (nonEmpty.length > 0) {
    throw new Error(`${to.label} already holds memories (${nonEmpty.map(([t]) => t).join(', ')}). Move only into an empty home; to merge two memories use: legendary-memory copy --from ${options.from} --to ${options.to} --apply`);
  }

  // A consistent look at what will move (read-only on the old home).
  const preview = temp('preview');
  let previewManifest: Manifest;
  try {
    previewManifest = await runBackup({ from: options.from, to: preview }, quiet);
  } finally {
    removeFile(preview);
  }
  log(`Move ${from.label}`);
  log(`  to  ${to.label} (empty)`);
  log(`  what moves: ${summary(previewManifest)}`);
  if (!options.apply) {
    log('');
    log('Nothing was changed. Add --apply to move. During the move the old home is read-only (apps can');
    log('still recall); afterwards it stays read-only and tells apps the new address.');
    return;
  }

  const at = new Date().toISOString();
  const snapshot = temp('snapshot');
  const check = temp('check');
  let frozen = false;
  try {
    log('1/4 Making the old home read-only for the move');
    await from.setMoved({ to: to.label, at, memory_sha256: PENDING });
    frozen = true;

    log('2/4 Taking a consistent backup of it');
    const source = await runBackup({ from: options.from, to: snapshot }, quiet);

    // Tests prove the rollback by failing here on purpose; nothing else sets this.
    if (process.env.LEGENDARY_MEMORY_TEST_MOVE_FAIL === 'copy') throw new Error('Failure injected by the test suite.');
    log('3/4 Copying it into the new home');
    await runCopy({ from: snapshot, to: options.to, apply: true, replaceOlder: false, only: new Set(GROUPS) }, quiet);

    log('4/4 Checking the new home holds exactly the same memories');
    const landed = await runBackup({ from: options.to, to: check }, quiet);
    if (landed.memory_sha256 !== source.memory_sha256) {
      throw new Error(
        `The new home does not match (old ${summary(source)}; new ${summary(landed)}). The old home was made writable again and still has everything; ${to.label} may hold a partial copy, so empty it before trying again.`,
      );
    }

    // Keep the moved memory as an archive too, in this computer's backups folder.
    const archiveDir = join(dataDir(), 'backups');
    mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    const archive = join(archiveDir, `move-${at.slice(0, 19).replace(/[:T]/g, '-')}.lmarchive`);
    await runExport({ from: snapshot, to: archive }, quiet);

    await from.setMoved({ to: to.label, at, memory_sha256: source.memory_sha256 });
    frozen = false;
    log('');
    log(`Moved. ${to.label} now holds your memory (${summary(source)}); both hash ${source.memory_sha256.slice(0, 16)}….`);
    log(`An archive of what moved: ${archive}`);
    log(`${from.label} is now read-only: apps there can still recall, and any save is refused with the new address.`);
    log('Next: reconnect each AI app to the new home. To undo while the new home has no new saves:');
    log(`  legendary-memory move --undo --from ${options.from} --to ${options.to}`);
  } catch (error) {
    if (frozen) {
      await from.setMoved(null).catch(() => undefined);
      log('The old home is writable again; nothing there changed.');
    }
    throw error;
  } finally {
    removeFile(snapshot);
    removeFile(check);
  }
}

export async function runUndoMove(options: { from: string; to?: string; force: boolean }, log: (line: string) => void = console.log): Promise<void> {
  const from = await home('from', options.from);
  const moved = await from.getMoved();
  if (!moved) {
    log(`${from.label} is not marked as moved; it already accepts saves. Nothing to undo.`);
    return;
  }
  if (!options.force) {
    const target = options.to ?? moved.to;
    const check = temp('undo');
    try {
      const now = await runBackup({ from: target, to: check }, quiet);
      if (now.memory_sha256 !== moved.memory_sha256) {
        throw new Error(
          `${moved.to} has changed since the move (it now holds ${summary(now)}). Undoing now would leave those changes only there. Copy them back first:\n  legendary-memory copy --from ${target} --to ${options.from} --apply\nthen run the undo again with --force.`,
        );
      }
    } finally {
      removeFile(check);
    }
  }
  await from.setMoved(null);
  log(`${from.label} accepts saves again. ${moved.to} still holds a copy; reconnect your apps here, and empty or remove that copy when you no longer need it.`);
}
