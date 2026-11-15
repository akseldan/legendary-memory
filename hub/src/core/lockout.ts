/**
 * Wrong-passphrase limits, shared by every place a passphrase is typed (the AI-app sign-in
 * page and the hosted memory view) so one set of counters covers them all.
 */

/** The part of Cloudflare KV, and of this project's SQLite stand-in, that the counters use. */
export interface CounterStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: string, options: { expirationTtl: number }): Promise<unknown>;
}

/** Wrong-passphrase limits per 15 minutes, per address and overall. */
const WINDOW_SECONDS = 15 * 60;
const MAX_FAILURES_PER_ADDRESS = 5;
const MAX_FAILURES_TOTAL = 40;

/** Compares two secrets without leaking, through timing, how much of them matched. */
export async function sameSecret(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  // Workers have this; Node gets it from the host target at startup.
  return (crypto.subtle as unknown as { timingSafeEqual(x: ArrayBuffer, y: ArrayBuffer): boolean }).timingSafeEqual(left, right);
}

const failureKeys = (request: Request): [string, string] => [
  `lm:login-fail:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}`,
  'lm:login-fail:all',
];

export async function tooManyFailures(store: CounterStore, request: Request): Promise<boolean> {
  const [perAddress, total] = await Promise.all(failureKeys(request).map((key) => store.get(key)));
  return Number(perAddress ?? 0) >= MAX_FAILURES_PER_ADDRESS || Number(total ?? 0) >= MAX_FAILURES_TOTAL;
}

export async function recordFailure(store: CounterStore, request: Request): Promise<void> {
  await Promise.all(
    failureKeys(request).map(async (key) => {
      const count = Number((await store.get(key)) ?? 0) + 1;
      await store.put(key, String(count), { expirationTtl: WINDOW_SECONDS });
    }),
  );
}
