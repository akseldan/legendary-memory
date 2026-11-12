/**
 * A small HTTP API for tools that are not AI apps: the history importer and the browser
 * extension. Off until a BRIDGE_API_KEY secret is set; every call needs that key.
 */
import type { Env } from './env';
import { VERSION } from './env';
import * as store from './store';

const MAX_BODY_BYTES = 1_500_000;
const MAX_MESSAGES = 2000;
const SOURCES = new Set(['chatgpt', 'claude', 'gemini', 'other']);
const ROLES = new Set(['user', 'assistant', 'system', 'tool']);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

const problem = (status: number, error: string): Response => json({ error }, status);

async function authorized(request: Request, env: Env): Promise<boolean> {
  const key = env.BRIDGE_API_KEY ?? '';
  const header = request.headers.get('Authorization') ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(given)),
    crypto.subtle.digest('SHA-256', encoder.encode(key)),
  ]);
  return crypto.subtle.timingSafeEqual(left, right) && key.length > 0;
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
  for (const field of ['title', 'url', 'started_at', 'project'] as const) {
    if (b[field] !== undefined && typeof b[field] !== 'string') return `${field} must be a string.`;
  }
  if (typeof b.url === 'string' && b.url && !/^https:\/\//.test(b.url)) return 'url must start with https://.';
  if (typeof b.started_at === 'string' && Number.isNaN(Date.parse(b.started_at))) return 'started_at must be a date.';
  return {
    source: b.source,
    externalId: b.external_id,
    title: b.title as string | undefined,
    url: ((b.url as string | undefined) ?? '').slice(0, 500),
    startedAt: b.started_at ? new Date(b.started_at as string).toISOString() : undefined,
    messages,
  };
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/api/health') return json({ ok: true, version: VERSION });

  if (!env.BRIDGE_API_KEY) return problem(503, 'The API is off. Set the BRIDGE_API_KEY secret to turn it on.');
  if (env.BRIDGE_API_KEY.length < 32) return problem(503, 'BRIDGE_API_KEY must be at least 32 characters.');
  if (!(await authorized(request, env))) {
    return new Response(JSON.stringify({ error: 'Invalid or missing API key.' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'WWW-Authenticate': 'Bearer' },
    });
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
    const projectRef = (body as { project?: string }).project;
    if (projectRef) {
      const found = await store.resolveProject(env.DB, projectRef);
      if (!found.match || found.fuzzy) return problem(404, `No project exactly matches "${projectRef}".`);
      input.projectId = found.match.id;
    }
    return json(await store.ingestConversation(env.DB, input));
  }

  if (url.pathname === '/api/export' && request.method === 'GET') {
    const table = url.searchParams.get('table') ?? '';
    if (!table) return json({ tables: store.EXPORT_TABLES });
    if (!(store.EXPORT_TABLES as readonly string[]).includes(table)) return problem(400, 'Unknown table.');
    const after = Math.max(0, Number(url.searchParams.get('after') ?? 0) || 0);
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 200) || 200));
    return json(await store.exportPage(env.DB, table as (typeof store.EXPORT_TABLES)[number], after, limit));
  }

  return problem(404, 'Not found.');
}
