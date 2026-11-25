/**
 * `host` target: the full hub (tools, sign-in page, importer API) on a machine you own, so
 * claude.ai, Claude on a phone and ChatGPT can reach it without a Cloudflare account.
 * It runs the very same request handler and sign-in library as the Cloudflare target; only
 * the storage underneath differs (SQLite files instead of D1 and KV).
 *
 * This server speaks plain HTTP. Put HTTPS in front of it: a reverse proxy with your own
 * domain (Caddy), or a tunnel (Cloudflare Tunnel, Tailscale Funnel). See docs/SELF-HOST.md.
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { Readable } from 'node:stream';
import worker from 'hub-worker';
import type { Db } from '../core/db';
import type { SqliteKv } from './kv';
import { hostUi } from '../core/ui-session';

export interface HostOptions {
  port: number;
  /** Address to listen on. 127.0.0.1 unless a proxy on another machine or Docker needs more. */
  bind: string;
  /** The public https address people and AI apps use, e.g. https://memory.example.com */
  publicUrl: string;
  passphrase: string;
  /** Key for /api/* (importer, mirror, browser extension). */
  apiKey: string;
  /** The welcome page, served at / with a passphrase sign-in for the memory view. */
  html: string;
  /** Hosts an AI app may send the sign-in result back to. */
  allowedRedirectHosts: string;
  /** True when a reverse proxy or tunnel on this machine forwards the requests. */
  behindProxy: boolean;
}

const MAX_BODY = 5_000_000;

// The sign-in page compares the passphrase with crypto.subtle.timingSafeEqual, which the
// Workers runtime has and Node does not. Same behavior, from Node's own crypto.
const subtle = crypto.subtle as unknown as { timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean };
if (typeof subtle.timingSafeEqual !== 'function') {
  Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
    value: (a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean => {
      const bytes = (v: ArrayBuffer | ArrayBufferView): Buffer =>
        v instanceof ArrayBuffer ? Buffer.from(v) : Buffer.from(v.buffer, v.byteOffset, v.byteLength);
      const left = bytes(a);
      const right = bytes(b);
      return left.length === right.length && timingSafeEqual(left, right);
    },
  });
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Who is really asking. The sign-in limit counts wrong passphrases per address, so a caller
 * must not be able to pick its own. X-Forwarded-For is believed only when `behindProxy`
 * says a proxy or tunnel in front of this server wrote it.
 */
export function clientAddress(req: IncomingMessage, behindProxy: boolean): string {
  const direct = req.socket.remoteAddress ?? 'unknown';
  if (!behindProxy) return direct;
  // Proxies and tunnels append the address they saw to X-Forwarded-For, so the last entry is
  // the one written by the hop next to us. Earlier entries are whatever the caller claimed.
  const header = req.headers['x-forwarded-for'];
  const forwarded = (Array.isArray(header) ? header.join(',') : (header ?? '')).split(',').pop()?.trim();
  return forwarded || direct;
}

export function startHost(db: Db, kv: SqliteKv, options: HostOptions): Promise<Server> {
  const origin = new URL(options.publicUrl).origin;
  const env = {
    DB: db,
    OAUTH_KV: kv,
    PUBLIC_URL: origin,
    ALLOWED_REDIRECT_HOSTS: options.allowedRedirectHosts,
    OWNER_PASSPHRASE: options.passphrase,
    BRIDGE_API_KEY: options.apiKey,
    // Checking an app by fetching its metadata document is only safe where outbound requests
    // cannot reach private addresses. Cloudflare guarantees that; a home network does not.
    // Apps fall back to registering themselves, which stays limited to the allowed hosts.
    DISABLE_CIMD: '1',
  };

  const memoryView = hostUi({ db, kv, passphrase: options.passphrase, origin, html: options.html });

  const server = createServer(async (req, res) => {
    const fail = (status: number, body: string) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
    };
    try {
      const method = req.method ?? 'GET';
      const body = method === 'GET' || method === 'HEAD' ? null : await readBody(req);
      if (body === null && method !== 'GET' && method !== 'HEAD') return fail(413, 'Body too large');

      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(name, value);
        else if (Array.isArray(value)) headers.set(name, value.join(', '));
      }
      // The one header the sign-in limit reads: always ours, never the caller's.
      headers.set('CF-Connecting-IP', clientAddress(req, options.behindProxy));
      headers.delete('x-forwarded-for');

      // Everything is addressed as the public URL, whatever proxy hop the request arrived on,
      // so sign-in links and token audiences always name the address apps actually use.
      const request = new Request(new URL(req.url ?? '/', origin), {
        method,
        headers,
        body: body && body.length > 0 ? new Uint8Array(body) : undefined,
      });
      const pending: Promise<unknown>[] = [];
      const ctx = {
        waitUntil: (work: Promise<unknown>) => void pending.push(Promise.resolve(work).catch(() => undefined)),
        passThroughOnException: () => undefined,
      };
      // The page and its /ui/ endpoints are answered here, before the sign-in library or the API see the request.
      const response = (await memoryView(request)) ?? (await worker.fetch(request, { ...env }, ctx));

      const out: Record<string, string | string[]> = {};
      response.headers.forEach((value, name) => {
        if (name !== 'set-cookie') out[name] = value;
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) out['set-cookie'] = cookies;
      res.writeHead(response.status, out);
      if (response.body) Readable.fromWeb(response.body as never).pipe(res);
      else res.end();
      await Promise.all(pending);
    } catch (error) {
      console.error('request failed:', error instanceof Error ? error.message : 'unknown error');
      if (!res.headersSent) fail(500, 'Internal error');
      else res.destroy();
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.bind, () => resolve(server));
  });
}
