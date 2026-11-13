export const VERSION = '0.2.0';
export const SCOPE_READ = 'memory:read';
export const SCOPE_WRITE = 'memory:write';

/** What a target hands the core for each connection. */
export interface ConnectionProps {
  /** The AI app that connected, e.g. "Claude" or "ChatGPT". */
  client: string;
}
