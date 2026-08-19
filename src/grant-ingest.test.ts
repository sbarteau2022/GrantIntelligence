// Live grant-opportunity ingest — mocked fetch (this sandbox can't reach
// api.grants.gov/api.www.sbir.gov at all; see the module header), plus an
// in-memory D1 stub for the upsert/close-stale orchestration.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchGrantsGovOpportunities, fetchSbirOpportunities, normalizeGrantsGovHit,
  normalizeSbirSolicitation, runGrantIngest, seedOpportunities, SEED_OPPORTUNITIES,
} from './grant-ingest';

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

describe('SEED_OPPORTUNITIES', () => {
  it('every row has a unique id and a valid funder_type', () => {
    const ids = SEED_OPPORTUNITIES.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    const validTypes = ['federal', 'state', 'foundation', 'corporate', 'international', 'accelerator'];
    for (const o of SEED_OPPORTUNITIES) expect(validTypes).toContain(o.funder_type);
  });

  it('necaif_applicable is set only on foundation/corporate funders', () => {
    for (const o of SEED_OPPORTUNITIES) {
      if (o.necaif_applicable === 1) expect(['foundation', 'corporate']).toContain(o.funder_type);
    }
  });
});

describe('normalizeGrantsGovHit', () => {
  it('normalizes a well-formed hit', () => {
    const result = normalizeGrantsGovHit({
      number: 'VA-2026-001', title: 'SSG Fox Suicide Prevention Grant', agency: 'U.S. Dept. of Veterans Affairs',
      agencyCode: 'VA', closeDate: '05/05/2026', oppStatus: 'posted',
    });
    expect(result).toMatchObject({
      id: 'grants-gov-VA-2026-001', source: 'grants.gov', funder_name: 'U.S. Dept. of Veterans Affairs',
      funder_type: 'federal', program_name: 'SSG Fox Suicide Prevention Grant', deadline: '05/05/2026',
    });
  });

  it('falls back to numeric id when "number" is missing', () => {
    expect(normalizeGrantsGovHit({ id: 12345, title: 'Some Program' })?.id).toBe('grants-gov-12345');
  });

  it('returns null when there is no usable identifier', () => {
    expect(normalizeGrantsGovHit({ title: 'No number or id' })).toBeNull();
  });

  it('returns null when there is no title', () => {
    expect(normalizeGrantsGovHit({ number: 'X-1' })).toBeNull();
  });
});

describe('normalizeSbirSolicitation', () => {
  it('normalizes a well-formed solicitation', () => {
    const result = normalizeSbirSolicitation({
      solicitation_number: 'NSF-26-001', solicitation_title: 'AI for Human-Computer Interaction',
      agency: 'National Science Foundation', branch: 'HCI', close_date: '2026-09-01',
    });
    expect(result).toMatchObject({
      id: 'sbir-gov-NSF-26-001', source: 'sbir.gov', funder_name: 'National Science Foundation',
      funder_type: 'federal', program_name: 'AI for Human-Computer Interaction', deadline: '2026-09-01',
      stated_priorities: 'HCI',
    });
  });

  it('returns null without a solicitation number', () => {
    expect(normalizeSbirSolicitation({ solicitation_title: 'X' })).toBeNull();
  });

  it('returns null without a title', () => {
    expect(normalizeSbirSolicitation({ solicitation_number: 'X-1' })).toBeNull();
  });
});

describe('fetchGrantsGovOpportunities', () => {
  it('fans out across all three named agency/keyword queries and aggregates hits', async () => {
    const fn = stubFetch([{ match: 'search2', json: { data: { oppHits: [{ number: 'A-1', title: 'A' }] } } }]);
    const { opportunities, errors } = await fetchGrantsGovOpportunities();
    expect(fn).toHaveBeenCalledTimes(3);
    expect(opportunities).toHaveLength(3);
    expect(errors).toHaveLength(0);
  });

  it('collects a per-query error without losing the other queries\' results', async () => {
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call++;
      if (call === 2) return { ok: false, status: 503, json: async () => ({}) } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({ data: { oppHits: [{ number: `Q-${call}`, title: 'X' }] } }) } as unknown as Response;
    }));
    const { opportunities, errors } = await fetchGrantsGovOpportunities();
    expect(opportunities).toHaveLength(2);
    expect(errors).toEqual([expect.stringMatching(/HHS-SAMHSA.*HTTP 503/)]);
  });

  it('turns a network failure into a collected error, not a throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    const { opportunities, errors } = await fetchGrantsGovOpportunities();
    expect(opportunities).toHaveLength(0);
    expect(errors).toHaveLength(3);
  });
});

