import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  resolveFunderEin, fetch990Overview, run990Overview,
  is990Stale, refreshStale990Overviews,
  DEFAULT_990_MAX_AGE_DAYS, DEFAULT_990_REFRESH_LIMIT,
} from './grant-990';

function stubFetch(routes: Array<{ match: string; ok?: boolean; status?: number; json?: unknown }>) {
  const fn = vi.fn(async (url: string) => {
    const r = routes.find((x) => String(url).includes(x.match));
    if (!r) throw new Error(`unrouted fetch: ${url}`);
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.json ?? {} } as unknown as Response;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
afterEach(() => vi.unstubAllGlobals());

describe('resolveFunderEin', () => {
  it('prefers an exact case-insensitive name match over ProPublica\'s own top result', async () => {
    stubFetch([
      {
        match: 'search.json',
        json: {
          organizations: [
            { ein: 999999999, name: 'Mozilla Foundation Endowment Fund' },
            { ein: 123456789, name: 'Mozilla Foundation' },
          ],
        },
      },
    ]);
    const result = await resolveFunderEin('Mozilla Foundation');
    expect(result).toEqual({ ein: '123456789' });
  });

  it('returns an error when nothing matches', async () => {
    stubFetch([{ match: 'search.json', json: { organizations: [] } }]);
    const result = await resolveFunderEin('Totally Fictional Foundation');
    expect(result).toEqual({ error: expect.stringMatching(/no ProPublica match/) });
  });

  it('returns an error on a non-OK response rather than throwing', async () => {
    stubFetch([{ match: 'search.json', ok: false, status: 503 }]);
    const result = await resolveFunderEin('X');
    expect(result).toEqual({ error: expect.stringMatching(/HTTP 503/) });
  });
});

describe('fetch990Overview', () => {
  it('resolves an EIN by name, then pulls the most recent filing\'s figures', async () => {
    stubFetch([
      { match: 'search.json', json: { organizations: [{ ein: 123456789, name: 'Mozilla Foundation' }] } },
      {
        match: 'organizations/123456789.json',
        json: {
          organization: { name: 'Mozilla Foundation', ein: 123456789, city: 'San Francisco', state: 'CA', ntee_code: 'B99' },
          filings_with_data: [
            { tax_prd_yr: 2023, totrevenue: 50_000_000, totfuncexpns: 40_000_000, totassetsend: 100_000_000, totliabend: 10_000_000, totcntrbgfts: 45_000_000, totprgmrevn: 1_000_000 },
            { tax_prd_yr: 2022, totrevenue: 48_000_000 },
          ],
          filings_without_data: [],
        },
      },
    ]);
    const result = await fetch990Overview('Mozilla Foundation');
    expect(result).toMatchObject({
      funderName: 'Mozilla Foundation', ein: '123456789', mostRecentFilingYear: 2023,
      totalRevenueCents: 5_000_000_000, pdfOnlyFilingYears: [],
    });
  });

  it('surfaces PDF-only filing years explicitly rather than treating them as missing data', async () => {
    stubFetch([
      { match: 'search.json', json: { organizations: [{ ein: 1, name: 'Paper Filer Foundation' }] } },
      {
        match: 'organizations/1.json',
        json: {
          organization: { name: 'Paper Filer Foundation', ein: 1 },
          filings_with_data: [],
          filings_without_data: [{ tax_prd_yr: 2023, pdf_url: 'https://example.com/990.pdf' }],
        },
      },
    ]);
    const result = await fetch990Overview('Paper Filer Foundation');
    expect((result as { pdfOnlyFilingYears: number[] }).pdfOnlyFilingYears).toEqual([2023]);
    expect((result as { mostRecentFilingYear: number | null }).mostRecentFilingYear).toBeNull();
  });

  it('propagates a resolution error without calling the organization endpoint', async () => {
    stubFetch([{ match: 'search.json', json: { organizations: [] } }]);
    const result = await fetch990Overview('Nonexistent Foundation');
    expect(result).toEqual({ error: expect.stringMatching(/no ProPublica match/) });
  });
});

// Minimal in-memory D1 stub for grant_funder_990_overview upserts.
function fakeD1Env() {
  const rows = new Map<string, Record<string, unknown>>();
  const db = {
    prepare: (sql: string) => {
      const bound: unknown[] = [];
      const api = {
        bind: (...args: unknown[]) => { bound.push(...args); return api; },
        run: async () => {
          if (sql.startsWith('INSERT INTO grant_funder_990_overview')) {
            const funderName = bound[0] as string;
            rows.set(funderName, { funderName, raw: bound });
          }
          return { meta: { changes: 1 } } as unknown as D1Result;
        },
        first: async () => null,
      };
      return api;
    },
    batch: async (_stmts: unknown[]) => [],
  };
  return { DB: db as unknown as D1Database, _rows: rows };
}

describe('run990Overview · persistence', () => {
  it('persists a successful overview keyed by funder name', async () => {
    stubFetch([
      { match: 'search.json', json: { organizations: [{ ein: 1, name: 'X' }] } },
      { match: 'organizations/1.json', json: { organization: { name: 'X', ein: 1 }, filings_with_data: [] } },
    ]);
    const env = fakeD1Env();
    const result = await run990Overview(env, 'X');
    expect('error' in result).toBe(false);
    expect(env._rows.has('X')).toBe(true);
  });

  it('persists an error row rather than throwing when the funder can\'t be resolved', async () => {
    stubFetch([{ match: 'search.json', json: { organizations: [] } }]);
    const env = fakeD1Env();
    const result = await run990Overview(env, 'Nonexistent Foundation');
    expect(result).toEqual({ error: expect.stringMatching(/no ProPublica match/) });
    expect(env._rows.has('Nonexistent Foundation')).toBe(true);
  });
});

// ── Staleness-driven refresh (the cron path) ────────────────────────────
describe('is990Stale', () => {
  const now = new Date('2026-08-19T00:00:00Z');

  it('treats never-fetched as stale — the empty-table case this exists for', () => {
    expect(is990Stale(null, now, 30)).toBe(true);
    expect(is990Stale(undefined, now, 30)).toBe(true);
    expect(is990Stale('', now, 30)).toBe(true);
  });

  it('treats an unreadable timestamp as stale rather than skipping it forever', () => {
    expect(is990Stale('not a date', now, 30)).toBe(true);
  });

  it('compares against the age window', () => {
    expect(is990Stale('2026-08-18T00:00:00Z', now, 30)).toBe(false);
    expect(is990Stale('2026-06-01T00:00:00Z', now, 30)).toBe(true);
    // Exactly at the boundary counts as due, not as fresh.
    expect(is990Stale('2026-07-20T00:00:00Z', now, 30)).toBe(true);
  });
});

// A D1 stub that can answer the refresh candidate query as well as persist.
function fakeRefreshEnv(candidates: Array<{ funder_name: string; fetched_at: string | null }>) {
  const persisted: string[] = [];
  // Captured from the candidate query specifically — every later persist
  // call also binds, so a single "last bound args" field would report the
  // wrong statement's parameters.
  let candidateQueryArgs: unknown[] = [];
  const db = {
    prepare: (sql: string) => {
      const bound: unknown[] = [];
      const api = {
        bind: (...args: unknown[]) => {
          bound.push(...args);
          if (sql.includes('LEFT JOIN grant_funder_990_overview')) candidateQueryArgs = [...bound];
          return api;
        },
        run: async () => {
          if (sql.startsWith('INSERT INTO grant_funder_990_overview')) persisted.push(bound[0] as string);
          return { meta: { changes: 1 } } as unknown as D1Result;
        },
        first: async () => null,
        all: async () => {
          if (sql.includes('LEFT JOIN grant_funder_990_overview')) {
            const limit = Number(bound[1]);
            return { results: candidates.slice(0, limit) };
          }
          return { results: [] };
        },
      };
      return api;
    },
    batch: async (_stmts: unknown[]) => [],
  };
  return { env: { DB: db as unknown as D1Database }, persisted, boundOf: () => candidateQueryArgs };
}

describe('refreshStale990Overviews', () => {
  it('does nothing when every funder is current', async () => {
    const { env, persisted } = fakeRefreshEnv([]);
    const result = await refreshStale990Overviews(env);
    expect(result).toMatchObject({ candidates: 0, refreshed: 0, failed: 0 });
    expect(persisted).toHaveLength(0);
  });

  it('refreshes the candidate slice and counts successes separately from failures', async () => {
    stubFetch([
      { match: 'search.json', json: { organizations: [{ ein: 1, name: 'Ok Foundation' }] } },
      { match: 'organizations/1.json', json: { organization: { name: 'Ok Foundation', ein: 1 }, filings_with_data: [] } },
    ]);
    const { env, persisted } = fakeRefreshEnv([
      { funder_name: 'Ok Foundation', fetched_at: null },
      { funder_name: 'Also Ok', fetched_at: '2026-01-01T00:00:00Z' },
    ]);
    const result = await refreshStale990Overviews(env);
    expect(result.candidates).toBe(2);
    expect(result.refreshed + result.failed).toBe(2);
    expect(result.funders).toEqual(['Ok Foundation', 'Also Ok']);
    // Every candidate lands a row either way — a funder ProPublica can't
    // resolve persists an error row rather than being retried forever.
    expect(persisted).toHaveLength(2);
  });

  it('one unresolvable funder never stops the rest of the slice', async () => {
    stubFetch([{ match: 'search.json', json: { organizations: [] } }]);
    const { env } = fakeRefreshEnv([
      { funder_name: 'A', fetched_at: null },
      { funder_name: 'B', fetched_at: null },
    ]);
    const result = await refreshStale990Overviews(env);
    expect(result.failed).toBe(2);
    expect(result.funders).toEqual(['A', 'B']);
  });

  it('bounds the slice and passes the age cutoff into the query', async () => {
    stubFetch([{ match: 'search.json', json: { organizations: [] } }]);
    const many = Array.from({ length: 50 }, (_, i) => ({ funder_name: `F${i}`, fetched_at: null }));
    const { env, boundOf } = fakeRefreshEnv(many);
    const result = await refreshStale990Overviews(env, {
      limit: 3, maxAgeDays: 10, now: new Date('2026-08-19T00:00:00Z'),
    });
    expect(result.candidates).toBe(3);
    const [cutoff, limit] = boundOf() as [string, number];
    expect(limit).toBe(3);
    expect(cutoff).toBe('2026-08-09T00:00:00.000Z');
  });

  it('defaults to a bounded monthly cadence, not a daily full sweep', async () => {
    expect(DEFAULT_990_MAX_AGE_DAYS).toBeGreaterThanOrEqual(7);
    expect(DEFAULT_990_REFRESH_LIMIT).toBeGreaterThan(0);
    expect(DEFAULT_990_REFRESH_LIMIT).toBeLessThanOrEqual(25);
  });
});
