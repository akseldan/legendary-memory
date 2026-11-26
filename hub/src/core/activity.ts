/**
 * Activity history (execution plan P8.2.4): a short, bounded record of which assistant read,
 * saved or deleted what. References only, never content; see migrations/0006_activity.sql.
 */
import type { Db } from './db';

export type ActivityAction = 'read' | 'write' | 'delete';

export interface ActivityEntry {
  client: string;
  action: ActivityAction;
  tool: string;
  target?: string | null;
  ok: boolean;
}

export interface ActivityRow {
  id: number;
  at: string;
  client: string;
  action: ActivityAction;
  tool: string;
  target: string | null;
  ok: number;
}

/** How long entries are kept, and how many at most. Published on the memory page. */
export const ACTIVITY_DAYS = 90;
export const ACTIVITY_MAX = 5000;
const MAX_TARGET = 120;

/** Cuts a reference to a safe length and drops anything that looks like a secret. */
export function cleanTarget(target: string | null | undefined): string | null {
  if (!target) return null;
  const flat = target.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  // A reference never needs these; if one shows up, it was pasted by mistake.
  if (/(sk-|ghp_|xox[abp]-|AKIA)[A-Za-z0-9_-]{8,}|-----BEGIN|\b\d{13,19}\b/.test(flat)) return '(hidden)';
  return flat.length > MAX_TARGET ? `${flat.slice(0, MAX_TARGET - 1)}…` : flat;
}

/** Records one entry and trims old ones. Never throws: history must not break the memory. */
export async function logActivity(db: Db, entry: ActivityEntry, now = new Date()): Promise<void> {
  try {
    const at = now.toISOString();
    const cutoff = new Date(now.getTime() - ACTIVITY_DAYS * 86400000).toISOString();
    await db.batch([
      db
        .prepare('INSERT INTO activity (at, client, action, tool, target, ok) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
        .bind(at, (entry.client || 'unknown').slice(0, 60), entry.action, entry.tool.slice(0, 40), cleanTarget(entry.target), entry.ok ? 1 : 0),
      db.prepare('DELETE FROM activity WHERE at < ?1').bind(cutoff),
      db.prepare('DELETE FROM activity WHERE id <= (SELECT id FROM activity ORDER BY id DESC LIMIT 1 OFFSET ?1)').bind(ACTIVITY_MAX),
    ]);
  } catch (error) {
    console.error('activity not recorded:', error instanceof Error ? error.message : 'unknown error');
  }
}

/** Newest first. Empty if the table is missing (a memory from before schema 6). */
export async function recentActivity(db: Db, limit = 50): Promise<ActivityRow[]> {
  try {
    const { results } = await db
      .prepare('SELECT id, at, client, action, tool, target, ok FROM activity ORDER BY id DESC LIMIT ?1')
      .bind(Math.min(500, Math.max(1, limit)))
      .all<ActivityRow>();
    return results;
  } catch {
    return [];
  }
}

/**
 * Saves and deletes one app may make: a steady assistant never comes close, while a runaway or
 * hijacked one cannot bury the memory in junk or delete it all in one go (execution plan P9.1.3).
 * Reads are never limited. The memory page and the importer are not apps and are not counted.
 */
export const WRITES_PER_MINUTE = 30;
export const WRITES_PER_HOUR = 300;

/** null when the app may write now, otherwise the plain reason it may not. */
export async function writeBudget(db: Db, client: string, now = new Date()): Promise<string | null> {
  try {
    const minute = new Date(now.getTime() - 60_000).toISOString();
    const hour = new Date(now.getTime() - 3_600_000).toISOString();
    const row = await db
      .prepare(
        "SELECT SUM(at > ?2) AS minute, COUNT(*) AS hour FROM activity WHERE client = ?1 AND action IN ('write', 'delete') AND ok = 1 AND at > ?3",
      )
      .bind(client, minute, hour)
      .first<{ minute: number | null; hour: number }>();
    if ((row?.minute ?? 0) >= WRITES_PER_MINUTE) {
      return `This app has saved or deleted ${WRITES_PER_MINUTE} times in the last minute, the most allowed, so nothing was changed. Wait a minute and try again. If you did not expect this many changes, the owner can review them under Activity on the memory page.`;
    }
    if ((row?.hour ?? 0) >= WRITES_PER_HOUR) {
      return `This app has saved or deleted ${WRITES_PER_HOUR} times in the last hour, the most allowed, so nothing was changed. Try again later. The owner can review these changes under Activity on the memory page.`;
    }
    return null;
  } catch {
    return null; // A memory from before the activity table: no history to count.
  }
}

export interface HealthSummary {
  hours: number;
  reads: number;
  writes: number;
  deletes: number;
  /** Calls that were refused or failed: permissions, the write budget, a full memory, errors. */
  refused: number;
  last_write_at: string | null;
}

/** Counts only, for the owner and for monitoring scripts (execution plan P9.4.1): no content. */
export async function healthSummary(db: Db, hours = 24, now = new Date()): Promise<HealthSummary | null> {
  try {
    const since = new Date(now.getTime() - hours * 3_600_000).toISOString();
    const row = await db
      .prepare(
        `SELECT SUM(action = 'read' AND ok = 1) AS reads, SUM(action = 'write' AND ok = 1) AS writes,
                SUM(action = 'delete' AND ok = 1) AS deletes, SUM(ok = 0) AS refused,
                (SELECT MAX(at) FROM activity WHERE action = 'write' AND ok = 1) AS last_write_at
           FROM activity WHERE at > ?1`,
      )
      .bind(since)
      .first<Record<string, number | string | null>>();
    const n = (v: unknown) => Number(v ?? 0);
    return { hours, reads: n(row?.reads), writes: n(row?.writes), deletes: n(row?.deletes), refused: n(row?.refused), last_write_at: (row?.last_write_at as string | null) ?? null };
  } catch {
    return null;
  }
}
