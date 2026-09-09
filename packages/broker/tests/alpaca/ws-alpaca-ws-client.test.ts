import { FakeWebSocket } from './fake-websocket';

jest.mock('ws', () => {
  const { FakeWebSocket: Fake } = jest.requireActual<{ FakeWebSocket: typeof FakeWebSocket }>('./fake-websocket');
  return { __esModule: true, default: Fake };
});

import { AlpacaOrder } from '../../src/alpaca/models';
import { WsAlpacaWsClient } from '../../src/alpaca/ws-alpaca-ws-client';
import { alpacaOrder } from './alpaca-orders';

const account = { accountId: 'PAPER001', live: false };
const credentials = { accessKey: 'key', secretKey: 'secret' };

/**
 * Opens a client and drives it as far as authorized, which is where `init` resolves.
 * Everything else in the class is only reachable past that point.
 */
async function connected(props: Partial<ConstructorParameters<typeof WsAlpacaWsClient>[0]> = {}): Promise<WsAlpacaWsClient> {
  const client = new WsAlpacaWsClient({ account, credentialsProvider: credentials, url: 'wss://test', ...props });
  const ready = client.init();
  FakeWebSocket.latest.open();
  // The credentials provider is awaited before the frame goes out, and it may be a
  // function rather than a literal — so flush the microtask queue, not one tick of it.
  await jest.advanceTimersByTimeAsync(0);
  FakeWebSocket.latest.authorize();
  await ready;
  return client;
}

