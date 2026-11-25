/**
 * /connections: the owner sees every app connected to this hub, what each may do and when it
 * last used the hub, and can revoke any of them (execution plan P4.3).
 *
 * Behind the same passphrase and lockout as the sign-in page. A correct passphrase opens a
 * 10-minute session whose token rides in the page's forms (it doubles as the CSRF token); the
 * passphrase is never put in a URL or cookie. Revoking deletes the connection's grant and tokens,
 * so its next request is refused; on Cloudflare, KV caching can let it through for up to about a
 * minute at other locations.
 */
import { SCOPE_DELETE, SCOPE_READ, SCOPE_WRITE } from '../core/constants';
import type { Db } from '../core/db';
import { recordFailure, sameSecret, tooManyFailures } from '../core/lockout';
import { escapeHtml } from '../core/text';
import { message, page } from './auth';
import type { Env } from './env';

const OWNER_ID = 'owner';
const SESSION_SECONDS = 600;
const SESSION_PREFIX = 'connections-session:';
/** Last use is recorded at most this often per connection, to keep writes cheap. */
const USE_INTERVAL_MS = 5 * 60 * 1000;

/** Grant id from an access token ("{userId}:{grantId}:{secret}"). */
export function grantIdOf(token: string | undefined): string | null {
  const parts = (token ?? '').split(':');
  return parts.length === 3 && parts[1] ? parts[1] : null;
}

/** Notes that a connection was just used; skips the write if it was noted recently. */
export async function recordUse(db: Db, grantId: string, client: string, now = new Date()): Promise<void> {
  const at = now.toISOString();
  const cutoff = new Date(now.getTime() - USE_INTERVAL_MS).toISOString();
  await db
    .prepare(
      `INSERT INTO connection_use (grant_id, client, first_used_at, last_used_at) VALUES (?1, ?2, ?3, ?3)
       ON CONFLICT (grant_id) DO UPDATE SET last_used_at = excluded.last_used_at, client = excluded.client
       WHERE connection_use.last_used_at < ?4`,
    )
    .bind(grantId, client, at, cutoff)
    .run();
}

function ago(iso: string | undefined, now: number): string {
  if (!iso) return 'not used yet';
  const minutes = Math.round((now - Date.parse(iso)) / 60000);
  if (minutes < 10) return 'in the last few minutes';
  if (minutes < 120) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function abilities(scope: string[], v: unknown): string {
  const can: string[] = [];
  if (scope.includes(SCOPE_READ)) can.push('read');
  if (scope.includes(SCOPE_WRITE)) can.push('save');
  if (scope.includes(SCOPE_DELETE) || (scope.includes(SCOPE_WRITE) && !(typeof v === 'number' && v >= 2))) can.push('delete');
  return can.length ? can.join(', ') : 'nothing';
}

const passphraseForm = (note = '') => `<h1>Connected apps</h1>
<p>See which AI apps can use this memory, and disconnect any of them.</p>${note}
<form method="post" autocomplete="off">
  <label class="field" for="passphrase">Your passphrase</label>
  <input id="passphrase" name="passphrase" type="password" autocomplete="current-password" required autofocus>
  <div class="row"><button class="go" name="decision" value="open">Show connections</button></div>
</form>`;

async function listPage(env: Env, db: Db, session: string, notice: string): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const grants = [];
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(OWNER_ID, cursor ? { cursor } : {});
    grants.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  const { results } = await db.prepare('SELECT grant_id, client, last_used_at FROM connection_use').all<{ grant_id: string; client: string; last_used_at: string }>();
  const used = new Map(results.map((r) => [r.grant_id, r]));
  const now = Date.now();
  grants.sort((a, b) => (used.get(b.id)?.last_used_at ?? '').localeCompare(used.get(a.id)?.last_used_at ?? '') || b.createdAt - a.createdAt);

  const rows = await Promise.all(
    grants.map(async (g) => {
      const name = (await oauth.lookupClient(g.clientId))?.clientName || (g.metadata as { client?: string })?.client || 'Unnamed app';
      const since = new Date(g.createdAt * 1000).toISOString().slice(0, 10);
      return `<li>
  <strong>${escapeHtml(name)}</strong><br>
  <span>Can ${escapeHtml(abilities(g.scope, (g.metadata as { v?: unknown })?.v))} · connected ${since} · last used ${escapeHtml(ago(used.get(g.id)?.last_used_at, now))}</span>
  <form method="post"><input type="hidden" name="session" value="${escapeHtml(session)}"><input type="hidden" name="revoke" value="${escapeHtml(g.id)}">
  <button name="decision" value="revoke">Disconnect</button></form>
</li>`;
    }),
  );
  const list = rows.length ? `<ul class="conns">${rows.join('')}</ul>` : '<p>No apps are connected.</p>';
  return page(
    'Connected apps',
    `<style>ul.conns{list-style:none;padding:0;margin:0 0 14px}ul.conns li{border-top:1px solid var(--line);padding:12px 0}ul.conns li span{color:var(--soft);font-size:14px}ul.conns form{margin-top:8px}</style>
<h1>Connected apps</h1>${notice}
<p>${grants.length} connected. A disconnected app is refused on its next request (on Cloudflare, within about a minute everywhere). It can connect again only if you approve it.</p>
${list}
<p>This page stays open for 10 minutes.</p>`,
  );
}

export async function handleConnections(request: Request, env: Env, db: Db): Promise<Response> {
  const passphrase = env.OWNER_PASSPHRASE ?? '';
  if (passphrase.length < 12) return message('Not set up yet', 'This hub has no passphrase yet.', 503);
  if (request.method === 'GET') return page('Connected apps', passphraseForm());
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });

  // Forms on another site must not drive this page.
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return message('Not allowed', 'That request came from another site.', 403);

  const form = await request.formData();
  let session = String(form.get('session') ?? '');
  if (session) {
    if (!/^[0-9a-f]{64}$/.test(session) || !(await env.OAUTH_KV.get(SESSION_PREFIX + session))) {
      return page('Connected apps', passphraseForm('<p class="warn">That page expired. Enter your passphrase again.</p>'), 401);
    }
  } else {
    if (await tooManyFailures(env.OAUTH_KV, request)) {
      return message('Too many attempts', 'Paused for 15 minutes after repeated wrong passphrases. Try again later.', 429);
    }
    if (!(await sameSecret(String(form.get('passphrase') ?? ''), passphrase))) {
      await recordFailure(env.OAUTH_KV, request);
      return page('Connected apps', passphraseForm('<p class="warn">That passphrase is not right.</p>'), 401);
    }
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    session = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    await env.OAUTH_KV.put(SESSION_PREFIX + session, '1', { expirationTtl: SESSION_SECONDS });
  }

  let notice = '';
  const revoke = String(form.get('revoke') ?? '');
  if (form.get('decision') === 'revoke' && revoke) {
    await env.OAUTH_PROVIDER.revokeGrant(revoke, OWNER_ID);
    await db.prepare('DELETE FROM connection_use WHERE grant_id = ?1').bind(revoke).run();
    notice = '<p><strong>Disconnected.</strong></p>';
  }
  return listPage(env, db, session, notice);
}
