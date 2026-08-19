// Public tiered opportunity search. Almost everything here is pure —
// normalization, scoring, tier gating — so it's tested directly. The one
// impure function (searchOpportunities) gets the same in-memory D1 stub
// shape the other suites in this repo use.
import { describe, it, expect } from 'vitest';
import {
  normalizeProfile, tokenize, tokenizeMap, detectGeographies, readDeadline, scoreOpportunity,
  resolveTier, searchOpportunities, TIERS, FUNDING_BANDS,
  type OrgProfile, type OpportunityRow,
} from './grant-search';

const NOW = new Date('2026-08-19T00:00:00Z');

function profile(over: Partial<OrgProfile> = {}): OrgProfile {
  return {
    track: 'nonprofit', orgType: '501c3', state: 'MO',
    focus: 'veteran suicide prevention and peer recovery support',
    fundingNeed: 275_000, entityStage: 'early', ...over,
  };
}

function opp(over: Partial<OpportunityRow> = {}): OpportunityRow {
  return {
    id: 'o-1', source: 'grant-strategy-map', funder_name: 'U.S. Dept. of Veterans Affairs',
    funder_type: 'federal', program_name: 'SSG Fox Suicide Prevention Grant',
    amount_min: 100_000, amount_max: 750_000, deadline: '2026-12-01',
    stated_priorities: 'Rural veteran focus; peer support between crisis and care',
    necaif_applicable: 0, status: 'open', ...over,
  };
}

describe('normalizeProfile', () => {
  it('defaults to the nonprofit track and drops values it does not recognize', () => {
    const p = normalizeProfile({ track: 'llc-ish', orgType: 'not-a-real-type', state: 'Missouri', entityStage: 'wat' });
    expect(p.track).toBe('nonprofit');
    expect(p.orgType).toBeNull();
    expect(p.entityStage).toBeNull();
    // "Missouri".slice(0,2) is "MI" — a real code, but not the one meant.
    // The form sends codes; free text is not silently reinterpreted here.
    expect(p.state).toBe('MI');
  });

  it('accepts a funding band id or a raw dollar figure', () => {
    expect(normalizeProfile({ fundingNeed: '100k-500k' }).fundingNeed).toBe(275_000);
    expect(normalizeProfile({ fundingNeed: 42_000 }).fundingNeed).toBe(42_000);
    expect(normalizeProfile({ fundingNeed: -5 }).fundingNeed).toBeNull();
    expect(normalizeProfile({}).fundingNeed).toBeNull();
  });

  it('caps a runaway focus description rather than scoring on unbounded text', () => {
    expect(normalizeProfile({ focus: 'x'.repeat(5000) }).focus).toHaveLength(600);
  });

  it('every funding band id round-trips to its own midpoint', () => {
    for (const b of FUNDING_BANDS) expect(normalizeProfile({ fundingNeed: b.id }).fundingNeed).toBe(b.midpoint);
  });
});

describe('tokenize', () => {
  it('stems plurals, gerunds and past tense so related words meet', () => {
    expect(tokenize('veterans training')).toEqual(tokenize('veteran train'));
    expect(tokenize('recoveries')).toEqual(tokenize('recovery'));
    expect(tokenize('sheltered')).toEqual(tokenize('shelter'));
  });

  it('strips one suffix class, never two — "housing" must not become "hou"', () => {
    expect([...tokenize('housing')]).toEqual(['hous']);
  });

  it('remembers the original word behind each stem, for what gets shown back', () => {
    expect(tokenizeMap('crisis intervention').get('crisi')).toBe('crisis');
  });

  it('drops stopwords and the domain filler that matches everything', () => {
    const t = tokenize('our organization provides grant funding for the community');
    expect(t.has('grant')).toBe(false);
    expect(t.has('funding')).toBe(false);
    expect(t.has('community')).toBe(false);
  });

  it('is empty for empty input rather than throwing', () => {
    expect(tokenize(null).size).toBe(0);
    expect(tokenize('   ').size).toBe(0);
  });
});

describe('detectGeographies', () => {
  it('finds a state by name and by a delimited uppercase code', () => {
    expect(detectGeographies('Missouri-based applicants only')).toEqual(['MO']);
    expect(detectGeographies('Applicants in (MO) preferred')).toEqual(['MO']);
  });

  it('does not read ordinary English words as state codes', () => {
    // "or", "in", "me" as lowercase words must never become OR/IN/ME.
    expect(detectGeographies('open to any applicant or organization in me')).toBeNull();
  });

  it('returns null when the listing names no geography at all', () => {
    expect(detectGeographies('Emergent AI for public benefit')).toBeNull();
  });
});

