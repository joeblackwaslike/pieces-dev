/**
 * `@pieces-dev/monitor-core` — the Pieces Monitor daemon: extension host, the
 * core services, and the HTTP/WS server. The `pmon` CLI and extensions consume
 * this; the daemon entry point is `daemon.ts`.
 */

export { Host } from './host.js';
export { buildServices } from './runtime.js';
export type { BuildOptions, Services } from './runtime.js';
export { buildServer } from './server.js';
export type { ServerOptions } from './server.js';
export { startDaemon } from './daemon.js';
