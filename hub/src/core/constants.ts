export const VERSION = '1.1.0';
export const SCOPE_READ = 'memory:read';
export const SCOPE_WRITE = 'memory:write';
/** Deleting (forget). Separate from writing since 2026-11-24; see `ConnectionProps.v`. */
export const SCOPE_DELETE = 'memory:delete';

/** What a target hands the core for each connection. */
export interface ConnectionProps {
  /** The AI app that connected, e.g. "Claude" or "ChatGPT". */
  client: string;
  /**
   * 2 for connections approved since deleting became its own permission. Older connections
   * (no `v`) were approved when "write" meant "save and delete", and keep that meaning.
   */
  v?: number;
}

/** Whether a connection may delete: its own permission now, implied by write on older grants. */
export function canDelete(scopes: string[], props: ConnectionProps | undefined): boolean {
  if (scopes.includes(SCOPE_DELETE)) return true;
  return scopes.includes(SCOPE_WRITE) && !(props?.v && props.v >= 2);
}
