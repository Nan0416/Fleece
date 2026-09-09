import { NextFunction, Request, Response } from 'express';
import { corsMiddleware } from '../../../src/http/middleware/cors';

interface FakeResponse {
  readonly headers: Record<string, string>;
  statusCode?: number;
  ended: boolean;
}

function invoke(origins: ReadonlyArray<string>, request: { origin?: string; method?: string }): { res: FakeResponse; nextCalled: boolean } {
  const res: FakeResponse = { headers: {}, ended: false };
  let nextCalled = false;

  const req = { headers: { origin: request.origin }, method: request.method ?? 'GET', path: '/account' } as unknown as Request;
  const response = {
    setHeader: (name: string, value: string) => {
      res.headers[name] = value;
    },
    status: (code: number) => {
      res.statusCode = code;
      return response;
    },
    end: () => {
      res.ended = true;
    },
  } as unknown as Response;

  corsMiddleware({ origins })(req, response, (() => {
    nextCalled = true;
  }) as NextFunction);

  return { res, nextCalled };
}

describe('corsMiddleware', () => {
  it('echoes an allowed origin back rather than answering "*"', () => {
    // `*` is incompatible with credentialed requests, so echoing is what keeps this
    // working the day the UI needs cookies.
    const { res } = invoke(['http://localhost:5173'], { origin: 'http://localhost:5173' });
    expect(res.headers['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
    expect(res.headers['Access-Control-Allow-Credentials']).toBe('true');
  });

  it("varies on Origin, so a shared cache cannot serve one origin another's response", () => {
    const { res } = invoke(['http://localhost:5173'], { origin: 'http://localhost:5173' });
    expect(res.headers['Vary']).toBe('Origin');
  });

  it('allows any origin when configured with a single "*"', () => {
    const { res } = invoke(['*'], { origin: 'https://anywhere.example' });
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://anywhere.example');
  });

  it('matches exactly: a near miss is not allowed', () => {
    const { res } = invoke(['http://localhost:5173'], { origin: 'http://localhost:5174' });
    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('passes a same-origin request through untouched', () => {
    const { res, nextCalled } = invoke(['http://localhost:5173'], {});
    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(nextCalled).toBe(true);
  });

  it('answers a preflight itself rather than letting it reach the 404 handler', () => {
    // No route serves OPTIONS, so continuing would fail every preflight.
    const { res, nextCalled } = invoke(['http://localhost:5173'], { origin: 'http://localhost:5173', method: 'OPTIONS' });
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    expect(nextCalled).toBe(false);
    expect(res.headers['Access-Control-Allow-Methods']).toContain('OPTIONS');
    expect(res.headers['Access-Control-Allow-Headers']).toContain('Authorization');
    expect(res.headers['Access-Control-Max-Age']).toBe('86400');
  });

  it('answers a preflight from a disallowed origin without the header that would permit it', () => {
    const { res } = invoke(['http://localhost:5173'], { origin: 'https://evil.example', method: 'OPTIONS' });
    expect(res.statusCode).toBe(204);
    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it("lets a disallowed origin's real request continue, so the browser is what blocks it", () => {
    const { res, nextCalled } = invoke(['http://localhost:5173'], { origin: 'https://evil.example' });
    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(nextCalled).toBe(true);
  });
});
