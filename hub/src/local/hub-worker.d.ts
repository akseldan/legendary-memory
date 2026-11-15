/**
 * The Cloudflare target's request handler, reused as-is by the `host` target. It is joined
 * in by the bundler (see the `--alias:hub-worker=` flag in package.json) instead of a normal
 * import so the Worker code keeps being type-checked against Workers types and this folder
 * against Node types, without the two sets of globals colliding.
 */
declare module 'hub-worker' {
  const worker: {
    fetch(request: Request, env: Record<string, unknown>, ctx: Record<string, unknown>): Promise<Response>;
  };
  export default worker;
}
