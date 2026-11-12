// End-to-end check against a running `wrangler dev` (default http://localhost:8787).
// Usage: node test/e2e.mjs   (reads OWNER_PASSPHRASE / BRIDGE_API_KEY from .dev.vars)
//
// Order matters: the wrong-passphrase lockout test runs LAST, because it pauses sign-in
// for 15 minutes. To rerun, restart `wrangler dev` with a fresh `--persist-to` directory
// or delete .wrangler/state.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE = process.env.HUB_URL ?? 'http://localhost:8787';
const REDIRECT = 'http://localhost:9999/cb';

const vars = Object.fromEntries(
  readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
    .split('\n')
    .map((l) => l.match(/^([A-Z_]+)="?(.*?)"?\s*$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const PASS = vars.OWNER_PASSPHRASE;
const BRIDGE = vars.BRIDGE_API_KEY;

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? `\n         ${String(detail).slice(0, 400)}` : ''}`);
  }
}

const b64url = (buf) => buf.toString('base64url');

async function register(redirectUris = [REDIRECT]) {
  const res = await fetch(`${BASE}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claude e2e',
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  return { res, body: await res.json().catch(() => ({})) };
}

/** Starts sign-in and returns what the form POST needs. */
async function startAuthorize(clientId) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: 'memory:read memory:write',
    state: 'xyz',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${BASE}/mcp`,
  });
  const res = await fetch(`${BASE}/authorize?${params}`, { redirect: 'manual' });
  const html = await res.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  return { res, html, handle, cookie, verifier };
}

async function submit(start, { passphrase, scopes, decision = 'approve' }) {
  const form = new URLSearchParams();
  form.set('handle', start.handle);
  form.set('decision', decision);
  form.set('passphrase', passphrase);
  for (const s of scopes) form.append('scope', s);
  return fetch(`${BASE}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: start.cookie },
    body: form,
  });
}

async function signIn(scopes) {
  const { body: client } = await register();
  const start = await startAuthorize(client.client_id);
  const res = await submit(start, { passphrase: PASS, scopes });
  const location = res.headers.get('location') ?? '';
  const code = new URL(location, BASE).searchParams.get('code');
  if (!code) throw new Error(`sign-in gave no code: ${res.status} ${location}`);
  const tokenRes = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: client.client_id,
      code_verifier: start.verifier,
    }),
  });
  const token = await tokenRes.json();
  if (!token.access_token) throw new Error(`no token: ${JSON.stringify(token)}`);
  return token.access_token;
}

let rpcId = 1;
async function rpc(token, method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { res, body };
}

const call = async (token, name, args) => {
  const { body } = await rpc(token, 'tools/call', { name, arguments: args });
  const result = body?.result;
  return { text: result?.content?.map((c) => c.text).join('\n') ?? JSON.stringify(body), isError: !!result?.isError, raw: body };
};

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${BRIDGE}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  return { res, body: await res.json().catch(() => ({})) };
}

// ---------------------------------------------------------------------------------------

