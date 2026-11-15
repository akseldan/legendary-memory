// Checks `legendary-memory setup` against a made-up home folder: it must connect installed
// apps, keep everything else in their config files, back files up, and never touch what it
// cannot parse. Builds are done by `npm run test:setup`.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const desktopDir = join(home, '.config', 'Claude');
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
    check('Claude Desktop gets the entry', entry?.args?.[0] === server && entry?.args?.[1] === 'stdio' && entry?.command === process.execPath, JSON.stringify(desktop));
    check('other servers and settings are kept', desktop.theme === 'dark' && desktop.mcpServers?.other?.command === 'npx', JSON.stringify(desktop));
    check('the previous file is backed up', json(`${desktopFile}.before-legendary-memory`).mcpServers['legendary-memory'] === undefined);
    check('Cursor config is created', json(cursorFile).mcpServers?.['legendary-memory']?.args?.[0] === server);
    check('an unparseable file is left untouched and reported', readFileSync(geminiFile, 'utf8') === brokenGemini && /Gemini CLI\s+NEEDS A HAND/.test(out.stdout) && out.status === 1, out.stdout);
    check('Claude Code is added through its own command', /mcp add --scope user legendary-memory -- .* stdio/.test(readFileSync(claudeLog, 'utf8')), readFileSync(claudeLog, 'utf8'));
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
    check('reports already connected and rewrites nothing', /Claude Desktop\s+already connected/.test(out.stdout) && /Claude Code\s+already connected/.test(out.stdout) && readFileSync(desktopFile, 'utf8') === before, out.stdout);
  }

  console.log('\nUndo');
  {
    const out = run(['--undo']);
    const desktop = json(desktopFile);
    check('removes only its own entry', desktop.mcpServers['legendary-memory'] === undefined && desktop.mcpServers.other?.command === 'npx' && desktop.theme === 'dark', JSON.stringify(desktop));
    check('Cursor entry is removed', json(cursorFile).mcpServers['legendary-memory'] === undefined);
    check('Claude Code entry is removed', !existsSync(claudeState) && /Claude Code\s+disconnected/.test(out.stdout), out.stdout);
    check('your memory is not deleted', existsSync(join(data, 'memory.db')));
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
