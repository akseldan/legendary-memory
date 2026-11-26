/**
 * All database access. Every write that carries text runs it through redact() first and
 * keeps the search index in step inside the same transaction (one batch).
 */
import type { Db, Statement } from './db';
import { redact } from './redact';
import { editDistance, ftsQuery, keyWords, nowIso, slugify } from './text';

export interface Project {
  id: string;
  slug: string;
  name: string;
  aliases: string;
  status: 'active' | 'paused' | 'done' | 'archived';
  brief: string;
  created_at: string;
  updated_at: string;
}

export interface Checkpoint {
  id: string;
  project_id: string;
  source: string;
  title: string;
  summary: string;
  decisions: string;
  next_steps: string;
  created_at: string;
}

export interface ArtifactMeta {
  id: string;
  project_id: string;
  name: string;
  kind: string;
  version: number;
  source: string;
  size: number;
  updated_at: string;
}

export interface Artifact extends ArtifactMeta {
  content: string;
}

export interface Conversation {
  id: string;
  source: string;
  external_id: string;
  project_id: string | null;
  title: string;
  url: string;
  started_at: string | null;
  updated_at: string;
  message_count: number;
}

export interface SearchHit {
  kind: 'project' | 'checkpoint' | 'artifact' | 'profile' | 'message';
  ref_id: string;
  project_id: string | null;
  seq: number;
  title: string;
  snippet: string;
  created_at: string;
}

/**
 * Long text is indexed in chunks of CHUNK_CHARS characters, each overlapping the next by
 * CHUNK_OVERLAP so a phrase crossing a boundary is still found. Must match migrations/0002.
 * Lengths are in characters (code points), as SQLite's length() and substr() count them.
 */
const CHUNK_CHARS = 4000;
const CHUNK_OVERLAP = 200;

/** The chunks a body is indexed as. Always at least one, so empty bodies still index their title. */
function chunksOf(body: string): string[] {
  const chars = Array.from(body);
  const out = [chars.slice(0, CHUNK_CHARS + CHUNK_OVERLAP).join('')];
  for (let k = 1; chars.length > k * CHUNK_CHARS + CHUNK_OVERLAP; k++) {
    out.push(chars.slice(k * CHUNK_CHARS, k * CHUNK_CHARS + CHUNK_CHARS + CHUNK_OVERLAP).join(''));
  }
  return out;
}
const BRIEF_VERSIONS_KEPT = 10;

// ---------------------------------------------------------------- search index

function unindex(db: Db, kind: string, refId: string): Statement[] {
  return [
    db
      .prepare('DELETE FROM search_fts WHERE rowid IN (SELECT id FROM search_map WHERE kind = ?1 AND ref_id = ?2)')
      .bind(kind, refId),
    db.prepare('DELETE FROM search_map WHERE kind = ?1 AND ref_id = ?2').bind(kind, refId),
  ];
}

function reindex(
  db: Db,
  kind: string,
  refId: string,
  projectId: string | null,
  title: string,
  body: string,
  createdAt: string,
): Statement[] {
  return [
    ...unindex(db, kind, refId),
    ...chunksOf(body).flatMap((chunk, k) => [
      db
        .prepare('INSERT INTO search_map (kind, ref_id, project_id, seq, chunk, created_at) VALUES (?1, ?2, ?3, 0, ?4, ?5)')
        .bind(kind, refId, projectId, k, createdAt),
      db
        .prepare(
          'INSERT INTO search_fts (rowid, title, body) SELECT id, ?4, ?5 FROM search_map WHERE kind = ?1 AND ref_id = ?2 AND chunk = ?3',
        )
        .bind(kind, refId, k, title, chunk),
    ]),
  ];
}

export async function search(
  db: Db,
  query: string,
  options: { projectId?: string; limit?: number; kinds?: SearchHit['kind'][] } = {},
): Promise<SearchHit[]> {
  const match = ftsQuery(query);
  if (!match) return [];
  const limit = Math.min(Math.max(options.limit ?? 8, 1), 25);
  const where = ['search_fts MATCH ?1'];
  const binds: unknown[] = [match];
  if (options.projectId) {
    binds.push(options.projectId);
    where.push(`m.project_id = ?${binds.length}`);
  }
  if (options.kinds?.length) {
    const marks = options.kinds.map((kind) => {
      binds.push(kind);
      return `?${binds.length}`;
    });
    where.push(`m.kind IN (${marks.join(', ')})`);
  }
  binds.push(limit * 4, limit);
  // Title matches count four times as much as body matches. A long item matches once per chunk;
  // keep its best chunk so one document cannot fill the whole result list. The inner LIMIT also
  // keeps SQLite from flattening the subquery, which bm25() does not allow.
  const sql = `
    SELECT kind, ref_id, project_id, seq, created_at, chunk, min(rank) AS rank FROM (
      SELECT m.kind, m.ref_id, m.project_id, m.seq, m.created_at, m.chunk, bm25(search_fts, 4.0, 1.0) AS rank
      FROM search_fts JOIN search_map m ON m.id = search_fts.rowid
      WHERE ${where.join(' AND ')}
      ORDER BY rank
      LIMIT ?${binds.length - 1}
    )
    GROUP BY kind, ref_id, seq
    ORDER BY rank
    LIMIT ?${binds.length}`;
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<Omit<SearchHit, 'title' | 'snippet'> & { chunk: number }>();
  return hydrate(db, results, query);
}

/**
 * The index keeps no copy of the text, so titles and snippets come from the records themselves.
 * A record deleted between the search and this read is dropped from the results.
 */
