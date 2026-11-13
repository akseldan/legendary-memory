/**
 * Local HTTP server: the same /mcp and /api/* the Cloudflare target serves, on your own
 * machine. Listens on 127.0.0.1 only and needs the key from `legendary-memory info`.
 * This is for tools that run on your computer (Claude Code, the importer, the browser
 * extension). Web ChatGPT and claude.ai cannot reach localhost; see the Cloudflare target.
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { handleApi } from '../core/api';
import { SCOPE_READ, SCOPE_WRITE } from '../core/constants';
import type { Db } from '../core/db';
import { handleMcpRequest } from '../core/mcp';

const MAX_BODY = 2_000_000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

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

function bearerOk(header: string | undefined, key: string): boolean {
  const given = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(key);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function startServer(db: Db, key: string, port: number): Promise<Server> {
  const server = createServer(async (req, res) => {
    const send = (status: number, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
      res.end(body);
    };
    try {
      // Refuse requests whose Host is not local: blocks DNS-rebinding from web pages.
      const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
      if (!LOCAL_HOSTS.has(host)) return send(403, 'Forbidden');

      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      if (url.pathname === '/') return send(200, 'Legendary Memory (local). Connect to /mcp with your key.\n');
      if (url.pathname === '/api/health') {
        return send(200, JSON.stringify({ ok: true }), { 'Content-Type': 'application/json' });
      }
      if (!url.pathname.startsWith('/api/') && url.pathname !== '/mcp') return send(404, 'Not found');

      const body = req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req);
      if (body === null && req.method === 'POST') return send(413, 'Body too large');

      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(name, value);
        else if (Array.isArray(value)) headers.set(name, value.join(', '));
      }
      const request = new Request(url, { method: req.method, headers, body: body ? new Uint8Array(body) : undefined });

      let response: Response;
      if (url.pathname === '/mcp') {
        if (!bearerOk(req.headers.authorization, key)) {
          return send(401, 'Missing or wrong key', { 'WWW-Authenticate': 'Bearer' });
        }
        response = await handleMcpRequest(request, db, { client: String(req.headers['user-agent'] ?? '') }, [
          SCOPE_READ,
          SCOPE_WRITE,
        ]);
      } else {
        response = await handleApi(request, { db, apiKey: key });
      }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error('request failed:', error instanceof Error ? error.message : 'unknown error');
      if (!res.headersSent) send(500, 'Internal error');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
