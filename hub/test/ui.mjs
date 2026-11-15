// Checks the welcome page's local endpoints (`legendary-memory start`): the page is served,
// everything behind it needs the one-time key, and connecting through the page does what
// `setup` does. Builds are done by `npm run test:ui`.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../dist/legendary-memory.mjs', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'lm-ui-'));
const KEY = 'k'.repeat(40);
const PORT = 18811;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `\n         ${String(detail).slice(0, 400)}` : ''}`);
};

mkdirSync(join(home, '.cursor'), { recursive: true });
mkdirSync(process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Claude') : join(home, '.config', 'Claude'), { recursive: true });
const child = spawn(process.execPath, [BIN, 'start', '--no-open', '--port', String(PORT)], {
  env: { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), LEGENDARY_MEMORY_DIR: join(home, '.legendary-memory'), LEGENDARY_MEMORY_KEY: KEY, PATH: '/usr/bin:/bin' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let printed = '';
child.stderr.on('data', (d) => (printed += d));
for (let i = 0; i < 50 && !/#t=[0-9a-f]+/.test(printed); i++) await new Promise((r) => setTimeout(r, 100));
const token = printed.match(/#t=([0-9a-f]+)/)?.[1] ?? '';

const ui = (path, { key = token, body, origin } = {}) =>
  fetch(`${BASE}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(origin ? { Origin: origin } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
const mcp = (name, args) =>
  fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${KEY}`, 'User-Agent': 'claude-desktop' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });

try {
  console.log('Page and key');
  check('start prints an address with a one-time key', token.length === 48, printed);
  const page = await fetch(`${BASE}/`);
  const html = await page.text();
  check('the welcome page is served', page.status === 200 && html.includes('One memory for every AI you use'));
  check('the page carries no key and no data', !html.includes(token) && !html.includes(KEY));
  check('the page may not load anything from elsewhere', /default-src 'none'/.test(page.headers.get('content-security-policy') ?? ''));
  check('no key: locked', (await ui('/ui/memory', { key: '' })).status === 401);
  check('wrong key: locked', (await ui('/ui/memory', { key: 'f'.repeat(48) })).status === 401);
  check('the importer key does not open the page endpoints', (await ui('/ui/memory', { key: KEY })).status === 401);
  check('another site is refused even with the key', (await ui('/ui/apps', { origin: 'https://evil.example' })).status === 403);

  console.log('\nApps');
  const before = await (await ui('/ui/apps')).json();
  const state = (list, app) => list.apps.find((a) => a.app === app)?.status;
  check('installed apps are found, others are not', state(before, 'Cursor') === 'found' && state(before, 'Claude Desktop') === 'found' && state(before, 'Windsurf') === 'missing', JSON.stringify(before));
  check('looking changes nothing', !existsSync(join(home, '.cursor', 'mcp.json')));
  const after = await (await ui('/ui/connect', { body: { only: ['Cursor'] } })).json();
  check('connecting one app connects only that app', state(after, 'Cursor') === 'connected' && state(after, 'Claude Desktop') === 'found', JSON.stringify(after));
  const entry = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers?.['legendary-memory'];
  check('the app is pointed at the permanent copy', entry?.args?.[0] === join(home, '.legendary-memory', 'bin', 'legendary-memory.mjs') && existsSync(entry.args[0]), JSON.stringify(entry));
  const undone = await (await ui('/ui/disconnect', { body: { only: ['Cursor'] } })).json();
  check('disconnecting puts it back to found', state(undone, 'Cursor') === 'found', JSON.stringify(undone));

  console.log('\nMemory');
  const empty = await (await ui('/ui/memory')).json();
  check('an empty memory reports nothing', empty.latest === null && empty.counts.projects === 0 && empty.projects.length === 0, JSON.stringify(empty));
  await mcp('save_checkpoint', { project: 'Cooling System', title: 'Chose the fan curve', summary: 'Thermistor-driven curve.', brief: 'Goal: quiet cooling.' });
  const full = await (await ui('/ui/memory')).json();
  check('a saved checkpoint shows up as the latest', full.latest?.title === 'Chose the fan curve' && full.latest?.project === 'Cooling System' && full.latest?.source === 'claude', JSON.stringify(full.latest));
  check('the project is listed with its brief and session', full.projects[0]?.brief === 'Goal: quiet cooling.' && full.projects[0]?.sessions[0]?.title === 'Chose the fan curve' && full.counts.sessions === 1, JSON.stringify(full.projects));
  check('unknown page endpoints are not found', (await ui('/ui/nope')).status === 404);
} finally {
  child.kill();
  rmSync(home, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