async function hydrate(
  db: Db,
  hits: (Omit<SearchHit, 'title' | 'snippet'> & { chunk: number })[],
  query: string,
): Promise<SearchHit[]> {
  if (hits.length === 0) return [];
  type Row = Record<'id' | 'name' | 'brief' | 'title' | 'summary' | 'decisions' | 'next_steps' | 'content' | 'key' | 'value', string>;
  const text = new Map<string, { title: string; body: string }>();
  const key = (kind: string, ref: string, seq: number) => `${kind}\u0000${ref}\u0000${seq}`;
  const ids = (kind: string) => [...new Set(hits.filter((h) => h.kind === kind).map((h) => h.ref_id))];
  const marks = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `?${i + from}`).join(', ');
  const load = async (kind: SearchHit['kind'], sql: (m: string) => string, build: (row: Row) => [string, string, string]) => {
    const list = ids(kind);
    if (list.length === 0) return;
    const { results } = await db.prepare(sql(marks(list.length))).bind(...list).all<Row>();
    for (const row of results) {
      const [ref, title, body] = build(row);
      text.set(key(kind, ref, 0), { title, body });
    }
  };
  await Promise.all([
    load('project', (m) => `SELECT id, name, brief FROM projects WHERE id IN (${m})`, (r) => [r.id, r.name, r.brief]),
    load(
      'checkpoint',
      (m) => `SELECT id, title, summary, decisions, next_steps FROM checkpoints WHERE id IN (${m})`,
      (r) => [r.id, r.title, [r.summary, r.decisions, r.next_steps].filter(Boolean).join('\n')],
    ),
    load('artifact', (m) => `SELECT id, name, content FROM artifacts WHERE id IN (${m})`, (r) => [r.id, r.name, r.content]),
    load('profile', (m) => `SELECT key, value FROM profile WHERE key IN (${m})`, (r) => [r.key, r.key.replace(/-/g, ' '), r.value]),
  ]);
  const messages = hits.filter((h) => h.kind === 'message');
  if (messages.length > 0) {
    const where = messages.map((_, i) => `(m.conversation_id = ?${2 * i + 1} AND m.seq = ?${2 * i + 2})`).join(' OR ');
    const { results } = await db
      .prepare(`SELECT c.id, c.title, m.seq, m.text FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE ${where}`)
      .bind(...messages.flatMap((h) => [h.ref_id, h.seq]))
      .all<{ id: string; title: string; seq: number; text: string }>();
    for (const row of results) text.set(key('message', row.id, Number(row.seq)), { title: row.title, body: row.text });
  }

  const terms = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1);
  const out: SearchHit[] = [];
  for (const { chunk, ...hit } of hits) {
    const found = text.get(key(hit.kind, hit.ref_id, hit.kind === 'message' ? Number(hit.seq) : 0));
    if (!found) continue;
    const region = Array.from(found.body)
      .slice(chunk * CHUNK_CHARS, chunk * CHUNK_CHARS + CHUNK_CHARS + CHUNK_OVERLAP)
      .join('');
    out.push({ ...hit, title: found.title, snippet: snippetOf(region, terms) });
  }
  return out;
}

/** About 28 words around the first query word in `text` (or its start), like FTS5's snippet(). */
function snippetOf(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    // The index stems words ("pumps" finds "pump"), so also look for the start of the word.
    for (const probe of [term, term.length > 5 ? term.slice(0, term.length - 2) : '']) {
      if (!probe) continue;
      const i = lower.indexOf(probe);
      if (i >= 0 && (at < 0 || i < at)) at = i;
    }
  }
  const words = text.split(/\s+/).filter(Boolean);
  if (at < 0) return words.slice(0, 28).join(' ') + (words.length > 28 ? ' …' : '');
  const before = text.slice(0, at).split(/\s+/).filter(Boolean).length;
  const start = Math.max(0, before - 8);
  const end = Math.min(words.length, start + 28);
  return (start > 0 ? '… ' : '') + words.slice(start, end).join(' ') + (end < words.length ? ' …' : '');
}

// -------------------------------------------------------------------- projects

export async function listProjects(db: Db): Promise<Project[]> {
  const { results } = await db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all<Project>();
  return results;
}

export async function getProject(db: Db, id: string): Promise<Project | null> {
  return db.prepare('SELECT * FROM projects WHERE id = ?1').bind(id).first<Project>();
}

export interface Resolution {
  /** Set when one project clearly fits. */
  match?: Project;
  /** True when the match came from a near-miss spelling rather than the name itself. */
  fuzzy: boolean;
  /** Other plausible projects, best first (excludes `match`). */
  candidates: Project[];
  /** True when `match` is the exact name, slug or alias, or contains every word whole. Safe for writes. */
  strong: boolean;
}

function scoreProject(project: Project, ref: string): number {
  const wanted = ref.trim().toLowerCase();
  if (!wanted) return 0;
  if (project.name.toLowerCase() === wanted) return 100;
  // The fallback slug ("project") only says the name had no letters; it identifies nothing.
  const refSlug = slugify(ref);
  if (project.slug === refSlug && (refSlug !== 'project' || wanted === 'project')) return 100;
  const refWords = keyWords(ref);
  if (refWords.length === 0) return 0;
  let best = 0;
  const names = [project.name, ...project.aliases.split(',')].map((name) => name.trim()).filter(Boolean);
  for (const name of names) {
    if (name.toLowerCase() === wanted) return 100;
    const nameWords = keyWords(name);
    if (nameWords.length === 0) continue;
    if (nameWords.join(' ') === refWords.join(' ')) best = Math.max(best, 95);
    // Every word appears whole in the name ("cooling" → "Cooling Rig"): confident.
    if (refWords.every((word) => nameWords.includes(word))) best = Math.max(best, 90);
    // Some words are only the start of a name word ("cookin" → "Cooking Club"): likely, not certain.
    const hits = refWords.filter((word) => nameWords.some((other) => other === word || other.startsWith(word)));
    if (hits.length === refWords.length) best = Math.max(best, 80);
    else if (hits.length > 0) best = Math.max(best, 50 + Math.round((20 * hits.length) / refWords.length));
    const near = refWords.filter((word) =>
      nameWords.some((other) => word.length >= 4 && editDistance(word, other, 2) <= (word.length >= 6 ? 2 : 1)),
    );
    if (near.length === refWords.length) best = Math.max(best, 60);
  }
  return best;
}

