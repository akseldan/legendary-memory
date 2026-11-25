// End-to-end check of the `host` target (the hub on your own machine, reachable with sign-in).
// Builds are done by `npm run test:host`. It starts the bundled server on a temp folder, runs
// the same suite the Cloudflare target must pass (test/e2e.mjs), then checks what is specific
// to hosting it yourself.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../dist/legendary-memory.mjs', import.meta.url));
const E2E = fileURLToPath(new URL('./e2e.mjs', import.meta.url));
const PASS = 'correct horse battery staple';
const KEY = 'k'.repeat(40);
const REDIRECT = 'http://localhost:9999/cb';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `\n         ${String(detail).slice(0, 400)}` : ''}`);
};

async function start(dir, port, extraArgs = [], extraEnv = {}) {
  const env = { ...process.env, LEGENDARY_MEMORY_DIR: dir, LEGENDARY_MEMORY_PASSPHRASE: PASS, LEGENDARY_MEMORY_KEY: KEY, NODE_NO_WARNINGS: '1', ...extraEnv };
  const child = spawn('node', [BIN, 'host', '--url', `http://127.0.0.1:${port}`, '--port', String(port), ...extraArgs], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return { child, err: () => err, base: `http://127.0.0.1:${port}` };
}
const stop = (server) => new Promise((resolve) => { server.child.once('exit', resolve); server.child.kill(); });

const b64url = (buf) => buf.toString('base64url');
async function register(base) {
  const res = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude host test', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  });
  return res.json();
}
async function consent(base, clientId) {
  const verifier = b64url(randomBytes(32));
  const params = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: 'memory:read memory:write', state: 's',
    code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', resource: `${base}/mcp`,
  });
  const res = await fetch(`${base}/authorize?${params}`, { redirect: 'manual' });
  const html = await res.text();
  return { verifier, handle: html.match(/name="handle" value="([^"]+)"/)?.[1], cookie: (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ') };
}
/** Posts the sign-in form with raw headers, so the test can claim any X-Forwarded-For. */
function approve(base, page, passphrase, forwardedFor) {
  const body = new URLSearchParams({ handle: page.handle, decision: 'approve', passphrase });
  body.append('scope', 'memory:read');
  body.append('scope', 'memory:write');
  const url = new URL(`${base}/authorize`);
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: page.cookie, ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}) } },
      (res) => { res.resume(); resolve({ status: res.statusCode, location: res.headers.location ?? '' }); },
    );
    req.on('error', () => resolve({ status: 0, location: '' }));
    req.end(body.toString());
  });
}
async function signIn(base) {
  const client = await register(base);
  const page = await consent(base, client.client_id);
  const done = await approve(base, page, PASS);
  const code = new URL(done.location, base).searchParams.get('code');
  const res = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: page.verifier }),
  });
  return { ...(await res.json()), clientId: client.client_id };
}
const tools = (base, token) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });

const dirs = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'lm-host-')); dirs.push(d); return d; };

