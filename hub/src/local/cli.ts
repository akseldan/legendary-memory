#!/usr/bin/env node
/**
 * Legendary Memory, local target. No account, no server to rent: your memory is one
 * SQLite file on this computer.
 *
 *   legendary-memory stdio        MCP over stdin/stdout (Claude Desktop, Claude Code)
 *   legendary-memory serve        local HTTP on 127.0.0.1 (importer, extension, HTTP clients)
 *   legendary-memory info         where things are, plus copy-paste connector settings
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SCOPE_READ, SCOPE_WRITE, VERSION } from '../core/constants';
import { buildServer } from '../core/mcp';
import { apiKey, dataDir, dbPath } from './config';
import { startServer } from './server';
import { openDatabase } from './sqlite';

const [command = 'help', ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = rest.indexOf(name);
  return at >= 0 ? rest[at + 1] : undefined;
};

async function main(): Promise<void> {
  switch (command) {
    case 'stdio': {
      const db = openDatabase(dbPath());
      const server = buildServer(db, { client: '' }, [SCOPE_READ, SCOPE_WRITE], () => server.server.getClientVersion()?.name ?? '');
      await server.connect(new StdioServerTransport());
      return; // stdout belongs to the protocol; log only to stderr
    }
    case 'serve': {
      const port = Number(flag('--port') ?? process.env.PORT ?? 8787);
      const db = openDatabase(dbPath());
      await startServer(db, apiKey(), port);
      console.error(`Legendary Memory ${VERSION} listening on http://127.0.0.1:${port}  (database: ${dbPath()})`);
      console.error('Run `legendary-memory info` for the key and connector settings.');
      return;
    }
    case 'info': {
      const self = process.argv[1] ?? 'legendary-memory';
      console.log(`Legendary Memory ${VERSION}
Data folder : ${dataDir()}
Database    : ${dbPath()}
Local key   : ${apiKey()}   (only needed for \`serve\`; keep it private)

Claude Desktop - add to claude_desktop_config.json under "mcpServers":
  "legendary-memory": { "command": "node", "args": ["${self}", "stdio"] }

Claude Code:
  claude mcp add legendary-memory -- node ${self} stdio

Local HTTP (after \`serve\`):  http://127.0.0.1:8787/mcp  with header  Authorization: Bearer <key>`);
      return;
    }
    default:
      console.log('Usage: legendary-memory <stdio | serve [--port N] | info>');
      process.exitCode = command === 'help' || command === '--help' ? 0 : 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
