/**
 * Storage admission (execution plan P2.5, storage contract in section 3).
 *
 * Before anything is saved, the hub checks two things a target can provide:
 *   - free disk space where the memory file lives (this computer, your own server), and
 *   - an optional allowance for the memory itself (LEGENDARY_MEMORY_QUOTA_MB locally, QUOTA_MB
 *     on a hub). From 80% a save succeeds with a note; at 100% new saves are refused.
 * Reading, searching, exporting and deleting are never refused for space: they are how you get
 * your memory out or make room. Nothing is ever deleted or summarized away to make space.
 */
export interface Limits {
  /** Allowance for the memory, in bytes. Unset: no allowance. */
  quotaBytes?: number;
  /** Bytes free on the disk holding the memory, or null when the target cannot tell. */
  diskFree?: () => number | null;
  /** Saving pauses when the disk would have less than this free. */
  minFreeBytes?: number;
  /** Current size of the memory in bytes, or null when unknown. */
  size?: () => Promise<number | null>;
}

let limits: Limits = {};

/** Each target sets its limits once at start; a later call only replaces the fields it names. */
export function setLimits(next: Limits): void {
  limits = { ...limits, ...next };
}

export function currentLimits(): Readonly<Limits> {
  return limits;
}

const mb = (bytes: number) => `${Math.round(bytes / 1048576)} MB`;

export type Admission = { ok: true; note?: string } | { ok: false; message: string };

/** Whether a save of about `incoming` bytes may go ahead, with a note to show near the limit. */
export async function admitWrite(incoming = 0): Promise<Admission> {
  const free = limits.diskFree?.() ?? null;
  const minFree = limits.minFreeBytes ?? 256 * 1048576;
  // A save can grow the journal and index by a few times its own size before it settles.
  if (free !== null && free - incoming * 4 < minFree) {
    return {
      ok: false,
      message: `Saving is paused: the disk holding this memory has only ${mb(free)} free, and Legendary Memory keeps at least ${mb(minFree)} free so the memory file cannot be damaged. Free some disk space and try again. Reading, searching, exporting and deleting still work.`,
    };
  }
  if (limits.quotaBytes && limits.size) {
    const size = await limits.size().catch(() => null);
    if (size !== null) {
      const after = size + incoming;
      if (after > limits.quotaBytes) {
        return {
          ok: false,
          message: `Memory is full: ${mb(size)} of its ${mb(limits.quotaBytes)} allowance is used, so nothing new was saved. Reading, searching, exporting and deleting still work. To make room, delete or archive old projects (export them first if you want to keep a copy), or raise the allowance.`,
        };
      }
      if (after >= limits.quotaBytes * 0.8) {
        return { ok: true, note: `Memory is at ${Math.round((after / limits.quotaBytes) * 100)}% of its ${mb(limits.quotaBytes)} allowance.` };
      }
    }
  }
  return { ok: true };
}
