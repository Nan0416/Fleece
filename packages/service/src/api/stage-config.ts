import { getenv, getenvInteger, getenvList, getenvOneOf } from '@fleece/shared';

export type Stage = 'beta' | 'prod';
export const STAGES: ReadonlyArray<Stage> = ['beta', 'prod'];

/**
 * Any origin by default, so a console works wherever it is served from without
 * configuration. This is a wide default and a deliberate one: narrow it with
 * `FLEECE_CORS_ORIGINS`, or close the service with `FLEECE_TOKEN`.
 */
const DEFAULT_CORS_ORIGINS: ReadonlyArray<string> = ['*'];

export interface ServiceConfig {
  readonly stage: Stage;
  readonly port: number;
  readonly host: string;
  readonly databaseUrl: string;
  /** Bearer token callers must present. Unset disables authentication. */
  readonly authToken?: string;
  readonly corsOrigins: ReadonlyArray<string>;
}

/**
 * The single place this package reads `process.env`. Everything else takes its
 * configuration as constructor arguments, which is what makes the pieces testable
 * without setting environment variables.
 *
 * The legacy service resolved all of this through a remote config service and a
 * per-stage table of hostnames and ports. Every value here has a default instead, so
 * importing the package never throws for missing configuration.
 */
export function loadServiceConfig(): ServiceConfig {
  const stage = getenvOneOf('FLEECE_STAGE', STAGES, 'beta');

  return {
    stage,
    port: getenvInteger('FLEECE_PORT', 3100),
    // Loopback by default: this service moves positions and realises profit, so
    // exposing it needs to be a deliberate act.
    host: getenv('FLEECE_HOST', '127.0.0.1'),
    databaseUrl: getenv('FLEECE_DATABASE_URL', `postgres://localhost:5432/fleece_${stage}`),
    authToken: process.env['FLEECE_TOKEN'],
    // Setting the variable replaces the default rather than adding to it, so naming
    // your own origins genuinely narrows the service instead of widening it.
    corsOrigins: getenvList('FLEECE_CORS_ORIGINS', DEFAULT_CORS_ORIGINS),
  };
}

/** Resolved once at import; every value has a default. */
export const config = loadServiceConfig();

export default config;
