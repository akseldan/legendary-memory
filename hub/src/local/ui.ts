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
import type { SetupResult } from './setup';

export interface UiOptions {
  /** Key for /ui/*, created fresh on every `start`. */
  token: string;
  html: string;
  dataFile: string;
  /** Looks at, connects or disconnects the AI apps on this computer. */
  setup: (run: { dryRun: boolean; undo: boolean; only?: string[] }) => SetupResult[];
}

type AppState = { app: string; status: 'found' | 'connected' | 'missing' | 'problem'; detail?: string };

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

/** What a look (dry run) at the apps says about each one. */
function appStates(results: SetupResult[]): AppState[] {
  return results.map((r) => {
    if (r.status === 'already') return { app: r.app, status: 'connected' };
    if (r.status === 'connected') return { app: r.app, status: 'found' };
    if (r.status === 'failed') return { app: r.app, status: 'problem', detail: r.detail };
    return { app: r.app, status: 'missing' };
  });
}

const total = async (db: Db, table: string): Promise<number> =>
  (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;

async function memorySummary(db: Db, dataFile: string) {
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
    counts: { projects: projects.length, sessions, files, facts },
    latest: latest
      ? { id: latest.id, title: latest.title, project: names.get(latest.project_id) ?? '', source: latest.source, at: latest.created_at }
      : null,
    projects: await Promise.all(
      projects.slice(0, 50).map(async (p) => ({
        name: p.name,
        status: p.status,
        updated_at: p.updated_at,
        brief: p.brief.length > 900 ? `${p.brief.slice(0, 900)}…` : p.brief,
        files: (await store.listArtifacts(db, p.id)).length,
        sessions: (await store.recentCheckpoints(db, p.id, 5)).map((c) => ({ title: c.title, source: c.source, created_at: c.created_at })),
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
  if (!keyOk(request, ui.token)) return json({ error: 'locked' }, 401);

  const route = `${request.method} ${url.pathname}`;
  if (route === 'GET /ui/apps') return json({ apps: appStates(ui.setup({ dryRun: true, undo: false })) });
  if (route === 'GET /ui/memory') return json(await memorySummary(db, ui.dataFile));
  if (route === 'POST /ui/connect' || route === 'POST /ui/disconnect') {
    const body = (await request.json().catch(() => ({}))) as { only?: unknown };
    const only = Array.isArray(body.only) ? body.only.filter((name): name is string => typeof name === 'string') : undefined;
    const done = ui.setup({ dryRun: false, undo: route.endsWith('disconnect'), only });
    // Report the real state afterwards, keeping the reason for anything that went wrong.
    const problems = new Map(done.filter((r) => r.status === 'failed').map((r) => [r.app, r.detail]));
    const apps = appStates(ui.setup({ dryRun: true, undo: false })).map((a) =>
      problems.has(a.app) ? { app: a.app, status: 'problem' as const, detail: problems.get(a.app) } : a,
    );
    return json({ apps });
  }
  return json({ error: 'not found' }, 404);
}