describe('readDeadline', () => {
  it('reads ISO and US dates, and knows which side of today they fall on', () => {
    expect(readDeadline('2026-12-01', NOW)).toEqual({ state: 'open', iso: '2026-12-01' });
    expect(readDeadline('2025-01-01', NOW).state).toBe('passed');
    expect(readDeadline('12/01/2026', NOW)).toEqual({ state: 'open', iso: '2026-12-01' });
  });

  it('reads the prose states these portals actually publish', () => {
    expect(readDeadline('Rolling', NOW).state).toBe('rolling');
    expect(readDeadline('Paused — reauthorization pending', NOW).state).toBe('paused');
    expect(readDeadline('FY26 open', NOW).state).toBe('open');
    expect(readDeadline('FY24', NOW).state).toBe('passed');
  });

  it('says unknown rather than guessing', () => {
    expect(readDeadline('Prep now — letter of inquiry', NOW).state).toBe('unknown');
    expect(readDeadline(null, NOW).state).toBe('unknown');
  });
});

describe('scoreOpportunity', () => {
  it('scores a well-matched opportunity strongly and names every signal used', () => {
    const m = scoreOpportunity(profile(), opp(), NOW);
    expect(m.band).toBe('strong');
    expect(m.signals.map((s) => s.feature).sort()).toEqual(['amount', 'eligibility', 'focus', 'geography', 'timing']);
    for (const s of m.signals) expect(s.detail.length).toBeGreaterThan(0);
  });

  it('NEVER emits a recommendation field — the engine presents, the applicant decides', () => {
    const m = scoreOpportunity(profile(), opp(), NOW);
    expect(m).not.toHaveProperty('recommendation');
    const blob = JSON.stringify(m).toLowerCase();
    expect(blob).not.toContain('you should');
    expect(blob).not.toContain('we recommend');
  });

  it('drops an unanswerable feature from the score instead of scoring it zero', () => {
    const thin = opp({ amount_min: null, amount_max: null });
    const withAmount = scoreOpportunity(profile(), opp(), NOW);
    const withoutAmount = scoreOpportunity(profile(), thin, NOW);
    // The amount feature scored 1.0 on the full row, so dropping it cannot
    // RAISE the score; what matters is that it doesn't crater it the way a
    // zero would. Renormalizing keeps it in the same band.
    expect(withoutAmount.signals.some((s) => s.feature === 'amount')).toBe(false);
    expect(withoutAmount.gaps.join(' ')).toMatch(/award amount is on file/i);
    expect(withoutAmount.band).toBe(withAmount.band);
    expect(withoutAmount.score).toBeGreaterThan(0.5);
  });

  it('names the gap when the visitor left a field blank, rather than penalizing them', () => {
    const m = scoreOpportunity(profile({ focus: null, fundingNeed: null, state: null }), opp(), NOW);
    expect(m.signals.map((s) => s.feature)).toEqual(['eligibility', 'timing']);
    expect(m.gaps).toHaveLength(3);
    expect(m.gaps.join(' ')).toMatch(/did not describe/i);
    expect(m.gaps.join(' ')).toMatch(/did not state how much/i);
    expect(m.gaps.join(' ')).toMatch(/did not select a state/i);
  });

  it('reads entity fit structurally: an LLC against a foundation, a nonprofit against an accelerator', () => {
    const foundation = opp({ funder_type: 'foundation', funder_name: 'Mozilla Foundation' });
    const asCharity = scoreOpportunity(profile({ orgType: '501c3' }), foundation, NOW);
    const asLlc = scoreOpportunity(profile({ track: 'business', orgType: 'llc' }), foundation, NOW);
    const eligOf = (m: ReturnType<typeof scoreOpportunity>) => m.signals.find((s) => s.feature === 'eligibility')!;
    expect(eligOf(asCharity).score).toBeGreaterThan(eligOf(asLlc).score);
    expect(eligOf(asLlc).detail).toMatch(/fiscal sponsor/i);

    const accelerator = opp({ funder_type: 'accelerator', funder_name: 'Arch Grants' });
    expect(eligOf(scoreOpportunity(profile({ track: 'business' }), accelerator, NOW)).score)
      .toBeGreaterThan(eligOf(scoreOpportunity(profile({ track: 'nonprofit' }), accelerator, NOW)).score);
  });

  it('penalizes a geographic mismatch and says which states the listing named', () => {
    const stateProgram = opp({
      funder_type: 'state', funder_name: 'Missouri Technology Corporation',
      program_name: 'MTC IDEA Fund', stated_priorities: 'Missouri-based applicants',
    });
    const inState = scoreOpportunity(profile({ state: 'MO' }), stateProgram, NOW);
    const outOfState = scoreOpportunity(profile({ state: 'CA' }), stateProgram, NOW);
    expect(inState.score).toBeGreaterThan(outOfState.score);
    expect(outOfState.signals.find((s) => s.feature === 'geography')!.detail).toContain('MO');
  });

  it('scores award size by ratio, so the same relative miss costs the same at any scale', () => {
    const small = scoreOpportunity(profile({ fundingNeed: 200_000 }), opp({ amount_min: 50_000, amount_max: 100_000 }), NOW);
    const large = scoreOpportunity(profile({ fundingNeed: 20_000_000 }), opp({ amount_min: 5_000_000, amount_max: 10_000_000 }), NOW);
    const amountOf = (m: ReturnType<typeof scoreOpportunity>) => m.signals.find((s) => s.feature === 'amount')!.score;
    expect(amountOf(small)).toBeCloseTo(amountOf(large), 6);
  });

  it('flags a paused program from the listing’s own words', () => {
    const m = scoreOpportunity(profile(), opp({ deadline: 'Paused — reauthorization pending' }), NOW);
    expect(m.deadline_state).toBe('paused');
    expect(m.signals.find((s) => s.feature === 'timing')!.detail).toMatch(/paused/i);
  });
});

