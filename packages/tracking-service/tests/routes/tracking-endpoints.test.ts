import { TrackingClient } from '@fleece/client';
import { TrackBrokerOrdersRequest, UnauthenticatedError } from '@fleece/shared';
import http from 'node:http';
import { DependencyFactory } from '../../src/dependencies/dependency-factory';
import { BrokerOrderClaims } from '../../src/routes';
import { TrackingService } from '../../src/service';
import { TrackingConfig } from '../../src/tracking-config';

/**
 * Stores the claims it is given, rather than recording that it was called: what a caller
 * depends on is that the claim arrives intact, and asserting on call arguments would
 * restate the route and pass just as happily if the parsing were wrong.
 */
class RecordingClaims implements BrokerOrderClaims {
  readonly claims: TrackBrokerOrdersRequest[] = [];

  track(request: TrackBrokerOrdersRequest): void {
    this.claims.push(request);
  }
}

function config(overrides: Partial<TrackingConfig> = {}): TrackingConfig {
  return {
    databaseUrl: 'postgres://localhost:5432/unused',
    port: 0,
    host: '127.0.0.1',
    brokerAccounts: [],
    defaultLiveAccountId: '0000000002',
    defaultPaperAccountId: '0000000001',
    unresolvedTimeoutMs: 60_000,
    ...overrides,
  };
}

interface Harness {
  readonly url: string;
  readonly claims: RecordingClaims;
  close(): Promise<void>;
}

/**
 * A real listener on a real port.
 *
 * The whole stack is what is under test — routing, the JSON body parser, the token
 * check, the parser and the error handler all sit between a caller and the facade, and
 * calling the route function directly would exercise none of them.
 */
async function serve(overrides: Partial<TrackingConfig> = {}): Promise<Harness> {
  const claims = new RecordingClaims();
  const dependencies = new DependencyFactory({ config: config(overrides), orderTracking: claims, startedAt: Date.now() }).build();
  const app = new TrackingService(dependencies).init();
  const server = http.createServer(app);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = address !== null && typeof address !== 'string' ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    claims,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function put(url: string, body: unknown, token?: string): Promise<Response> {
  return await fetch(`${url}/track`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });
}

describe('PUT /track', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('accepts a claim and hands it to the facade intact', async () => {
    harness = await serve();

    const response = await put(harness.url, { brokerOrderIds: ['order-1', 'order-2'], accountId: 'MOMENTUM01' });

    // 202, not 200: the claim is queued behind whatever the broker's feeds are already
    // applying, so nothing has been booked by the time this returns.
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({});
    expect(harness.claims.claims).toEqual([{ brokerOrderIds: ['order-1', 'order-2'], accountId: 'MOMENTUM01' }]);
  });

  it('accepts the same claim twice, because a claim is an assertion', async () => {
    harness = await serve();
    const body = { brokerOrderIds: ['order-1'], accountId: 'MOMENTUM01' };

    await put(harness.url, body);
    const second = await put(harness.url, body);

    expect(second.status).toBe(202);
    expect(harness.claims.claims).toHaveLength(2);
  });

  it('rejects a malformed claim with the field that was wrong, and passes nothing on', async () => {
    harness = await serve();

    const response = await put(harness.url, { brokerOrderIds: [], accountId: 'MOMENTUM01' });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.stringContaining('brokerOrderIds is empty'), errorCode: 'INVALID_REQUEST' });
    expect(harness.claims.claims).toHaveLength(0);
  });

  it('refuses a claim with no token when one is configured', async () => {
    // A claim decides which account an order's fills are booked to, and an order's
    // account is written once.
    harness = await serve({ authToken: 'secret' });

    const response = await put(harness.url, { brokerOrderIds: ['order-1'], accountId: 'MOMENTUM01' });

    expect(response.status).toBe(401);
    expect(harness.claims.claims).toHaveLength(0);
  });

  it('accepts a claim carrying the configured token', async () => {
    harness = await serve({ authToken: 'secret' });

    const response = await put(harness.url, { brokerOrderIds: ['order-1'], accountId: 'MOMENTUM01' }, 'secret');

    expect(response.status).toBe(202);
    expect(harness.claims.claims).toHaveLength(1);
  });

  it('is reachable by the typed client, verb and path included', async () => {
    // The one thing neither side can check alone. `TrackingClient` says `PUT /track` and
    // so does the route; nothing but a round trip notices when one of them stops.
    harness = await serve({ authToken: 'secret' });
    const client = new TrackingClient({ baseUrl: harness.url, token: 'secret' });

    await client.trackBrokerOrders({ brokerOrderIds: ['order-1'], accountId: 'MOMENTUM01' });

    expect(harness.claims.claims).toEqual([{ brokerOrderIds: ['order-1'], accountId: 'MOMENTUM01' }]);
  });

  it('rebuilds the error on the client side, as a typed error', async () => {
    harness = await serve({ authToken: 'secret' });
    const client = new TrackingClient({ baseUrl: harness.url });

    await expect(client.trackBrokerOrders({ brokerOrderIds: ['order-1'], accountId: 'MOMENTUM01' })).rejects.toThrow(UnauthenticatedError);
  });

  it('answers /ping without a token, so a probe can tell up from refusing', async () => {
    harness = await serve({ authToken: 'secret' });

    const response = await fetch(`${harness.url}/ping`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok' });
  });
});
