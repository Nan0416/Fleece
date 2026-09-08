import { AlpacaOrder } from './models';

export type OrderEventHandler = (order: AlpacaOrder) => void;
export type DisconnectHandler = (code: number, reason: string) => void;

export type AuthorizationStatus = 'waiting' | 'passed' | 'failed';

export interface AlpacaWsClientStatus {
  readonly connected: boolean;
  readonly authorization: AuthorizationStatus;
}

/**
 * A live feed of order events for one Alpaca account.
 *
 * Alpaca's stream has quirks worth knowing before trusting it as the only source:
 *
 * - No `new` or `accepted` event is sent while the market is closed.
 * - Replacing an open order sends the `replaced` event for the old order, and no event
 *   at all for the new one.
 * - Cancelling sends `canceled` exactly once; cancelling an already-cancelled order
 *   succeeds over REST and sends nothing.
 * - The second leg of an OTO order arrives nested inside the first over REST, but the
 *   websocket sends no separate event for it, and no `canceled` event when the parent
 *   is cancelled.
 *
 * `AlpacaActiveSynchronization` exists because of this list.
 */
export interface AlpacaWsClient {
  onDisconnected?: DisconnectHandler;

  /** Resolves once the socket is authorized and listening. */
  init(): Promise<void>;
  terminate(): Promise<void>;
  getStatus(): AlpacaWsClientStatus;

  addOrderEventHandler(handler: OrderEventHandler): string;
  removeOrderEventHandler(id: string): void;
}
