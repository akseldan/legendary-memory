// Threat model T5 (docs/contracts/THREAT-MODEL.md): a web page must not reach the local server.
// DNS rebinding makes a browser send requests for evil.example to 127.0.0.1 with "Host:
// evil.example"; those must be refused on every route. Cross-site pages must not get CORS
// permission to read answers. Temp folder and 127.0.0.1 only. Builds: `npm run test:guards`.
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../dist/legendary-memory.mjs', import.meta.url));
const KEY = 'g'.repeat(40);
const PORT = 18871;
const home = mkdtempSync(join(tmpdir(), 'lm-guards-'));

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `\n         ${String(detail).slice(0, 400)}` : ''}`);
};

/** A raw request, so the Host header can be set the way a rebinding browser sets it. */
const raw = (method, path, headers = {}, body, setHost = true) =>
  new Promise((done, fail) => {
    const sent = setHost ? { host: `127.0.0.1:${PORT}`, ...headers } : headers;
    const req = request({ host: '127.0.0.1', port: PORT, method, path, headers: sent, setHost: false }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });

const env = { ...process.env, NODE_NO_WARNINGS: '1', LEGENDARY_MEMORY_DIR: home, LEGENDARY_MEMORY_KEY: KEY };
for (const name of Object.keys(env)) if (/^(HUB_URL|BRIDGE_API_KEY)/.test(name)) delete env[name];
const server = spawn('node', [BIN, 'serve', '--port', String(PORT)], { env, stdio: ['ignore', 'ignore', 'pipe'] });
try {
  for (let i = 0; i < 80; i++) {
    try { if ((await raw('GET', '/api/health')).status === 200) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const mcpBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'recall', arguments: {} } });
  const mcpHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${KEY}` };

  console.log('Requests addressed to the local names work');
  check('health answers for 127.0.0.1', (await raw('GET', '/api/health')).status === 200);
  check('health answers for localhost', (await raw('GET', '/api/health', { host: `localhost:${PORT}` })).status === 200);
  check('/mcp answers with the key', (await raw('POST', '/mcp', mcpHeaders, mcpBody)).status === 200);

  console.log('A rebinding page (Host: evil.example) is refused everywhere');
  for (const [method, path, headers, body] of [
    ['GET', '/', {}, undefined],
    ['GET', '/api/health', {}, undefined],
    ['GET', '/ui/memory', {}, undefined],
    ['POST', '/mcp', mcpHeaders, mcpBody],
    ['GET', '/api/export?table=projects', { authorization: `Bearer ${KEY}` }, undefined],
  ]) {
    const res = await raw(method, path, { ...headers, host: `evil.example:${PORT}` }, body);
    check(`${method} ${path.split('?')[0]} → 403`, res.status === 403 && !/Stored memory|projects/.test(res.text), `${res.status} ${res.text.slice(0, 120)}`);
  }
  const lookalike = await raw('GET', '/api/health', { host: `127.0.0.1.evil.example:${PORT}` });
  check('a look-alike host (127.0.0.1.evil.example) is refused', lookalike.status === 403, lookalike.status);
  const noHost = await raw('GET', '/api/health', {}, undefined, false);
  check('a request with no Host header is refused', noHost.status === 403 || noHost.status === 400, noHost.status);

  console.log('No cross-site read permission');
  const pre = await raw('OPTIONS', '/mcp', { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' });
  check('a preflight from another site gets no CORS permission', !pre.headers['access-control-allow-origin'], JSON.stringify(pre.headers));
  const read = await raw('POST', '/mcp', { ...mcpHeaders, origin: 'https://evil.example' }, mcpBody);
  check('an answer carries no Access-Control-Allow-Origin', !read.headers['access-control-allow-origin'], JSON.stringify(read.headers));
  const ui = await raw('GET', '/ui/memory', { origin: 'https://evil.example' });
  check('the memory page API refuses another site', ui.status === 403 || ui.status === 404, ui.status);
} catch (error) {
  check('suite ran without crashing', false, error?.stack ?? error);
} finally {
  server.kill();
  rmSync(home, { recursive: true, force: true });
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
