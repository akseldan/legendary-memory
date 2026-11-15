// Builds dist/legendary-memory.mcpb: a one-click install for Claude Desktop.
// Run from hub/ with `npm run pack:mcpb` (which builds the bundle first).
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const stage = `${root}hub/dist/mcpb/`;
const bundle = `${root}hub/dist/legendary-memory.mjs`;
const out = `${root}hub/dist/legendary-memory.mcpb`;
const version = JSON.parse(readFileSync(`${root}hub/package.json`, 'utf8')).version;

rmSync(stage, { recursive: true, force: true });
mkdirSync(`${stage}server`, { recursive: true });
copyFileSync(bundle, `${stage}server/legendary-memory.mjs`);
const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
writeFileSync(`${stage}manifest.json`, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);

const run = (args) => spawnSync('npx', ['-y', '@anthropic-ai/mcpb', ...args], { stdio: 'inherit', shell: process.platform === 'win32' });
if (run(['validate', `${stage}manifest.json`]).status !== 0) process.exit(1);
process.exit(run(['pack', stage, out]).status ?? 1);
