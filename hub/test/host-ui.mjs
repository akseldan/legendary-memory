// Checks the memory view served by `host`: the page is public but holds no data, everything
// behind it needs the owner's passphrase and a cookie, and writes resist cross-site requests.
// Runs on a temp folder and 127.0.0.1 only. Builds are done by `npm run test:hostui`.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../dist/legendary-memory.mjs', import.meta.url));
const PASS = 'correct horse battery staple';
const KEY = 'k'.repeat(40);
const PUBLIC = 'https://memory.example.com';
const PORT = 18805;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'lm-hostui-'));

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `\n         ${String(detail).slice(0, 500)}` : ''}`);
};

const env = (passphrase) => {
  const clean = { ...process.env, NODE_NO_WARNINGS: '1' };
  for (const name of Object.keys(clean)) if (/^(HUB_URL|BRIDGE_API_KEY|LEGENDARY_MEMORY_)/.test(name)) delete clean[name];
  return { ...clean, LEGENDARY_MEMORY_DIR: dir, LEGENDARY_MEMORY_KEY: KEY, LEGENDARY_MEMORY_PASSPHRASE: passphrase };
};
async function launch(args, passphrase, port) {
  const child = spawn('node', [BIN, ...args], { env: env(passphrase), stdio: ['ignore', 'ignore', 'pipe'] });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return child; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}
const stop = (child) => new Promise((done) => { child.once('exit', done); child.kill(); });
const host = (passphrase = PASS) => launch(['host', '--url', PUBLIC, '--port', String(PORT)], passphrase, PORT);

// Seed through the local server, which takes the API key, then hand the same folder to host.
const seedPort = 18806;
const seeder = await launch(['serve', '--port', String(seedPort)], PASS, seedPort);
let rpc = 0;
const tool = (name, args) => fetch(`http://127.0.0.1:${seedPort}/mcp`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${KEY}`, 'User-Agent': 'claude-desktop' },
  body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }),
});
await tool('save_checkpoint', { project: 'Cooling System', title: 'Chose the fan curve', summary: 'Thermistor-driven curve.', brief: 'Goal: quiet cooling.' });
await tool('save_checkpoint', { project: 'Cooling System', title: 'Compared pumps', summary: 'Two pumps tested.' });
await tool('save_checkpoint', { project: 'Second Project', title: 'Started', summary: 'Nothing yet.', brief: 'Goal: be deleted.' });
await stop(seeder);

let server = await host();

