import { InvalidRequestError } from '@fleece/shared';

/**
 * Alpaca's `client_order_id` is the only field we control that comes back on every
 * event about an order, so it is where the order's own identity is carried: which
 * virtual account it trades for, and which order group it belongs to.
 *
 * Without it, an event arriving from the websocket could not be attributed to a
 * strategy, and the fill would land in a default account.
 *
 * The encoding is `_c@a:<accountId>;r:<reservationId>;g:<groupId>`, any segment
 * optional. Alpaca caps the field at 128 characters, which is why the format is terse
 * rather than JSON.
 */
const PREFIX = '_c@';
const MAX_CORRELATION_LENGTH = 128;

/** `;` separates segments and `:` separates tag from value, so neither can appear in an id. */
const RESERVED_CHARACTERS = /[;:]/;

export interface AlpacaOrderCorrelation {
  readonly virtualAccountId?: string;
  readonly reservationId?: string;
  readonly groupId?: string;
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
  if (typeof correlation.groupId === 'string') {
    assertEncodable(correlation.groupId, 'groupId');
    segments.push(`g:${correlation.groupId}`);
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
  let groupId: string | undefined;

  for (const segment of clientOrderId.slice(PREFIX.length).split(';')) {
    if (segment.startsWith('a:')) {
      virtualAccountId = segment.slice(2);
    } else if (segment.startsWith('r:')) {
      reservationId = segment.slice(2);
    } else if (segment.startsWith('g:')) {
      groupId = segment.slice(2);
    }
  }

  return { virtualAccountId, reservationId, groupId };
}
