import { FleeceClient } from '@fleece/client';
import { BrokerOrderRecord } from '@fleece/models';
import { ConflictError, Decimal, InvalidRequestError, NotFoundError, UnauthenticatedError } from '@fleece/utilities';
import http from 'node:http';
import { AccountService, BrokerOrderService, DividendService, LedgerService } from '../../src/core';
import { bearerTokenAuth, corsMiddleware, errorHandler, HealthEndpoints, HttpApp, serviceVersion } from '../../src/http';
import { AccountEndpoints, BrokerOrderEndpoints, DividendEndpoints, LedgerEndpoints } from '../../src/api/routes';
import { FakeAccountDao } from '../core/services/fake-daos';
import { FakeLedgerDao, aPosition, aTransaction } from '../core/services/fake-ledger-dao';
import { FakeBrokerOrderDao, FakeDividendDao } from './fake-ledger-daos';

const d = (value: string): Decimal => Decimal.of(value);

interface Harness {
  readonly client: FleeceClient;
  readonly accounts: FakeAccountDao;
  readonly ledger: FakeLedgerDao;
  readonly dividends: FakeDividendDao;
  readonly brokerOrders: FakeBrokerOrderDao;
  readonly url: string;
  close(): Promise<void>;
}

interface ServeOptions {
  readonly authToken?: string;
  readonly corsOrigins?: ReadonlyArray<string>;
}

/**
 * The real Express app on a real port, driven by the real typed client, over fake
 * DAOs.
 *
 * Everything between a caller and the ledger is what is under test — routing, the JSON
 * body parser, the token check, query parsing, the error handler, and on the way back
 * the client's revivers turning decimal strings into `Decimal`s. Calling a route
 * function directly would exercise none of it, and asserting on a `res` double would
 * assert on the double.
 *
 * The DAOs are fakes and the services above them are real: the rules a caller depends
 * on live in the services, and swapping those for doubles would leave this testing the
 * doubles. Nothing here needs PostgreSQL, which is why it runs everywhere the coverage
 * gate does.
 */