/** Find the project a loose human reference ("the cooling project") points at. */
export async function resolveProject(db: Db, ref: string): Promise<Resolution> {
  const scored = (await listProjects(db))
    .map((project) => ({ project, score: scoreProject(project, ref) }))
    .filter((entry) => entry.score >= 50)
    .sort((a, b) => b.score - a.score);
  const [top, second] = scored;
  if (!top) return { fuzzy: false, candidates: [], strong: false };
  const clear = top.score >= 80 && (!second || top.score - second.score >= 15);
  const onlyOne = top.score >= 60 && !second;
  if (clear || onlyOne) {
    return { match: top.project, fuzzy: top.score < 80, strong: top.score >= 90, candidates: scored.slice(1, 5).map((e) => e.project) };
  }
  return { fuzzy: false, strong: false, candidates: scored.slice(0, 5).map((e) => e.project) };
}

export async function createProject(db: Db, name: string): Promise<Project> {
  const cleanName = redact(name.trim()).text;
  const base = slugify(cleanName);
  let slug = base;
  for (let n = 2; await db.prepare('SELECT 1 FROM projects WHERE slug = ?1').bind(slug).first(); n++) {
    slug = `${base}-${n}`;
  }
  const now = nowIso();
  const project: Project = {
    id: crypto.randomUUID(),
    slug,
    name: cleanName,
    aliases: '',
    status: 'active',
    brief: '',
    created_at: now,
    updated_at: now,
  };
  await db.batch([
    db
      .prepare(
        "INSERT INTO projects (id, slug, name, aliases, status, brief, created_at, updated_at) VALUES (?1, ?2, ?3, '', 'active', '', ?4, ?4)",
      )
      .bind(project.id, slug, cleanName, now),
    ...reindex(db, 'project', project.id, project.id, cleanName, '', now),
  ]);
  return project;
}

export interface ProjectUpdate {
  brief?: string;
  status?: Project['status'];
  aliases?: string[];
}

/** Statements that apply an update to a project; the caller batches them with its own writes. */
function projectUpdateStatements(db: Db, project: Project, update: ProjectUpdate, now: string) {
  const statements: Statement[] = [];
  let redactions = 0;
  const next = { ...project };
  if (update.brief !== undefined) {
    const clean = redact(update.brief);
    redactions += clean.count;
    if (project.brief && project.brief !== clean.text) {
      statements.push(
        db
          .prepare('INSERT INTO brief_versions (project_id, brief, replaced_at) VALUES (?1, ?2, ?3)')
          .bind(project.id, project.brief, now),
        db
          .prepare(
            `DELETE FROM brief_versions WHERE project_id = ?1 AND id NOT IN
               (SELECT id FROM brief_versions WHERE project_id = ?1 ORDER BY id DESC LIMIT ${BRIEF_VERSIONS_KEPT})`,
          )
          .bind(project.id),
      );
    }
    next.brief = clean.text;
  }
  if (update.status) next.status = update.status;
  if (update.aliases) {
    const merged = new Set([...project.aliases.split(','), ...update.aliases].map((a) => a.trim()).filter(Boolean));
    next.aliases = redact([...merged].slice(0, 12).join(', ')).text;
  }
  next.updated_at = now;
  statements.push(
    db
      .prepare('UPDATE projects SET brief = ?2, status = ?3, aliases = ?4, updated_at = ?5 WHERE id = ?1')
      .bind(project.id, next.brief, next.status, next.aliases, now),
    ...reindex(db, 'project', project.id, project.id, `${next.name} ${next.aliases}`, next.brief, now),
  );
  return { statements, redactions, project: next };
}

export async function updateProject(db: Db, project: Project, update: ProjectUpdate) {
  const result = projectUpdateStatements(db, project, update, nowIso());
  await db.batch(result.statements);
  return result;
}

// ----------------------------------------------------------------- checkpoints

export interface CheckpointInput {
  title: string;
  summary: string;
  decisions?: string[];
  nextSteps?: string[];
  source: string;
}

export async function saveCheckpoint(
  db: Db,
  project: Project,
  input: CheckpointInput,
  update: ProjectUpdate = {},
): Promise<{ checkpoint: Checkpoint; project: Project; redactions: number }> {
  const now = nowIso();
  const title = redact(input.title.trim());
  const summary = redact(input.summary.trim());
  const decisions = redact((input.decisions ?? []).map((line) => `- ${line.trim()}`).join('\n'));
  const nextSteps = redact((input.nextSteps ?? []).map((line) => `- ${line.trim()}`).join('\n'));
  const checkpoint: Checkpoint = {
    id: crypto.randomUUID(),
    project_id: project.id,
    source: input.source,
    title: title.text,
    summary: summary.text,
    decisions: decisions.text,
    next_steps: nextSteps.text,
    created_at: now,
  };
  const projectChange = projectUpdateStatements(db, project, update, now);
  await db.batch([
    db
      .prepare(
        'INSERT INTO checkpoints (id, project_id, source, title, summary, decisions, next_steps, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
      )
      .bind(
        checkpoint.id,
        project.id,
        checkpoint.source,
        checkpoint.title,
        checkpoint.summary,
        checkpoint.decisions,
        checkpoint.next_steps,
        now,
      ),
    ...reindex(
      db,
      'checkpoint',
      checkpoint.id,
      project.id,
      checkpoint.title,
      [checkpoint.summary, checkpoint.decisions, checkpoint.next_steps].filter(Boolean).join('\n'),
      now,
    ),
    ...projectChange.statements,
  ]);
  return {
    checkpoint,
    project: projectChange.project,
    redactions: title.count + summary.count + decisions.count + nextSteps.count + projectChange.redactions,
  };
}

