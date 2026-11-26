/**
 * A small HTTP API for tools that are not AI apps: the history importer and the browser
 * extension. Off until a BRIDGE_API_KEY secret is set; every call needs that key.
 */
import { VERSION } from './constants';
import type { Db } from './db';
import { healthSummary } from './activity';
import * as store from './store';
import { admitWrite, currentLimits } from './limits';

const MAX_BODY_BYTES = 1_500_000;
const MAX_MESSAGES = 2000;
const MAX_IMPORT_ROWS = 100;
const SOURCES = new Set(['chatgpt', 'claude', 'codex', 'cursor', 'gemini', 'other']);
const ROLES = new Set(['user', 'assistant', 'system', 'tool']);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

const problem = (status: number, error: string): Response => json({ error }, status);

/** What a target gives the API: the database and the key callers must present. */
export interface ApiContext {
  db: Db;
  apiKey?: string;
}

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ (y[i] ?? 0);
  return diff === 0;
}

async function authorized(request: Request, key: string): Promise<boolean> {
  const header = request.headers.get('Authorization') ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(given)),
    crypto.subtle.digest('SHA-256', encoder.encode(key)),
  ]);
  return sameBytes(left, right) && key.length > 0;
}

function parseIngest(body: unknown): store.IngestInput | string {
  if (typeof body !== 'object' || body === null) return 'Body must be a JSON object.';
  const b = body as Record<string, unknown>;
  if (typeof b.source !== 'string' || !SOURCES.has(b.source)) return `source must be one of: ${[...SOURCES].join(', ')}.`;
  if (typeof b.external_id !== 'string' || b.external_id.length < 1 || b.external_id.length > 200) {
    return 'external_id must be a string of 1 to 200 characters.';
  }
  if (!Array.isArray(b.messages) || b.messages.length > MAX_MESSAGES) return `messages must be an array of at most ${MAX_MESSAGES}.`;
  const messages: store.IngestMessage[] = [];
  const seen = new Set<number>();
  for (const raw of b.messages) {
    const m = raw as Record<string, unknown>;
    if (typeof m !== 'object' || m === null) return 'Each message must be an object.';
    if (!Number.isInteger(m.seq) || (m.seq as number) < 0) return 'Each message needs a whole-number seq of 0 or more.';
    if (seen.has(m.seq as number)) return `seq ${m.seq} appears twice.`;
    seen.add(m.seq as number);
    if (typeof m.role !== 'string' || !ROLES.has(m.role)) return `role must be one of: ${[...ROLES].join(', ')}.`;
    if (typeof m.text !== 'string') return 'Each message needs text.';
    messages.push({ seq: m.seq as number, role: m.role, text: m.text });
  }
  for (const field of ['title', 'url', 'started_at', 'updated_at', 'project', 'project_id'] as const) {
    if (b[field] !== undefined && typeof b[field] !== 'string') return `${field} must be a string.`;
  }
  if (typeof b.url === 'string' && b.url && !/^https:\/\//.test(b.url)) return 'url must start with https://.';
  if (typeof b.started_at === 'string' && Number.isNaN(Date.parse(b.started_at))) return 'started_at must be a date.';
  if (typeof b.updated_at === 'string' && Number.isNaN(Date.parse(b.updated_at))) return 'updated_at must be a date.';
  return {
    source: b.source,
    externalId: b.external_id,
    title: b.title as string | undefined,
    url: ((b.url as string | undefined) ?? '').slice(0, 500),
    startedAt: b.started_at ? new Date(b.started_at as string).toISOString() : undefined,
    updatedAt: b.updated_at ? new Date(b.updated_at as string).toISOString() : undefined,
    messages,
  };
}

export async function handleApi(request: Request, ctx: ApiContext): Promise<Response> {
  const { db, apiKey } = ctx;
  const url = new URL(request.url);
  if (url.pathname === '/api/health') return json({ ok: true, version: VERSION });

  if (!apiKey) return problem(503, 'The API is off. Set an API key (BRIDGE_API_KEY) to turn it on.');
  if (apiKey.length < 32) return problem(503, 'The API key must be at least 32 characters.');
  if (!(await authorized(request, apiKey))) {
    return new Response(JSON.stringify({ error: 'Invalid or missing API key.' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'WWW-Authenticate': 'Bearer' },
    });
  }

  // Monitoring (P9.4.1): versions, sizes, counts and the last day's activity. Never content.
  if (url.pathname === '/api/status' && request.method === 'GET') {
    const [counts, health, ledger] = await Promise.all([
      db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM projects) AS projects, (SELECT COUNT(*) FROM checkpoints) AS sessions,
                  (SELECT COUNT(*) FROM artifacts) AS files, (SELECT COUNT(*) FROM profile) AS facts,
                  (SELECT COUNT(*) FROM conversations) AS chats, (SELECT COUNT(*) FROM deletions) AS deletions`,
        )
        .first<Record<string, number>>(),
      healthSummary(db),
      store.ledgerStatus(db),
    ]);
    const limits = currentLimits();
    return json({
      version: VERSION,
      moved: Boolean(await store.getMoved(db)),
      counts,
      storage: { used_bytes: limits.size ? await limits.size().catch(() => null) : null, quota_bytes: limits.quotaBytes ?? null },
      last_24h: health,
      deletion_ledger: ledger,
    });
  }

  // Moving homes (`legendary-memory move`): read or set whether this memory is read-only.
  if (url.pathname === '/api/state') {
    if (request.method === 'GET') return json({ moved: await store.getMoved(db), version: VERSION });
    if (request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as { moved?: unknown } | null;
      const moved = body?.moved;
      if (moved === null) {
        await store.setMoved(db, null);
        return json({ moved: null });
      }
      if (!moved || typeof moved !== 'object') return problem(400, 'moved must be null or { to, at, memory_sha256 }.');
      const { to, at, memory_sha256 } = moved as Record<string, unknown>;
      if (typeof to !== 'string' || !to || to.length > 300 || typeof at !== 'string' || typeof memory_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(memory_sha256)) {
        return problem(400, 'moved must be null or { to, at, memory_sha256 }.');
      }
      await store.setMoved(db, { to, at, memory_sha256 });
      return json({ moved: await store.getMoved(db) });
    }
  }

  // Nothing is written to a memory that has moved; reads and export still work.
  if (request.method === 'POST' && (url.pathname === '/api/ingest/conversation' || url.pathname === '/api/import')) {
    const moved = await store.getMoved(db);
    if (moved) return problem(409, store.movedMessage(moved));
    const admission = await admitWrite(Number(request.headers.get('Content-Length') ?? 0) || 0);
    if (!admission.ok) return problem(507, admission.message);
  }

  if (url.pathname === '/api/ingest/conversation' && request.method === 'POST') {
    const declared = Number(request.headers.get('Content-Length') ?? 0);
    if (declared > MAX_BODY_BYTES) return problem(413, 'Body too large. Send long chats in several requests.');
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return problem(413, 'Body too large. Send long chats in several requests.');
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return problem(400, 'Body is not valid JSON.');
    }
    const input = parseIngest(body);
    if (typeof input === 'string') return problem(400, input);
    const { project: projectRef, project_id: projectId } = body as { project?: string; project_id?: string };
    if (projectId) {
      if (!(await store.getProject(db, projectId))) return problem(404, `No project has the id "${projectId}".`);
      input.projectId = projectId;
    } else if (projectRef) {
      const found = await store.resolveProject(db, projectRef);
      if (!found.match || found.fuzzy) return problem(404, `No project exactly matches "${projectRef}".`);
      input.projectId = found.match.id;
    }
    return json(await store.ingestConversation(db, input));
  }

  // Rows exported from another memory, written with their ids and dates (see `legendary-memory copy`).
  if (url.pathname === '/api/import' && request.method === 'POST') {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return problem(413, 'Body too large. Send fewer rows per request.');
    let body: { table?: unknown; rows?: unknown; replace?: unknown; dry_run?: unknown; id_map?: unknown };
    try {
      body = JSON.parse(raw);
    } catch {
      return problem(400, 'Body is not valid JSON.');
    }
    const table = (store.IMPORT_TABLES as readonly unknown[]).includes(body.table) ? (body.table as store.ImportTable) : null;
    if (!table) return problem(400, `table must be one of: ${store.IMPORT_TABLES.join(', ')}.`);
    if (!Array.isArray(body.rows) || body.rows.length > MAX_IMPORT_ROWS) return problem(400, `rows must be an array of at most ${MAX_IMPORT_ROWS}.`);
    const idMap = typeof body.id_map === 'object' && body.id_map !== null ? (body.id_map as Record<string, string>) : {};
    try {
      return json(await store.importRows(db, table, body.rows, { replace: body.replace === true, dryRun: body.dry_run === true, idMap }));
    } catch (error) {
      if (error instanceof store.ImportError) return problem(400, error.message);
      throw error;
    }
  }

  if (url.pathname === '/api/export' && request.method === 'GET') {
    const table = url.searchParams.get('table') ?? '';
    if (!table) return json({ tables: store.EXPORT_TABLES });
    if (!(store.EXPORT_TABLES as readonly string[]).includes(table)) return problem(400, 'Unknown table.');
    const after = Math.max(0, Number(url.searchParams.get('after') ?? 0) || 0);
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 200) || 200));
    return json(await store.exportPage(db, table as (typeof store.EXPORT_TABLES)[number], after, limit));
  }

  return problem(404, 'Not found.');
}
