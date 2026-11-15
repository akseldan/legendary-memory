/**
 * `legendary-memory setup`: connects the local memory to the AI apps installed on this
 * computer, so nobody has to find and hand-edit a config file.
 *
 * Rules it keeps: it only touches apps that are already installed, only adds or replaces its
 * own "legendary-memory" entry, leaves a file alone if it cannot parse it, and saves a copy
 * of any file before changing it.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SERVER_NAME = 'legendary-memory';
export const BACKUP_SUFFIX = '.before-legendary-memory';

export interface SetupContext {
  home: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** Absolute path of the Node.js binary the apps should run. */
  nodePath: string;
  /** Absolute path of the bundled server the apps should run. */
  serverPath: string;
  dryRun: boolean;
  /** Remove the entry instead of adding it. */
  undo: boolean;
  /** Limit the run to these apps, by the names used in the results. Everything when unset. */
  only?: string[];
  /** Runs a command; returns its exit code, or null if the program is not installed. */
  run: (command: string, args: string[]) => { code: number | null; output: string };
}

export interface SetupResult {
  app: string;
  status: 'connected' | 'already' | 'removed' | 'not-installed' | 'skipped' | 'failed';
  detail: string;
}

interface JsonApp {
  app: string;
  /** The app counts as installed when this folder exists. */
  folder: (ctx: SetupContext) => string;
  file: (ctx: SetupContext) => string;
  after?: string;
}

const claudeDesktopFolder = (ctx: SetupContext): string => {
  if (ctx.platform === 'darwin') return join(ctx.home, 'Library', 'Application Support', 'Claude');
  if (ctx.platform === 'win32') return join(ctx.env.APPDATA ?? join(ctx.home, 'AppData', 'Roaming'), 'Claude');
  return join(ctx.env.XDG_CONFIG_HOME ?? join(ctx.home, '.config'), 'Claude');
};

/** Apps that keep MCP servers in a JSON file under a top-level "mcpServers" object. */
const JSON_APPS: JsonApp[] = [
  {
    app: 'Claude Desktop',
    folder: claudeDesktopFolder,
    file: (ctx) => join(claudeDesktopFolder(ctx), 'claude_desktop_config.json'),
    after: 'Quit and reopen Claude Desktop to load it.',
  },
  { app: 'Cursor', folder: (ctx) => join(ctx.home, '.cursor'), file: (ctx) => join(ctx.home, '.cursor', 'mcp.json') },
  {
    app: 'Windsurf',
    folder: (ctx) => join(ctx.home, '.codeium', 'windsurf'),
    file: (ctx) => join(ctx.home, '.codeium', 'windsurf', 'mcp_config.json'),
  },
  { app: 'Gemini CLI', folder: (ctx) => join(ctx.home, '.gemini'), file: (ctx) => join(ctx.home, '.gemini', 'settings.json') },
];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function writeJsonSafely(file: string, data: unknown): void {
  const existed = existsSync(file);
  if (existed) copyFileSync(file, file + BACKUP_SUFFIX);
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: existed ? statSync(file).mode & 0o777 : 0o600 });
  renameSync(temp, file);
}

function connectJsonApp(app: JsonApp, ctx: SetupContext): SetupResult {
  const result = (status: SetupResult['status'], detail: string): SetupResult => ({ app: app.app, status, detail });
  if (!existsSync(app.folder(ctx))) return result('not-installed', '');
  const file = app.file(ctx);
  const wanted = { command: ctx.nodePath, args: [ctx.serverPath, 'stdio'] };

  let config: Record<string, unknown> = {};
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    if (text.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return result('failed', `${file} is not plain JSON, so it was left untouched. Add the entry by hand (see \`legendary-memory info\`).`);
      }
      if (!isObject(parsed)) return result('failed', `${file} has an unexpected shape, so it was left untouched.`);
      config = parsed;
    }
  }
  const servers = config.mcpServers;
  if (servers !== undefined && !isObject(servers)) {
    return result('failed', `"mcpServers" in ${file} has an unexpected shape, so it was left untouched.`);
  }
  const current = servers?.[SERVER_NAME];

  if (ctx.undo) {
    if (current === undefined) return result('skipped', 'was not connected');
    if (!ctx.dryRun) {
      const rest = { ...servers };
      delete rest[SERVER_NAME];
      writeJsonSafely(file, { ...config, mcpServers: rest });
    }
    return result('removed', `${ctx.dryRun ? 'would remove from' : 'removed from'} ${file}`);
  }

  if (JSON.stringify(current) === JSON.stringify(wanted)) return result('already', file);
  if (!ctx.dryRun) writeJsonSafely(file, { ...config, mcpServers: { ...servers, [SERVER_NAME]: wanted } });
  const note = app.after && !ctx.dryRun ? ` ${app.after}` : '';
  return result('connected', `${ctx.dryRun ? 'would write' : 'wrote'} ${file}.${note}`);
}

