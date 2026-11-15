#!/usr/bin/env node
/**
 * Legendary Memory on your own machine. No account, no server to rent: your memory is one
 * SQLite file on this computer.
 *
 *   legendary-memory start        open the welcome page: guided setup, then your memory
 *   legendary-memory setup        the same setup from the terminal, no browser
 *   legendary-memory stdio        MCP over stdin/stdout (what those apps run)
 *   legendary-memory serve        local HTTP on 127.0.0.1 (importer, extension, HTTP clients)
 *   legendary-memory host         reachable from the internet with sign-in (phone, web apps)
 *   legendary-memory copy         add one memory's contents to another (computer, server, file)
 *   legendary-memory info         where things are, plus copy-paste connector settings
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SCOPE_READ, SCOPE_WRITE, VERSION } from '../core/constants';
import { buildServer } from '../core/mcp';
import { MIN_PASSPHRASE_LENGTH, apiKey, dataDir, dbPath, passphrase, signInDbPath } from './config';
import { startServer } from './server';
import { bearerAuthorizer } from './ui';
import { defaultRunner, formatResults, installBundle, runSetup, stableNodePath } from './setup';
import { loadSqlite, openDatabase } from './sqlite';
import welcomeHtml from './ui/welcome.html';

// Node 22 labels its built-in SQLite "experimental" on every start. Apps show a server's
// stderr as errors, so drop that one notice and let every other warning through.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  if (String(typeof warning === 'string' ? warning : warning.message).includes('SQLite is an experimental feature')) return;
  (emitWarning as (...all: unknown[]) => void)(warning, ...args);
}) as typeof process.emitWarning;

const [command = 'help', ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = rest.indexOf(name);
  return at >= 0 ? rest[at + 1] : undefined;
};
const has = (name: string): boolean => rest.includes(name);

const USAGE = `Legendary Memory ${VERSION}: one memory shared across your AI assistants.

  legendary-memory start               Open the welcome page in your browser (start here)
  legendary-memory setup [--dry-run]   Connect the AI apps on this computer from the terminal
  legendary-memory setup --undo        Disconnect them again
  legendary-memory copy --from <hub> --to <hub> [--apply] [--replace-older] [--only projects,chats,profile]
                                       Add one memory to another. <hub> is https://..., http://127.0.0.1:PORT,
                                       "local" or a .db file. Reports only until you add --apply
  legendary-memory info                Show where your data is and settings to paste by hand
  legendary-memory serve [--port N]    Local-only HTTP server for the importer and extension
  legendary-memory host --url https://your-address [--port N] [--bind ADDR] [--behind-proxy]
                                       Serve phone and web apps from your own machine
  legendary-memory stdio               Used by the AI apps; you do not run this yourself`;

/** Opens the address in the default browser. Best effort: the address is also printed. */
function openInBrowser(address: string): void {
  const [program, args] =
    process.platform === 'darwin' ? ['open', [address]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', address]] : ['xdg-open', [address]];
  try {
    spawn(program, args as string[], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
  } catch {
    // No browser launcher here (a server, a container): the printed address is enough.
  }
}

async function main(): Promise<void> {
  switch (command) {
    case 'start': {
      const db = openDatabase(dbPath());
      const self = process.argv[1] ?? '';
      const token = randomBytes(24).toString('hex');
      const ui = {
        authorize: bearerAuthorizer(token),
        html: welcomeHtml,
        dataFile: dbPath(),
        setup: (run: { dryRun: boolean; undo: boolean; only?: string[] }) =>
          runSetup({
            home: homedir(),
            platform: process.platform,
            env: process.env,
            nodePath: stableNodePath(process.execPath),
            serverPath: installBundle(self, dataDir(), run.dryRun || run.undo),
            run: defaultRunner,
            ...run,
          }),
      };
      const first = Number(flag('--port') ?? process.env.PORT ?? 8787);
      let port = first;
      for (;;) {
        try {
          await startServer(db, apiKey(), port, ui);
          break;
        } catch (error) {
          // Another copy, or another program, already has the port: try the next few.
          if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || port >= first + 10) throw error;
          port++;
        }
      }
      const address = `http://127.0.0.1:${port}/#t=${token}`;
      console.error(`Legendary Memory ${VERSION} is open at:\n  ${address}\n`);
      console.error('Keep this window open while you use the page. Press Ctrl+C to close it.');
      console.error('Your connected apps keep working after you close it.');
      if (!has('--no-open')) openInBrowser(address);
      return;
    }
    case 'stdio': {
      const db = openDatabase(dbPath());
      const server = buildServer(db, { client: '' }, [SCOPE_READ, SCOPE_WRITE], () => server.server.getClientVersion()?.name ?? '');
      await server.connect(new StdioServerTransport());
      return; // stdout belongs to the protocol; log only to stderr
    }
    case 'setup': {
      const dryRun = has('--dry-run');
      const undo = has('--undo');
      loadSqlite(); // fails early, with a plain message, if this Node is too old
      const serverPath = installBundle(process.argv[1] ?? '', dataDir(), dryRun || undo);
      const results = runSetup({
        home: homedir(),
        platform: process.platform,
        env: process.env,
        nodePath: stableNodePath(process.execPath),
        serverPath,
        dryRun,
        undo,
        run: defaultRunner,
      });
      console.log(`Legendary Memory ${VERSION}${dryRun ? ' (dry run: nothing is changed)' : ''}`);
      console.log(`Your memory lives in ${dbPath()}\n`);
      console.log(formatResults(results, undo, dryRun));
      if (results.some((r) => r.status === 'failed')) process.exitCode = 1;
      return;
    }
    case 'serve': {
      const port = Number(flag('--port') ?? process.env.PORT ?? 8787);
      const db = openDatabase(dbPath());
      await startServer(db, apiKey(), port);
      console.error(`Legendary Memory ${VERSION} listening on http://127.0.0.1:${port}  (database: ${dbPath()})`);
      console.error('Run `legendary-memory info` for the key and connector settings.');
      return;
    }
    case 'host': {
      const url = flag('--url') ?? process.env.LEGENDARY_MEMORY_URL ?? '';
      let origin: URL;
      try {
        origin = new URL(url);
      } catch {
        throw new Error('host needs the public address apps will use, for example:\n  legendary-memory host --url https://memory.example.com');
      }
      const localOnly = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
      if (origin.protocol !== 'https:' && !localOnly) {
        throw new Error('The public address must start with https://. AI apps refuse to connect over plain http.');
      }
      const secret = passphrase();
      if (secret.length < MIN_PASSPHRASE_LENGTH) {
        throw new Error(
          `host needs a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters; you type it to approve each app.\n` +
            `Put it in the LEGENDARY_MEMORY_PASSPHRASE environment variable, or in the file ${dataDir()}/passphrase`,
        );
      }
      const port = Number(flag('--port') ?? process.env.PORT ?? 8787);
      const bind = flag('--bind') ?? process.env.LEGENDARY_MEMORY_BIND ?? '127.0.0.1';
      // Loaded here so the everyday commands do not pay for the sign-in code.
      const [{ startHost }, { SqliteKv }] = await Promise.all([import('./host'), import('./kv')]);
      await startHost(openDatabase(dbPath()), new SqliteKv(signInDbPath()), {
        port,
        bind,
        publicUrl: origin.origin,
        passphrase: secret,
        html: welcomeHtml,
        apiKey: apiKey(),
        allowedRedirectHosts: process.env.LEGENDARY_MEMORY_REDIRECT_HOSTS ?? 'claude.ai,claude.com,chatgpt.com,localhost,127.0.0.1',
        behindProxy: has('--behind-proxy') || process.env.LEGENDARY_MEMORY_BEHIND_PROXY === '1',
      });
      console.error(`Legendary Memory ${VERSION} hosting on ${bind}:${port}  (database: ${dbPath()})`);
      console.error(`Add this as a custom connector in Claude or ChatGPT:  ${origin.origin}/mcp`);
      return;
    }
    case 'copy': {
      if (['--key', '--from-key', '--to-key'].some(has)) {
        throw new Error(
          'Keys are not accepted on the command line, where they stay in your shell history.\n' +
            'Set LEGENDARY_MEMORY_FROM_KEY and LEGENDARY_MEMORY_TO_KEY, or leave them unset to be asked.',
        );
      }
      const from = flag('--from');
      const to = flag('--to');
      if (!from || !to) throw new Error('copy needs both addresses, for example:\n  legendary-memory copy --from local --to https://memory.example.com');
      const { GROUPS, runCopy } = await import('./copy');
      const asked = (flag('--only') ?? GROUPS.join(',')).split(',').map((g) => g.trim());
      const unknown = asked.filter((g) => !(GROUPS as readonly string[]).includes(g));
      if (unknown.length) throw new Error(`--only takes ${GROUPS.join(', ')}; "${unknown.join(', ')}" is not one of them.`);
      await runCopy({ from, to, apply: has('--apply'), replaceOlder: has('--replace-older'), only: new Set(asked as (typeof GROUPS)[number][]) });
      return;
    }
    case 'info': {
      const self = process.argv[1] ?? 'legendary-memory';
      console.log(`Legendary Memory ${VERSION}
Data folder : ${dataDir()}
Database    : ${dbPath()}
Local key   : ${apiKey()}   (for \`serve\` and the importer; keep it private)

The easy way: \`legendary-memory setup\` connects installed apps for you.

By hand, Claude Desktop - add to claude_desktop_config.json under "mcpServers":
  "legendary-memory": { "command": "${stableNodePath(process.execPath)}", "args": ["${self}", "stdio"] }

By hand, Claude Code:
  claude mcp add --scope user legendary-memory -- ${stableNodePath(process.execPath)} ${self} stdio

Local HTTP (after \`serve\`):  http://127.0.0.1:8787/mcp  with header  Authorization: Bearer <key>`);
      return;
    }
    case '--version':
    case 'version':
      console.log(VERSION);
      return;
    default:
      console.log(USAGE);
      process.exitCode = command === 'help' || command === '--help' ? 0 : 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
