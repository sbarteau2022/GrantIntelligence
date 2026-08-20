// Routing and the auth gate. This entry point had no tests at all, which is
// how it shipped serving every /internal/* route open to the internet — so
// the gate's behavior is pinned here first, and the routing around it after.
import { describe, it, expect } from 'vitest';
import worker from './grant-worker-index';
import type { Env } from './grant-worker-index';

// Minimal D1 stub: enough for the search path and the schema bootstrap.
// Anything an internal route would touch is deliberately absent — no test
// below is supposed to get far enough to need it.
function fakeEnv(over: Partial<Env> = {}): Env {
  const db = {
    prepare: () => {
      const api = {
        bind: () => api,
        first: async () => null,
        run: async () => ({ meta: { changes: 0 } } as unknown as D1Result),
        all: async () => ({ results: [] }),
      };
      return api;
    },
    batch: async () => [],
  };
  return { DB: db as unknown as D1Database, ...over } as Env;
}

const req = (path: string, init: RequestInit = {}) =>
  new Request(`https://grantintelligence.example${path}`, init);

const INTERNAL_ROUTES = [
  '/internal/run-ingest', '/internal/seed', '/internal/990-all',
  '/internal/enrich-captures', '/internal/atlas-observation', '/internal/visual-capture',
];

describe('the /internal/* gate', () => {
  it('fails CLOSED when SERVICE_KEY is unset — every route, no exceptions', async () => {
    const env = fakeEnv(); // no SERVICE_KEY
    for (const path of INTERNAL_ROUTES) {
      const res = await worker.fetch(req(path, { method: 'POST', body: '{}' }), env);
      expect(res.status, `${path} must not be served open`).toBe(503);
      const body = await res.json() as { error: string };
      // The error has to tell the operator how to fix it, not just refuse.
      expect(body.error).toMatch(/wrangler secret put SERVICE_KEY/);
    }
  });

  it('rejects a wrong or missing bearer token once armed', async () => {
    const env = fakeEnv({ SERVICE_KEY: 'correct-horse' });
    for (const headers of [{}, { Authorization: 'Bearer wrong' }, { Authorization: 'correct-horse' }]) {
      const res = await worker.fetch(req('/internal/seed', { method: 'POST', headers }), env);
      expect(res.status).toBe(401);
    }
  });

  it('lets the right token through', async () => {
    const env = fakeEnv({ SERVICE_KEY: 'correct-horse' });
    const res = await worker.fetch(req('/internal/seed', {
      method: 'POST', headers: { Authorization: 'Bearer correct-horse' },
    }), env);
    expect(res.status).toBe(200);
  });

  it('does not leak whether a near-miss token was close', async () => {
    const env = fakeEnv({ SERVICE_KEY: 'correct-horse' });
    const short = await worker.fetch(req('/internal/seed', { method: 'POST', headers: { Authorization: 'Bearer c' } }), env);
    const long = await worker.fetch(req('/internal/seed', { method: 'POST', headers: { Authorization: 'Bearer correct-horsx' } }), env);
    expect(await short.json()).toEqual(await long.json());
    expect(short.status).toBe(long.status);
  });
});

describe('public routes stay public', () => {
  it('serves /health with no key, armed or not', async () => {
    for (const env of [fakeEnv(), fakeEnv({ SERVICE_KEY: 'k' })]) {
      const res = await worker.fetch(req('/health'), env);
      expect(res.status).toBe(200);
      expect((await res.json() as { status: string }).status).toBe('ok');
    }
  });

  it('serves /api/tiers and /api/search with no key, even once SERVICE_KEY is armed', async () => {
    const env = fakeEnv({ SERVICE_KEY: 'k' });
    expect((await worker.fetch(req('/api/tiers'), env)).status).toBe(200);
    const res = await worker.fetch(req('/api/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: { track: 'nonprofit' }, tier: 'basic' }),
    }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tier: 'basic', results: [] });
  });

  it('caps the search body rather than scoring against an unbounded profile', async () => {
    const res = await worker.fetch(req('/api/search', {
      method: 'POST', body: JSON.stringify({ profile: { focus: 'x'.repeat(20_000) } }),
    }), fakeEnv());
    expect(res.status).toBe(413);
  });

  it('rejects a malformed search body with 400, not a 500', async () => {
    const res = await worker.fetch(req('/api/search', { method: 'POST', body: '{not json' }), fakeEnv());
    expect(res.status).toBe(400);
  });

  it('answers CORS preflight without touching the gate', async () => {
    const res = await worker.fetch(req('/internal/seed', { method: 'OPTIONS' }), fakeEnv());
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('404s an unknown path under an armed key rather than falling through', async () => {
    const env = fakeEnv({ SERVICE_KEY: 'k' });
    const res = await worker.fetch(req('/internal/nope', {
      method: 'POST', headers: { Authorization: 'Bearer k' },
    }), env);
    expect(res.status).toBe(404);
  });
});
