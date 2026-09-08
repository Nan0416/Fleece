/**
 * The ledger and the three processes that write to it.
 *
 *     core/               the ledger: services hold the rules, data talks to Postgres
 *     http/               the plumbing the two Express apps are assembled from
 *     api/                the HTTP API over it            → dist/api/main.js
 *     tracking/           broker events in, claims in     → dist/tracking/main.js
 *     corporate-actions/  the dividend job, one run       → dist/corporate-actions/main.js
 *
 * One package because all three are one deployable unit against one schema, and they
 * coordinate through the row locks on the write path rather than with each other. Each
 * keeps its own `main.ts`, so a runnable thing still has exactly one entry point and
 * nothing parses arguments to choose between them.
 *
 * `core/` is star-exported because it is what a consumer outside this package wants —
 * the ledger without the routes. `api/` and `tracking/` are named instead: what the two
 * apps have in common lives in `http/`, and what is left still collides on
 * `DependencyFactory` and its props — two genuinely different object graphs that happen
 * to share a name — so a star export of both would be an ambiguity error.
 */
export * from './core';
export * from './corporate-actions';

export { FleeceServer } from './api/server';
export type { StartServerOptions } from './api/server';
export { STAGES, loadServiceConfig } from './api/stage-config';
export type { ServiceConfig, Stage } from './api/stage-config';

export { TrackingServiceRuntime } from './tracking/tracking-service-runtime';
export type { StartTrackingServiceOptions } from './tracking/tracking-service-runtime';
export { loadTrackingConfig } from './tracking/tracking-config';
export type { BrokerAccountConfig, TrackingConfig } from './tracking/tracking-config';
