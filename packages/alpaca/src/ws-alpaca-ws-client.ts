import { LinearBackoff, LoggerFactory } from '@fleece/shared';
import WebSocket from 'ws';
import { AlpacaWsClient, AlpacaWsClientStatus, AuthorizationStatus, DisconnectHandler, OrderEventHandler } from './alpaca-ws-client';
import { websocketUrl } from './constants';
import { AlpacaAccountIdentifier, AlpacaCredentialsProvider, AlpacaOrder, resolveCredentials } from './models';

const logger = LoggerFactory.getLogger('AlpacaWsClient');

interface AlpacaWsEvent {
  readonly stream?: unknown;
  readonly data?: unknown;
}

export interface WsAlpacaWsClientProps {
  readonly account: AlpacaAccountIdentifier;
  readonly credentialsProvider: AlpacaCredentialsProvider;
  readonly onDisconnected?: DisconnectHandler;
  /** Keeps the connection open through an idle market. */
  readonly pingPeriodMs?: number;
  readonly pongTimeoutMs?: number;
  readonly authTimeoutMs?: number;
  /** Overrides the URL derived from `account.live`. For tests. */
  readonly url?: string;
}

/**
 * Credentials are read on every connect rather than captured once.
 *
 * Alpaca authorises a websocket only when it opens, so a rotated key has no effect on
 * a connection that is already up — but it has to be the new key when the socket next
 * reconnects, which is exactly when nobody is watching.
 */
export class WsAlpacaWsClient implements AlpacaWsClient {
  private ws?: WebSocket;
  private connected = false;
  private authorization: AuthorizationStatus = 'waiting';
  private autoReconnect = true;
  private readonly backoff = new LinearBackoff(100, 2_000, 300);
  private readonly url: string;
  private readonly logMeta: { readonly brokerAccountId: string };

  private pingJob?: NodeJS.Timeout;
  private pongTimeout?: NodeJS.Timeout;
  private authTimeout?: NodeJS.Timeout;
  private pendingInit?: { resolve: () => void; reject: (err: Error) => void };

  private handlers: Array<[string, OrderEventHandler]> = [];
  onDisconnected?: DisconnectHandler;

  constructor(private readonly props: WsAlpacaWsClientProps) {
    this.url = props.url ?? websocketUrl(props.account.live);
    this.onDisconnected = props.onDisconnected;
    this.logMeta = { brokerAccountId: props.account.accountId };
  }

  async init(): Promise<void> {
    logger.info(`Connecting to Alpaca ${this.props.account.live ? 'live' : 'paper'} stream for account ${this.props.account.accountId}.`);
    const authorized = new Promise<void>((resolve, reject) => {
      this.pendingInit = { resolve, reject };
      this.authTimeout = setTimeout(() => {
        this.settleInit(new Error(`Alpaca did not authorize the stream for account ${this.props.account.accountId} within ${this.authTimeoutMs()}ms.`));
      }, this.authTimeoutMs());
    });

    this.connect();
    await authorized;
    this.startPinging();
  }

  async terminate(): Promise<void> {
    logger.info(`Closing the Alpaca stream for account ${this.props.account.accountId}.`, this.logMeta);
    // Set first: the close handler reconnects unless told not to, and terminating
    // would otherwise immediately reopen what it just closed.
    this.autoReconnect = false;
    this.clearTimers();
    this.ws?.close();
    this.ws = undefined;
    this.connected = false;
  }

  getStatus(): AlpacaWsClientStatus {
    return { connected: this.connected, authorization: this.authorization };
  }

  addOrderEventHandler(handler: OrderEventHandler): string {
    const id = crypto.randomUUID();
    this.handlers.push([id, handler]);
    return id;
  }

  removeOrderEventHandler(id: string): void {
    this.handlers = this.handlers.filter(([handlerId]) => handlerId !== id);
  }

  private connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.authorization = 'waiting';

    ws.on('open', () => {
      this.connected = true;
      logger.info(`Alpaca stream open for account ${this.props.account.accountId}; authenticating.`, this.logMeta);
      this.backoff.reset();
      void this.authenticate(ws);
    });

    ws.on('message', (data: WebSocket.RawData) => {
      this.handleMessage(data);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      this.connected = false;
      const text = reason.toString();
      logger.info(`Alpaca stream closed for account ${this.props.account.accountId}: code ${code} ${text}.`, this.logMeta);
      this.onDisconnected?.(code, text);
      void this.reconnect();
    });

    // Logged, not thrown: an error is always followed by a close, and reconnection is
    // handled there. Throwing here would take the process down for a blip.
    ws.on('error', (err) => {
      logger.warn(`Alpaca stream error for account ${this.props.account.accountId}: ${err.message}`, this.logMeta);
    });

