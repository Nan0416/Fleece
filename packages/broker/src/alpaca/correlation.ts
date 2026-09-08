import { InvalidRequestError } from '@fleece/shared';

/**
 * Alpaca's `client_order_id` is the only field we control that comes back on every
 * event about an order, so it is where the order's own identity is carried.
 *
 * Two things travel in it, and they belong to different processes:
 *
 * - `a:<accountId>` — the virtual account the order trades for. Without it an event
 *   arriving from the websocket could not be attributed to a strategy, and the fill
 *   would land in the catch-all account. This is what the ledger reads.
 * - `r:<reservationId>` — the placing process's own bookkeeping. The ledger decodes it
 *   and ignores it. It matters because it is the only identifier that exists *before*
 *   the order does, and so the only one that covers the window between reserving buying
 *   power and being told the broker's id for the order — a window Alpaca can and does
 *   deliver events in.
 *
 * The `g:` segment carried an order group and was removed with them.
 *
 * The encoding is `_c@a:<accountId>;r:<reservationId>`, either segment optional. Alpaca
 * caps the field at 128 characters, which is why the format is terse rather than JSON.
 */
const PREFIX = '_c@';
const MAX_CORRELATION_LENGTH = 128;

/** `;` separates segments and `:` separates tag from value, so neither can appear in an id. */
const RESERVED_CHARACTERS = /[;:]/;

export interface AlpacaOrderCorrelation {
  readonly virtualAccountId?: string;
  readonly reservationId?: string;
}

function assertEncodable(value: string, field: string): void {
  if (RESERVED_CHARACTERS.test(value)) {
    throw new InvalidRequestError(`${field} "${value}" cannot contain ':' or ';', which separate fields in an Alpaca client order id.`);
  }
}

export function encodeAlpacaOrderCorrelation(correlation: AlpacaOrderCorrelation): string {
  const segments: string[] = [];
  if (typeof correlation.virtualAccountId === 'string') {
    assertEncodable(correlation.virtualAccountId, 'virtualAccountId');
    segments.push(`a:${correlation.virtualAccountId}`);
  }
  if (typeof correlation.reservationId === 'string') {
    assertEncodable(correlation.reservationId, 'reservationId');
    segments.push(`r:${correlation.reservationId}`);
  }

  const encoded = `${PREFIX}${segments.join(';')}`;
  if (encoded.length > MAX_CORRELATION_LENGTH) {
    throw new InvalidRequestError(`The encoded correlation is ${encoded.length} characters; Alpaca allows at most ${MAX_CORRELATION_LENGTH} in a client order id.`);
  }
  return encoded;
}

/**
 * Returns an empty correlation for anything not in this format — an order placed by
 * hand on Alpaca's website carries whatever client order id Alpaca generated, and that
 * is exactly the orphan case the injector is written to handle.
 */
export function decodeAlpacaOrderCorrelation(clientOrderId: string): AlpacaOrderCorrelation {
  if (!clientOrderId.startsWith(PREFIX)) {
    return {};
  }

  let virtualAccountId: string | undefined;
  let reservationId: string | undefined;

  // Unrecognised segments are skipped rather than refused, so an id written by an older
  // encoding — one still carrying `g:` — still yields its account rather than orphaning
  // an order that says whose it is.
  for (const segment of clientOrderId.slice(PREFIX.length).split(';')) {
    if (segment.startsWith('a:')) {
      virtualAccountId = segment.slice(2);
    } else if (segment.startsWith('r:')) {
      reservationId = segment.slice(2);
    }
  }

  return { virtualAccountId, reservationId };
}
