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
