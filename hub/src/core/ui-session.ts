/**
 * The welcome page's "your memory" view on a hosted server (`host`). The page is the same
 * file `start` serves; what differs is how it signs in. Here the owner types the passphrase
 * once, and the server hands back a cookie that script cannot read. The memory endpoints
 * live next to the page and are never reachable with an AI app's token or the API key.
 *
 * Used by `host` and by the Cloudflare hub, so it uses only Web Crypto.
 */
import type { Db } from './db';
import { recordFailure, sameSecret, tooManyFailures } from './lockout';
import { handleUi } from './ui';

/** The part of Cloudflare KV, and of this project's SQLite stand-in, that sessions use. */
export interface SessionKv {
  get(key: string, type?: 'json'): Promise<unknown>;
  put(key: string, value: string, options: { expirationTtl: number }): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

const SESSION_SECONDS = 12 * 60 * 60;

export interface HostUiOptions {
  db: Db;
  kv: SessionKv;
  passphrase: string;
  /** Shown as "Kept in …". */
  dataFile?: string;
  backupNote?: string;
  connectionsUrl?: string;
  /** The public address, e.g. https://memory.example.com */
  origin: string;
  html: string;
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

const sha = async (value: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const same = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};
const randomToken = (bytes: number): string => {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** Marks the page so it knows it is served by a host and asks for the passphrase. */
export function hostPage(html: string): string {
  const marked = html.replace('<html ', '<html data-mode="host" ');
  if (marked === html) throw new Error('The welcome page has no <html> tag to mark; the hosted memory view cannot start.');
  return marked;
}

export function hostUi(options: HostUiOptions): (request: Request) => Promise<Response | null> {
  const { kv, origin } = options;
  const secure = origin.startsWith('https:');
  // The __Host- prefix makes browsers refuse the cookie unless it is Secure, set for this
  // exact host and for the whole site. Plain http (a test on this computer) cannot carry it.
  const cookieName = secure ? '__Host-lm_ui' : 'lm_ui';
  let fingerprintCache: Promise<string> | null = null;
  const fingerprint = (): Promise<string> => (fingerprintCache ??= sha(options.passphrase));
  const key = async (id: string): Promise<string> => `lm:ui-session:${await sha(id)}`;

  const sessionId = (request: Request): string => {
    for (const part of (request.headers.get('cookie') ?? '').split(';')) {
      const [name, ...value] = part.trim().split('=');
      if (name === cookieName) return value.join('=');
    }
    return '';
  };
  const session = async (request: Request): Promise<{ id: string; csrf: string } | null> => {
    const id = sessionId(request);
    if (!id) return null;
    const stored = (await kv.get(await key(id), 'json')) as { csrf: string; fp: string } | null;
    if (!stored) return null;
    // A changed passphrase ends every page session, like a changed lock ends old keys.
    if (stored.fp !== (await fingerprint())) {
      await kv.delete(await key(id));
      return null;
    }
    return { id, csrf: stored.csrf };
  };
  const cookie = (value: string, seconds: number): string =>
    `${cookieName}=${value}; Max-Age=${seconds}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;

  /** Writes need the page's own origin, a JSON body (which a plain form cannot send) and the session's token. */
  const writeAllowed = (request: Request, csrf?: string): boolean =>
    request.headers.get('origin') === origin &&
    (request.headers.get('content-type') ?? '').startsWith('application/json') &&
    (csrf === undefined || same(request.headers.get('x-lm-csrf') ?? '', csrf));

  const authorize = async (request: Request): Promise<Response | null> => {
    // An AI app's token or the API key is not a way into this page.
    if (request.headers.has('authorization')) return json({ error: 'locked' }, 401);
    const current = await session(request);
    if (!current) return json({ error: 'locked' }, 401);
    if (request.method !== 'GET' && request.method !== 'HEAD' && !writeAllowed(request, current.csrf)) return json({ error: 'forbidden' }, 403);
    return null;
  };
  const ui = {
    authorize,
    html: hostPage(options.html),
    dataFile: options.dataFile ?? 'this server',
    ...(options.backupNote ? { backupNote: options.backupNote } : {}),
    ...(options.connectionsUrl ? { connectionsUrl: options.connectionsUrl } : {}),
  };

  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== '/' && !url.pathname.startsWith('/ui/')) return null;
    const route = `${request.method} ${url.pathname}`;

    if (route === 'GET /ui/session') {
      if (request.headers.has('authorization')) return json({ error: 'locked' }, 401);
      const current = await session(request);
      return current ? json({ csrf: current.csrf }) : json({ error: 'locked' }, 401);
    }
    if (route === 'POST /ui/login') {
      if (!writeAllowed(request)) return json({ error: 'forbidden' }, 403);
      if (await tooManyFailures(kv, request)) return json({ error: 'Too many wrong passphrases. Wait about fifteen minutes.' }, 429);
      const body = (await request.json().catch(() => ({}))) as { passphrase?: unknown };
      if (typeof body.passphrase !== 'string' || !(await sameSecret(body.passphrase, options.passphrase))) {
        await recordFailure(kv, request);
        return json({ error: 'That passphrase did not match.' }, 401);
      }
      const id = randomToken(32);
      const csrf = randomToken(24);
      await kv.put(await key(id), JSON.stringify({ csrf, fp: await fingerprint() }), { expirationTtl: SESSION_SECONDS });
      return json({ csrf }, 200, { 'Set-Cookie': cookie(id, SESSION_SECONDS) });
    }
    if (route === 'POST /ui/logout') {
      const denied = await authorize(request);
      if (denied) return denied;
      await kv.delete(await key(sessionId(request)));
      return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });
    }
    return handleUi(request, options.db, ui);
  };
}