/** Claude Code keeps its settings in a file it manages itself, so go through its own command. */
function connectClaudeCode(ctx: SetupContext): SetupResult {
  const result = (status: SetupResult['status'], detail: string): SetupResult => ({ app: 'Claude Code', status, detail });
  const add = ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', ctx.nodePath, ctx.serverPath, 'stdio'];
  const shown = `claude ${add.join(' ')}`;
  if (ctx.run('claude', ['--version']).code !== 0) return result('not-installed', '');

  const existing = ctx.run('claude', ['mcp', 'get', SERVER_NAME]);
  const present = existing.code === 0;
  if (ctx.undo) {
    if (!present) return result('skipped', 'was not connected');
    if (ctx.dryRun) return result('removed', `would run: claude mcp remove ${SERVER_NAME}`);
    const removed = ctx.run('claude', ['mcp', 'remove', SERVER_NAME]);
    return removed.code === 0 ? result('removed', 'removed') : result('failed', `Could not remove it. Run: claude mcp remove ${SERVER_NAME}`);
  }
  if (present && existing.output.includes(ctx.serverPath)) return result('already', 'user scope');
  if (ctx.dryRun) return result('connected', `would run: ${shown}`);
  if (present) ctx.run('claude', ['mcp', 'remove', SERVER_NAME]);
  const added = ctx.run('claude', add);
  return added.code === 0 ? result('connected', 'added for every project (user scope)') : result('failed', `Could not add it. Run: ${shown}`);
}

export function runSetup(ctx: SetupContext): SetupResult[] {
  const chosen = (app: string): boolean => !ctx.only || ctx.only.includes(app);
  return [
    ...JSON_APPS.filter((app) => chosen(app.app)).map((app) => connectJsonApp(app, ctx)),
    ...(chosen('Claude Code') ? [connectClaudeCode(ctx)] : []),
  ];
}

/**
 * Copies the running bundle to a permanent place in the data folder and returns that path.
 * Apps are pointed there, so the connection keeps working after a temporary download
 * (for example an `npx` run) is cleaned up.
 */
export function installBundle(self: string, dataDir: string, dryRun: boolean): string {
  const target = join(dataDir, 'bin', 'legendary-memory.mjs');
  const source = realpathSync(self);
  if (dryRun) return target;
  if (!existsSync(target) || realpathSync(target) !== source) {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(source, target);
    chmodSync(target, 0o755);
  }
  return target;
}

export function defaultRunner(command: string, args: string[]): { code: number | null; output: string } {
  // Windows installs CLIs as .cmd shims, which only start through a shell.
  const done = spawnSync(command, args, { encoding: 'utf8', timeout: 20_000, shell: process.platform === 'win32' });
  if (done.error) return { code: null, output: '' };
  return { code: done.status, output: `${done.stdout ?? ''}${done.stderr ?? ''}` };
}

export function formatResults(results: SetupResult[], undo: boolean, dryRun = false): string {
  const lines: string[] = [];
  const mark: Record<SetupResult['status'], string> = {
    connected: dryRun ? 'would connect' : 'connected',
    already: 'already connected',
    removed: dryRun ? 'would disconnect' : 'disconnected',
    'not-installed': 'not found on this computer',
    skipped: 'nothing to do',
    failed: 'NEEDS A HAND',
  };
  for (const r of results) {
    lines.push(`  ${r.app.padEnd(15)} ${mark[r.status]}${r.detail && r.status !== 'not-installed' ? `: ${r.detail}` : ''}`);
  }
  const touched = results.some((r) => r.status === 'connected' || r.status === 'already');
  if (!undo && !touched) {
    lines.push('', 'No supported AI app was found. Install Claude Desktop, Claude Code, Cursor, Windsurf or Gemini CLI,', 'or run `legendary-memory info` for settings to paste into another app.');
  }
  if (!undo && touched && !dryRun) {
    lines.push(
      '',
      'Try it: ask the app to "save a checkpoint for this project", then in another app "recall the <name> project".',
      'Tip: add this to each app\'s custom instructions so it uses the memory unprompted:',
      '  Use Legendary Memory: recall a project before working on it and save a checkpoint when we finish a session.',
    );
  }
  return lines.join('\n');
}
