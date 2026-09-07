import { InternalServiceError, ServiceUnreachableError } from '../../src/errors';
import { FetchHttpClient } from '../../src/http/fetch-http-client';

import { startTestServer, type TestServer } from './test-server';

const JSON_REPLY = { 'content-type': 'application/json' };

describe('FetchHttpClient', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });

  afterEach(async () => {
    await server.close();
  });

  describe('sending', () => {
    it('returns the status, headers and parsed body of a JSON response', async () => {
      server.reply({ status: 200, headers: { ...JSON_REPLY, 'x-request-id': 'abc' }, body: '{"symbol":"AAPL"}' });
      const response = await new FetchHttpClient({ baseUrl: server.baseUrl }).send({ method: 'GET', url: '/v1/quote' });

      expect(response.status).toBe(200);
      expect(response.body).toStrictEqual({ symbol: 'AAPL' });
      expect(response.headers['x-request-id']).toBe('abc');
    });

    it('joins the base URL to the path, with or without a trailing slash', async () => {
      const withSlash = new FetchHttpClient({ baseUrl: `${server.baseUrl}/` });
      await withSlash.send({ method: 'GET', url: '/v1/quote' });
      await new FetchHttpClient({ baseUrl: server.baseUrl }).send({ method: 'GET', url: '/v1/quote' });

      expect(server.requests().map((request) => request.url)).toStrictEqual(['/v1/quote', '/v1/quote']);
    });

    it('lets one request override the client base URL', async () => {
      const other = await startTestServer();
      try {
        await new FetchHttpClient({ baseUrl: 'http://127.0.0.1:1' }).send({ method: 'GET', url: '/v1/quote', baseUrl: other.baseUrl });
        expect(other.requests()).toHaveLength(1);
      } finally {
        await other.close();
      }
    });

    it('works with no base URL at all, given an absolute request URL', async () => {
      const response = await new FetchHttpClient().send({ method: 'GET', url: `${server.baseUrl}/v1/quote` });
      expect(response.status).toBe(200);
    });

    it('passes headers through', async () => {
      await new FetchHttpClient({ baseUrl: server.baseUrl }).send({
        method: 'GET',
        url: '/v1/quote',
        headers: { 'apca-api-key-id': 'key', accept: 'application/json' },
      });

      expect(server.requests()[0].headers['apca-api-key-id']).toBe('key');
      expect(server.requests()[0].headers['accept']).toBe('application/json');
    });
  });

  describe('query strings', () => {
    it('appends the query and encodes its values', async () => {
      await new FetchHttpClient({ baseUrl: server.baseUrl }).send({
        method: 'GET',
        url: '/v3/reference/dividends',
        query: { ticker: 'BRK B', limit: 50, adjusted: true },
      });

      expect(server.requests()[0].url).toBe('/v3/reference/dividends?ticker=BRK+B&limit=50&adjusted=true');
    });

    it('drops an undefined parameter rather than sending the word undefined', async () => {
      await new FetchHttpClient({ baseUrl: server.baseUrl }).send({ method: 'GET', url: '/v1/quote', query: { a: '1', b: undefined } });
      expect(server.requests()[0].url).toBe('/v1/quote?a=1');
    });

    it('sends no question mark when the query is empty or absent', async () => {
      const client = new FetchHttpClient({ baseUrl: server.baseUrl });
      await client.send({ method: 'GET', url: '/v1/quote' });
      await client.send({ method: 'GET', url: '/v1/quote', query: {} });

      expect(server.requests().map((request) => request.url)).toStrictEqual(['/v1/quote', '/v1/quote']);
    });

    it('adds to a query the URL already carries instead of starting a second one', async () => {
      await new FetchHttpClient({ baseUrl: server.baseUrl }).send({ method: 'GET', url: '/v1/quote?cursor=abc', query: { limit: 10 } });
      expect(server.requests()[0].url).toBe('/v1/quote?cursor=abc&limit=10');
    });
  });

  describe('request bodies', () => {
    it.each(['POST', 'PUT', 'PATCH'] as const)('serialises a %s body as JSON and says so', async (method) => {
      await new FetchHttpClient({ baseUrl: server.baseUrl }).send({ method, url: '/v2/orders', body: { symbol: 'AAPL', qty: '1' } });

      const request = server.requests()[0];
      expect(request.method).toBe(method);
      expect(request.body).toBe('{"symbol":"AAPL","qty":"1"}');
      expect(request.headers['content-type']).toBe('application/json');
    });

    it('sends no content-type when there is no body', async () => {
      await new FetchHttpClient({ baseUrl: server.baseUrl }).send({ method: 'POST', url: '/v2/orders' });

      expect(server.requests()[0].body).toBe('');
      expect(server.requests()[0].headers['content-type']).toBeUndefined();
    });

    it('lets a caller override the content type it declares', async () => {
      await new FetchHttpClient({ baseUrl: server.baseUrl }).send({
        method: 'POST',
        url: '/v2/orders',
        headers: { 'content-type': 'application/vnd.api+json' },
        body: { symbol: 'AAPL' },
      });

      expect(server.requests()[0].headers['content-type']).toBe('application/vnd.api+json');
    });

    it('sends no body on GET or DELETE', async () => {
      const client = new FetchHttpClient({ baseUrl: server.baseUrl });
      await client.send({ method: 'GET', url: '/v2/orders' });
      await client.send({ method: 'DELETE', url: '/v2/orders/1' });

      expect(server.requests().map((request) => request.body)).toStrictEqual(['', '']);
      expect(server.requests()[1].method).toBe('DELETE');
    });
  });

  describe('response bodies', () => {
    it('hands back the raw text when the response is not JSON', async () => {
      server.reply({ status: 200, headers: { 'content-type': 'text/html' }, body: '<html>hello</html>' });
      const response = await new FetchHttpClient({ baseUrl: server.baseUrl }).send({ method: 'GET', url: '/' });

      expect(response.body).toBe('<html>hello</html>');
    });

    it('reports an empty body as undefined, not as an empty string', async () => {
      server.reply({ status: 204, headers: {}, body: '' });
      const response = await new FetchHttpClient({ baseUrl: server.baseUrl }).send({ method: 'DELETE', url: '/v2/orders/1' });

      expect(response.status).toBe(204);
      expect(response.body).toBeUndefined();
    });

    it('refuses a response that announces JSON and is not', async () => {
      server.reply({ status: 200, headers: JSON_REPLY, body: '<html>502 Bad Gateway</html>' });
      const send = new FetchHttpClient({ baseUrl: server.baseUrl }).send({ method: 'GET', url: '/v1/quote' });

      await expect(send).rejects.toThrow(InternalServiceError);
    });
  });

  describe('statuses the server chose', () => {
    it.each([400, 401, 404, 429, 500, 503])('returns %d with its body rather than throwing', async (status) => {
      server.reply({ status, headers: JSON_REPLY, body: '{"message":"nope"}' });
      const response = await new FetchHttpClient({ baseUrl: server.baseUrl }).send({ method: 'GET', url: '/v1/quote' });

      expect(response.status).toBe(status);
      expect(response.body).toStrictEqual({ message: 'nope' });
    });

    it('returns an error body that is plain text too', async () => {
      server.reply({ status: 403, headers: { 'content-type': 'text/plain' }, body: 'Missing Authentication Token' });
      const response = await new FetchHttpClient({ baseUrl: server.baseUrl }).send({ method: 'GET', url: '/v1/quote' });

      expect(response.status).toBe(403);
      expect(response.body).toBe('Missing Authentication Token');
    });
  });

  describe('failures to get an answer', () => {
    it('times out at the deadline the client was built with', async () => {
      server.reply({ status: 200, headers: JSON_REPLY, body: '{}', delayMs: 2_000 });
      const send = new FetchHttpClient({ baseUrl: server.baseUrl, timeoutMs: 60 }).send({ method: 'GET', url: '/v1/quote' });

      await expect(send).rejects.toThrow(ServiceUnreachableError);
      await expect(send).rejects.toThrow(/timed out after 60ms/);
    });

    it('lets one request set its own deadline', async () => {
      server.reply({ status: 200, headers: JSON_REPLY, body: '{}', delayMs: 2_000 });
      const send = new FetchHttpClient({ baseUrl: server.baseUrl, timeoutMs: 30_000 }).send({ method: 'GET', url: '/v1/quote', timeoutMs: 60 });

      await expect(send).rejects.toThrow(/timed out after 60ms/);
    });

    it('waits indefinitely when no deadline is set', async () => {
      server.reply({ status: 200, headers: JSON_REPLY, body: '{"waited":true}', delayMs: 150 });
      const response = await new FetchHttpClient({ baseUrl: server.baseUrl }).send({ method: 'GET', url: '/v1/quote' });

      expect(response.body).toStrictEqual({ waited: true });
    });

    it("leaves the deadline to a caller's own signal", async () => {
      server.reply({ status: 200, headers: JSON_REPLY, body: '{}', delayMs: 2_000 });
      const controller = new AbortController();
      const send = new FetchHttpClient({ baseUrl: server.baseUrl, timeoutMs: 60 }).send({ method: 'GET', url: '/v1/quote', signal: controller.signal });
      setTimeout(() => controller.abort(), 100);

      // The 60ms client timeout does not apply, so this is the abort, not the deadline.
      await expect(send).rejects.toThrow(/was aborted/);
    });

    it('reports a refused connection as unreachable, not as a status', async () => {
      // A port that was listening and is not any more, so this is a real ECONNREFUSED.
      const closed = await startTestServer();
      const baseUrl = closed.baseUrl;
      await closed.close();
      const send = new FetchHttpClient({ baseUrl }).send({ method: 'GET', url: '/v1/quote' });

      await expect(send).rejects.toThrow(ServiceUnreachableError);
      await expect(send).rejects.toThrow(/could not be reached: fetch failed: connect ECONNREFUSED/);
    });

    it('reports an unresolvable host as unreachable', async () => {
      const send = new FetchHttpClient({ baseUrl: 'http://no-such-host.invalid' }).send({ method: 'GET', url: '/v1/quote' });

      await expect(send).rejects.toThrow(ServiceUnreachableError);
    });

    it('names the method and URL, so a failure says which call it was', async () => {
      const send = new FetchHttpClient({ baseUrl: 'http://127.0.0.1:1' }).send({ method: 'DELETE', url: '/v2/orders/9' });

      await expect(send).rejects.toThrow(/DELETE http:\/\/127\.0\.0\.1:1\/v2\/orders\/9/);
    });
  });
});
