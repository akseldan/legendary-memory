// /connections and per-connection permissions (execution plan P4.3), on the `host` target, which
// runs the same Worker code as Cloudflare. Two apps connect; the owner lists them, sees last use,
// disconnects one; its next request is refused while the other keeps working.
// Temp folder and 127.0.0.1 only. Builds are done by `npm run test:connections`.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../dist/legendary-memory.mjs', import.meta.url));
const PASS = 'correct horse battery staple';
const PORT = 18891;
const BASE = `http://127.0.0.1:${PORT}`;
const REDIRECT = 'http://localhost:9999/cb';
const dir = mkdtempSync(join(tmpdir(), 'lm-conn-'));

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `\n         ${String(detail).slice(0, 500)}` : ''}`);
};
const b64url = (buf) => buf.toString('base64url');

async function signIn(name, scopes) {
  const client = await (await fetch(`${BASE}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  })).json();
  const verifier = b64url(randomBytes(32));
  const params = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, scope: 'memory:read memory:write offline_access', state: 's', code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', resource: `${BASE}/mcp` });
  const start = await fetch(`${BASE}/authorize?${params}`, { redirect: 'manual' });
  const handle = (await start.text()).match(/name="handle" value="([^"]+)"/)?.[1];
  const cookie = (start.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const form = new URLSearchParams({ handle, decision: 'approve', passphrase: PASS });
  for (const s of [...scopes, 'offline_access']) form.append('scope', s);
  const done = await fetch(`${BASE}/authorize`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie }, body: form });
  const code = new URL(done.headers.get('location') ?? '', BASE).searchParams.get('code');
  const token = await (await fetch(`${BASE}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier }) })).json();
  return { ...token, clientId: client.client_id };
}
let id = 0;
const call = (token, name, args) =>
  fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
  });
const post = (fields, headers = {}) =>
  fetch(`${BASE}/connections`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields) });
const useRows = () => {
  const db = new DatabaseSync(join(dir, 'memory.db'), { readOnly: true });
  try {
    return db.prepare('SELECT grant_id, client, last_used_at FROM connection_use ORDER BY client').all();
  } finally {
    db.close();
  }
};

const env = { ...process.env, LEGENDARY_MEMORY_DIR: dir, LEGENDARY_MEMORY_PASSPHRASE: PASS, LEGENDARY_MEMORY_KEY: 'k'.repeat(40), NODE_NO_WARNINGS: '1' };
const server = spawn('node', [BIN, 'host', '--url', BASE, '--port', String(PORT)], { env, stdio: ['ignore', 'ignore', 'pipe'] });
try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log('Two apps connect');
  const alpha = await signIn('Alpha Assistant', ['memory:read', 'memory:write']);
  const beta = await signIn('Beta Assistant', ['memory:read', 'memory:write', 'memory:delete']);
  check('both get tokens', Boolean(alpha.access_token && beta.access_token));
  check('alpha works', (await call(alpha.access_token, 'recall', {})).status === 200);
  check('beta works', (await call(beta.access_token, 'recall', {})).status === 200);
  await new Promise((r) => setTimeout(r, 300));
  const rows = useRows();
  check('each connection\'s use is recorded (no content, just when)', rows.length === 2 && rows.every((r) => r.last_used_at), JSON.stringify(rows));
  const first = rows.map((r) => r.last_used_at).join();
  await call(alpha.access_token, 'recall', {});
  await call(beta.access_token, 'recall', {});
  await new Promise((r) => setTimeout(r, 300));
  check('repeat use within 5 minutes writes nothing', useRows().map((r) => r.last_used_at).join() === first);

  console.log('The connections page');
  const get = await fetch(`${BASE}/connections`);
  const form = await get.text();
  check('asks for the passphrase first', get.status === 200 && /name="passphrase"/.test(form) && !/Alpha/.test(form));
  check('is not cached and cannot be framed', get.headers.get('cache-control') === 'no-store' && /frame-ancestors 'none'/.test(get.headers.get('content-security-policy') ?? ''));
  const wrong = await post({ passphrase: 'not the passphrase at all' });
  check('a wrong passphrase shows nothing', wrong.status === 401 && !/Alpha/.test(await wrong.text()));
  const list = await post({ passphrase: PASS });
  const html = await list.text();
  check('the right passphrase lists both apps', list.status === 200 && /Alpha Assistant/.test(html) && /Beta Assistant/.test(html), html.slice(0, 500));
  check('with what each may do', /Alpha Assistant<\/strong><br>\s*<span>Can read, save ·/.test(html) && /Beta Assistant<\/strong><br>\s*<span>Can read, save, delete ·/.test(html), html);
  check('and when it was last used', (html.match(/last used in the last few minutes/g) ?? []).length === 2);
  const session = html.match(/name="session" value="([0-9a-f]{64})"/)?.[1];
  check('the page carries a session for its buttons, not the passphrase', Boolean(session) && !html.includes(PASS));
  const fromElsewhere = await post({ session, decision: 'revoke', revoke: 'x' }, { Origin: 'https://evil.example' });
  check('a form on another site cannot use it', fromElsewhere.status === 403);
  const forged = await post({ session: 'f'.repeat(64), decision: 'revoke', revoke: 'x' });
  check('a made-up session is refused', forged.status === 401);

  console.log('Disconnect one');
  const alphaGrant = (() => {
    const blocks = html.split('<li>').slice(1);
    const block = blocks.find((b) => b.includes('Alpha Assistant')) ?? '';
    return block.match(/name="revoke" value="([^"]+)"/)?.[1];
  })();
  const t0 = performance.now();
  const after = await post({ session, decision: 'revoke', revoke: alphaGrant });
  const afterHtml = await after.text();
  const refused = await call(alpha.access_token, 'recall', {});
  const ms = Math.round(performance.now() - t0);
  check('the page confirms and lists only the other app', /Disconnected/.test(afterHtml) && !/Alpha Assistant/.test(afterHtml) && /Beta Assistant/.test(afterHtml), afterHtml.slice(0, 400));
  check(`the disconnected app's next request is refused (${ms} ms after clicking, here)`, refused.status === 401, refused.status);
  const refresh = await fetch(`${BASE}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: alpha.refresh_token ?? '', client_id: alpha.clientId }) });
  check('it cannot get a new token with its refresh token', refresh.status >= 400, refresh.status);
  check('the other app keeps working', (await call(beta.access_token, 'recall', {})).status === 200);
  check('its use record is gone too', useRows().length === 1);
} catch (error) {
  check('suite ran without crashing', false, error?.stack ?? error);
} finally {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