describe('WsAlpacaWsClient', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    FakeWebSocket.reset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('connecting', () => {
    it('authenticates on open and subscribes once authorized', async () => {
      const client = await connected();
      expect(FakeWebSocket.latest.actions()).toEqual([
        { action: 'authenticate', data: { key_id: 'key', secret_key: 'secret' } },
        { action: 'listen', data: { streams: ['trade_updates'] } },
      ]);
      expect(client.getStatus()).toEqual({ connected: true, authorization: 'passed' });
      await client.terminate();
    });

    it('reads credentials on every connect, so a rotated key is used on the next one', async () => {
      let reads = 0;
      const client = await connected({
        credentialsProvider: async () => {
          reads += 1;
          return { accessKey: `key-${reads}`, secretKey: 'secret' };
        },
      });
      expect(reads).toBe(1);

      FakeWebSocket.latest.disconnect();
      await jest.advanceTimersByTimeAsync(500);
      FakeWebSocket.latest.open();
      await jest.advanceTimersByTimeAsync(0);

      expect(reads).toBe(2);
      expect(FakeWebSocket.latest.actions()[0]).toMatchObject({ data: { key_id: 'key-2' } });
      await client.terminate();
    });

    it('rejects init and stops reconnecting when Alpaca refuses the credentials', async () => {
      // A rejected key will not fix itself; retrying only hammers Alpaca with it.
      const client = new WsAlpacaWsClient({ account, credentialsProvider: credentials, url: 'wss://test' });
      const ready = client.init();
      const rejection = expect(ready).rejects.toThrow(/refused the credentials/);
      FakeWebSocket.latest.open();
      await jest.advanceTimersByTimeAsync(0);
      FakeWebSocket.latest.authorize('unauthorized');

      await rejection;
      expect(client.getStatus().authorization).toBe('failed');

      const opened = FakeWebSocket.instances.length;
      FakeWebSocket.latest.disconnect();
      await jest.advanceTimersByTimeAsync(10_000);
      expect(FakeWebSocket.instances).toHaveLength(opened);
    });

    it('rejects init when authorization never arrives', async () => {
      const client = new WsAlpacaWsClient({ account, credentialsProvider: credentials, url: 'wss://test', authTimeoutMs: 50 });
      const ready = client.init();
      const rejection = expect(ready).rejects.toThrow(/did not authorize/);
      FakeWebSocket.latest.open();
      await jest.advanceTimersByTimeAsync(60);
      await rejection;
    });

    it('rejects init when the credentials cannot be read at all', async () => {
      const client = new WsAlpacaWsClient({
        account,
        credentialsProvider: async () => {
          throw new Error('the secret store is down');
        },
        url: 'wss://test',
      });
      const ready = client.init();
      const rejection = expect(ready).rejects.toThrow(/secret store is down/);
      FakeWebSocket.latest.open();
      await rejection;
    });
  });

  describe('order events', () => {
    it('hands a trade update to every registered handler', async () => {
      const client = await connected();
      const seen: AlpacaOrder[] = [];
      client.addOrderEventHandler((order) => seen.push(order));
      client.addOrderEventHandler((order) => seen.push(order));

      FakeWebSocket.latest.deliver({ stream: 'trade_updates', data: { event: 'fill', order: alpacaOrder({ id: 'order-1' }) } });

      expect(seen.map((order) => order.id)).toEqual(['order-1', 'order-1']);
      await client.terminate();
    });

    it('stops delivering to a handler that has been removed', async () => {
      const client = await connected();
      const seen: AlpacaOrder[] = [];
      const id = client.addOrderEventHandler((order) => seen.push(order));
      client.removeOrderEventHandler(id);

      FakeWebSocket.latest.deliver({ stream: 'trade_updates', data: { event: 'fill', order: alpacaOrder({ id: 'order-1' }) } });

      expect(seen).toHaveLength(0);
      await client.terminate();
    });

    it.each([
      ['a frame that is not JSON', (socket: FakeWebSocket) => socket.deliverRaw('{oops')],
      ['a frame that is not an object', (socket: FakeWebSocket) => socket.deliverRaw('42')],
      ['an unrecognised stream', (socket: FakeWebSocket) => socket.deliver({ stream: 'quotes', data: {} })],
      ['a trade update with no order', (socket: FakeWebSocket) => socket.deliver({ stream: 'trade_updates', data: {} })],
      ['a trade update whose order has no id', (socket: FakeWebSocket) => socket.deliver({ stream: 'trade_updates', data: { order: {} } })],
      ['a listening acknowledgement', (socket: FakeWebSocket) => socket.deliver({ stream: 'listening', data: { streams: ['trade_updates'] } })],
    ])('survives %s without taking the process down', async (_label, send) => {
      const client = await connected();
      const seen: AlpacaOrder[] = [];
      client.addOrderEventHandler((order) => seen.push(order));

      expect(() => send(FakeWebSocket.latest)).not.toThrow();
      expect(seen).toHaveLength(0);
      await client.terminate();
    });

    it('logs a socket error rather than throwing, because a close follows it', async () => {
      const client = await connected();
      expect(() => FakeWebSocket.latest.emit('error', new Error('blip'))).not.toThrow();
      await client.terminate();
    });
  });

  describe('reconnecting', () => {
    it('opens a new socket after a close, and reports the disconnection', async () => {
      const disconnections: Array<[number, string]> = [];
      const client = await connected({ onDisconnected: (code, reason) => disconnections.push([code, reason]) });

      FakeWebSocket.latest.disconnect(1006, 'gone');
      expect(disconnections).toEqual([[1006, 'gone']]);
      expect(client.getStatus().connected).toBe(false);

      await jest.advanceTimersByTimeAsync(500);
      expect(FakeWebSocket.instances).toHaveLength(2);
      await client.terminate();
    });

    it('does not reopen a socket it was told to terminate', async () => {
      const client = await connected();
      await client.terminate();

      FakeWebSocket.latest.disconnect();
      await jest.advanceTimersByTimeAsync(10_000);

      expect(FakeWebSocket.instances).toHaveLength(1);
      // A closed socket is not an authorized one, and reporting otherwise is what let
      // the ping job go on pinging it through the whole reconnect delay.
      expect(client.getStatus()).toEqual({ connected: false, authorization: 'waiting' });
    });
  });

  describe('the ping keepalive', () => {
    it('pings on the period, and treats a missing pong as a dead stream', async () => {
      // A TCP connection can be dead without either side noticing, and an idle market
      // looks exactly the same as a broken one until a pong goes missing.
      const disconnections: number[] = [];
      const client = await connected({ pingPeriodMs: 100, pongTimeoutMs: 50, onDisconnected: (code) => disconnections.push(code) });

      await jest.advanceTimersByTimeAsync(100);
      expect(FakeWebSocket.latest.pings).toBe(1);

      await jest.advanceTimersByTimeAsync(50);
      expect(disconnections).toEqual([1006]);
      expect(FakeWebSocket.latest.terminated).toBe(1);

      await client.terminate();
    });

    it('still declares the stream dead when the deadline spans several ping periods', async () => {
      // Re-arming the deadline on every ping — or clearing and re-arming it — pushes it
      // past the next tick forever, so a stream that had gone completely silent would
      // never be declared dead. The first unanswered ping starts the clock; only a pong
      // stops it.
      const client = await connected({ pingPeriodMs: 100, pongTimeoutMs: 250 });

      await jest.advanceTimersByTimeAsync(100);
      expect(FakeWebSocket.latest.pings).toBe(1);

      // Two further pings go out inside the deadline, and it still expires on time.
      await jest.advanceTimersByTimeAsync(250);
      expect(FakeWebSocket.latest.pings).toBeGreaterThan(1);
      expect(FakeWebSocket.latest.terminated).toBe(1);

      await client.terminate();
    });

    it('keeps one deadline in flight, not one per ping', async () => {
      // Overwriting `pongTimeout` on every tick abandons the handle without cancelling
      // the timer, so a silent stream accumulates one live timer per ping — each of
      // which later fires and terminates a socket. Two are expected here: the ping
      // interval, and the single deadline it armed.
      const client = await connected({ pingPeriodMs: 10, pongTimeoutMs: 10_000 });

      await jest.advanceTimersByTimeAsync(500);
      expect(FakeWebSocket.latest.pings).toBeGreaterThan(10);
      expect(jest.getTimerCount()).toBe(2);

      await client.terminate();
    });

    it('starts a fresh deadline once a pong has answered the last one', async () => {
      const client = await connected({ pingPeriodMs: 100, pongTimeoutMs: 250 });

      await jest.advanceTimersByTimeAsync(100);
      FakeWebSocket.latest.emit('pong');
      // The answered deadline is gone, so the next ping arms a new one that expires on
      // its own schedule rather than inheriting the old one's.
      await jest.advanceTimersByTimeAsync(100);
      expect(FakeWebSocket.latest.terminated).toBe(0);
      await jest.advanceTimersByTimeAsync(250);
      expect(FakeWebSocket.latest.terminated).toBe(1);

      await client.terminate();
    });

    it('leaves the socket alone when the pong arrives in time', async () => {
      const client = await connected({ pingPeriodMs: 100, pongTimeoutMs: 50 });

      await jest.advanceTimersByTimeAsync(100);
      FakeWebSocket.latest.emit('pong');
      await jest.advanceTimersByTimeAsync(60);

      expect(FakeWebSocket.latest.terminated).toBe(0);
      await client.terminate();
    });

    it('does not kill the replacement socket with the pong the old one was owed', async () => {
      // The deadline outlived the socket it belonged to. After a reconnect it fired
      // against whatever `this.ws` pointed at by then — the healthy replacement — and
      // reported a disconnection that had not happened before terminating a connection
      // that was fine, which then reconnected, and so on.
      const disconnections: number[] = [];
      const client = await connected({ pingPeriodMs: 100, pongTimeoutMs: 5_000, onDisconnected: (code) => disconnections.push(code) });

      // A ping goes out, and its deadline is a long way off.
      await jest.advanceTimersByTimeAsync(100);
      expect(FakeWebSocket.latest.pings).toBe(1);

      // The socket drops for its own reasons and the client reconnects.
      FakeWebSocket.latest.disconnect(1006, 'network blip');
      await jest.advanceTimersByTimeAsync(500);
      expect(FakeWebSocket.instances).toHaveLength(2);
      const replacement = FakeWebSocket.latest;
      replacement.open();
      await jest.advanceTimersByTimeAsync(0);
      replacement.authorize();

      // Well past the old deadline. The replacement must still be up.
      await jest.advanceTimersByTimeAsync(5_000);
      expect(replacement.terminated).toBe(0);
      expect(disconnections).toEqual([1006]);

      await client.terminate();
    });

    it('stops pinging once terminated, so the process can exit', async () => {
      const client = await connected({ pingPeriodMs: 100, pongTimeoutMs: 50 });
      await client.terminate();

      await jest.advanceTimersByTimeAsync(1_000);
      expect(FakeWebSocket.latest.pings).toBe(0);
    });
  });
});
