import * as http from 'node:http';

export interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

export interface Reply {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly delayMs?: number;
}

export interface TestServer {
  readonly baseUrl: string;
  /** Consumed one per request; the last one repeats once the queue empties. */
  readonly reply: (...replies: ReadonlyArray<Reply>) => void;
  readonly requests: () => ReadonlyArray<CapturedRequest>;
  readonly close: () => Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const captured: CapturedRequest[] = [];
  const pending = new Set<NodeJS.Timeout>();
  let queued: Reply[] = [{ status: 200, headers: { 'content-type': 'application/json' }, body: '{}' }];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      captured.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      const reply = queued.length > 1 ? queued.shift()! : queued[0];
      // Tracked so that closing cancels a delay still counting down; an abandoned timer
      // holds the event loop open and jest reports it long after the test has passed.
      const timer = setTimeout(() => {
        pending.delete(timer);
        res.writeHead(reply.status ?? 200, reply.headers ?? {});
        res.end(reply.body ?? '');
      }, reply.delayMs ?? 0);
      pending.add(timer);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The test server did not bind a TCP port.');
  }
  const { port } = address;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    reply: (...replies) => {
      queued = Array.from(replies);
    },
    requests: () => captured,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const timer of pending) {
          clearTimeout(timer);
        }
        pending.clear();
        server.closeAllConnections();
        server.close((err) => (err === undefined ? resolve() : reject(err)));
      }),
  };
}