describe('fetchSbirOpportunities', () => {
  it('normalizes solicitations from a well-formed response', async () => {
    stubFetch([{ match: 'solicitations', json: [{ solicitation_number: 'S-1', solicitation_title: 'AI Track' }] }]);
    const { opportunities, errors } = await fetchSbirOpportunities();
    expect(errors).toHaveLength(0);
    expect(opportunities).toEqual([expect.objectContaining({ id: 'sbir-gov-S-1', source: 'sbir.gov' })]);
  });

  it('returns an error on a non-OK response rather than throwing', async () => {
    stubFetch([{ match: 'solicitations', ok: false, status: 500 }]);
    const { opportunities, errors } = await fetchSbirOpportunities();
    expect(opportunities).toHaveLength(0);
    expect(errors).toEqual([expect.stringMatching(/HTTP 500/)]);
  });

  // This used to assert "tolerates a non-array response body" with NO error.
  // It survives without throwing either way — but silently reporting zero
  // opportunities is what runGrantIngest's close-stale pass reads as "every
  // sbir.gov row just closed," which would wipe the source's catalogue on an
  // upstream envelope change. An unrecognized shape is an error; an actual
  // empty array is still a clean zero (see the next test).
  it('reports an unrecognized response envelope as an error, not as zero opportunities', async () => {
    stubFetch([{ match: 'solicitations', json: { unexpected: 'shape' } }]);
    const { opportunities, errors } = await fetchSbirOpportunities();
    expect(opportunities).toHaveLength(0);
    expect(errors).toEqual([expect.stringMatching(/unrecognized response envelope/)]);
  });

  it('treats a well-formed empty array as a clean zero, with no error', async () => {
    stubFetch([{ match: 'solicitations', json: [] }]);
    const { opportunities, errors } = await fetchSbirOpportunities();
    expect(opportunities).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });
});

// In-memory D1 stub for grant_opportunities.
function fakeD1Env() {
  const rows = new Map<string, { id: string; source: string; status: string }>();
  const db = {
    prepare: (sql: string) => {
      const bound: unknown[] = [];
      const api = {
        bind: (...args: unknown[]) => { bound.push(...args); return api; },
        first: async () => {
          if (sql.includes('SELECT id FROM grant_opportunities WHERE id = ?')) {
            const id = bound[0] as string;
            return rows.has(id) ? { id } : null;
          }
          return null;
        },
        all: async <T,>() => {
          if (sql.includes('WHERE source = ? AND status = ')) {
            const source = bound[0] as string;
            const results = [...rows.values()].filter((r) => r.source === source && r.status === 'open').map((r) => ({ id: r.id }));
            return { results } as unknown as D1Result<T>;
          }
          return { results: [] } as unknown as D1Result<T>;
        },
        run: async () => {
          if (sql.startsWith('INSERT INTO grant_opportunities')) {
            const [id, source] = bound as string[];
            rows.set(id, { id, source, status: 'open' });
          } else if (sql.startsWith('UPDATE grant_opportunities SET status = ')) {
            const id = bound[0] as string;
            const row = rows.get(id);
            if (row) row.status = 'closed';
          }
          return { meta: { changes: 1 } } as unknown as D1Result;
        },
      };
      return api;
    },
    batch: async (_stmts: unknown[]) => [],
  };
  return { DB: db as unknown as D1Database, _rows: rows };
}

describe('seedOpportunities', () => {
  it('inserts every seed row once, then updates on re-run', async () => {
    const env = fakeD1Env();
    const first = await seedOpportunities(env);
    expect(first.inserted).toBe(SEED_OPPORTUNITIES.length);
    expect(first.updated).toBe(0);
    const second = await seedOpportunities(env);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(SEED_OPPORTUNITIES.length);
  });
});

describe('runGrantIngest · orchestration', () => {
  it('inserts fresh hits from both sources', async () => {
    stubFetch([
      { match: 'search2', json: { data: { oppHits: [{ number: 'V-1', title: 'Veteran Program' }] } } },
      { match: 'solicitations', json: [{ solicitation_number: 'S-1', solicitation_title: 'AI Track' }] },
    ]);
    const env = fakeD1Env();
    const result = await runGrantIngest(env);
    expect(result.fetched).toBe(4);
    expect(result.inserted).toBe(2);
    expect(result.updated).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  it('closes a previously-open row that no longer appears in a cleanly-fetched source', async () => {
    stubFetch([
      { match: 'search2', json: { data: { oppHits: [{ number: 'V-1', title: 'Veteran Program' }] } } },
      { match: 'solicitations', json: [{ solicitation_number: 'S-1', solicitation_title: 'AI Track' }] },
    ]);
    const env = fakeD1Env();
    await runGrantIngest(env);

    vi.unstubAllGlobals();
    stubFetch([
      { match: 'search2', json: { data: { oppHits: [{ number: 'V-1', title: 'Veteran Program' }] } } },
      { match: 'solicitations', json: [] },
    ]);
    const second = await runGrantIngest(env);
    expect(second.closed).toBe(1);
    expect(env._rows.get('sbir-gov-S-1')?.status).toBe('closed');
  });

  it('never closes rows from a source that errored this run', async () => {
    stubFetch([
      { match: 'search2', json: { data: { oppHits: [{ number: 'V-1', title: 'Veteran Program' }] } } },
      { match: 'solicitations', json: [{ solicitation_number: 'S-1', solicitation_title: 'AI Track' }] },
    ]);
    const env = fakeD1Env();
    await runGrantIngest(env);

    vi.unstubAllGlobals();
    stubFetch([
      { match: 'search2', json: { data: { oppHits: [{ number: 'V-1', title: 'Veteran Program' }] } } },
      { match: 'solicitations', ok: false, status: 500 },
    ]);
    const second = await runGrantIngest(env);
    expect(second.closed).toBe(0);
    expect(env._rows.get('sbir-gov-S-1')?.status).toBe('open');
  });
});
