import { FleeceClient } from '@fleece/client';
import { getenv } from '@fleece/shared';

/** Global options every command inherits from the root program. */
export interface GlobalOptions {
  readonly service?: string;
  readonly token?: string;
  readonly json?: boolean;
}

/**
 * Where the CLI points and how it authenticates, resolved as
 * flag > environment > localhost default. Flags win so a single shell can talk to more
 * than one Fleece — a paper one and a live one, most usefully — without re-exporting
 * variables.
 */
export function resolveServiceUrl(options: GlobalOptions): string {
  return options.service ?? getenv('FLEECE_SERVICE_URL', 'http://127.0.0.1:3100');
}

export function resolveToken(options: GlobalOptions): string | undefined {
  return options.token ?? process.env['FLEECE_TOKEN'];
}

export function createClient(options: GlobalOptions): FleeceClient {
  return new FleeceClient({ baseUrl: resolveServiceUrl(options), token: resolveToken(options) });
}
