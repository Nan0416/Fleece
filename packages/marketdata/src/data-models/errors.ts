import { AppError } from '@fleece/shared';

/**
 * A data provider answered, and what it said is not usable — a non-200, or a body whose
 * shape the client cannot read.
 *
 * Separate from `ServiceUnreachableError`, which the HTTP client throws when there was no
 * answer at all. A caller retries one and not the other.
 */
export class DataProviderError extends AppError {
  readonly source: string;
  /** The provider's own status, when it gave one. */
  readonly providerStatus?: number;

  constructor(source: string, message: string, providerStatus?: number) {
    super(`${source} ${message}`, 502, 'INTERNAL');
    this.source = source;
    this.providerStatus = providerStatus;
  }
}
