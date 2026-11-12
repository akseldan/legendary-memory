/**
 * All database access. Every write that carries text runs it through redact() first and
 * keeps the search index in step inside the same transaction (D1 batch).
 */
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

/** Longest stretch of a row's text that goes into the search index. */
const INDEX_BODY_CHARS = 8000;
const BRIEF_VERSIONS_KEPT = 10;

// ---------------------------------------------------------------- search index

function unindex(db: D1Database, kind: string, refId: string): D1PreparedStatement[] {
  return [
    db
      .prepare('DELETE FROM search_fts WHERE rowid IN (SELECT id FROM search_map WHERE kind = ?1 AND ref_id = ?2)')
      .bind(kind, refId),
    db.prepare('DELETE FROM search_map WHERE kind = ?1 AND ref_id = ?2').bind(kind, refId),
  ];
}

function reindex(
  db: D1Database,
  kind: string,
  refId: string,
  projectId: string | null,
  title: string,
  body: string,
  createdAt: string,
): D1PreparedStatement[] {
  return [
    ...unindex(db, kind, refId),
    db
      .prepare('INSERT INTO search_map (kind, ref_id, project_id, seq, created_at) VALUES (?1, ?2, ?3, 0, ?4)')
      .bind(kind, refId, projectId, createdAt),
    db
      .prepare(
        'INSERT INTO search_fts (rowid, title, body) SELECT id, ?3, ?4 FROM search_map WHERE kind = ?1 AND ref_id = ?2',
      )
      .bind(kind, refId, title, body.slice(0, INDEX_BODY_CHARS)),
  ];
}

export async function search(
  db: D1Database,
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
  binds.push(limit);
  // Title matches count four times as much as body matches.
  const sql = `
    SELECT m.kind, m.ref_id, m.project_id, m.seq, m.created_at, search_fts.title AS title,
           snippet(search_fts, 1, '', '', ' … ', 28) AS snippet
    FROM search_fts JOIN search_map m ON m.id = search_fts.rowid
    WHERE ${where.join(' AND ')}
    ORDER BY bm25(search_fts, 4.0, 1.0)
    LIMIT ?${binds.length}`;
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<SearchHit>();
  return results;
}

// -------------------------------------------------------------------- projects

export async function listProjects(db: D1Database): Promise<Project[]> {
  const { results } = await db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all<Project>();
  return results;
}

export async function getProject(db: D1Database, id: string): Promise<Project | null> {
  return db.prepare('SELECT * FROM projects WHERE id = ?1').bind(id).first<Project>();
}

export interface Resolution {
  /** Set when one project clearly fits. */
  match?: Project;
  /** True when the match came from a near-miss spelling rather than the name itself. */
  fuzzy: boolean;
  /** Other plausible projects, best first (excludes `match`). */
  candidates: Project[];
}