    ws.on('pong', () => {
      logger.debug(`Alpaca stream pong for account ${this.props.account.accountId}.`, this.logMeta);
      this.clearPongTimeout();
    });
  }

  private async authenticate(ws: WebSocket): Promise<void> {
    try {
      const credentials = await resolveCredentials(this.props.credentialsProvider);
      ws.send(JSON.stringify({ action: 'authenticate', data: { key_id: credentials.accessKey, secret_key: credentials.secretKey } }));
    } catch (err) {
      logger.error(`Could not read Alpaca credentials for account ${this.props.account.accountId}.`, err);
      this.settleInit(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private async reconnect(): Promise<void> {
    if (!this.autoReconnect) {
      return;
    }
    const delay = this.backoff.nextDelayMs();
    logger.info(`Reconnecting to the Alpaca stream for account ${this.props.account.accountId} in ${delay}ms.`, this.logMeta);
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    if (this.autoReconnect) {
      this.connect();
    }
  }

  private handleMessage(data: WebSocket.RawData): void {
    let event: AlpacaWsEvent;
    try {
      const parsed: unknown = JSON.parse(data.toString());
      if (typeof parsed !== 'object' || parsed === null) {
        logger.warn('Alpaca sent a stream frame that is not an object.', this.logMeta);
        return;
      }
      event = { ...parsed };
    } catch {
      logger.warn('Alpaca sent a stream frame that is not JSON.', this.logMeta);
      return;
    }

    if (event.stream === 'authorization') {
      this.handleAuthorization(event.data);
      return;
    }
    if (event.stream === 'listening') {
      logger.info(`Alpaca stream is listening for account ${this.props.account.accountId}.`, this.logMeta);
      return;
    }
    if (event.stream === 'trade_updates') {
      this.handleTradeUpdate(event.data);
      return;
    }
    logger.warn(`Alpaca sent an unrecognised stream "${String(event.stream)}".`, this.logMeta);
  }

  private handleAuthorization(data: unknown): void {
    const status = typeof data === 'object' && data !== null && 'status' in data ? data.status : undefined;

    if (status === 'authorized') {
      this.authorization = 'passed';
      logger.info(`Alpaca stream authorized for account ${this.props.account.accountId}; subscribing to trade_updates.`, this.logMeta);
      this.ws?.send(JSON.stringify({ action: 'listen', data: { streams: ['trade_updates'] } }));
      this.settleInit();
      return;
    }

    this.authorization = 'failed';
    const message = `Alpaca refused the credentials for account ${this.props.account.accountId}. Check FLEECE_ALPACA_KEY and FLEECE_ALPACA_SECRET, and that they match the ${this.props.account.live ? 'live' : 'paper'} environment.`;
    logger.error(message, this.logMeta);
    // Bad credentials will not fix themselves, so stop reconnecting rather than
    // hammering Alpaca with a key it has already rejected.
    this.autoReconnect = false;
    this.settleInit(new Error(message));
  }

  private handleTradeUpdate(data: unknown): void {
    if (typeof data !== 'object' || data === null || !('order' in data)) {
      logger.warn('Alpaca sent a trade_updates frame with no order.', this.logMeta);
      return;
    }
    const order = data.order;
    if (typeof order !== 'object' || order === null || !('id' in order) || typeof order.id !== 'string') {
      logger.warn('Alpaca sent a trade_updates order with no id.', this.logMeta);
      return;
    }
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the boundary with Alpaca's schema; the converter validates every field it reads.
    const alpacaOrder = order as AlpacaOrder;
    for (const [, handler] of this.handlers) {
      handler(alpacaOrder);
    }
  }

  private startPinging(): void {
    const period = this.props.pingPeriodMs ?? 10_000;
    this.pingJob = setInterval(() => {
      if (this.authorization !== 'passed' || this.ws === undefined) {
        return;
      }
      this.ws.ping();
      // A TCP connection can be dead without either side noticing; a missing pong is
      // the only signal that the stream has gone quiet because it is broken rather
      // than because the market is.
      this.pongTimeout = setTimeout(() => {
        logger.warn(`No pong from Alpaca for account ${this.props.account.accountId}; treating the stream as dead.`, this.logMeta);
        this.onDisconnected?.(1006, 'ping detected abnormal closure');
        this.ws?.terminate();
      }, this.props.pongTimeoutMs ?? 5_000);
    }, period);
  }

  private authTimeoutMs(): number {
    return this.props.authTimeoutMs ?? 10_000;
  }

  /** Resolves or rejects `init`, exactly once, and clears its timer either way. */
  private settleInit(err?: Error): void {
    if (this.authTimeout !== undefined) {
      clearTimeout(this.authTimeout);
      this.authTimeout = undefined;
    }
    const pending = this.pendingInit;
    this.pendingInit = undefined;
    if (pending === undefined) {
      return;
    }
    if (err === undefined) {
      pending.resolve();
    } else {
      pending.reject(err);
    }
  }

  private clearPongTimeout(): void {
    if (this.pongTimeout !== undefined) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = undefined;
    }
  }

  private clearTimers(): void {
    this.clearPongTimeout();
    if (this.pingJob !== undefined) {
      clearInterval(this.pingJob);
      this.pingJob = undefined;
    }
    this.settleInit(new Error('The Alpaca stream was terminated before it authorized.'));
  }
}
