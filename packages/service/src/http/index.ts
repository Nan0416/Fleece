/**
 * The HTTP plumbing both Express apps are built from.
 *
 * `api/` and `tracking/` are two apps of the same shape — one assembler, one error
 * handler, one request log, one auth scheme, one health check — and until they shared a
 * package each kept its own copy. Nine of those copies were identical or identical but
 * for a comment. A folder is what that duplication was standing in for.
 *
 * What is *not* here is the part that differs: each app keeps its own `server.ts`,
 * `dependencies/` and `utils/request-parsing.ts`, because those are the app, not the
 * plumbing. `cors.ts` sits here and only `api/` installs it — where a middleware is used
 * is the factory's decision, not a reason to keep it somewhere else.
 */
export * from './app';
export * from './endpoints';
export * from './health-endpoints';
export * from './middleware';
export * from './version';
