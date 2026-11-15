/**
 * `legendary-memory setup`: connects the local memory to the AI apps installed on this
 * computer, so nobody has to find and hand-edit a config file.
 *
 * Rules it keeps: it only touches apps that are already installed, only adds or replaces its
 * own "legendary-memory" entry, leaves a file alone if it cannot parse it, and saves a copy
 * of any file before changing it.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

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
  /** Something the user should know about this app, shown next to it on the welcome page. */
  note?: string;
}

interface JsonApp {
  app: string;
  /** The app counts as installed when this folder exists. */
  folder: (ctx: SetupContext) => string;
  file: (ctx: SetupContext) => string;
  after?: string;
  /** Finds this server installed some other way, so it is not added a second time. */
  extension?: (ctx: SetupContext) => InstalledExtension | null;
}

interface InstalledExtension {
  id: string;
  version: string;
  enabled: boolean;
}

const claudeDesktopFolder = (ctx: SetupContext): string => {
  if (ctx.platform === 'darwin') return join(ctx.home, 'Library', 'Application Support', 'Claude');
  if (ctx.platform === 'win32') return join(ctx.env.APPDATA ?? join(ctx.home, 'AppData', 'Roaming'), 'Claude');
  return join(ctx.env.XDG_CONFIG_HOME ?? join(ctx.home, '.config'), 'Claude');
};

/**
 * The Legendary Memory extension (the .mcpb), if Claude Desktop has it installed. Claude
 * Desktop lists installed extensions in one JSON file, keeps each one's files in its own
 * folder, and keeps an on/off switch per extension. The file format is not documented, so
 * anything unexpected counts as "not installed" rather than an error.
 */
function claudeDesktopExtension(ctx: SetupContext): InstalledExtension | null {
  const folder = claudeDesktopFolder(ctx);
  const readJson = (file: string): unknown => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };
  let id = '';
  let version = '';
  const listed = readJson(join(folder, 'extensions-installations.json'));
  const entries = isObject(listed) && isObject(listed.extensions) ? Object.entries(listed.extensions) : [];
  for (const [key, entry] of entries) {
    if (isObject(entry) && isObject(entry.manifest) && entry.manifest.name === SERVER_NAME) {
      id = typeof entry.id === 'string' ? entry.id : key;
      version = typeof entry.version === 'string' ? entry.version : '';
    }
  }
  if (!id) {
    // The list can lag behind the folders, so look at the folders too.
    try {
      for (const name of readdirSync(join(folder, 'Claude Extensions'))) {
        const manifest = readJson(join(folder, 'Claude Extensions', name, 'manifest.json'));
        if (isObject(manifest) && manifest.name === SERVER_NAME) {
          id = name;
          version = typeof manifest.version === 'string' ? manifest.version : '';
        }
      }
    } catch {
      // No extensions folder: nothing installed that way.
    }
  }
  if (!id) return null;
  const settings = readJson(join(folder, 'Claude Extensions Settings', `${id}.json`));
  return { id, version, enabled: !(isObject(settings) && settings.isEnabled === false) };
}

