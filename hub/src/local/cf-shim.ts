/**
 * Stand-in for the `cloudflare:workers` module when the hub runs on Node (`host` target).
 * The OAuth library only uses this class for an `instanceof` check on handlers, and the
 * hub's handlers are plain objects, so an empty class is all it needs.
 */
export class WorkerEntrypoint {}