function scoreProject(project: Project, ref: string): number {
  const wanted = ref.trim().toLowerCase();
  if (!wanted) return 0;
  if (project.slug === slugify(ref) || project.name.toLowerCase() === wanted) return 100;
  const refWords = keyWords(ref);
  if (refWords.length === 0) return 0;
  let best = 0;
  const names = [project.name, ...project.aliases.split(',')].map((name) => name.trim()).filter(Boolean);
  for (const name of names) {
    if (name.toLowerCase() === wanted) return 100;
    const nameWords = keyWords(name);
    if (nameWords.length === 0) continue;
    if (nameWords.join(' ') === refWords.join(' ')) best = Math.max(best, 95);
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
export async function resolveProject(db: D1Database, ref: string): Promise<Resolution> {
  const scored = (await listProjects(db))
    .map((project) => ({ project, score: scoreProject(project, ref) }))
    .filter((entry) => entry.score >= 50)
    .sort((a, b) => b.score - a.score);
  const [top, second] = scored;
  if (!top) return { fuzzy: false, candidates: [] };
  const clear = top.score >= 80 && (!second || top.score - second.score >= 15);
  const onlyOne = top.score >= 60 && !second;
  if (clear || onlyOne) {
    return { match: top.project, fuzzy: top.score < 80, candidates: scored.slice(1, 5).map((e) => e.project) };
  }
  return { fuzzy: false, candidates: scored.slice(0, 5).map((e) => e.project) };
}

export async function createProject(db: D1Database, name: string): Promise<Project> {
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
function projectUpdateStatements(db: D1Database, project: Project, update: ProjectUpdate, now: string) {
  const statements: D1PreparedStatement[] = [];
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

export async function updateProject(db: D1Database, project: Project, update: ProjectUpdate) {
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
  db: D1Database,
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

export async function recentCheckpoints(db: D1Database, projectId: string | null, limit: number) {
  const statement = projectId
    ? db.prepare('SELECT * FROM checkpoints WHERE project_id = ?1 ORDER BY created_at DESC LIMIT ?2').bind(projectId, limit)
    : db.prepare('SELECT * FROM checkpoints ORDER BY created_at DESC LIMIT ?1').bind(limit);
  return (await statement.all<Checkpoint>()).results;
}

export const getCheckpoint = (db: D1Database, id: string) =>
  db.prepare('SELECT * FROM checkpoints WHERE id = ?1').bind(id).first<Checkpoint>();

// ------------------------------------------------------------------- artifacts

export async function saveArtifact(
  db: D1Database,
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

export async function listArtifacts(db: D1Database, projectId: string): Promise<ArtifactMeta[]> {
  const { results } = await db
    .prepare(
      'SELECT id, project_id, name, kind, version, source, length(content) AS size, updated_at FROM artifacts WHERE project_id = ?1 ORDER BY updated_at DESC',
    )
    .bind(projectId)
    .all<ArtifactMeta>();
  return results;
}

export const getArtifact = (db: D1Database, id: string) =>
  db
    .prepare('SELECT *, length(content) AS size FROM artifacts WHERE id = ?1')
    .bind(id)
    .first<Artifact>();

// --------------------------------------------------------------------- profile

export async function getProfile(db: D1Database): Promise<{ key: string; value: string; updated_at: string }[]> {
  return (await db.prepare('SELECT key, value, updated_at FROM profile ORDER BY key').all<{ key: string; value: string; updated_at: string }>())
    .results;
}

export async function setProfile(db: D1Database, key: string, value: string): Promise<{ key: string; redactions: number }> {
  const now = nowIso();
  const cleanKey = slugify(key).slice(0, 60);
  const clean = redact(value.trim());
  await db.batch([
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
  projectId?: string | null;
  messages: IngestMessage[];
}

/**
 * Store or update a conversation. Messages are keyed by (conversation, seq), so sending
 * the same chat again only changes what is new. Uses a fixed number of SQL statements
 * however long the chat is.
 */
export async function ingestConversation(
  db: D1Database,
  input: IngestInput,
): Promise<{ id: string; created: boolean; messages: number; redactions: number }> {
  const now = nowIso();
  const existing = await db
    .prepare('SELECT id, project_id, title FROM conversations WHERE source = ?1 AND external_id = ?2')
    .bind(input.source, input.externalId)
    .first<{ id: string; project_id: string | null; title: string }>();
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
  const seqs = rows.map((row) => row.seq);
  const low = seqs.length ? Math.min(...seqs) : 0;
  const high = seqs.length ? Math.max(...seqs) : -1;

  const statements: D1PreparedStatement[] = [
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
  if (rows.length > 0) {
    statements.push(
      db
        .prepare(
          `INSERT INTO messages (conversation_id, seq, role, text)
           SELECT ?1, json_extract(value, '$.seq'), json_extract(value, '$.role'), json_extract(value, '$.text')
           FROM json_each(?2) WHERE true
           ON CONFLICT (conversation_id, seq) DO UPDATE SET role = excluded.role, text = excluded.text`,
        )
        .bind(id, payload),
      db
        .prepare(
          `DELETE FROM search_fts WHERE rowid IN
             (SELECT id FROM search_map WHERE kind = 'message' AND ref_id = ?1 AND seq BETWEEN ?2 AND ?3)`,
        )
        .bind(id, low, high),
      db.prepare("DELETE FROM search_map WHERE kind = 'message' AND ref_id = ?1 AND seq BETWEEN ?2 AND ?3").bind(id, low, high),
      db
        .prepare(
          `INSERT INTO search_map (kind, ref_id, project_id, seq, created_at)
           SELECT 'message', ?1, ?2, seq, ?5 FROM messages WHERE conversation_id = ?1 AND seq BETWEEN ?3 AND ?4`,
        )
        .bind(id, projectId, low, high, now),
      db
        .prepare(
          `INSERT INTO search_fts (rowid, title, body)
           SELECT m.id, ?4, substr(msg.text, 1, ${INDEX_BODY_CHARS})
           FROM search_map m JOIN messages msg ON msg.conversation_id = m.ref_id AND msg.seq = m.seq
           WHERE m.kind = 'message' AND m.ref_id = ?1 AND m.seq BETWEEN ?2 AND ?3`,
        )
        .bind(id, low, high, title.text || existing?.title || ''),
    );
  }
  statements.push(
    db.prepare("UPDATE search_map SET project_id = ?2 WHERE kind = 'message' AND ref_id = ?1").bind(id, projectId),
    db
      .prepare('UPDATE conversations SET message_count = (SELECT count(*) FROM messages WHERE conversation_id = ?1) WHERE id = ?1')
      .bind(id),
  );
  await db.batch(statements);
  return { id, created: !existing, messages: rows.length, redactions };
}

export const getConversation = (db: D1Database, id: string) =>
  db.prepare('SELECT * FROM conversations WHERE id = ?1').bind(id).first<Conversation>();

export async function listConversations(db: D1Database, projectId: string, limit: number): Promise<Conversation[]> {
  return (
    await db
      .prepare('SELECT * FROM conversations WHERE project_id = ?1 ORDER BY updated_at DESC LIMIT ?2')
      .bind(projectId, limit)
      .all<Conversation>()
  ).results;
}

export async function getMessages(db: D1Database, conversationId: string, fromSeq: number, limit: number) {
  return (
    await db
      .prepare('SELECT seq, role, text FROM messages WHERE conversation_id = ?1 AND seq >= ?2 ORDER BY seq LIMIT ?3')
      .bind(conversationId, fromSeq, limit)
      .all<IngestMessage>()
  ).results;
}

// ---------------------------------------------------------------------- forget

export type ForgetKind = 'project' | 'checkpoint' | 'artifact' | 'profile' | 'conversation';

/** Permanently delete one stored item and everything indexed for it. Returns false if it did not exist. */
export async function forget(db: D1Database, kind: ForgetKind, id: string): Promise<boolean> {
  switch (kind) {
    case 'project': {
      if (!(await getProject(db, id))) return false;
      await db.batch([
        // Chats that belonged to the project stay, unfiled; their search rows lose the project tag.
        db.prepare("UPDATE search_map SET project_id = NULL WHERE kind = 'message' AND project_id = ?1").bind(id),
        db.prepare('DELETE FROM search_fts WHERE rowid IN (SELECT id FROM search_map WHERE project_id = ?1)').bind(id),
        db.prepare('DELETE FROM search_map WHERE project_id = ?1').bind(id),
        db.prepare('DELETE FROM projects WHERE id = ?1').bind(id),
      ]);
      return true;
    }
    case 'checkpoint':
    case 'artifact': {
      const table = kind === 'checkpoint' ? 'checkpoints' : 'artifacts';
      if (!(await db.prepare(`SELECT 1 FROM ${table} WHERE id = ?1`).bind(id).first())) return false;
      await db.batch([...unindex(db, kind, id), db.prepare(`DELETE FROM ${table} WHERE id = ?1`).bind(id)]);
      return true;
    }
    case 'profile': {
      if (!(await db.prepare('SELECT 1 FROM profile WHERE key = ?1').bind(id).first())) return false;
      await db.batch([...unindex(db, 'profile', id), db.prepare('DELETE FROM profile WHERE key = ?1').bind(id)]);
      return true;
    }
    case 'conversation': {
      if (!(await getConversation(db, id))) return false;
      await db.batch([...unindex(db, 'message', id), db.prepare('DELETE FROM conversations WHERE id = ?1').bind(id)]);
      return true;
    }
  }
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
] as const;

/** One page of a table, for taking your data out. `after` is the last rowid already seen. */
export async function exportPage(db: D1Database, table: (typeof EXPORT_TABLES)[number], after: number, limit: number) {
  const { results } = await db
    .prepare(`SELECT rowid AS _rowid, * FROM ${table} WHERE rowid > ?1 ORDER BY rowid LIMIT ?2`)
    .bind(after, limit)
    .all<Record<string, unknown> & { _rowid: number }>();
  const last = results[results.length - 1];
  return { table, rows: results, next: results.length === limit && last ? last._rowid : null };
}