/** Apps that keep MCP servers in a JSON file under a top-level "mcpServers" object. */
const JSON_APPS: JsonApp[] = [
  {
    app: 'Claude Desktop',
    folder: claudeDesktopFolder,
    file: (ctx) => join(claudeDesktopFolder(ctx), 'claude_desktop_config.json'),
    after: 'Quit and reopen Claude Desktop to load it.',
    extension: claudeDesktopExtension,
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
  const extension = app.extension?.(ctx) ?? null;
  const said = (status: SetupResult['status'], sentence: string): SetupResult => ({ ...result(status, sentence), note: sentence });
  const dropEntry = (): void => {
    const rest = { ...servers };
    delete rest[SERVER_NAME];
    writeJsonSafely(file, { ...config, mcpServers: rest });
  };
  const removeInSettings = 'To remove the extension, use Claude Desktop > Settings > Extensions.';

  if (ctx.undo) {
    if (current === undefined) {
      return extension
        ? said('skipped', `connected through the Legendary Memory extension, which this does not remove. ${removeInSettings}`)
        : result('skipped', 'was not connected');
    }
    if (!ctx.dryRun) dropEntry();
    const gone = `${ctx.dryRun ? 'would remove from' : 'removed from'} ${file}`;
    return extension ? said('removed', `${gone}. The extension is still installed. ${removeInSettings}`) : result('removed', gone);
  }

  // The extension and a config entry would show Claude two copies of every tool.
  if (extension?.enabled) {
    const via = `the Legendary Memory extension${extension.version ? ` v${extension.version}` : ''}`;
    if (current === undefined) return said('already', `connected through ${via}; nothing added`);
    if (!ctx.dryRun) dropEntry();
    return said('already', `${ctx.dryRun ? 'would remove' : 'removed'} the duplicate entry from ${file}; ${via} is used`);
  }
  if (extension && current === undefined) {
    return said('skipped', 'the Legendary Memory extension is installed but switched off. Turn it on in Claude Desktop > Settings > Extensions.');
  }

  if (JSON.stringify(current) === JSON.stringify(wanted)) return result('already', file);
  const stale = isObject(current) && typeof current.command === 'string' && isAbsolute(current.command) && !existsSync(current.command);
  if (!ctx.dryRun) writeJsonSafely(file, { ...config, mcpServers: { ...servers, [SERVER_NAME]: wanted } });
  const after = app.after && !ctx.dryRun ? ` ${app.after}` : '';
  const done = result('connected', `${ctx.dryRun ? 'would write' : 'wrote'} ${file}.${after}`);
  return stale ? { ...done, note: 'It points at a Node.js that is no longer there. Connecting again repairs it.' } : done;
}

/**
 * The path to put in an app's settings for Node.js. The running binary's own path can be
 * a versioned folder (Homebrew's Cellar, nvm, an npx cache) that disappears on the next
 * upgrade; a plain `node` in a standard folder that leads to the same binary survives it.
 */
const VERSIONED_NODE = /\/(Cellar|node-versions|_npx|fnm_multishells)\/|\/\.(nvm|fnm|volta)\//;
export function stableNodePath(execPath: string, env: Record<string, string | undefined> = process.env): string {
  if (process.platform === 'win32') return execPath;
  let real: string;
  try {
    real = realpathSync(execPath);
  } catch {
    return execPath;
  }
  const folders = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', ...(env.PATH ?? '').split(delimiter)].filter(Boolean);
  for (const folder of folders) {
    const candidate = join(folder, 'node');
    try {
      if (!VERSIONED_NODE.test(candidate) && realpathSync(candidate) === real) return candidate;
    } catch {
      // Not there; try the next folder.
    }
  }
  return VERSIONED_NODE.test(execPath) ? real : execPath;
}

/**
 * Apps that manage their own settings file and offer a command for it. Going through the
 * app's command is safer than editing its file: the app keeps its own format.
 */
interface CliApp {
  app: string;
  program: string;
  /** Extra flags for `mcp add`, before the server name. */
  addFlags: string[];
  /** Said after a successful add. */
  added: string;
}

const CLI_APPS: CliApp[] = [
  { app: 'Claude Code', program: 'claude', addFlags: ['--scope', 'user'], added: 'added for every project (user scope)' },
  // Codex's settings are shared by its command line, editor extension and desktop app.
  { app: 'Codex', program: 'codex', addFlags: [], added: 'added for every project' },
];

function connectCliApp(cli: CliApp, ctx: SetupContext): SetupResult {
  const result = (status: SetupResult['status'], detail: string): SetupResult => ({ app: cli.app, status, detail });
  const add = ['mcp', 'add', ...cli.addFlags, SERVER_NAME, '--', ctx.nodePath, ctx.serverPath, 'stdio'];
  const shown = `${cli.program} ${add.join(' ')}`;
  const remove = ['mcp', 'remove', SERVER_NAME];
  if (ctx.run(cli.program, ['--version']).code !== 0) return result('not-installed', '');

  const existing = ctx.run(cli.program, ['mcp', 'get', SERVER_NAME]);
  const present = existing.code === 0;
  if (ctx.undo) {
    if (!present) return result('skipped', 'was not connected');
    if (ctx.dryRun) return result('removed', `would run: ${cli.program} ${remove.join(' ')}`);
    return ctx.run(cli.program, remove).code === 0
      ? result('removed', 'removed')
      : result('failed', `Could not remove it. Run: ${cli.program} ${remove.join(' ')}`);
  }
  if (present && existing.output.includes(ctx.serverPath) && existing.output.includes(ctx.nodePath)) return result('already', '');
  if (ctx.dryRun) return result('connected', `would run: ${shown}`);
  if (present) ctx.run(cli.program, remove);
  return ctx.run(cli.program, add).code === 0 ? result('connected', cli.added) : result('failed', `Could not add it. Run: ${shown}`);
}

export function runSetup(ctx: SetupContext): SetupResult[] {
  const chosen = (app: string): boolean => !ctx.only || ctx.only.includes(app);
  return [
    ...JSON_APPS.filter((app) => chosen(app.app)).map((app) => connectJsonApp(app, ctx)),
    ...CLI_APPS.filter((cli) => chosen(cli.app)).map((cli) => connectCliApp(cli, ctx)),
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
    if (r.note && !r.detail.includes(r.note)) lines.push(`  ${''.padEnd(15)} ${r.note}`);
  }
  const touched = results.some((r) => r.status === 'connected' || r.status === 'already');
  if (!undo && !touched) {
    lines.push('', 'No supported AI app was found. Install Claude Desktop, Claude Code, Codex, Cursor, Windsurf or Gemini CLI,', 'or run `legendary-memory info` for settings to paste into another app.');
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