async function serve(options: ServeOptions = {}): Promise<Harness> {
  const accounts = new FakeAccountDao();
  const ledger = new FakeLedgerDao();
  const dividends = new FakeDividendDao();
  const brokerOrders = new FakeBrokerOrderDao();

  const accountService = new AccountService(accounts);
  const ledgerService = new LedgerService(ledger, accounts);
  const dividendService = new DividendService(dividends, accounts);
  const brokerOrderService = new BrokerOrderService(brokerOrders, accounts);

  const middleware = [
    ...(options.corsOrigins === undefined ? [] : [corsMiddleware({ origins: options.corsOrigins })]),
    ...(options.authToken === undefined ? [] : [bearerTokenAuth(options.authToken)]),
  ];

  const app = new HttpApp({
    name: 'FleeceApiTest',
    // The same cap `ApiServer` passes: a test app assembled with a different one would
    // be exercising a server that does not exist.
    jsonBodyLimit: '1mb',
    middleware,
    endpoints: [
      new HealthEndpoints({ version: serviceVersion(), startedAt: Date.now() }),
      new AccountEndpoints({ accountService }),
      new LedgerEndpoints({ ledgerService }),
      new DividendEndpoints({ dividendService }),
      new BrokerOrderEndpoints({ brokerOrderService, ledgerService }),
    ],
    errorHandler,
  }).init();

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = address !== null && typeof address !== 'string' ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;

  return {
    client: new FleeceClient({ baseUrl: url, token: options.authToken }),
    accounts,
    ledger,
    dividends,
    brokerOrders,
    url,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('the HTTP API, end to end through the typed client', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  describe('health', () => {
    it('answers a ping', async () => {
      harness = await serve();
      await expect(harness.client.ping()).resolves.toEqual(expect.objectContaining({ status: 'ok' }));
    });
  });

  describe('accounts', () => {
    it('creates an account and reads it back', async () => {
      harness = await serve();

      const { account } = await harness.client.createAccount({ name: 'Momentum', accountType: 'paper' });
      expect(account.accountId).toMatch(/^[0-9A-Z]{10}$/);

      const read = await harness.client.getAccount({ accountId: account.accountId });
      expect(read.account).toEqual(account);
    });

    it('lists accounts, and filters by status', async () => {
      harness = await serve();
      const { account } = await harness.client.createAccount({ accountId: 'MOMENTUM01', name: 'Momentum', accountType: 'paper' });
      await harness.client.createAccount({ accountId: 'CARRY00001', name: 'Carry', accountType: 'paper' });
      await harness.client.deactivateAccount({ accountId: account.accountId });

      expect((await harness.client.listAccounts()).accounts).toHaveLength(2);
      expect((await harness.client.listAccounts({ status: 'inactive' })).accounts.map((a) => a.accountId)).toEqual(['MOMENTUM01']);
    });

    it('renames, deactivates and reactivates', async () => {
      // These four answer `{}` — the change is the point, not a copy of the row — so
      // what each one did is read back rather than taken from the response.
      harness = await serve();
      await harness.client.createAccount({ accountId: 'MOMENTUM01', name: 'Momentum', accountType: 'paper' });

      await harness.client.updateAccountName({ accountId: 'MOMENTUM01', name: 'Renamed' });
      expect((await harness.client.getAccount({ accountId: 'MOMENTUM01' })).account.name).toBe('Renamed');

      await harness.client.deactivateAccount({ accountId: 'MOMENTUM01' });
      expect((await harness.client.getAccount({ accountId: 'MOMENTUM01' })).account.status).toBe('inactive');

      await harness.client.activateAccount({ accountId: 'MOMENTUM01' });
      expect((await harness.client.getAccount({ accountId: 'MOMENTUM01' })).account.status).toBe('active');
    });

    it('deletes an account', async () => {
      harness = await serve();
      await harness.client.createAccount({ accountId: 'MOMENTUM01', name: 'Momentum', accountType: 'paper' });
      await harness.client.deleteAccount({ accountId: 'MOMENTUM01', force: true });
      await expect(harness.client.getAccount({ accountId: 'MOMENTUM01' })).rejects.toThrow(NotFoundError);
    });

    it('rebuilds the service error type on the caller side, not a generic failure', async () => {
      // `catch (err) { if (err instanceof NotFoundError) }` has to work the same for a
      // caller as it does inside the service, which is the whole point of the client
      // reconstructing the type from the error code rather than the status alone.
      harness = await serve();
      await expect(harness.client.getAccount({ accountId: 'NOSUCHACC1' })).rejects.toThrow(NotFoundError);
      await expect(harness.client.createAccount({ name: 'bad|name', accountType: 'paper' })).rejects.toThrow(InvalidRequestError);

      await harness.client.createAccount({ accountId: 'MOMENTUM01', name: 'Momentum', accountType: 'paper' });
      await expect(harness.client.createAccount({ accountId: 'MOMENTUM01', name: 'Again', accountType: 'paper' })).rejects.toThrow(ConflictError);
    });
  });

  describe('the ledger', () => {
    it('revives decimals as Decimals, not as the strings they crossed the wire as', async () => {
      // The response JSON does not have the shape its `Response` type claims — `size` is
      // `"17.666666667"` — so this is the assertion that the client is reviving rather
      // than casting.
      harness = await serve();
      harness.accounts.seed('MOMENTUM01');
      harness.ledger.positions = [aPosition({ size: d('17.666666667'), totalCost: d('1793.1666667') })];

      const { positions } = await harness.client.listPositions({ accountId: 'MOMENTUM01' });
      expect(positions[0].size).toBeInstanceOf(Decimal);
      expect(positions[0].size.toString()).toBe('17.666666667');
      expect(positions[0].totalCost.toString()).toBe('1793.1666667');
    });

    it('passes the query filters through to the ledger', async () => {
      harness = await serve();
      harness.accounts.seed('MOMENTUM01');

      await harness.client.listPositions({ accountId: 'MOMENTUM01', includeClosed: true, assetClass: 'option' });
      expect(harness.ledger.inputFor('listPositions')).toMatchObject({ accountId: 'MOMENTUM01', includeClosed: true, assetClass: 'option' });
    });

    it('reads one position, and 404s for a symbol never held', async () => {
      harness = await serve();
      harness.accounts.seed('MOMENTUM01');

      harness.ledger.position = aPosition();
      expect((await harness.client.getPosition({ accountId: 'MOMENTUM01', symbol: 'AAPL' })).position.symbol).toBe('AAPL');

      harness.ledger.position = null;
      await expect(harness.client.getPosition({ accountId: 'MOMENTUM01', symbol: 'TSLA' })).rejects.toThrow(NotFoundError);
    });

    it('pages the transaction log, requiring the window rather than defaulting it', async () => {
      harness = await serve();
      harness.accounts.seed('MOMENTUM01');

      await harness.client.listTransactions({ accountId: 'MOMENTUM01', from: 1, limit: 10, sort: 'desc' });
      expect(harness.ledger.inputFor('listTransactions')).toMatchObject({ from: 1, limit: 10, sort: 'desc' });

      // An unbounded listing is what the deprecated legacy endpoint did; the cap is the
      // reason `limit` is not optional.
      await expect(harness.client.listTransactions({ accountId: 'MOMENTUM01', from: 1, limit: 5000, sort: 'desc' })).rejects.toThrow(/limit must be between 1 and 1000/);
    });

    it('lists transactions for one broker order', async () => {
      harness = await serve();
      harness.accounts.seed('MOMENTUM01');
      await expect(harness.client.listTransactionsByReferenceId({ referenceId: 'order-1' })).resolves.toEqual({ transactions: [] });
    });

    it('reads realised profit, and explains its absence', async () => {
      harness = await serve();
      harness.accounts.seed('MOMENTUM01');

      harness.ledger.profit = { accountId: 'MOMENTUM01', symbol: 'AAPL', assetClass: 'equity', profit: d('-12.34'), createdAt: 1, lastUpdatedAt: 1 };
      expect((await harness.client.getProfit({ accountId: 'MOMENTUM01', symbol: 'AAPL' })).profit.profit.toString()).toBe('-12.34');

      harness.ledger.profit = null;
      await expect(harness.client.getProfit({ accountId: 'MOMENTUM01', symbol: 'TSLA' })).rejects.toThrow(/reduced/);
    });

    it('lists historical positions', async () => {
      harness = await serve();
      harness.accounts.seed('MOMENTUM01');
      await expect(harness.client.listHistoricalPositions({ accountId: 'MOMENTUM01', symbol: 'AAPL', from: 1, limit: 10, sort: 'asc' })).resolves.toEqual({ positions: [] });
    });

    it('takes a split ratio as a string, and refuses it as a JSON number', async () => {
      harness = await serve();
      harness.accounts.seed('MOMENTUM01');

      await harness.client.stockSplit({ accountId: 'MOMENTUM01', symbol: 'AAPL', ratio: d('1.5') });
      expect(harness.ledger.inputFor('applyStockSplit')).toMatchObject({ symbol: 'AAPL' });

      const raw = await fetch(`${harness.url}/position/split`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: 'MOMENTUM01', symbol: 'AAPL', ratio: 1.5 }),
      });
      expect(raw.status).toBe(400);
      expect(await raw.json()).toEqual({ error: expect.stringContaining('must be sent as a string'), errorCode: 'INVALID_REQUEST' });
    });

    it('transfers a position between two accounts', async () => {
      harness = await serve();
      harness.accounts.seed('MOMENTUM01');
      harness.accounts.seed('CARRY00001');

      await harness.client.transferPosition({
        originAccountId: 'MOMENTUM01',
        destinationAccountId: 'CARRY00001',
        symbol: 'AAPL',
        assetClass: 'equity',
        size: d('10'),
        unitCost: d('100'),
      });
      expect(harness.ledger.inputFor('transferPosition')).toMatchObject({ symbol: 'AAPL' });
    });

    it('refuses a transfer between a paper account and a live one', async () => {
      harness = await serve();
      harness.accounts.seed('MOMENTUM01');
      harness.accounts.seed('LIVEACCT01', { accountType: 'live' });

      await expect(
        harness.client.transferPosition({
          originAccountId: 'MOMENTUM01',
          destinationAccountId: 'LIVEACCT01',
          symbol: 'AAPL',
          assetClass: 'equity',
          size: d('10'),
          unitCost: d('100'),
        }),
      ).rejects.toThrow(/same account type/);
    });
  });

  describe('dividends', () => {
    it('lists what an account is owed', async () => {
      harness = await serve();
      harness.accounts.seed('MOMENTUM01');
      harness.dividends.seed();

      const { dividends } = await harness.client.listDividends({ accountId: 'MOMENTUM01' });
      expect(dividends).toHaveLength(1);
      expect(dividends[0].amountPerShare.toString()).toBe('0.24');
    });

    it('filters by symbol', async () => {
      harness = await serve();
      harness.accounts.seed('MOMENTUM01');
      harness.dividends.seed({ symbol: 'AAPL' });
      harness.dividends.seed({ symbol: 'MSFT' });

      expect((await harness.client.listDividends({ accountId: 'MOMENTUM01', symbol: 'MSFT' })).dividends).toHaveLength(1);
    });
  });

  describe('broker orders', () => {
    it('reads one order back, with its decimals revived', async () => {
      harness = await serve();
      harness.brokerOrders.seed({ brokerOrderId: 'order-1', qty: d('10'), filledAvgPrice: d('100.25') });

      const { brokerOrder } = await harness.client.getBrokerOrder({ brokerOrderId: 'order-1' });
      expect(brokerOrder.filledAvgPrice?.toString()).toBe('100.25');
      expect(brokerOrder.qty).toBeInstanceOf(Decimal);
    });

    it('404s for an order it does not have', async () => {
      harness = await serve();
      await expect(harness.client.getBrokerOrder({ brokerOrderId: 'nope' })).rejects.toThrow(NotFoundError);
    });

    it('lists orders and their legs', async () => {
      harness = await serve();
      harness.accounts.seed('MOMENTUM01');
      harness.brokerOrders.seed({ brokerOrderId: 'parent-1', symbol: undefined, orderClass: 'mleg' });
      harness.brokerOrders.seed({ brokerOrderId: 'leg-1', parentBrokerOrderId: 'parent-1' });

      expect((await harness.client.listBrokerOrders({ accountId: 'MOMENTUM01', from: 1, limit: 10, sort: 'desc' })).brokerOrders).toHaveLength(2);
      expect((await harness.client.listBrokerOrderLegs({ parentBrokerOrderId: 'parent-1' })).brokerOrders.map((o) => o.brokerOrderId)).toEqual(['leg-1']);
    });

    it('reads the broker payloads kept verbatim against an order', async () => {
      harness = await serve();
      harness.brokerOrders.seed({ brokerOrderId: 'order-1' });
      // `BrokerOrderRecord` declares only `id`; the rest is whatever the broker sent and
      // has to survive the round trip untouched, which is what makes a replay possible.
      const record: BrokerOrderRecord = Object.assign({ id: 'evt-1' }, { event: 'fill', qty: '10' });
      await harness.brokerOrders.insertRecord({ brokerOrderId: 'order-1', record });

      const { records } = await harness.client.listBrokerOrderRecords({ brokerOrderId: 'order-1' });
      expect(records).toEqual([{ id: 'evt-1', event: 'fill', qty: '10' }]);
    });

    it('reports fill progress and whether it reconciles', async () => {
      harness = await serve();
      harness.ledger.transaction = aTransaction();

      const { reconciled } = await harness.client.getOrderFillProgress({ referenceId: 'order-1' });
      expect(reconciled).toBe(true);
    });

    it('deletes an order', async () => {
      harness = await serve();
      harness.brokerOrders.seed({ brokerOrderId: 'order-1' });
      await harness.client.deleteBrokerOrder({ brokerOrderId: 'order-1' });
      await expect(harness.client.getBrokerOrder({ brokerOrderId: 'order-1' })).rejects.toThrow(NotFoundError);
    });
  });

  describe('authentication', () => {
    it('refuses a request with no token when one is configured', async () => {
      harness = await serve({ authToken: 'secret' });
      const unauthenticated = new FleeceClient({ baseUrl: harness.url });
      await expect(unauthenticated.listAccounts()).rejects.toThrow(UnauthenticatedError);
    });

    it('accepts the configured token', async () => {
      harness = await serve({ authToken: 'secret' });
      await expect(harness.client.listAccounts()).resolves.toEqual({ accounts: [] });
    });

    it('refuses the wrong token', async () => {
      harness = await serve({ authToken: 'secret' });
      const wrong = new FleeceClient({ baseUrl: harness.url, token: 'guess' });
      await expect(wrong.listAccounts()).rejects.toThrow(UnauthenticatedError);
    });
  });

  describe('CORS', () => {
    it('answers a preflight from an allowed origin without reaching a route', async () => {
      harness = await serve({ corsOrigins: ['http://localhost:5173'], authToken: 'secret' });

      // No Authorization header, which is what a browser sends: CORS runs before auth,
      // so this must be a 204 rather than the 401 that would surface as an unexplained
      // CORS error.
      const response = await fetch(`${harness.url}/accounts`, { method: 'OPTIONS', headers: { origin: 'http://localhost:5173' } });
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    });

    it('leaves the allow header off for an origin not on the list', async () => {
      harness = await serve({ corsOrigins: ['http://localhost:5173'] });
      const response = await fetch(`${harness.url}/accounts`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  describe('failures', () => {
    it('reports an unknown route as a 404 rather than hanging', async () => {
      harness = await serve();
      const response = await fetch(`${harness.url}/no-such-route`);
      expect(response.status).toBe(404);
    });

    it('turns a service fault into a 500 that says nothing about the internals', async () => {
      harness = await serve();
      harness.accounts.seed('MOMENTUM01');
      jest.spyOn(harness.ledger, 'listPositions').mockRejectedValueOnce(new Error('the connection pool is on fire'));

      const response = await fetch(`${harness.url}/positions?accountId=MOMENTUM01`);
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('on fire');
    });

    it('says a service is unreachable rather than blaming it for a fault', async () => {
      // Nothing was served, so `InternalServiceError` would be the wrong story: a caller
      // wants to say "start the service", not "the service has a bug".
      const client = new FleeceClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 });
      await expect(client.listAccounts()).rejects.toThrow(/could not reach/);
    });
  });
});
