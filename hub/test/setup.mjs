// Checks `legendary-memory setup` against a made-up home folder: it must connect installed
// apps, keep everything else in their config files, back files up, and never touch what it
// cannot parse. Builds are done by `npm run test:setup`.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../dist/legendary-memory.mjs', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'lm-setup-'));
const data = join(home, '.legendary-memory');
const fakeBin = join(home, 'fakebin');
const claudeLog = join(home, 'claude-calls.log');
const claudeState = join(home, 'claude-state');

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `\n         ${String(detail).slice(0, 500)}` : ''}`);
};
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const run = (args, withClaude = true) =>
  spawnSync(process.execPath, [BIN, 'setup', ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      LEGENDARY_MEMORY_DIR: data,
      NODE_NO_WARNINGS: '1',
      PATH: withClaude ? `${fakeBin}:/usr/bin:/bin` : '/usr/bin:/bin',
      CLAUDE_LOG: claudeLog,
      CLAUDE_STATE: claudeState,
    },
  });

// A pretend `claude` command that remembers one MCP server, like the real one would.
mkdirSync(fakeBin, { recursive: true });
writeFileSync(
  join(fakeBin, 'claude'),
  `#!/bin/sh
echo "$@" >> "$CLAUDE_LOG"
case "$1 $2" in
  "--version ") echo "9.9.9 (Claude Code)";;
  "mcp get") [ -f "$CLAUDE_STATE" ] && cat "$CLAUDE_STATE" || exit 1;;
  "mcp add") echo "$@" > "$CLAUDE_STATE";;
  "mcp remove") rm -f "$CLAUDE_STATE";;
esac
`,
);
chmodSync(join(fakeBin, 'claude'), 0o755);
// A pretend `codex` with the same four commands, keeping its own state file.
writeFileSync(
  join(fakeBin, 'codex'),
  `#!/bin/sh
echo "codex $@" >> "$CLAUDE_LOG"
case "$1 $2" in
  "--version ") echo "codex-cli 9.9.9";;
  "mcp get") [ -f "$CLAUDE_STATE.codex" ] && cat "$CLAUDE_STATE.codex" || exit 1;;
  "mcp add") echo "$@" > "$CLAUDE_STATE.codex";;
  "mcp remove") rm -f "$CLAUDE_STATE.codex";;
