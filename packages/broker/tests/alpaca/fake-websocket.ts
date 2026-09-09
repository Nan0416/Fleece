import { EventEmitter } from 'node:events';

/**
 * A stand-in for the one `ws` socket the client opens, driven from the test.
 *
 * `WsAlpacaWsClient` is almost entirely event handling — authorise, subscribe,
 * reconnect, ping, give up — and none of it is reachable without a socket to raise
 * those events. Every instance is recorded, because the behaviour worth asserting on
 * is what happens across a reconnect: which socket a timer fires against, and whether
 * the replacement survives.
 */
export class FakeWebSocket extends EventEmitter {
  static instances: FakeWebSocket[] = [];

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  static get latest(): FakeWebSocket {
    const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (socket === undefined) {
      throw new Error('No socket has been opened.');
    }
    return socket;
  }

  readonly sent: string[] = [];
  pings = 0;
  terminated = 0;
  closed = 0;

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  ping(): void {
    this.pings += 1;
  }

  terminate(): void {
    this.terminated += 1;
  }

  close(): void {
    this.closed += 1;
  }

  /** Everything the client sent, parsed, so a test asserts on the action rather than the JSON. */
  actions(): Array<Record<string, unknown>> {
    return this.sent.map((payload) => JSON.parse(payload));
  }

  open(): void {
    this.emit('open');
  }

  deliver(frame: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)));
  }

  deliverRaw(text: string): void {
    this.emit('message', Buffer.from(text));
  }

  authorize(status = 'authorized'): void {
    this.deliver({ stream: 'authorization', data: { status } });
  }

  disconnect(code = 1006, reason = 'gone'): void {
    this.emit('close', code, Buffer.from(reason));
  }
}
