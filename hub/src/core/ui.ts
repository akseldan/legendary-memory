/**
 * The welcome page and "your memory" view that `legendary-memory start` opens in the
 * browser, plus the few local-only endpoints that page calls.
 *
 * Runs unchanged on the Cloudflare hub (no Node-only imports here).
 *
 * The page itself holds no data and is served to anyone on this computer. Everything under
 * /ui/ needs the one-time key that `start` puts in the address it opens, so another program
 * or web page that merely knows the port cannot read your memory or change app settings.
 */
import type { Db } from './db';
import * as store from './store';
import { ACTIVITY_DAYS, ACTIVITY_MAX, logActivity, recentActivity } from './activity';
import { projectHandoff } from './handoff';
import { admitWrite, currentLimits } from './limits';
/** What looking at, connecting or disconnecting one app reports (the local target's setup). */
export interface SetupResult {
  app: string;
  status: 'connected' | 'already' | 'removed' | 'not-installed' | 'skipped' | 'failed';
  detail: string;
  note?: string;
}

export interface UiOptions {
  /** Decides whether a /ui/ request may go on: null means yes, otherwise the answer to send back. */
  authorize: (request: Request) => Response | null | Promise<Response | null>;
  html: string;
  dataFile: string;
  /** Where backups of this memory come from, in a sentence; a function is asked on each visit. */
  backupNote?: string | (() => string | undefined);
  /** Where the owner sees and disconnects the apps connected to a hub. */
  connectionsUrl?: string;
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

/** Compares without stopping at the first difference, so timing does not reveal how much matched. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function keyOk(request: Request, token: string): boolean {
  const header = request.headers.get('authorization') ?? '';
  return sameText(header.startsWith('Bearer ') ? header.slice(7) : '', token);
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

async function memorySummary(db: Db, ui: UiOptions) {
  const { dataFile, undoCommand } = ui;
  const projects = await store.listProjects(db);
  const [sessions, files, facts, [latest]] = await Promise.all([
    total(db, 'checkpoints'),
    total(db, 'artifacts'),
    total(db, 'profile'),
    store.recentCheckpoints(db, null, 1),
  ]);
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const limits = currentLimits();
  const [used, activity, profile] = await Promise.all([
    limits.size ? limits.size().catch(() => null) : Promise.resolve(null),
    recentActivity(db, 40),
    store.getProfile(db),
  ]);
  return {
    dataFile,
    ...(() => {
      const note = typeof ui.backupNote === 'function' ? ui.backupNote() : ui.backupNote;
      return note ? { backupNote: note } : {};
    })(),
    ...(ui.connectionsUrl ? { connectionsUrl: ui.connectionsUrl } : {}),
    storage: { usedBytes: used, quotaBytes: limits.quotaBytes ?? null, diskFreeBytes: limits.diskFree?.() ?? null },
    activity: { days: ACTIVITY_DAYS, max: ACTIVITY_MAX, entries: activity },
    facts: profile,
    ...(undoCommand ? { undoCommand } : {}),
    counts: { projects: projects.length, sessions, files, facts },
    latest: latest
      ? { id: latest.id, title: latest.title, project: names.get(latest.project_id) ?? '', source: latest.source, at: latest.created_at }
      : null,
    // Archived projects go last, so the list leads with what is in use.
    projects: await Promise.all(
      [...projects.filter((p) => p.status !== 'archived'), ...projects.filter((p) => p.status === 'archived')].slice(0, 50).map(async (p) => ({
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
  if (route === 'GET /ui/memory') return json(await memorySummary(db, ui));
  if (route === 'GET /ui/search') {
    const [hits, projects] = await Promise.all([store.search(db, url.searchParams.get('q') ?? '', { limit: 10 }), store.listProjects(db)]);
    const names = new Map(projects.map((p) => [p.id, p.name]));
    return json({ hits: hits.map((h) => ({ kind: h.kind, title: h.title, snippet: h.snippet, project: (h.project_id && names.get(h.project_id)) || '' })) });
  }
  if (route === 'GET /ui/handoff') {
    const handoff = await projectHandoff(db, url.searchParams.get('id') ?? '');
    if (!handoff) return json({ error: 'not found' }, 404);
    await logActivity(db, { client: 'memory page', action: 'read', tool: 'handoff', target: handoff.name, ok: true });
    // An ASCII name for old browsers, and the real one (any script) for the rest (RFC 6266).
    const ascii = `${handoff.name.replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-') || 'project'}-handoff.md`;
    const full = `${handoff.name.replace(/[\\/:*?"<>|\p{Cc}]+/gu, '').trim().replace(/\s+/g, '-') || 'project'}-handoff.md`;
    return new Response(handoff.markdown, {
      headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(full)}`, 'Cache-Control': 'no-store' },
    });
  }
  if (route === 'POST /ui/brief' || route === 'POST /ui/forget' || route === 'POST /ui/fact' || route === 'POST /ui/status') {
    const moved = await store.getMoved(db);
    if (moved) return json({ error: store.movedMessage(moved) }, 409);
  }
  if (route === 'POST /ui/brief' || route === 'POST /ui/fact' || route === 'POST /ui/status') {
    const admission = await admitWrite(Number(request.headers.get('Content-Length') ?? 0) || 0);
    if (!admission.ok) return json({ error: admission.message }, 507);
  }
  if (route === 'POST /ui/brief') {
    const body = (await request.json().catch(() => ({}))) as { id?: unknown; brief?: unknown };
    if (typeof body.id !== 'string' || typeof body.brief !== 'string' || body.brief.length > MAX_BRIEF) return json({ error: 'bad request' }, 400);
    const project = await store.getProject(db, body.id);
    if (!project) return json({ error: 'not found' }, 404);
    await store.updateProject(db, project, { brief: body.brief });
    await logActivity(db, { client: 'memory page', action: 'write', tool: 'edit brief', target: project.name, ok: true });
    return json({ ok: true });
  }
  if (route === 'POST /ui/status') {
    // Archive hides a project from the list and the overview assistants get; nothing is deleted.
    const body = (await request.json().catch(() => ({}))) as { id?: unknown; status?: unknown };
    if (typeof body.id !== 'string' || (body.status !== 'archived' && body.status !== 'active')) return json({ error: 'bad request' }, 400);
    const project = await store.getProject(db, body.id);
    if (!project) return json({ error: 'not found' }, 404);
    await store.updateProject(db, project, { status: body.status });
    await logActivity(db, { client: 'memory page', action: 'write', tool: body.status === 'archived' ? 'archive' : 'unarchive', target: project.name, ok: true });
    return json({ ok: true });
  }
  if (route === 'POST /ui/fact') {
    // Correcting a fact: the new wording replaces the old one under the same key.
    const body = (await request.json().catch(() => ({}))) as { key?: unknown; value?: unknown };
    if (typeof body.key !== 'string' || !body.key.trim() || body.key.length > 60 || typeof body.value !== 'string' || !body.value.trim() || body.value.length > 2000) {
      return json({ error: 'bad request' }, 400);
    }
    const saved = await store.setProfile(db, body.key, body.value);
    await logActivity(db, { client: 'memory page', action: 'write', tool: 'correct fact', target: `fact:${saved.key}`, ok: true });
    return json({ ok: true, key: saved.key, redactions: saved.redactions });
  }
  if (route === 'POST /ui/forget') {
    const body = (await request.json().catch(() => ({}))) as { kind?: unknown; id?: unknown };
    // The page lists projects, sessions and facts, so it may delete only those.
    if ((body.kind !== 'project' && body.kind !== 'checkpoint' && body.kind !== 'profile') || typeof body.id !== 'string') return json({ error: 'bad request' }, 400);
    const done = await store.forget(db, body.kind, body.id);
    await logActivity(db, { client: 'memory page', action: 'delete', tool: `delete ${body.kind === 'profile' ? 'fact' : body.kind === 'checkpoint' ? 'session' : 'project'}`, target: body.kind === 'profile' ? `fact:${body.id}` : body.id, ok: done });
    return done ? json({ ok: true }) : json({ error: 'not found' }, 404);
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
