import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  /** Injected by the OAuth library for the sign-in page. */
  OAUTH_PROVIDER: OAuthHelpers;
  PUBLIC_URL?: string;
  ALLOWED_REDIRECT_HOSTS?: string;
  /** Secret: what the owner types to approve a connection. */
  OWNER_PASSPHRASE?: string;
  /** Secret: bearer key for /api/* (importer, browser extension). Unset = API off. */
  BRIDGE_API_KEY?: string;
}

/** What the sign-in step stores with a connection, handed to every tool call. */
export interface ConnectionProps {
  /** The AI app that connected, e.g. "Claude" or "ChatGPT". */
  client: string;
}

export const SCOPE_READ = 'memory:read';
export const SCOPE_WRITE = 'memory:write';
export const VERSION = '0.1.0';
