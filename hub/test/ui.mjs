// Checks the welcome page's local endpoints (`legendary-memory start`): the page is served,
// everything behind it needs the one-time key, and connecting through the page does what
// `setup` does. Builds are done by `npm run test:ui`.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  console.log('\nThe Claude Desktop extension');
  const desktop = process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Claude') : join(home, '.config', 'Claude');
  const extId = 'local.mcpb.akseldan.legendary-memory';
  mkdirSync(join(desktop, 'Claude Extensions Settings'), { recursive: true });
  writeFileSync(join(desktop, 'extensions-installations.json'), JSON.stringify({ extensions: { [extId]: { id: extId, version: '0.9.0', manifest: { name: 'legendary-memory' } } } }));
  writeFileSync(join(desktop, 'Claude Extensions Settings', `${extId}.json`), JSON.stringify({ isEnabled: true }));
  const withExtension = await (await ui('/ui/apps')).json();
  const desktopApp = withExtension.apps.find((a) => a.app === 'Claude Desktop');
  check('an installed extension shows as connected, with a note saying how', desktopApp?.status === 'connected' && /extension v0\.9\.0/.test(desktopApp?.note ?? ''), JSON.stringify(desktopApp));
  const viaPage = await (await ui('/ui/connect', { body: { only: ['Claude Desktop'] } })).json();
  check('connecting through the page adds no second copy', !existsSync(join(desktop, 'claude_desktop_config.json')) && viaPage.apps.find((a) => a.app === 'Claude Desktop')?.status === 'connected', JSON.stringify(viaPage));

  console.log('\nMemory');
  const empty = await (await ui('/ui/memory')).json();
  check('an empty memory reports nothing', empty.latest === null && empty.counts.projects === 0 && empty.projects.length === 0, JSON.stringify(empty));
  check(
    'the undo command names the Node.js and program that are actually installed',
    /\/node ~\/\.legendary-memory\/bin\/legendary-memory\.mjs setup --undo$/.test(empty.undoCommand ?? ''),
    empty.undoCommand,
  );
  await mcp('save_checkpoint', { project: 'Cooling System', title: 'Chose the fan curve', summary: 'Thermistor-driven curve.', brief: 'Goal: quiet cooling.' });
  const full = await (await ui('/ui/memory')).json();
  check('a saved checkpoint shows up as the latest', full.latest?.title === 'Chose the fan curve' && full.latest?.project === 'Cooling System' && full.latest?.source === 'claude', JSON.stringify(full.latest));
  check('the project is listed with its brief and session', full.projects[0]?.brief === 'Goal: quiet cooling.' && full.projects[0]?.sessions[0]?.title === 'Chose the fan curve' && full.counts.sessions === 1, JSON.stringify(full.projects));
  check('unknown page endpoints are not found', (await ui('/ui/nope')).status === 404);

  console.log('\nSearch, edit, delete');
  const post = (path, body, opts = {}) => ui(path, { body, ...opts });
  check('search needs the key', (await ui('/ui/search?q=fan', { key: '' })).status === 401);
  const found = await (await ui('/ui/search?q=thermistor')).json();
  check('search finds a saved session', found.hits.some((h) => h.kind === 'checkpoint' && h.project === 'Cooling System'), JSON.stringify(found));
  check('an empty search finds nothing', (await (await ui('/ui/search?q=')).json()).hits.length === 0);
  const projectId = full.projects[0].id;
  const sessionId = full.projects[0].sessions[0].id;
  check('the summary carries ids', typeof projectId === 'string' && typeof sessionId === 'string');
  check('editing needs the key', (await post('/ui/brief', { id: projectId, brief: 'x' }, { key: '' })).status === 401);
  check('another site cannot edit', (await post('/ui/brief', { id: projectId, brief: 'x' }, { origin: 'https://evil.example' })).status === 403);
  check('a brief that is not text is refused', (await post('/ui/brief', { id: projectId, brief: 5 })).status === 400);
  check('a brief over the limit is refused', (await post('/ui/brief', { id: projectId, brief: 'a'.repeat(16001) })).status === 400);
  check('editing an unknown project is not found', (await post('/ui/brief', { id: 'nope', brief: 'x' })).status === 404);
  check('a brief can be edited', (await post('/ui/brief', { id: projectId, brief: 'Goal: silent and cool.' })).status === 200);
  const edited = await (await ui('/ui/memory')).json();
  check('the edit shows in the memory view', edited.projects[0].brief === 'Goal: silent and cool.', JSON.stringify(edited.projects[0]));
  const asked = await (await mcp('recall', { project: 'Cooling System' })).text();
  check('and assistants recall the edited brief', asked.includes('Goal: silent and cool.'), asked.slice(0, 300));
  check('deleting needs the key', (await post('/ui/forget', { kind: 'checkpoint', id: sessionId }, { key: '' })).status === 401);
  check('only projects, sessions and facts can be deleted here', (await post('/ui/forget', { kind: 'artifact', id: 'x' })).status === 400);

  console.log('\nOwnership (P8)');
  const fact = await (await mcp('remember', { key: 'favorite editor', value: 'Vim' })).text();
  check('an assistant saves a fact', fact.includes('favorite-editor') || fact.toLowerCase().includes('remember'), fact.slice(0, 200));
  let view = await (await ui('/ui/memory')).json();
  check('the page lists the fact', view.facts.some((f) => f.key === 'favorite-editor' && f.value === 'Vim'), JSON.stringify(view.facts));
  check('the page shows where the memory lives and storage', typeof view.dataFile === 'string' && view.storage && 'usedBytes' in view.storage, JSON.stringify(view.storage));
  check('the page says how backups stand', typeof view.backupNote === 'string' && view.backupNote.length > 10, view.backupNote);
  check('correcting a fact needs the key', (await post('/ui/fact', { key: 'favorite-editor', value: 'Helix' }, { key: '' })).status === 401);
  check('an empty correction is refused', (await post('/ui/fact', { key: 'favorite-editor', value: '  ' })).status === 400);
  check('a fact can be corrected', (await post('/ui/fact', { key: 'favorite-editor', value: 'Helix' })).status === 200);
  const recalled = await (await mcp('recall', {})).text();
  check('assistants now get the corrected fact, not the old one', recalled.includes('Helix') && !recalled.includes('Vim'), recalled.slice(0, 400));
  view = await (await ui('/ui/memory')).json();
  const log = view.activity.entries;
  check('activity shows the assistant saving the fact', log.some((a) => a.client === 'claude' && a.tool === 'remember' && a.action === 'write' && a.ok === 1 && a.target === 'fact:favorite editor'), JSON.stringify(log.slice(0, 5)));
  check('activity shows the page correcting it', log.some((a) => a.client === 'memory page' && a.tool === 'correct fact'), JSON.stringify(log.slice(0, 5)));
  check('activity shows reads too', log.some((a) => a.tool === 'recall' && a.action === 'read'));
  check('activity never stores what was saved', !JSON.stringify(log).includes('Helix') && !JSON.stringify(log).includes('Vim'));
  await mcp('search', { query: 'secret plans for thermistor' });
  check('activity never stores search words', !JSON.stringify((await (await ui('/ui/memory')).json()).activity).includes('thermistor'));
  check('activity publishes its retention', view.activity.days === 90 && view.activity.max === 5000);
  const handoff = await ui(`/ui/handoff?id=${encodeURIComponent(projectId)}`);
  const md = await handoff.text();
  check('a project handoff downloads as Markdown', handoff.status === 200 && (handoff.headers.get('content-type') ?? '').startsWith('text/markdown') && /attachment; filename=".+-handoff\.md"/.test(handoff.headers.get('content-disposition') ?? ''), handoff.headers.get('content-disposition'));
  check('the handoff holds the brief and the sessions', md.startsWith('# Cooling System') && md.includes('Goal: silent and cool.') && md.includes('## Recent sessions'), md.slice(0, 400));
  check('a handoff needs the key', (await ui(`/ui/handoff?id=${encodeURIComponent(projectId)}`, { key: '' })).status === 401);
  check('an unknown project has no handoff', (await ui('/ui/handoff?id=nope')).status === 404);
  check('archiving needs the key', (await post('/ui/status', { id: projectId, status: 'archived' }, { key: '' })).status === 401);
  check('an unknown status is refused', (await post('/ui/status', { id: projectId, status: 'gone' })).status === 400);
  check('a project can be archived', (await post('/ui/status', { id: projectId, status: 'archived' })).status === 200);
  const overview = await (await mcp('recall', {})).text();
  check('the overview leaves archived projects out but says they exist', !overview.includes('- Cooling System') && overview.includes('1 archived project'), overview.slice(0, 500));
  check('an archived project still recalls by name', (await (await mcp('recall', { project: 'Cooling System' })).text()).includes('# Cooling System'));
  check('archived projects are listed last on the page', (await (await ui('/ui/memory')).json()).projects.at(-1).status === 'archived');
  check('and it can be brought back', (await post('/ui/status', { id: projectId, status: 'active' })).status === 200 && (await (await mcp('recall', {})).text()).includes('Cooling System'));
  check('a fact can be deleted from the page', (await post('/ui/forget', { kind: 'profile', id: 'favorite-editor' })).status === 200);
  check('and it is gone', !(await (await ui('/ui/memory')).json()).facts.some((f) => f.key === 'favorite-editor'));
  check('deleting an unknown session is not found', (await post('/ui/forget', { kind: 'checkpoint', id: 'nope' })).status === 404);
  check('a session can be deleted', (await post('/ui/forget', { kind: 'checkpoint', id: sessionId })).status === 200);
  const trimmed = await (await ui('/ui/memory')).json();
  check('the session is gone and the project stays', trimmed.counts.sessions === 0 && trimmed.projects.length === 1, JSON.stringify(trimmed.counts));
  check('a deleted session no longer turns up in search', (await (await ui('/ui/search?q=thermistor')).json()).hits.every((h) => h.kind !== 'checkpoint'));
  check('a project can be deleted', (await post('/ui/forget', { kind: 'project', id: projectId })).status === 200);
  check('the memory is empty again', (await (await ui('/ui/memory')).json()).counts.projects === 0);
} finally {
  child.kill();
  rmSync(home, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
