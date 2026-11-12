/**
 * The sign-in page an AI app sends you to when it connects.
 *
 * The OAuth library validates the request and owns tokens; this file owns the one human
 * step: you see which app is asking and what for, type your passphrase, and allow or deny.
 */
import { AuthorizationError, CimdFetchError, type ConsentDescription } from '@cloudflare/workers-oauth-provider';
import { type ConnectionProps, type Env, SCOPE_READ, SCOPE_WRITE } from './env';
import { escapeHtml } from './text';

const OWNER_ID = 'owner';
const MIN_PASSPHRASE_LENGTH = 12;

/** Wrong-passphrase limits per 15 minutes, per address and overall. */
const WINDOW_SECONDS = 15 * 60;
const MAX_FAILURES_PER_ADDRESS = 5;
const MAX_FAILURES_TOTAL = 40;

const SCOPE_LABELS: Record<string, string> = {
  [SCOPE_READ]: 'Read your memory',
  [SCOPE_WRITE]: 'Save to and delete from your memory',
};

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
};

function page(title: string, body: string, status = 200, extra?: Headers): Response {
  const headers = new Headers(extra);
  for (const [name, value] of Object.entries(PAGE_HEADERS)) {
    // Keep the library's own policy too: a browser enforces every policy header it gets.
    if (name === 'Content-Security-Policy' && headers.has(name)) headers.append(name, value);
    else headers.set(name, value);
  }
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · Legendary Memory</title>
<style>
  :root { color-scheme: light dark; --ink: #16181d; --soft: #5b6270; --line: #d9dde3; --bg: #f6f7f9; --card: #fff; --go: #1f5eff; --warn: #a15c00; }
  @media (prefers-color-scheme: dark) { :root { --ink: #eef0f3; --soft: #a2a9b6; --line: #343a45; --bg: #111317; --card: #1a1d23; --go: #6b93ff; --warn: #f0b354; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--ink);
         font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: 100%; max-width: 420px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 28px; }
  h1 { font-size: 20px; line-height: 1.3; margin: 0 0 8px; }
  p { margin: 0 0 14px; color: var(--soft); }
  strong { color: var(--ink); }
  .warn { color: var(--warn); }
  fieldset { border: 0; padding: 0; margin: 0 0 18px; }
  legend, label.field { display: block; font-size: 14px; color: var(--soft); margin-bottom: 6px; padding: 0; }
  label.check { display: flex; gap: 10px; align-items: flex-start; margin: 6px 0; }
  input[type=password] { width: 100%; padding: 11px 12px; font: inherit; color: inherit; background: transparent;
                         border: 1px solid var(--line); border-radius: 9px; margin-bottom: 18px; }
  input:focus-visible, button:focus-visible { outline: 2px solid var(--go); outline-offset: 2px; }
  .row { display: flex; gap: 10px; }
  button { flex: 1; padding: 11px 12px; font: inherit; font-weight: 600; border-radius: 9px; border: 1px solid var(--line);
           background: transparent; color: inherit; cursor: pointer; }
  button.go { background: var(--go); border-color: var(--go); color: #fff; }
  @media (prefers-color-scheme: dark) { button.go { color: #0b0d12; } }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
  return new Response(html, { status, headers });
}

const message = (title: string, text: string, status: number): Response =>
  page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>`, status);

function consentForm(details: ConsentDescription, handle: string): string {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : 'This app registered itself, so its name is not verified.';
  const requested = details.scope.filter((scope) => scope in SCOPE_LABELS);
  const offered = requested.length > 0 ? requested : [SCOPE_READ, SCOPE_WRITE];
  const scopes = offered
    .map(
      (scope) =>
        `<label class="check"><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked> <span>${escapeHtml(SCOPE_LABELS[scope]!)}</span></label>`,
    )
    .join('');
  const passthrough = details.scope.includes('offline_access') ? '<input type="hidden" name="scope" value="offline_access">' : '';
  const local = details.redirectIsLoopback
    ? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>'
    : '';
  return `<h1>Connect ${name} to your memory?</h1>
<p>${origin} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${local}
<form method="post" autocomplete="off">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <fieldset><legend>Allow it to</legend>${scopes}${passthrough}</fieldset>
  <label class="field" for="passphrase">Your passphrase</label>
  <input id="passphrase" name="passphrase" type="password" autocomplete="current-password" required autofocus>
  <div class="row">
    <button name="decision" value="deny" formnovalidate>Deny</button>
    <button class="go" name="decision" value="approve">Allow</button>
  </div>
</form>`;
}

/** Compares two secrets without leaking, through timing, how much of them matched. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(left, right);
}

const failureKeys = (request: Request): [string, string] => [
  `lm:login-fail:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}`,
  'lm:login-fail:all',
];

async function tooManyFailures(env: Env, request: Request): Promise<boolean> {
  const [perAddress, total] = await Promise.all(failureKeys(request).map((key) => env.OAUTH_KV.get(key)));
  return Number(perAddress ?? 0) >= MAX_FAILURES_PER_ADDRESS || Number(total ?? 0) >= MAX_FAILURES_TOTAL;
}

async function recordFailure(env: Env, request: Request): Promise<void> {
  await Promise.all(
    failureKeys(request).map(async (key) => {
      const count = Number((await env.OAUTH_KV.get(key)) ?? 0) + 1;
      await env.OAUTH_KV.put(key, String(count), { expirationTtl: WINDOW_SECONDS });
    }),
  );
}

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const passphrase = env.OWNER_PASSPHRASE ?? '';
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    // Fail closed: without a real passphrase nobody may connect.
    return message(
      'Not set up yet',
      `This hub has no passphrase. Set one of at least ${MIN_PASSPHRASE_LENGTH} characters with "wrangler secret put OWNER_PASSPHRASE", then try again.`,
      503,
    );
  }
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === 'GET') {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      return page('Connect', consentForm(details, consent.handle), 200, consent.headers);
    }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });

    const form = await request.formData();
    const handle = String(form.get('handle') ?? '');
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }

    if (await tooManyFailures(env, request)) {
      return message('Too many attempts', 'Sign-in is paused for 15 minutes after repeated wrong passphrases. Try again later.', 429);
    }
    if (!(await sameSecret(String(form.get('passphrase') ?? ''), passphrase))) {
      await recordFailure(env, request);
      // The page's handle is still unused, so going back and retrying works.
      return message('Wrong passphrase', 'That passphrase is not right. Go back and try again.', 401);
    }

    const scope = form.getAll('scope').map(String);
    const approved = await oauth.approveConsent(request, handle, { scope });
    const client = (await oauth.lookupClient(approved.request.clientId))?.clientName ?? '';
    const props: ConnectionProps = { client };
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: OWNER_ID,
      metadata: { client },
      scope: approved.request.scope,
      props,
    });
    approved.headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError) return message('Could not connect', error.description, 400);
    if (error instanceof CimdFetchError) return message('Could not connect', 'This app could not be verified.', 400);
    throw error;
  }
}