console.log('Unauthenticated access');
{
  const { res } = await rpc(null, 'tools/list', {});
  check('call without token gets 401', res.status === 401, res.status);
  check('401 carries WWW-Authenticate', !!res.headers.get('www-authenticate'), res.headers.get('www-authenticate'));
  const meta = await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`);
  check('protected-resource metadata is served', meta.status === 200, meta.status);
  const as = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
  check('authorization-server metadata is served', as.status === 200, as.status);
}

console.log('Registration allowlist');
{
  const bad = await register(['https://evil.example.com/cb']);
  check('off-list redirect is refused', bad.res.status >= 400 && bad.res.status < 500, `${bad.res.status} ${JSON.stringify(bad.body)}`);
  const good = await register();
  check('localhost redirect is accepted', good.res.status === 201 || good.res.status === 200, good.res.status);
}

console.log('Sign-in and tools');
const token = await signIn(['memory:read', 'memory:write']);
check('full sign-in yields a token', !!token);

{
  const init = await rpc(token, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'e2e', version: '0' },
  });
  check('initialize works', init.body?.result?.serverInfo?.name === 'legendary-memory', JSON.stringify(init.body));
  check('instructions are sent', typeof init.body?.result?.instructions === 'string');

  const list = await rpc(token, 'tools/list', {});
  const names = (list.body?.result?.tools ?? []).map((t) => t.name).sort();
  check(
    'tools/list returns the seven tools',
    JSON.stringify(names) === JSON.stringify(['forget', 'read', 'recall', 'remember', 'save_artifact', 'save_checkpoint', 'search']),
    names.join(','),
  );
}

{
  const empty = await call(token, 'recall', {});
  check('recall on empty store says nothing is stored', /Nothing is stored/.test(empty.text), empty.text);

  const saved = await call(token, 'save_checkpoint', {
    project: 'Cooling System',
    title: 'First session',
    summary: 'We chose a thermistor-driven fan controller using a quokka firmware loop.',
    decisions: ['Use PWM fans because they are quieter'],
    next_steps: ['Order the thermistors'],
    brief: 'Goal: quiet cooling for the rocket avionics bay.',
  });
  check('save_checkpoint creates the project', /Started project "Cooling System"/.test(saved.text) && !saved.isError, saved.text);
  const checkpointId = saved.text.match(/checkpoint:([\w-]+)/)?.[1];

  const exact = await call(token, 'recall', { project: 'Cooling System' });
  check('recall by exact name finds it', /Quiet cooling|quiet cooling/.test(exact.text) && /Stored memory/.test(exact.text), exact.text);

  const loose = await call(token, 'recall', { project: 'the cooling project' });
  check('recall by loose name finds it', /Cooling System/.test(loose.text) && !/No project matches/.test(loose.text), loose.text);

  const typo = await call(token, 'recall', { project: 'Coolng System' });
  check('recall with a one-letter typo finds it, flagged as closest match', /Cooling System/.test(typo.text) && /closest match/.test(typo.text), typo.text);

  const typoWrite = await call(token, 'save_checkpoint', {
    project: 'Coolng System',
    title: 'Should not land',
    summary: 'This must not be written into the wrong project.',
  });
  check('write with a typo is refused with suggestions', /does not exactly match/.test(typoWrite.text), typoWrite.text);

  const found = await call(token, 'search', { query: 'quokka' });
  check('search finds a word from the summary', /quokka|Cooling System/i.test(found.text) && !/Nothing stored matches/.test(found.text), found.text);

  const secret = await call(token, 'save_artifact', {
    project: 'Cooling System',
    name: 'notes.txt',
    kind: 'document',
    content: 'deploy key is sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD and the plan is fine',
  });
  check('saving a fake key reports redaction', /removed before saving/.test(secret.text), secret.text);
  const artifactId = secret.text.match(/artifact:([\w-]+)/)?.[1];
  const opened = await call(token, 'read', { ref: `artifact:${artifactId}` });
  check('stored artifact does not contain the key', !/sk-abcdefghijklmnopqrstuvwxyz/.test(opened.text) && /plan is fine/.test(opened.text), opened.text);

  const code = await call(token, 'save_artifact', {
    project: 'Cooling System',
    name: 'fan.py',
    kind: 'code',
    content: 'token = getToken()\nprint(token)',
  });
  const codeId = code.text.match(/artifact:([\w-]+)/)?.[1];
  const codeOpen = await call(token, 'read', { ref: `artifact:${codeId}` });
  check('ordinary code is not redacted', /token = getToken\(\)/.test(codeOpen.text), codeOpen.text);

  const cp = await call(token, 'read', { ref: `checkpoint:${checkpointId}` });
  check('read opens a checkpoint', /thermistor-driven/.test(cp.text), cp.text);

  const fact = await call(token, 'remember', { key: 'answer-style', value: 'short and direct' });
  check('remember stores a fact', /Remembered/.test(fact.text), fact.text);
  const overview = await call(token, 'recall', {});
  check('overview lists project and fact', /Cooling System/.test(overview.text) && /answer-style/.test(overview.text), overview.text);

  const gone = await call(token, 'forget', { ref: `artifact:${artifactId}` });
  check('forget deletes the artifact', /Deleted/.test(gone.text), gone.text);
  const after = await call(token, 'read', { ref: `artifact:${artifactId}` });
  check('forgotten artifact can no longer be opened', after.isError, after.text);
  const searchGone = await call(token, 'search', { query: 'plan is fine' });
  check('forgotten artifact is gone from search', /Nothing stored matches/.test(searchGone.text), searchGone.text);

  const forgetFuzzy = await call(token, 'forget', { ref: 'project:Coolng System' });
  check('forget refuses a typo project name', forgetFuzzy.isError && /nothing was deleted/i.test(forgetFuzzy.text), forgetFuzzy.text);
}

console.log('Read-only connection');
{
  const ro = await signIn(['memory:read']);
  const r = await call(ro, 'recall', { project: 'Cooling System' });
  check('read-only token can recall', /Cooling System/.test(r.text) && !r.isError, r.text);
  const w = await call(ro, 'save_checkpoint', { project: 'Cooling System', title: 'x', summary: 'x' });
  check('read-only token cannot save', w.isError && /read-only/.test(w.text), w.text);
  const f = await call(ro, 'remember', { key: 'k', value: 'v' });
  check('read-only token cannot remember', f.isError, f.text);
}

console.log('Importer API');
{
  const noKey = await fetch(`${BASE}/api/ingest/conversation`, { method: 'POST', body: '{}' });
  check('/api without key gets 401', noKey.status === 401, noKey.status);

  const payload = (text) => ({
    source: 'chatgpt',
    external_id: 'conv-e2e-1',
    title: 'Imported chat',
    messages: [
      { seq: 0, role: 'user', text: 'hello there' },
      { seq: 1, role: 'assistant', text },
    ],
  });
  const first = await api('/api/ingest/conversation', { method: 'POST', body: JSON.stringify(payload('the zebrafish protocol is ready')) });
  check('first ingest succeeds', first.res.status === 200, JSON.stringify(first.body));
  const second = await api('/api/ingest/conversation', { method: 'POST', body: JSON.stringify(payload('the zebrafish protocol is revised')) });
  check('second ingest succeeds', second.res.status === 200, JSON.stringify(second.body));

  const exp = await api('/api/export?table=conversations&limit=50');
  const rows = exp.body?.rows ?? exp.body?.items ?? exp.body?.data ?? [];
  const matching = Array.isArray(rows) ? rows.filter((r) => r.external_id === 'conv-e2e-1') : [];
  check('same external_id updates instead of duplicating', matching.length === 1, JSON.stringify(exp.body).slice(0, 300));

  const s = await call(token, 'search', { query: 'zebrafish' });
  check('search finds a word from an imported message', /zebrafish/i.test(s.text) && !/Nothing stored/.test(s.text), s.text);
  check('search shows the revised text, not the stale one', !/is ready/.test(s.text) || /revised/.test(s.text), s.text);
}

console.log('Passphrase lockout (runs last)');
{
  const { body: client } = await register();
  const start = await startAuthorize(client.client_id);
  check('consent page renders with a handle', !!start.handle && start.res.status === 200, start.res.status);
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const r = await submit(start, { passphrase: `wrong-passphrase-${i}`, scopes: ['memory:read', 'memory:write'] });
    statuses.push(r.status);
  }
  check('wrong passphrase gives 401 for the first five tries', statuses.slice(0, 5).every((s) => s === 401), statuses.join(','));
  check('sixth try gives 429', statuses[5] === 429, statuses.join(','));
  const right = await submit(start, { passphrase: PASS, scopes: ['memory:read', 'memory:write'] });
  check('even the right passphrase is paused during lockout', right.status === 429, right.status);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
