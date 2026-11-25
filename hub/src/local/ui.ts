/**
 * The welcome page and "your memory" view that `legendary-memory start` opens in the
 * browser, plus the few local-only endpoints that page calls.
 *
 * The page itself holds no data and is served to anyone on this computer. Everything under
 * /ui/ needs the one-time key that `start` puts in the address it opens, so another program
 * or web page that merely knows the port cannot read your memory or change app settings.
 */
import { timingSafeEqual } from 'node:crypto';
import type { Db } from '../core/db';
import * as store from '../core/store';
import { admitWrite } from '../core/limits';
import type { SetupResult } from './setup';

export interface UiOptions {
  /** Decides whether a /ui/ request may go on: null means yes, otherwise the answer to send back. */
  authorize: (request: Request) => Response | null | Promise<Response | null>;
  html: string;
  dataFile: string;
  /** The command that disconnects every app, as this copy was installed. Shown on the page. */
  undoCommand?: string;
  /** Looks at, connects or disconnects the AI apps on this computer. Absent on a hosted server, where those routes do not exist. */
  setup?: (run: { dryRun: boolean; undo: boolean; only?: string[] }) => SetupResult[];
}

/** Same ceiling as the save_checkpoint tool's brief. */
const MAX_BRIEF = 16000;

type AppState = { app: string; status: 'found' | 'connected' | 'missing' | 'problem'; detail?: string; note?: string };

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

function keyOk(request: Request, token: string): boolean {
  const header = request.headers.get('authorization') ?? '';
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The key `start` creates fresh each time and puts in the address it opens. */
export const bearerAuthorizer =
  (token: string) =>
  (request: Request): Response | null =>
    keyOk(request, token) ? null : json({ error: 'locked' }, 401);

/** What a look (dry run) at the apps says about each one. */
function appStates(results: SetupResult[]): AppState[] {
  return results.map((r) => {
    if (r.status === 'already') return { app: r.app, status: 'connected', ...(r.note ? { note: r.note } : {}) };
    if (r.status === 'connected') return { app: r.app, status: 'found', ...(r.note ? { note: r.note } : {}) };
    if (r.status === 'failed') return { app: r.app, status: 'problem', detail: r.detail };
    // Skipped (for example an extension that is switched off) is still an app that is there.
    if (r.status === 'skipped' && r.note) return { app: r.app, status: 'found', note: r.note };
    return { app: r.app, status: 'missing' };
  });
}

const total = async (db: Db, table: string): Promise<number> =>
  (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;

async function memorySummary(db: Db, dataFile: string, undoCommand?: string) {
  const projects = await store.listProjects(db);
  const [sessions, files, facts, [latest]] = await Promise.all([
    total(db, 'checkpoints'),
    total(db, 'artifacts'),
    total(db, 'profile'),
    store.recentCheckpoints(db, null, 1),
  ]);
  const names = new Map(projects.map((p) => [p.id, p.name]));
  return {
    dataFile,
    ...(undoCommand ? { undoCommand } : {}),
    counts: { projects: projects.length, sessions, files, facts },
    latest: latest
      ? { id: latest.id, title: latest.title, project: names.get(latest.project_id) ?? '', source: latest.source, at: latest.created_at }
      : null,
    projects: await Promise.all(
      projects.slice(0, 50).map(async (p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        updated_at: p.updated_at,
        // Whole brief, because the page edits it in place.
        brief: p.brief,
        files: (await store.listArtifacts(db, p.id)).length,
        sessions: (await store.recentCheckpoints(db, p.id, 10)).map((c) => ({ id: c.id, title: c.title, source: c.source, created_at: c.created_at })),
      })),
    ),
  };
}

/** Answers the welcome page's requests; null means the path is not one of its own. */
export async function handleUi(request: Request, db: Db, ui: UiOptions): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === '/') {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    return new Response(ui.html, { headers: PAGE_HEADERS });
  }
  if (!url.pathname.startsWith('/ui/')) return null;

  // A web page on another site must not be able to drive this, even if it guessed the key.
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return json({ error: 'forbidden' }, 403);
  const denied = await ui.authorize(request);
  if (denied) return denied;

  const route = `${request.method} ${url.pathname}`;
  const setup = ui.setup;
  if (!setup && /^(GET \/ui\/apps|POST \/ui\/(connect|disconnect))$/.test(route)) return json({ error: 'not found' }, 404);
  if (setup && route === 'GET /ui/apps') return json({ apps: appStates(setup({ dryRun: true, undo: false })) });
  if (route === 'GET /ui/memory') return json(await memorySummary(db, ui.dataFile, ui.undoCommand));
  if (route === 'GET /ui/search') {
    const [hits, projects] = await Promise.all([store.search(db, url.searchParams.get('q') ?? '', { limit: 10 }), store.listProjects(db)]);
    const names = new Map(projects.map((p) => [p.id, p.name]));
    return json({ hits: hits.map((h) => ({ kind: h.kind, title: h.title, snippet: h.snippet, project: (h.project_id && names.get(h.project_id)) || '' })) });
  }
  if (route === 'POST /ui/brief' || route === 'POST /ui/forget') {
    const moved = await store.getMoved(db);
    if (moved) return json({ error: store.movedMessage(moved) }, 409);
  }
  if (route === 'POST /ui/brief') {
    const admission = await admitWrite(Number(request.headers.get('Content-Length') ?? 0) || 0);
    if (!admission.ok) return json({ error: admission.message }, 507);
  }
  if (route === 'POST /ui/brief') {
    const body = (await request.json().catch(() => ({}))) as { id?: unknown; brief?: unknown };
    if (typeof body.id !== 'string' || typeof body.brief !== 'string' || body.brief.length > MAX_BRIEF) return json({ error: 'bad request' }, 400);
    const project = await store.getProject(db, body.id);
    if (!project) return json({ error: 'not found' }, 404);
    await store.updateProject(db, project, { brief: body.brief });
    return json({ ok: true });
  }
  if (route === 'POST /ui/forget') {
    const body = (await request.json().catch(() => ({}))) as { kind?: unknown; id?: unknown };
    // The page lists only projects and sessions, so it may delete only those.
    if ((body.kind !== 'project' && body.kind !== 'checkpoint') || typeof body.id !== 'string') return json({ error: 'bad request' }, 400);
    return (await store.forget(db, body.kind, body.id)) ? json({ ok: true }) : json({ error: 'not found' }, 404);
  }
  if (setup && (route === 'POST /ui/connect' || route === 'POST /ui/disconnect')) {
    const body = (await request.json().catch(() => ({}))) as { only?: unknown };
    const only = Array.isArray(body.only) ? body.only.filter((name): name is string => typeof name === 'string') : undefined;
    const done = setup({ dryRun: false, undo: route.endsWith('disconnect'), only });
    // Report the real state afterwards, keeping the reason for anything that went wrong.
    const problems = new Map(done.filter((r) => r.status === 'failed').map((r) => [r.app, r.detail]));
    const apps = appStates(setup({ dryRun: true, undo: false })).map((a) =>
      problems.has(a.app) ? { app: a.app, status: 'problem' as const, detail: problems.get(a.app) } : a,
    );
    return json({ apps });
  }
  return json({ error: 'not found' }, 404);
}