describe('resolveTier', () => {
  it('honors the requested tier in preview mode (TIER_KEYS unset)', () => {
    expect(resolveTier({ DB: {} as D1Database }, 'full', null)).toEqual({
      tier: 'full', requested: 'full', enforced: false,
    });
  });

  it('falls back to basic — never to the requested tier — once TIER_KEYS is armed', () => {
    const env = { DB: {} as D1Database, TIER_KEYS: JSON.stringify({ k1: 'supported' }) };
    expect(resolveTier(env, 'enterprise', null).tier).toBe('basic');
    expect(resolveTier(env, 'enterprise', 'wrong-key').tier).toBe('basic');
    expect(resolveTier(env, 'enterprise', 'k1').tier).toBe('supported'); // capped at what the key grants
    expect(resolveTier(env, 'basic', 'k1').tier).toBe('basic');          // and never above what was asked
    expect(resolveTier(env, 'enterprise', 'k1').enforced).toBe(true);
  });

  it('fails closed to basic on malformed TIER_KEYS rather than open', () => {
    expect(resolveTier({ DB: {} as D1Database, TIER_KEYS: '{not json' }, 'enterprise', 'k1').tier).toBe('basic');
  });

  it('treats an unknown requested tier as basic', () => {
    expect(resolveTier({ DB: {} as D1Database }, 'platinum', null).tier).toBe('basic');
  });
});

// In-memory D1 stub, same shape as grant-ingest.test.ts's / grant-observation.test.ts's.
function fakeD1Env(opportunities: OpportunityRow[], financials: Array<Record<string, unknown>> = []) {
  const db = {
    prepare: (sql: string) => {
      const bound: unknown[] = [];
      const api = {
        bind: (...args: unknown[]) => { bound.push(...args); return api; },
        first: async () => null,
        run: async () => ({ meta: { changes: 0 } } as unknown as D1Result),
        all: async () => {
          if (sql.includes('FROM grant_opportunities')) {
            return { results: opportunities.filter((o) => o.status === 'open') };
          }
          if (sql.includes('FROM grant_funder_990_overview')) {
            const names = new Set(bound as string[]);
            return { results: financials.filter((f) => names.has(String(f.funder_name))) };
          }
          return { results: [] };
        },
      };
      return api;
    },
    batch: async (_stmts: unknown[]) => [],
  };
  return { DB: db as unknown as D1Database };
}

