import { getenv } from '@fleece/shared';

export interface CorporateActionsConfig {
  readonly databaseUrl: string;
  readonly polygonApiKey: string;
}

/** The single place this package reads `process.env`. */
export function loadCorporateActionsConfig(): CorporateActionsConfig {
  const stage = getenv('FLEECE_STAGE', 'beta');
  return {
    databaseUrl: getenv('FLEECE_DATABASE_URL', `postgres://localhost:5432/fleece_${stage}`),
    // No default: without a key the job would run to completion having recorded
    // nothing, which looks like success.
    polygonApiKey: getenv('FLEECE_POLYGON_API_KEY'),
  };
}
