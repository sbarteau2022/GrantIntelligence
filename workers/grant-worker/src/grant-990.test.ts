import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveFunderEin, fetch990Overview, run990Overview } from './grant-990';

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
