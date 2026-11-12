/** Small text helpers shared across the hub. No dependencies. */

export const nowIso = (): string => new Date().toISOString();

export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'project';
}

/** Cut text to a budget, saying how much was left out so the reader knows to ask for more. */
export function clamp(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const kept = text.slice(0, Math.max(0, maxChars));
  return `${kept}\n…[${text.length - kept.length} more characters not shown]`;
}

/** Rough token estimate (about 4 characters per token for English). */
export const approxTokens = (text: string): number => Math.ceil(text.length / 4);

/** "2026-11-12" from an ISO timestamp. */
export const day = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : '');

/** Lines of a stored bullet block, without blanks. */
export const lines = (block: string): string[] =>
  block
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

/** Words that say nothing about which project is meant. */
const FILLER = new Set(['the', 'a', 'an', 'my', 'our', 'project', 'projects', 'app', 'thing', 'on', 'for', 'about']);

/** Lowercased meaningful words of a project reference: "the Cooling project" -> ["cooling"]. */
export function keyWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0 && !FILLER.has(word));
}

/** Levenshtein distance, capped: returns cap + 1 as soon as the distance exceeds cap. */
export function editDistance(a: string, b: string, cap = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > cap) return cap + 1;
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * Turn free text into a safe FTS5 query: each word quoted, joined with OR so partial
 * matches still rank. Returns null when there is nothing searchable.
 */
export function ftsQuery(text: string): string | null {
  const words = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 12);
  if (words.length === 0) return null;
  return words.map((word) => `"${word}"`).join(' OR ');
}

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