const CORPUS: OpportunityRow[] = [
  opp(),
  opp({
    id: 'o-2', funder_type: 'foundation', funder_name: 'Mozilla Foundation',
    program_name: 'Democracy × AI Incubator', amount_min: null, amount_max: 300_000,
    deadline: '2026', stated_priorities: 'Information ecosystem resilience', necaif_applicable: 1,
  }),
  opp({
    id: 'o-3', funder_type: 'accelerator', funder_name: 'Arch Grants',
    program_name: 'Arch Grants — St. Louis', amount_min: 75_000, amount_max: 75_000,
    deadline: 'Rolling', stated_priorities: 'Equity-free; Missouri presence', necaif_applicable: 0,
  }),
  opp({ id: 'o-4', funder_name: 'Expired Fund', program_name: 'Old Program', deadline: '2024-01-01' }),
  opp({ id: 'o-5', funder_name: 'Closed Fund', program_name: 'Closed Program', status: 'closed' }),
];

describe('searchOpportunities', () => {
  it('returns only open, still-applicable rows, best match first', async () => {
    const env = fakeD1Env(CORPUS);
    const res = await searchOpportunities(env, profile(), 'supported', NOW);
    const ids = res.results.map((r) => r.id);
    expect(ids).not.toContain('o-5'); // status = 'closed'
    expect(ids).not.toContain('o-4'); // deadline already passed
    expect(res.results[0].score!).toBeGreaterThanOrEqual(res.results[res.results.length - 1].score!);
    expect(res.total_matches).toBe(3);
  });

  it('strips every gated field at Basic and names what it withheld', async () => {
    const env = fakeD1Env(CORPUS);
    const res = await searchOpportunities(env, profile(), 'basic', NOW);
    for (const row of res.results) {
      // Not "hidden in the browser" — genuinely absent from the payload.
      expect(row).not.toHaveProperty('score');
      expect(row).not.toHaveProperty('signals');
      expect(row).not.toHaveProperty('gaps');
      expect(row).not.toHaveProperty('financials');
      expect(row).not.toHaveProperty('necaif_available');
      // What Basic DOES promise on the pricing page: matches, deadlines, requirements.
      expect(row.band).toBeTruthy();
      expect(row).toHaveProperty('deadline');
      expect(row).toHaveProperty('requirements');
    }
    expect(res.locked_fields).toContain('score');
    expect(res.locked_fields).toContain('financials');
  });

  it('gives Supported the fit breakdown, the NECAI-F flag, and 990 financials', async () => {
    const env = fakeD1Env(CORPUS, [{
      funder_name: 'Mozilla Foundation', most_recent_filing_year: 2024,
      total_revenue_cents: 5_000_000_000, total_expenses_cents: 4_000_000_000,
      contributions_gifts_grants_cents: 4_500_000_000, total_assets_end_cents: 10_000_000_000,
      source_url: 'https://projects.propublica.org/nonprofits/organizations/200097189',
    }]);
    const res = await searchOpportunities(env, profile(), 'supported', NOW);
    const mozilla = res.results.find((r) => r.funder_name === 'Mozilla Foundation')!;
    expect(mozilla.signals!.length).toBeGreaterThan(0);
    expect(mozilla.necaif_available).toBe(true);
    expect(mozilla.financials!.total_revenue).toBe(50_000_000); // cents -> dollars
    expect(mozilla.financials!.source_url).toContain('propublica.org');
    // A funder with no 990 row on file reads as null, not as a missing key.
    expect(res.results.find((r) => r.funder_name === 'Arch Grants')!.financials).toBeNull();
  });

  it('caps results per tier and reports honestly how many it held back', async () => {
    const many = Array.from({ length: 40 }, (_, i) => opp({ id: `bulk-${i}`, funder_name: `Funder ${i}` }));
    const env = fakeD1Env(many);
    const basic = await searchOpportunities(env, profile(), 'basic', NOW);
    expect(basic.returned).toBe(TIERS.basic.resultLimit);
    expect(basic.withheld).toBe(40 - TIERS.basic.resultLimit);
    expect(basic.total_matches).toBe(40);

    const full = await searchOpportunities(env, profile(), 'full', NOW);
    expect(full.returned).toBe(40);
    expect(full.withheld).toBe(0);
  });

  it('always ships the disclosure — sources named, limits stated, no verdict', async () => {
    const res = await searchOpportunities(fakeD1Env(CORPUS), profile(), 'basic', NOW);
    expect(res.disclosure.sources.length).toBeGreaterThan(0);
    expect(res.disclosure.limits.length).toBeGreaterThan(0);
    expect(res.disclosure.method).toMatch(/not a recommendation/i);
  });

  it('still answers with an empty profile rather than erroring', async () => {
    const res = await searchOpportunities(fakeD1Env(CORPUS), {}, 'supported', NOW);
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0].gaps!.length).toBeGreaterThan(0);
    expect(res.profile.track).toBe('nonprofit');
  });
});
