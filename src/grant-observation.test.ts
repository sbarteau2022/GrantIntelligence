import { describe, it, expect } from 'vitest';
import { runGrantObservationGate, parseLooseAmountCents, stableObservationId, ingestAtlasObservations } from './grant-observation';

describe('parseLooseAmountCents', () => {
  it('parses a plain dollar figure', () => {
    expect(parseLooseAmountCents('$50,000')).toBe(5_000_000);
  });
  it('parses a "k" suffix', () => {
    expect(parseLooseAmountCents('$250k')).toBe(25_000_000);
  });
  it('parses an "M" suffix', () => {
    expect(parseLooseAmountCents('$2M')).toBe(200_000_000);
  });
  it('takes the first figure out of a range, rather than failing', () => {
    expect(parseLooseAmountCents('$250k-$600k')).toBe(25_000_000);
  });
  it('returns null for prose with no number', () => {
    expect(parseLooseAmountCents('varies by program')).toBeNull();
  });
  it('returns null when nothing is present', () => {
    expect(parseLooseAmountCents(undefined)).toBeNull();
  });
});

describe('stableObservationId', () => {
  it('is deterministic for the same funder/program/portal', async () => {
    const a = await stableObservationId('Arch Grants', 'Arch Grants — St. Louis', 'https://archgrants.org/apply');
    const b = await stableObservationId('Arch Grants', 'Arch Grants — St. Louis', 'https://archgrants.org/apply');
    expect(a).toBe(b);
  });

  it('is case-insensitive', async () => {
    const a = await stableObservationId('Arch Grants', 'X', 'https://x.com');
    const b = await stableObservationId('ARCH GRANTS', 'x', 'HTTPS://X.COM');
    expect(a).toBe(b);
  });

  it('differs when the portal differs, even with the same funder/program', async () => {
    const a = await stableObservationId('X Foundation', 'Y Program', 'https://x.com/a');
    const b = await stableObservationId('X Foundation', 'Y Program', 'https://x.com/b');
    expect(a).not.toBe(b);
  });

  it('has the atlas-capture- prefix so it never collides with a Grants.gov/SBIR.gov id', async () => {
    const id = await stableObservationId('X', 'Y', null);
    expect(id).toMatch(/^atlas-capture-[0-9a-f]{24}$/);
  });
});

describe('runGrantObservationGate', () => {
  it('normalizes a valid opportunity sighting', async () => {
    const { valid, rejected } = await runGrantObservationGate([
      {
        funderName: 'Mozilla Foundation',
        programName: 'Democracy × AI Incubator',
        funderType: 'foundation',
        amountText: '$300,000',
        deadlineText: '2026',
        eligibilityText: 'Top 2 of 10 advance',
        portalContext: '/programs/ai-incubator',
        captureMethod: 'dom',
        observedAt: '2026-07-30T12:00:00.000Z',
      },
    ]);
    expect(rejected).toHaveLength(0);
    expect(valid).toHaveLength(1);
    expect(valid[0]).toMatchObject({
      funderName: 'Mozilla Foundation',
      programName: 'Democracy × AI Incubator',
      funderType: 'foundation',
      amountCents: 30_000_000,
      deadlineText: '2026',
      captureMethod: 'dom',
      observedAt: '2026-07-30T12:00:00.000Z',
    });
    expect(valid[0].id).toMatch(/^atlas-capture-/);
  });

  it('rejects a non-array input', async () => {
    const { valid, rejected } = await runGrantObservationGate({ nope: true } as unknown);
    expect(valid).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/must be an array/);
  });

  it('rejects a row missing funderName', async () => {
    const { rejected } = await runGrantObservationGate([{ programName: 'X' }]);
    expect(rejected[0]).toEqual({ index: 0, reason: 'missing funderName' });
  });

  it('rejects a row missing programName', async () => {
    const { rejected } = await runGrantObservationGate([{ funderName: 'X' }]);
    expect(rejected[0]).toEqual({ index: 0, reason: 'missing programName' });
  });

  it('keeps amountText even when amountCents cannot be parsed', async () => {
    const { valid } = await runGrantObservationGate([
      { funderName: 'F', programName: 'P', amountText: 'varies by program' },
    ]);
    expect(valid[0].amountText).toBe('varies by program');
    expect(valid[0].amountCents).toBeNull();
  });

  it('de-duplicates identical funder/program/portal within a batch', async () => {
    const obs = { funderName: 'Arch Grants', programName: 'Arch Grants — St. Louis', portalContext: '/apply' };
    const { valid, rejected } = await runGrantObservationGate([obs, { ...obs }, { ...obs }]);
    expect(valid).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    expect(rejected.every((r) => r.reason === 'duplicate within batch')).toBe(true);
  });

  it('defaults an unrecognized funderType to "foundation" rather than throwing', async () => {
    const { valid } = await runGrantObservationGate([
      { funderName: 'X', programName: 'Y', funderType: 'small nonprofit thing' },
    ]);
    expect(valid[0].funderType).toBe('foundation');
  });
});

// In-memory D1 stub, same shape as grant-ingest.test.ts's.
function fakeD1Env() {
  const rows = new Map<string, Record<string, unknown>>();
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
        run: async () => {
          if (sql.startsWith('INSERT INTO grant_opportunities')) {
            const [id, funderName, funderType, programName] = bound as string[];
            rows.set(id, { id, funder_name: funderName, funder_type: funderType, program_name: programName, source: 'atlas-capture' });
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

describe('ingestAtlasObservations', () => {
  it('inserts a fresh, valid capture and returns its stable id', async () => {
    const env = fakeD1Env();
    const result = await ingestAtlasObservations(env, [
      { funderName: 'Arch Grants', programName: 'Arch Grants — St. Louis', portalContext: '/apply', amountText: '$75,000' },
    ]);
    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.rejected).toHaveLength(0);
    expect(result.ids).toHaveLength(1);
    expect(env._rows.get(result.ids[0])).toMatchObject({ funder_name: 'Arch Grants', source: 'atlas-capture' });
  });

  it('updates rather than duplicates when the same portal/funder/program is re-captured', async () => {
    const env = fakeD1Env();
    const obs = [{ funderName: 'Arch Grants', programName: 'Arch Grants — St. Louis', portalContext: '/apply' }];
    const first = await ingestAtlasObservations(env, obs);
    const second = await ingestAtlasObservations(env, obs);
    expect(first.ids).toEqual(second.ids); // same stable id both times
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(1);
  });

  it('surfaces gate rejections without touching the database', async () => {
    const env = fakeD1Env();
    const result = await ingestAtlasObservations(env, [{ programName: 'no funder name' }]);
    expect(result.inserted).toBe(0);
    expect(result.rejected).toEqual([{ index: 0, reason: 'missing funderName' }]);
    expect(result.ids).toHaveLength(0);
  });
});