try {
  console.log('Refuses unsafe starts');
  {
    const env = { ...process.env, LEGENDARY_MEMORY_DIR: tempDir(), NODE_NO_WARNINGS: '1' };
    delete env.LEGENDARY_MEMORY_PASSPHRASE;
    const noPass = spawnSync('node', [BIN, 'host', '--url', 'https://memory.example.com'], { env, encoding: 'utf8', timeout: 10_000 });
    check('will not start without a passphrase', noPass.status === 1 && /passphrase/.test(noPass.stderr), noPass.stderr);
    const short = spawnSync('node', [BIN, 'host', '--url', 'https://memory.example.com'], { env: { ...env, LEGENDARY_MEMORY_PASSPHRASE: 'short' }, encoding: 'utf8', timeout: 10_000 });
    check('will not start with a short passphrase', short.status === 1 && /at least 12/.test(short.stderr), short.stderr);
    const plain = spawnSync('node', [BIN, 'host', '--url', 'http://memory.example.com'], { env: { ...env, LEGENDARY_MEMORY_PASSPHRASE: PASS }, encoding: 'utf8', timeout: 10_000 });
    check('will not serve a public address over plain http', plain.status === 1 && /https/.test(plain.stderr), plain.stderr);
  }

  console.log('\nSame suite as the Cloudflare target');
  {
    const server = await start(tempDir(), 18801);
    const run = spawnSync('node', [E2E], { env: { ...process.env, HUB_URL: server.base, OWNER_PASSPHRASE: PASS, BRIDGE_API_KEY: KEY }, encoding: 'utf8', timeout: 120_000 });
    const summary = run.stdout.trim().split('\n').pop() ?? '';
    const fails = run.stdout.split('\n').filter((l) => l.includes('FAIL'));
    check(`shared end-to-end suite passes (${summary})`, run.status === 0, fails.join('\n') || run.stderr || server.err());
    await stop(server);
  }

  console.log('\nHosting it yourself');
  {
    const dir = tempDir();
    let server = await start(dir, 18802);
    const meta = await (await fetch(`${server.base}/.well-known/oauth-authorization-server`)).json();
    check('sign-in addresses use the public URL', meta.issuer === server.base && String(meta.token_endpoint).startsWith(server.base), JSON.stringify(meta).slice(0, 300));
    check('apps are not verified by fetching URLs (no outbound requests to private addresses)', meta.client_id_metadata_document_supported !== true, meta.client_id_metadata_document_supported);

    const session = await signIn(server.base);
    check('sign-in works', !!session.access_token, JSON.stringify(session));
    check('token opens the tools', (await tools(server.base, session.access_token)).status === 200);

    await stop(server);
    server = await start(dir, 18802);
    check('connection survives a restart', (await tools(server.base, session.access_token)).status === 200);
    const refreshed = await (await fetch(`${server.base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refresh_token, client_id: session.clientId }),
    })).json();
    check('refresh token works after a restart', !!refreshed.access_token, JSON.stringify(refreshed));

    // Back up while it serves, restore elsewhere (the Docker route: `docker compose exec memory node /app/legendary-memory.mjs backup ...`).
    const save = await fetch(`${server.base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${refreshed.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'save_checkpoint', arguments: { project: 'Self Host', title: 'kept', summary: 'kept across backup and restore' } } }),
    });
    check('a save works on the restarted server', save.status === 200);
    const backupFile = join(tempDir(), 'hosted.db');
    const backup = spawnSync('node', [BIN, 'backup', '--from', join(dir, 'memory.db'), '--to', backupFile], { env: { ...process.env, NODE_NO_WARNINGS: '1', LEGENDARY_MEMORY_DIR: tempDir() }, encoding: 'utf8' });
    check('a consistent backup can be taken while it serves', backup.status === 0 && /checkpoints\s+1/.test(backup.stdout), backup.stdout + backup.stderr);
    const restoredDir = tempDir();
    const restore = spawnSync('node', [BIN, 'copy', '--from', backupFile, '--to', join(restoredDir, 'memory.db'), '--apply'], { env: { ...process.env, NODE_NO_WARNINGS: '1', LEGENDARY_MEMORY_DIR: tempDir() }, encoding: 'utf8' });
    const restored = await start(restoredDir, 18805);
    const second = await signIn(restored.base);
    const recalled = await (await fetch(`${restored.base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${second.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'recall', arguments: { project: 'self host' } } }),
    })).text();
    check('a new server restored from that backup serves the memory', restore.status === 0 && /kept across backup and restore/.test(recalled), recalled.slice(0, 300));
    await stop(restored);

    // Not behind a proxy: a caller cannot dodge the lockout by inventing addresses.
    const client = await register(server.base);
    const page = await consent(server.base, client.client_id);
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await approve(server.base, page, `wrong-${i}`, `203.0.113.${i + 1}`)).status);
    check('invented X-Forwarded-For does not dodge the lockout', statuses.slice(0, 5).every((s) => s === 401) && statuses[5] === 429, statuses.join(','));
    await stop(server);
  }
  {
    // Behind a proxy: each real visitor is counted separately, by the proxy's last entry.
    const server = await start(tempDir(), 18803, ['--behind-proxy']);
    const client = await register(server.base);
    const page = await consent(server.base, client.client_id);
    const a = [];
    for (let i = 0; i < 6; i++) a.push((await approve(server.base, page, `wrong-${i}`, `10.9.9.9, 198.51.100.7`)).status);
    check('behind a proxy, one visitor is locked out after five tries', a[5] === 429, a.join(','));
    const other = await approve(server.base, page, 'wrong-again', '198.51.100.7, 198.51.100.8');
    check('behind a proxy, another visitor is not locked out with them', other.status === 401, other.status);
    await stop(server);
  }
} finally {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