export async function recentCheckpoints(db: Db, projectId: string | null, limit: number) {
  const statement = projectId
    ? db.prepare('SELECT * FROM checkpoints WHERE project_id = ?1 ORDER BY created_at DESC LIMIT ?2').bind(projectId, limit)
    : db.prepare('SELECT * FROM checkpoints ORDER BY created_at DESC LIMIT ?1').bind(limit);
  return (await statement.all<Checkpoint>()).results;
}

export const getCheckpoint = (db: Db, id: string) =>
  db.prepare('SELECT * FROM checkpoints WHERE id = ?1').bind(id).first<Checkpoint>();

// ------------------------------------------------------------------- artifacts

export async function saveArtifact(
  db: Db,
  project: Project,
  input: { name: string; content: string; kind: string; source: string },
): Promise<{ artifact: ArtifactMeta; redactions: number }> {
  const now = nowIso();
  const name = redact(input.name.trim()).text;
  const content = redact(input.content);
  const existing = await db
    .prepare('SELECT id, version, created_at FROM artifacts WHERE project_id = ?1 AND name = ?2')
    .bind(project.id, name)
    .first<{ id: string; version: number; created_at: string }>();
  const id = existing?.id ?? crypto.randomUUID();
  const version = (existing?.version ?? 0) + 1;
  await db.batch([
    db
      .prepare(
        `INSERT INTO artifacts (id, project_id, name, kind, content, version, source, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
         ON CONFLICT (project_id, name) DO UPDATE SET
           kind = excluded.kind, content = excluded.content, version = excluded.version,
           source = excluded.source, updated_at = excluded.updated_at`,
      )
      .bind(id, project.id, name, input.kind, content.text, version, input.source, now),
    ...reindex(db, 'artifact', id, project.id, name, content.text, now),
    db.prepare('UPDATE projects SET updated_at = ?2 WHERE id = ?1').bind(project.id, now),
  ]);
  return {
    artifact: {
      id,
      project_id: project.id,
      name,
      kind: input.kind,
      version,
      source: input.source,
      size: content.text.length,
      updated_at: now,
    },
    redactions: content.count,
  };
}

export async function listArtifacts(db: Db, projectId: string): Promise<ArtifactMeta[]> {
  const { results } = await db
    .prepare(
      'SELECT id, project_id, name, kind, version, source, length(content) AS size, updated_at FROM artifacts WHERE project_id = ?1 ORDER BY updated_at DESC',
    )
    .bind(projectId)
    .all<ArtifactMeta>();
  return results;
}

export const getArtifact = (db: Db, id: string) =>
  db
    .prepare('SELECT *, length(content) AS size FROM artifacts WHERE id = ?1')
    .bind(id)
    .first<Artifact>();

// --------------------------------------------------------------------- profile

export async function getProfile(db: Db): Promise<{ key: string; value: string; updated_at: string }[]> {
  return (await db.prepare('SELECT key, value, updated_at FROM profile ORDER BY key').all<{ key: string; value: string; updated_at: string }>())
    .results;
}