esac
`,
);
chmodSync(join(fakeBin, 'codex'), 0o755);

const desktopDir = process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Claude') : join(home, '.config', 'Claude');
const desktopFile = join(desktopDir, 'claude_desktop_config.json');
const cursorFile = join(home, '.cursor', 'mcp.json');
const geminiFile = join(home, '.gemini', 'settings.json');
const server = join(data, 'bin', 'legendary-memory.mjs');

try {
  console.log('Nothing installed');
  {
    const out = run(['--dry-run'], false);
    check('reports that no app was found', out.status === 0 && /No supported AI app was found/.test(out.stdout), out.stdout + out.stderr);
  }

  // Claude Desktop with other servers and settings; Cursor installed but never configured;
  // Gemini CLI with a settings file this tool must not damage.
  mkdirSync(desktopDir, { recursive: true });
  writeFileSync(desktopFile, JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'npx', args: ['-y', 'other-server'] } } }, null, 2));
  mkdirSync(join(home, '.cursor'), { recursive: true });
  mkdirSync(join(home, '.gemini'), { recursive: true });
  const brokenGemini = '{ // my notes\n  "theme": "x",\n}';
  writeFileSync(geminiFile, brokenGemini);

  console.log('\nDry run');
  {
    const before = readFileSync(desktopFile, 'utf8');
    const out = run(['--dry-run']);
    check('says what it would do', /would write/.test(out.stdout) && /would run: claude mcp add/.test(out.stdout), out.stdout + out.stderr);
    check('creates nothing, not even the data folder', !existsSync(data));
    check('changes no file', readFileSync(desktopFile, 'utf8') === before && !existsSync(cursorFile) && !existsSync(server));
  }

  console.log('\nSetup');
  {
    const out = run([]);
    const desktop = json(desktopFile);
    const entry = desktop.mcpServers?.['legendary-memory'];
    check('Claude Desktop gets the entry', entry?.args?.[0] === server && entry?.args?.[1] === 'stdio' && realpathSync(entry?.command ?? '/nonexistent') === realpathSync(process.execPath), JSON.stringify(desktop));
    check('other servers and settings are kept', desktop.theme === 'dark' && desktop.mcpServers?.other?.command === 'npx', JSON.stringify(desktop));
    check('the previous file is backed up', json(`${desktopFile}.before-legendary-memory`).mcpServers['legendary-memory'] === undefined);
    check('Cursor config is created', json(cursorFile).mcpServers?.['legendary-memory']?.args?.[0] === server);
    check('an unparseable file is left untouched and reported', readFileSync(geminiFile, 'utf8') === brokenGemini && /Gemini CLI\s+NEEDS A HAND/.test(out.stdout) && out.status === 1, out.stdout);
    check('Claude Code is added through its own command', /mcp add --scope user legendary-memory -- .* stdio/.test(readFileSync(claudeLog, 'utf8')), readFileSync(claudeLog, 'utf8'));
    check('Codex is added through its own command', /codex mcp add legendary-memory -- .* stdio/.test(readFileSync(claudeLog, 'utf8')) && /Codex\s+connected/.test(out.stdout), out.stdout);
    check('apps not installed are only mentioned', /Windsurf\s+not found/.test(out.stdout), out.stdout);
    check('the server is copied to a permanent place', existsSync(server));

    const hello = spawnSync(process.execPath, [server, 'stdio'], {
      encoding: 'utf8',
      timeout: 10_000,
      input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } } })}\n`,
      env: { HOME: home, LEGENDARY_MEMORY_DIR: data, NODE_NO_WARNINGS: '1', PATH: '/usr/bin:/bin' },
    });
    check('the configured command really starts the memory', /"name":"legendary-memory"/.test(hello.stdout), hello.stdout + hello.stderr);
  }

  console.log('\nRunning it again');
  {
    const before = readFileSync(desktopFile, 'utf8');
    const out = run([]);
    check('reports already connected and rewrites nothing', /Claude Desktop\s+already connected/.test(out.stdout) && /Claude Code\s+already connected/.test(out.stdout) && /Codex\s+already connected/.test(out.stdout) && readFileSync(desktopFile, 'utf8') === before, out.stdout);
  }

  console.log('\nUndo');
  {
    const out = run(['--undo']);
    const desktop = json(desktopFile);
    check('removes only its own entry', desktop.mcpServers['legendary-memory'] === undefined && desktop.mcpServers.other?.command === 'npx' && desktop.theme === 'dark', JSON.stringify(desktop));
    check('Cursor entry is removed', json(cursorFile).mcpServers['legendary-memory'] === undefined);
    check('Claude Code entry is removed', !existsSync(claudeState) && /Claude Code\s+disconnected/.test(out.stdout), out.stdout);
    check('Codex entry is removed', !existsSync(`${claudeState}.codex`) && /Codex\s+disconnected/.test(out.stdout), out.stdout);
    check('your memory is not deleted', existsSync(join(data, 'memory.db')));
  }

  console.log('\nThe Claude Desktop extension');
  {
    const ours = 'local.mcpb.akseldan.legendary-memory';
    const listFile = join(desktopDir, 'extensions-installations.json');
    const switchFile = join(desktopDir, 'Claude Extensions Settings', `${ours}.json`);
    const folder = join(desktopDir, 'Claude Extensions', ours);
    const install = (enabled) => {
      mkdirSync(folder, { recursive: true });
      mkdirSync(join(desktopDir, 'Claude Extensions Settings'), { recursive: true });
      writeFileSync(join(folder, 'manifest.json'), JSON.stringify({ name: 'legendary-memory', version: '0.9.0' }));
      writeFileSync(listFile, JSON.stringify({ extensions: { [ours]: { id: ours, version: '0.9.0', manifest: { name: 'legendary-memory' } } } }));
      writeFileSync(switchFile, JSON.stringify({ isEnabled: enabled }));
    };
    const snapshot = () => [listFile, switchFile, join(folder, 'manifest.json')].map((p) => readFileSync(p, 'utf8')).join('|');
    const entryOf = () => json(desktopFile).mcpServers?.['legendary-memory'];
    const setConfig = (servers) => writeFileSync(desktopFile, JSON.stringify({ theme: 'dark', mcpServers: servers }, null, 2));

    setConfig({ other: { command: 'npx', args: ['-y', 'other-server'] } });
    install(true);
    let out = run([]);
    check('an enabled extension is used and no second entry is added', entryOf() === undefined && /Claude Desktop\s+already connected/.test(out.stdout) && /extension v0\.9\.0/.test(out.stdout), out.stdout);

    setConfig({ other: { command: 'npx' }, 'legendary-memory': { command: '/x/node', args: ['/x/server.mjs', 'stdio'] } });
    out = run(['--dry-run']);
    check('a dry run says it would remove the duplicate and removes nothing', /would remove the duplicate/.test(out.stdout) && entryOf() !== undefined, out.stdout);
    out = run([]);
    check('a duplicate entry is removed when the extension is on', entryOf() === undefined && json(desktopFile).mcpServers.other?.command === 'npx' && json(desktopFile).theme === 'dark', out.stdout);

    const extensionBefore = snapshot();
    setConfig({ 'legendary-memory': { command: '/x/node', args: ['/x/server.mjs', 'stdio'] } });
    out = run(['--undo']);
    check('undo removes only the entry and says the extension stays', entryOf() === undefined && /extension is still installed/.test(out.stdout) && snapshot() === extensionBefore, out.stdout);

    setConfig({});
    out = run(['--undo']);
    check('undo with only the extension changes nothing and says how to remove it', /Settings > Extensions/.test(out.stdout) && snapshot() === extensionBefore, out.stdout);

    install(false);
    setConfig({});
    out = run([]);
    check('a switched-off extension is not worked around with a second copy', entryOf() === undefined && /switched off/.test(out.stdout), out.stdout);

    rmSync(join(desktopDir, 'Claude Extensions'), { recursive: true });
    rmSync(join(desktopDir, 'Claude Extensions Settings'), { recursive: true });
    rmSync(listFile);
    writeFileSync(listFile, '{ not json');
    out = run([]);
    check('an unreadable extension list counts as no extension', entryOf()?.args?.[1] === 'stdio', out.stdout);
    rmSync(listFile);
  }

  console.log('\nA Node.js that moves or disappears');
  {
    const real = realpathSync(process.execPath);
    const versioned = join(home, '.nvm', 'versions', 'node', 'v1.0.0', 'bin');
    const stable = join(home, 'stablebin');
    mkdirSync(versioned, { recursive: true });
    mkdirSync(stable, { recursive: true });
    symlinkSync(real, join(versioned, 'node'));
    symlinkSync(real, join(stable, 'node'));
    const viaVersioned = (args) => spawnSync(join(versioned, 'node'), [BIN, 'setup', ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), LEGENDARY_MEMORY_DIR: data, NODE_NO_WARNINGS: '1', PATH: `${stable}:${fakeBin}:/usr/bin:/bin`, CLAUDE_LOG: claudeLog, CLAUDE_STATE: claudeState },
    });
    writeFileSync(desktopFile, JSON.stringify({ mcpServers: {} }));
    viaVersioned([]);
    const command = json(desktopFile).mcpServers?.['legendary-memory']?.command ?? '';
    check('a version-specific Node.js is replaced by a stable path to the same binary', command !== '' && !/\.nvm/.test(command) && realpathSync(command) === real, command);
    check('Claude Code is given the same stable path', !/\.nvm/.test(readFileSync(claudeLog, 'utf8').split('\n').filter((l) => /mcp add/.test(l)).pop() ?? ''));

    writeFileSync(desktopFile, JSON.stringify({ mcpServers: { 'legendary-memory': { command: '/gone/for/good/node', args: [server, 'stdio'] } } }));
    let out = run(['--dry-run']);
    check('a dry run flags an entry whose Node.js is gone', /no longer there/.test(out.stdout), out.stdout);
    out = run([]);
    check('setup repairs it', realpathSync(json(desktopFile).mcpServers['legendary-memory'].command) === real, out.stdout);

    run(['--undo']);
    out = run([]);
    const staleCli = readFileSync(claudeState, 'utf8').replace(/\S*\/node\b/, '/gone/for/good/node');
    writeFileSync(claudeState, staleCli);
    out = run([]);
    check('Claude Code is re-added when its Node.js path differs', !/Claude Code\s+already connected/.test(out.stdout) && !readFileSync(claudeState, 'utf8').includes('/gone/for/good/node'), out.stdout);
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
