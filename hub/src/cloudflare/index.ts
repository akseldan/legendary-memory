/**
 * Legendary Memory hub, Cloudflare target: one Worker with D1 (data) and KV (sign-in state).
 * The memory logic itself lives in ../core and is shared with the local target.
 *
 *   /mcp         the tools AI apps call (needs a token from the sign-in below)
 *   /authorize   the sign-in page where you approve an app
 *   /oauth/*     token and registration endpoints, handled by the OAuth library
 *   /api/*       importer and browser-extension API (needs BRIDGE_API_KEY)
 */
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { handleApi } from '../core/api';
import type { Db } from '../core/db';
import { handleMcpRequest } from '../core/mcp';
import { handleAuthorize } from './auth';
import { type ConnectionProps, type Env, SCOPE_READ, SCOPE_WRITE, VERSION } from './env';

/** D1 already has the shape the core needs; this cast only bridges two type definitions. */
const dbOf = (env: Env): Db => env.DB as unknown as Db;

/** Handles POST /mcp for a request the OAuth layer has already authenticated. */
const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const context = ctx as ExecutionContext & { props?: ConnectionProps; auth?: { scope?: string[] } };
    return handleMcpRequest(request, dbOf(env), context.props ?? { client: '' }, context.auth?.scope ?? []);
  },
};

const DAY = 24 * 60 * 60;

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/authorize') return handleAuthorize(request, env);
    if (pathname.startsWith('/api/')) return handleApi(request, { db: dbOf(env), apiKey: env.BRIDGE_API_KEY });
    if (pathname === '/') {
      return new Response(`Legendary Memory hub v${VERSION}. Add this address plus /mcp as a connector in your AI app.\n`, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': 'noindex' },
      });
    }
    return new Response('Not found', { status: 404 });
  },
};

/** Hosts an AI app may send the sign-in result back to. */
function allowedRedirectHosts(env: Env): Set<string> {
  return new Set(
    (env.ALLOWED_REDIRECT_HOSTS ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
}

function buildProvider(origin: string, env: Env): OAuthProvider<Env> {
  const allowed = allowedRedirectHosts(env);
  return new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: mcpHandler,
    defaultHandler,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [SCOPE_READ, SCOPE_WRITE, 'offline_access'],
    requiredScopes: [SCOPE_READ, SCOPE_WRITE],
    resourceMetadata: {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      resource_name: 'Legendary Memory',
    },
    // A connection stays valid while it is used and lapses after 90 idle days.
    refreshTokenTTL: 90 * DAY,
    refreshTokenIdleTTL: 90 * DAY,
    // Refuse self-registration by apps whose sign-in would return anywhere unexpected.
    clientRegistrationCallback: ({ clientMetadata }) => {
      const uris = Array.isArray(clientMetadata.redirect_uris) ? clientMetadata.redirect_uris : [];
      const hosts = uris.map((uri) => {
        try {
          return new URL(String(uri)).hostname.toLowerCase();
        } catch {
          return '';
        }
      });
      if (allowed.size > 0 && (hosts.length === 0 || !hosts.every((host) => allowed.has(host)))) {
        return { code: 'invalid_redirect_uri', description: 'This hub does not accept sign-ins from that app.', status: 403 };
      }
      return undefined;
    },
  });
}

const providers = new Map<string, OAuthProvider<Env>>();

/** The hub's public address: the configured one, else the address this request came in on. */
function publicOrigin(request: Request, env: Env): string {
  const configured = env.PUBLIC_URL?.trim().replace(/\/+$/, '');
  return configured || new URL(request.url).origin;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = publicOrigin(request, env);
    let provider = providers.get(origin);
    if (!provider) {
      if (providers.size >= 4) providers.clear();
      provider = buildProvider(origin, env);
      providers.set(origin, provider);
    }
    return provider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