export async function setProfile(db: Db, key: string, value: string): Promise<{ key: string; redactions: number }> {
  const now = nowIso();
  const cleanKey = slugify(key).slice(0, 60);
  const clean = redact(value.trim());
  await db.batch([
    // Saying it again on purpose is a new fact, so an earlier deletion no longer blocks it.
    db.prepare("DELETE FROM deletions WHERE kind = 'profile' AND ref = ?1").bind(cleanKey),
    db
      .prepare(
        'INSERT INTO profile (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .bind(cleanKey, clean.text, now),
    ...reindex(db, 'profile', cleanKey, null, cleanKey.replace(/-/g, ' '), clean.text, now),
  ]);
  return { key: cleanKey, redactions: clean.count };
}

// --------------------------------------------------------------- conversations

export interface IngestMessage {
  seq: number;
  role: string;
  text: string;
}

export interface IngestInput {
  source: string;
  externalId: string;
  title?: string;
  url?: string;
  startedAt?: string;
  /** The chat's own last-change date. Copying a memory between homes passes it so dates survive. */
  updatedAt?: string;
  projectId?: string | null;
  messages: IngestMessage[];
}

/**
 * Store or update a conversation. Messages are keyed by (conversation, seq), so sending
 * the same chat again only changes what is new. Uses a fixed number of SQL statements
 * however long the chat is.
 */
export async function ingestConversation(
  db: Db,
  input: IngestInput,
): Promise<{ id: string; created: boolean; messages: number; redactions: number; deleted?: true }> {
  // A chat deleted here stays deleted, however often an importer re-sends its history.
  if (await wasDeleted(db, 'conversation', chatRef(input.source, input.externalId))) {
    return { id: '', created: false, messages: 0, redactions: 0, deleted: true };
  }
  const now = input.updatedAt ?? nowIso();
  const existing = await db
    .prepare('SELECT id, project_id, title, started_at FROM conversations WHERE source = ?1 AND external_id = ?2')
    .bind(input.source, input.externalId)
    .first<{ id: string; project_id: string | null; title: string; started_at: string | null }>();
  const id = existing?.id ?? crypto.randomUUID();
  const projectId = input.projectId === undefined ? (existing?.project_id ?? null) : input.projectId;
  const title = redact((input.title ?? '').trim().slice(0, 300));

  let redactions = title.count;
  const rows = input.messages.map((message) => {
    const clean = redact(message.text);
    redactions += clean.count;
    return { seq: message.seq, role: message.role, text: clean.text };
  });
  const payload = JSON.stringify(rows);

  const statements: Statement[] = [
    db
      .prepare(
        `INSERT INTO conversations (id, source, external_id, project_id, title, url, started_at, updated_at, message_count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0)
         ON CONFLICT (source, external_id) DO UPDATE SET
           project_id = excluded.project_id,
           title = CASE WHEN excluded.title != '' THEN excluded.title ELSE conversations.title END,
           url = CASE WHEN excluded.url != '' THEN excluded.url ELSE conversations.url END,
           started_at = COALESCE(excluded.started_at, conversations.started_at),
           updated_at = excluded.updated_at`,
      )
      .bind(id, input.source, input.externalId, projectId, title.text, input.url ?? '', input.startedAt ?? null, now),
  ];
  // Only messages that are new or differ from what is stored are written and re-indexed, so
  // re-sending history costs reads, not writes. A changed title touches every indexed message,
  // because each one carries the chat title for ranking.
  const titleChanged = Boolean(existing) && title.text !== '' && title.text !== existing?.title;
  const indexTitle = title.text || existing?.title || '';
  const CHANGED = `SELECT json_extract(j.value, '$.seq') FROM json_each(?2) j
     WHERE NOT EXISTS (SELECT 1 FROM messages x WHERE x.conversation_id = ?1 AND x.seq = json_extract(j.value, '$.seq')
       AND x.role = json_extract(j.value, '$.role') AND x.text = json_extract(j.value, '$.text'))`;
  if (rows.length > 0) {
    statements.push(
      // 1. Drop index rows of the messages about to change.
      db
        .prepare(
          `DELETE FROM search_fts WHERE rowid IN
             (SELECT id FROM search_map WHERE kind = 'message' AND ref_id = ?1 AND seq IN (${CHANGED}))`,
        )
        .bind(id, payload),
      db.prepare(`DELETE FROM search_map WHERE kind = 'message' AND ref_id = ?1 AND seq IN (${CHANGED})`).bind(id, payload),
      // 2. Write only new or different messages.
      db
        .prepare(
          `INSERT INTO messages (conversation_id, seq, role, text)
           SELECT ?1, json_extract(j.value, '$.seq'), json_extract(j.value, '$.role'), json_extract(j.value, '$.text')
           FROM json_each(?2) j WHERE json_extract(j.value, '$.seq') IN (${CHANGED})
           ON CONFLICT (conversation_id, seq) DO UPDATE SET role = excluded.role, text = excluded.text`,
        )
        .bind(id, payload),
    );
  }
  if (titleChanged) {
    // Re-index the whole chat under its new title.
    statements.push(
      db
        .prepare(`DELETE FROM search_fts WHERE rowid IN (SELECT id FROM search_map WHERE kind = 'message' AND ref_id = ?1)`)
        .bind(id),
      db.prepare(`DELETE FROM search_map WHERE kind = 'message' AND ref_id = ?1`).bind(id),
    );
  }
  if (rows.length > 0 || titleChanged) {
    statements.push(
      // 3. Index every stored message of this chat that has no index rows yet, in chunks.
      db
        .prepare(
          `WITH RECURSIVE ch(seq, k) AS (
             SELECT msg.seq, 0 FROM messages msg
             WHERE msg.conversation_id = ?1
               AND NOT EXISTS (SELECT 1 FROM search_map m WHERE m.kind = 'message' AND m.ref_id = ?1 AND m.seq = msg.seq)
             UNION ALL
             SELECT ch.seq, ch.k + 1 FROM ch JOIN messages msg ON msg.conversation_id = ?1 AND msg.seq = ch.seq
             WHERE length(msg.text) > (ch.k + 1) * ${CHUNK_CHARS} + ${CHUNK_OVERLAP}
           )
           INSERT INTO search_map (kind, ref_id, project_id, seq, chunk, created_at)
           SELECT 'message', ?1, ?2, seq, k, ?3 FROM ch`,
        )
        // Imported history keeps its real date; live captures without one use now.
        .bind(id, projectId, input.startedAt ?? existing?.started_at ?? now),
      db
        .prepare(
          `INSERT INTO search_fts (rowid, title, body)
           SELECT m.id, ?2, substr(msg.text, m.chunk * ${CHUNK_CHARS} + 1, ${CHUNK_CHARS + CHUNK_OVERLAP})
           FROM search_map m JOIN messages msg ON msg.conversation_id = m.ref_id AND msg.seq = m.seq
           WHERE m.kind = 'message' AND m.ref_id = ?1 AND NOT EXISTS (SELECT 1 FROM search_fts f WHERE f.rowid = m.id)`,
        )
        .bind(id, indexTitle),
    );
  }
  statements.push(
    db
      .prepare("UPDATE search_map SET project_id = ?2 WHERE kind = 'message' AND ref_id = ?1 AND project_id IS NOT ?2")
      .bind(id, projectId),
    db
      .prepare(
        `UPDATE conversations SET message_count = (SELECT count(*) FROM messages WHERE conversation_id = ?1)
         WHERE id = ?1 AND message_count != (SELECT count(*) FROM messages WHERE conversation_id = ?1)`,
      )
      .bind(id),
  );
  await db.batch(statements);
  return { id, created: !existing, messages: rows.length, redactions };
}

export const getConversation = (db: Db, id: string) =>
  db.prepare('SELECT * FROM conversations WHERE id = ?1').bind(id).first<Conversation>();

export async function listConversations(db: Db, projectId: string, limit: number): Promise<Conversation[]> {
  return (
    await db
      .prepare('SELECT * FROM conversations WHERE project_id = ?1 ORDER BY updated_at DESC LIMIT ?2')
      .bind(projectId, limit)
      .all<Conversation>()
  ).results;
}

export async function getMessages(db: Db, conversationId: string, fromSeq: number, limit: number) {
  return (
    await db
      .prepare('SELECT seq, role, text FROM messages WHERE conversation_id = ?1 AND seq >= ?2 ORDER BY seq LIMIT ?3')
      .bind(conversationId, fromSeq, limit)
      .all<IngestMessage>()
  ).results;
}

// ---------------------------------------------------------------------- forget


// ---------------------------------------------------------------------- moved (read-only)

export interface Moved {
  /** The new home, without any key. */
  to: string;
  at: string;
  /** The memory hash both homes had when the move was verified. */
  memory_sha256: string;
}

/** Set when this memory was moved to a new home; it is then read-only. Null on older schemas. */
export async function getMoved(db: Db): Promise<Moved | null> {
  try {
    const row = await db.prepare("SELECT value FROM hub_state WHERE key = 'moved'").first<{ value: string }>();
    return row ? (JSON.parse(row.value) as Moved) : null;
  } catch {
    return null;
  }
}

export async function setMoved(db: Db, moved: Moved | null): Promise<void> {
  if (!moved) {
    await db.prepare("DELETE FROM hub_state WHERE key = 'moved'").run();
    return;
  }
  await db
    .prepare("INSERT INTO hub_state (key, value, updated_at) VALUES ('moved', ?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(JSON.stringify(moved), nowIso())
    .run();
}

/** The sentence every refused write gives while a memory is read-only after a move. */
export const movedMessage = (moved: Moved) =>
  `This memory moved to ${moved.to} on ${moved.at.slice(0, 10)} and is read-only here, so nothing was changed. Reconnect this app to the new address.`;

export type DeletionKind = 'project' | 'checkpoint' | 'artifact' | 'profile' | 'conversation';
const DELETION_KINDS: readonly DeletionKind[] = ['project', 'checkpoint', 'artifact', 'profile', 'conversation'];

/** Ledger key of a chat: chats are identified across homes by where they came from. */
const chatRef = (source: string, externalId: string) => `${source}:${externalId}`;

/** True when a record with this identity was deleted here, so it must not come back. */
export async function wasDeleted(db: Db, kind: DeletionKind, ref: string): Promise<boolean> {
  return Boolean(await db.prepare('SELECT 1 FROM deletions WHERE kind = ?1 AND ref = ?2').bind(kind, ref).first());
}

/** Statements that remove one record (and its index rows) and add it to the ledger. */
async function deletionStatements(db: Db, kind: DeletionKind, id: string, now: string): Promise<Statement[] | null> {
  const record = (k: DeletionKind, ref: string) =>
    db.prepare('INSERT OR REPLACE INTO deletions (kind, ref, deleted_at) VALUES (?1, ?2, ?3)').bind(k, ref, now);
  switch (kind) {
    case 'project': {
      if (!(await getProject(db, id))) return null;
      return [
        record('project', id),
        // Its sessions and files go with it (ON DELETE CASCADE), so they are listed too.
        db.prepare("INSERT OR REPLACE INTO deletions (kind, ref, deleted_at) SELECT 'checkpoint', id, ?2 FROM checkpoints WHERE project_id = ?1").bind(id, now),
        db.prepare("INSERT OR REPLACE INTO deletions (kind, ref, deleted_at) SELECT 'artifact', id, ?2 FROM artifacts WHERE project_id = ?1").bind(id, now),
        // Chats that belonged to the project stay, unfiled; their search rows lose the project tag.
        db.prepare("UPDATE search_map SET project_id = NULL WHERE kind = 'message' AND project_id = ?1").bind(id),
        db.prepare('DELETE FROM search_fts WHERE rowid IN (SELECT id FROM search_map WHERE project_id = ?1)').bind(id),
        db.prepare('DELETE FROM search_map WHERE project_id = ?1').bind(id),
        db.prepare('DELETE FROM projects WHERE id = ?1').bind(id),
      ];
    }
    case 'checkpoint':
    case 'artifact': {
      const table = kind === 'checkpoint' ? 'checkpoints' : 'artifacts';
      if (!(await db.prepare(`SELECT 1 FROM ${table} WHERE id = ?1`).bind(id).first())) return null;
      return [record(kind, id), ...unindex(db, kind, id), db.prepare(`DELETE FROM ${table} WHERE id = ?1`).bind(id)];
    }
    case 'profile': {
      if (!(await db.prepare('SELECT 1 FROM profile WHERE key = ?1').bind(id).first())) return null;
      return [record('profile', id), ...unindex(db, 'profile', id), db.prepare('DELETE FROM profile WHERE key = ?1').bind(id)];
    }
    case 'conversation': {
      const chat = await getConversation(db, id);
      if (!chat) return null;
      return [record('conversation', chatRef(chat.source, chat.external_id)), ...unindex(db, 'message', id), db.prepare('DELETE FROM conversations WHERE id = ?1').bind(id)];
    }
  }
}

export type ForgetKind = DeletionKind;

/**
 * Permanently delete one stored item and everything indexed for it, and record the deletion so
 * imports, restores and copies cannot bring it back. Returns false if it did not exist.
 */
export async function forget(db: Db, kind: ForgetKind, id: string): Promise<boolean> {
  const statements = await deletionStatements(db, kind, id, nowIso());
  if (!statements) return false;
  await db.batch(statements);
  return true;
}

// ---------------------------------------------------------------------- export

export const EXPORT_TABLES = [
  'projects',
  'brief_versions',
  'checkpoints',
  'artifacts',
  'profile',
  'conversations',
  'messages',
  'deletions',
] as const;

/** One page of a table, for taking your data out. `after` is the last rowid already seen. */
export async function exportPage(db: Db, table: (typeof EXPORT_TABLES)[number], after: number, limit: number) {
  const { results } = await db
    .prepare(`SELECT rowid AS _rowid, * FROM ${table} WHERE rowid > ?1 ORDER BY rowid LIMIT ?2`)
    .bind(after, limit)
    .all<Record<string, unknown> & { _rowid: number }>();
  const last = results[results.length - 1];
  return { table, rows: results, next: results.length === limit && last ? last._rowid : null };
}

// ---------------------------------------------------------------------- import

export const IMPORT_TABLES = ['deletions', 'projects', 'brief_versions', 'checkpoints', 'artifacts', 'profile'] as const;
export type ImportTable = (typeof IMPORT_TABLES)[number];

/** A row the caller sent is malformed; the message says which field and what to fix. */
export class ImportError extends Error {}

export interface ImportResult {
  inserted: number;
  same: number;
  replaced: number;
  /** Rows that differ from the destination's, where the destination's was kept. */
  kept: number;
  /** Rows whose project is on neither side. */
  skipped: number;
  /** Rows not added because they were deleted on the destination, plus (for the ledger itself) records it removed. */
  deleted: number;
  notes: string[];
  /** Source project id -> destination project id, for the rows that follow. */
  idMap: Record<string, string>;
}

type Row = Record<string, unknown>;
const NOTES_KEPT = 50;

/**
 * Add rows exported from another memory, keeping their ids and dates. Additive: the
 * destination wins on a difference unless `replace` is set and the incoming row is newer.
 * With `dryRun`, reports what would happen and writes nothing.
 */
export async function importRows(
  db: Db,
  table: ImportTable,
  rows: Row[],
  options: { replace?: boolean; dryRun?: boolean; idMap?: Record<string, string> } = {},
): Promise<ImportResult> {
  const out: ImportResult = { inserted: 0, same: 0, replaced: 0, kept: 0, skipped: 0, deleted: 0, notes: [], idMap: { ...options.idMap } };
  const statements: Statement[] = [];
  const touched = new Set<string>();
  const note = (line: string) => {
    if (out.notes.length < NOTES_KEPT) out.notes.push(line);
  };
  const text = (row: Row, field: string, optional = false): string => {
    const value = row[field];
    if (typeof value === 'string') return value;
    if (optional && value == null) return '';
    throw new ImportError(`${table} row needs "${field}" as text.`);
  };
  const date = (row: Row, field: string): string => {
    const value = text(row, field);
    if (Number.isNaN(Date.parse(value))) throw new ImportError(`${table} row has an invalid date in "${field}".`);
    return value;
  };
  const newer = (incoming: string, stored: string) => Date.parse(incoming) > Date.parse(stored);
  // The map is authoritative for projects that came with this copy, because in a dry run
  // they are not written yet.
  const projectFor = async (row: Row): Promise<string | null> => {
    const source = text(row, 'project_id');
    const mapped = out.idMap[source];
    if (mapped) return mapped;
    return (await db.prepare('SELECT id FROM projects WHERE id = ?1').bind(source).first<{ id: string }>()) ? source : null;
  };

  for (const row of rows) {
    if (typeof row !== 'object' || row === null) throw new ImportError(`Each ${table} row must be an object.`);
    // Something deleted here never comes back through an import, restore or copy.
    const identity: [DeletionKind, unknown] | null =
      table === 'projects' ? ['project', row.id]
      : table === 'checkpoints' ? ['checkpoint', row.id]
      : table === 'artifacts' ? ['artifact', row.id]
      : table === 'profile' ? ['profile', row.key]
      : null;
    if (identity && typeof identity[1] === 'string' && (await wasDeleted(db, identity[0], identity[1]))) {
      out.deleted++;
      continue;
    }
    switch (table) {
      case 'deletions': {
        const kind = text(row, 'kind') as DeletionKind;
        if (!DELETION_KINDS.includes(kind)) throw new ImportError(`deletions row has an unknown kind "${kind}".`);
        const ref = text(row, 'ref');
        const at = date(row, 'deleted_at');
        if (await wasDeleted(db, kind, ref)) {
          out.same++;
          break;
        }
        out.inserted++;
        // Remove the record here too, if this memory still has it.
        let localId: string | null = ref;
        if (kind === 'conversation') {
          const split = ref.indexOf(':');
          const found = await db
            .prepare('SELECT id FROM conversations WHERE source = ?1 AND external_id = ?2')
            .bind(ref.slice(0, split), ref.slice(split + 1))
            .first<{ id: string }>();
          localId = found?.id ?? null;
        }
        const removal = localId ? await deletionStatements(db, kind, localId, at) : null;
        if (removal) {
          out.deleted++;
          note(`removed ${kind} ${ref}: it was deleted on the source`);
          statements.push(...removal);
        } else {
          statements.push(db.prepare('INSERT OR IGNORE INTO deletions (kind, ref, deleted_at) VALUES (?1, ?2, ?3)').bind(kind, ref, at));
        }
        break;
      }
      case 'projects': {
        const id = text(row, 'id');
        const slug = text(row, 'slug');
        const name = redact(text(row, 'name')).text;
        const status = text(row, 'status');
        if (!['active', 'paused', 'done', 'archived'].includes(status)) throw new ImportError(`projects row has an unknown status "${status}".`);
        const brief = redact(text(row, 'brief', true)).text;
        const aliases = redact(text(row, 'aliases', true)).text;
        const created = date(row, 'created_at');
        const updated = date(row, 'updated_at');
        const found = await db
          .prepare('SELECT * FROM projects WHERE id = ?1 OR slug = ?2 OR lower(name) = lower(?3) ORDER BY (id = ?1) DESC LIMIT 1')
          .bind(id, slug, name)
          .first<Project>();
        if (!found) {
          out.idMap[id] = id;
          out.inserted++;
          statements.push(
            db
              .prepare('INSERT INTO projects (id, slug, name, aliases, status, brief, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
              .bind(id, slug, name, aliases, status, brief, created, updated),
            ...reindex(db, 'project', id, id, `${name} ${aliases}`, brief, updated),
          );
          break;
        }
        out.idMap[id] = found.id;
        const merged = redact(
          [...new Set([...found.aliases.split(','), ...aliases.split(',')].map((a) => a.trim()).filter(Boolean))].slice(0, 12).join(', '),
        ).text;
        let nextBrief = found.brief;
        let outcome: 'same' | 'replaced' | 'kept' = 'same';
        if (brief && brief !== found.brief) {
          if (options.replace && newer(updated, found.updated_at)) {
            statements.push(
              db.prepare('INSERT INTO brief_versions (project_id, brief, replaced_at) VALUES (?1, ?2, ?3)').bind(found.id, found.brief, updated),
            );
            touched.add(found.id);
            nextBrief = brief;
            outcome = 'replaced';
            note(`${found.name}: brief replaced by the newer one (the old one is in its history)`);
          } else {
            outcome = 'kept';
            note(`${found.name}: brief differs, kept the destination's`);
            // Nothing is lost: the other brief goes to history, unless it is already there.
            const have = await db
              .prepare('SELECT 1 FROM brief_versions WHERE project_id = ?1 AND brief = ?2')
              .bind(found.id, brief)
              .first();
            if (!have) {
              statements.push(
                db.prepare('INSERT INTO brief_versions (project_id, brief, replaced_at) VALUES (?1, ?2, ?3)').bind(found.id, brief, updated),
              );
              touched.add(found.id);
            }
          }
        }
        if (nextBrief !== found.brief || merged !== found.aliases) {
          const stamp = newer(updated, found.updated_at) ? updated : found.updated_at;
          statements.push(
            db.prepare('UPDATE projects SET brief = ?2, aliases = ?3, updated_at = ?4 WHERE id = ?1').bind(found.id, nextBrief, merged, stamp),
            ...reindex(db, 'project', found.id, found.id, `${found.name} ${merged}`, nextBrief, stamp),
          );
        }
        out[outcome]++;
        break;
      }
      case 'brief_versions': {
        const project = await projectFor(row);
        if (!project) {
          out.skipped++;
          break;
        }
        const brief = redact(text(row, 'brief')).text;
        const at = date(row, 'replaced_at');
        const have = await db
          .prepare('SELECT 1 FROM brief_versions WHERE project_id = ?1 AND brief = ?2 AND replaced_at = ?3')
          .bind(project, brief, at)
          .first();
        if (have) {
          out.same++;
          break;
        }
        out.inserted++;
        touched.add(project);
        statements.push(db.prepare('INSERT INTO brief_versions (project_id, brief, replaced_at) VALUES (?1, ?2, ?3)').bind(project, brief, at));
        break;
      }
      case 'checkpoints': {
        const project = await projectFor(row);
        if (!project) {
          out.skipped++;
          break;
        }
        const id = text(row, 'id');
        if (await db.prepare('SELECT 1 FROM checkpoints WHERE id = ?1').bind(id).first()) {
          out.same++;
          break;
        }
        const title = redact(text(row, 'title')).text;
        const summary = redact(text(row, 'summary')).text;
        const decisions = redact(text(row, 'decisions', true)).text;
        const nextSteps = redact(text(row, 'next_steps', true)).text;
        const created = date(row, 'created_at');
        out.inserted++;
        statements.push(
          db
            .prepare('INSERT INTO checkpoints (id, project_id, source, title, summary, decisions, next_steps, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
            .bind(id, project, text(row, 'source'), title, summary, decisions, nextSteps, created),
          ...reindex(db, 'checkpoint', id, project, title, [summary, decisions, nextSteps].filter(Boolean).join('\n'), created),
        );
        break;
      }
      case 'artifacts': {
        const project = await projectFor(row);
        if (!project) {
          out.skipped++;
          break;
        }
        const id = text(row, 'id');
        const name = redact(text(row, 'name').trim()).text;
        const content = redact(text(row, 'content')).text;
        const updated = date(row, 'updated_at');
        const found = await db
          .prepare('SELECT id, content, updated_at, version FROM artifacts WHERE id = ?1 OR (project_id = ?2 AND name = ?3) LIMIT 1')
          .bind(id, project, name)
          .first<{ id: string; content: string; updated_at: string; version: number }>();
        if (!found) {
          out.inserted++;
          statements.push(
            db
              .prepare('INSERT INTO artifacts (id, project_id, name, kind, content, version, source, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)')
              .bind(id, project, name, text(row, 'kind', true) || 'text', content, Number(row.version) || 1, text(row, 'source'), date(row, 'created_at'), updated),
            ...reindex(db, 'artifact', id, project, name, content, updated),
          );
        } else if (found.content === content) {
          out.same++;
        } else if (options.replace && newer(updated, found.updated_at)) {
          out.replaced++;
          note(`file ${name}: replaced by the newer one`);
          statements.push(
            db
              .prepare('UPDATE artifacts SET kind = ?2, content = ?3, version = ?4, source = ?5, updated_at = ?6 WHERE id = ?1')
              .bind(found.id, text(row, 'kind', true) || 'text', content, found.version + 1, text(row, 'source'), updated),
            ...reindex(db, 'artifact', found.id, project, name, content, updated),
          );
        } else {
          out.kept++;
          note(`file ${name}: differs, kept the destination's`);
        }
        break;
      }
      case 'profile': {
        const key = text(row, 'key');
        const value = redact(text(row, 'value')).text;
        const updated = date(row, 'updated_at');
        const found = await db.prepare('SELECT value, updated_at FROM profile WHERE key = ?1').bind(key).first<{ value: string; updated_at: string }>();
        const index = () => reindex(db, 'profile', key, null, key.replace(/-/g, ' '), value, updated);
        if (!found) {
          out.inserted++;
          statements.push(db.prepare('INSERT INTO profile (key, value, updated_at) VALUES (?1, ?2, ?3)').bind(key, value, updated), ...index());
        } else if (found.value === value) {
          out.same++;
        } else if (options.replace && newer(updated, found.updated_at)) {
          out.replaced++;
          note(`fact ${key}: replaced by the newer one`);
          statements.push(db.prepare('UPDATE profile SET value = ?2, updated_at = ?3 WHERE key = ?1').bind(key, value, updated), ...index());
        } else {
          out.kept++;
          note(`fact ${key}: differs, kept the destination's`);
        }
        break;
      }
    }
  }
  for (const project of touched) {
    statements.push(
      db
        .prepare(
          `DELETE FROM brief_versions WHERE project_id = ?1 AND id NOT IN
             (SELECT id FROM brief_versions WHERE project_id = ?1 ORDER BY id DESC LIMIT ${BRIEF_VERSIONS_KEPT})`,
        )
        .bind(project),
    );
  }
  if (!options.dryRun && statements.length > 0) await db.batch(statements);
  return out;
}