/** One request to the hosted page, as a browser on the public address would make it. */
async function ask(path, { method = 'GET', cookie, csrf, origin = PUBLIC, body, type = 'application/json', headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { 'X-LM-CSRF': csrf } : {}),
      ...(origin ? { Origin: origin } : {}),
      ...(body !== undefined ? { 'Content-Type': type } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { res, status: res.status, text, data, setCookie: res.headers.getSetCookie?.() ?? [] };
}
const login = async (passphrase = PASS, extra = {}) => {
  const r = await ask('/ui/login', { method: 'POST', body: { passphrase }, ...extra });
  return { ...r, cookie: r.setCookie[0]?.split(';')[0], csrf: r.data?.csrf };
};

try {
  console.log('The page and what is locked');
  const page = await ask('/', { origin: null });
  check('the page is served to anyone', page.status === 200 && page.text.includes('One memory for every AI you use'));
  check('it is marked for host mode', /<html[^>]* data-mode="host"/.test(page.text));
  check('it carries no passphrase and no key', !page.text.includes(PASS) && !page.text.includes(KEY));
  check('it may not load anything from elsewhere', /default-src 'none'/.test(page.res.headers.get('content-security-policy') ?? ''));
  for (const [method, path, body] of [['GET', '/ui/memory'], ['GET', '/ui/search?q=fan'], ['GET', '/ui/session'], ['POST', '/ui/brief', { id: 'x', brief: 'y' }], ['POST', '/ui/forget', { kind: 'project', id: 'x' }], ['POST', '/ui/logout', {}]]) {
    check(`${method} ${path.split('?')[0]} is locked without a sign-in`, (await ask(path, { method, body })).status === 401);
  }
  check('the API key is not a way in', (await ask('/ui/memory', { headers: { Authorization: `Bearer ${KEY}` } })).status === 401);
  check('a key or passphrase in the address is never accepted', (await Promise.all([`?t=${KEY}`, `?key=${KEY}`, `?passphrase=${encodeURIComponent(PASS)}`].map((q) => ask(`/ui/memory${q}`)))).every((r) => r.status === 401));
  check('login does not read the passphrase from the address', (await ask(`/ui/login?passphrase=${encodeURIComponent(PASS)}`, { method: 'POST', body: {} })).status === 401);
  check('login from another site is refused', (await login(PASS, { origin: 'https://evil.example' })).status === 403);
  check('login with no origin is refused', (await login(PASS, { origin: null })).status === 403);
  check('login as a plain form is refused', (await ask('/ui/login', { method: 'POST', body: `passphrase=${encodeURIComponent(PASS)}`, type: 'application/x-www-form-urlencoded' })).status === 403);

  console.log('\nSigning in');
  const wrong = await login('not the passphrase at all');
  check('a wrong passphrase is refused and sets no cookie', wrong.status === 401 && wrong.setCookie.length === 0);
  const session = await login();
  check('the right passphrase signs in', session.status === 200 && !!session.cookie && !!session.csrf, session.text);
  const flags = session.setCookie[0] ?? '';
  check('the cookie is __Host-, HttpOnly, Secure, SameSite=Strict and site-wide', /^__Host-lm_ui=/.test(flags) && /HttpOnly/i.test(flags) && /;\s*Secure/i.test(flags) && /SameSite=Strict/i.test(flags) && /Path=\//.test(flags) && !/Domain=/i.test(flags), flags);
  check('the cookie value is not in the response body', !session.text.includes(session.cookie.split('=')[1]));
  const { cookie, csrf } = session;

  console.log('\nThe memory view');
  const memory = await ask('/ui/memory', { cookie });
  check('the memory loads with the cookie', memory.status === 200 && memory.data.counts.projects === 2 && memory.data.counts.sessions === 3, memory.text);
  check('the server path is not disclosed', !memory.text.includes(dir) && memory.data.dataFile === 'this server');
  check('the session reports its token', (await ask('/ui/session', { cookie })).data?.csrf === csrf);
  check('an API key sent along with the cookie still fails', (await ask('/ui/memory', { cookie, headers: { Authorization: `Bearer ${KEY}` } })).status === 401);
  check('search works', (await ask('/ui/search?q=thermistor', { cookie })).data.hits.some((h) => h.kind === 'checkpoint'));
  check('app setup does not exist here', (await ask('/ui/apps', { cookie })).status === 404 && (await ask('/ui/connect', { cookie, csrf, method: 'POST', body: {} })).status === 404);

  console.log('\nEditing and deleting');
  const project = memory.data.projects.find((p) => p.name === 'Cooling System');
  const edit = (opts) => ask('/ui/brief', { method: 'POST', cookie, csrf, body: { id: project.id, brief: 'Goal: silent and cool.' }, ...opts });
  check('a write without the session token is refused', (await edit({ csrf: undefined })).status === 403);
  check('a write with a wrong token is refused', (await edit({ csrf: 'wrong' })).status === 403);
  check('a write from another site is refused', (await edit({ origin: 'https://evil.example' })).status === 403);
  check('a write with no origin is refused', (await edit({ origin: null })).status === 403);
  check('a write as a plain form is refused', (await edit({ type: 'application/x-www-form-urlencoded', body: 'id=x' })).status === 403);
  check('a write with the cookie, token and origin works', (await edit()).status === 200);
  check('the edit shows in the view', (await ask('/ui/memory', { cookie })).data.projects.find((p) => p.id === project.id).brief === 'Goal: silent and cool.');
  const pumps = project && (await ask('/ui/memory', { cookie })).data.projects.find((p) => p.id === project.id).sessions.find((s) => s.title === 'Compared pumps');
  check('a session can be deleted', (await ask('/ui/forget', { method: 'POST', cookie, csrf, body: { kind: 'checkpoint', id: pumps.id } })).status === 200);
  const other = memory.data.projects.find((p) => p.name === 'Second Project');
  check('a project can be deleted', (await ask('/ui/forget', { method: 'POST', cookie, csrf, body: { kind: 'project', id: other.id } })).status === 200);
  check('only projects and sessions can be deleted here', (await ask('/ui/forget', { method: 'POST', cookie, csrf, body: { kind: 'profile', id: 'x' } })).status === 400);
  const after = (await ask('/ui/memory', { cookie })).data;
  check('the deletions took effect', after.counts.projects === 1 && after.counts.sessions === 1, JSON.stringify(after.counts));

  console.log('\nLogout and restarts');
  check('logging out needs the token', (await ask('/ui/logout', { method: 'POST', cookie, body: {} })).status === 403);
  const out = await ask('/ui/logout', { method: 'POST', cookie, csrf, body: {} });
  check('logout works and clears the cookie', out.status === 200 && /Max-Age=0/.test(out.setCookie[0] ?? ''));
  check('the old cookie no longer works', (await ask('/ui/memory', { cookie })).status === 401);
  const again = await login();
  await stop(server);
  server = await host();
  check('a session survives a restart', (await ask('/ui/memory', { cookie: again.cookie })).status === 200);
  await stop(server);
  server = await host('a different passphrase entirely');
  check('and ends when the passphrase changes', (await ask('/ui/memory', { cookie: again.cookie })).status === 401);
  await stop(server);
  server = await host();

  console.log('\nGuessing');
  const attempts = [];
  for (let i = 0; i < 5; i++) attempts.push((await login(`wrong guess ${i}`)).status);
  // Two wrong tries were already made above, so the limit of five arrives after three more.
  check('wrong passphrases are refused until the limit of five, then locked', attempts.slice(0, 3).every((s) => s === 401) && attempts.slice(3).every((s) => s === 429), attempts.join(','));
  check('then even the right one is locked out', (await login()).status === 429);
  check('an invented X-Forwarded-For does not get around it', (await login(PASS, { headers: { 'X-Forwarded-For': '203.0.113.9' } })).status === 429);
} finally {
  await stop(server).catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
