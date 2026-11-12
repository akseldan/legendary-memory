import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where the local database and key live. Override with LEGENDARY_MEMORY_DIR. */
export const dataDir = (): string => process.env.LEGENDARY_MEMORY_DIR || join(homedir(), '.legendary-memory');
export const dbPath = (): string => process.env.LEGENDARY_MEMORY_DB || join(dataDir(), 'memory.db');

/** The key for the local HTTP server and importer API. Created on first use, readable only by you. */
export function apiKey(): string {
  const fromEnv = process.env.LEGENDARY_MEMORY_KEY;
  if (fromEnv) return fromEnv;
  const file = join(dataDir(), 'api-key');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const key = randomBytes(32).toString('hex');
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return key;
}
