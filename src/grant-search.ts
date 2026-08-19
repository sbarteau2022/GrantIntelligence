// ============================================================
// PUBLIC TIERED OPPORTUNITY SEARCH — src/grant-search.ts
//
// The marketing page's product surface: a visitor describes their
// organization (the same profile shape elle-worker stores in
// grant_organizations — track, org_type, geographic_scope, budget_range,
// entity_stage, mission) and gets back the open opportunities in
// grant_opportunities, ranked.
//
// Two hard rules, both inherited from the engine spec elle-worker
// implements (corpus/engines/03-grant-intelligence.md) and from this
// page's own promise ("facts, not verdicts"):
//
//   1. NO RECOMMENDATION. This module scores structural overlap and names
//      every signal it used. It never says "apply to this one."
//   2. UNKNOWN IS NOT ZERO. A feature the data can't answer (an
//      opportunity with no amount on file, a deadline that doesn't parse)
//      is dropped from the denominator and reported as a gap — never
//      scored as a miss. A thin row must not look like a bad match.
//
// SHAPE: pure scoring/normalization/gating (unit-tested, no I/O) plus one
// thin D1 edge (searchOpportunities). Same split as grant-ingest.ts's
// normalize*/fetch* vs. runGrantIngest.
//
// Deliberately NOT an LLM call. This runs unauthenticated on every visitor
// keystroke-to-submit; it must be cheap, deterministic, and explainable
// line by line. elle-worker's runFitAnalysis (the LLM fit index with a
// sealed reasoning log) is the paid, authenticated counterpart — this is
// the free structural pre-filter that decides what's worth sending there.
// ============================================================

import { ensureGrantWorkerSchema } from './db/schema';
import type { FunderType } from './grant-ingest';

export interface GrantSearchEnv {
  DB: D1Database;
  // JSON map of entitlement key -> tier, e.g. {"k_live_abc":"supported"}.
  // Unset (today) = preview mode: the caller's requested tier is honored.
  // See resolveTier() — same "dormant until deliberately armed" posture as
  // SERVICE_KEY in grant-worker-index.ts.
  TIER_KEYS?: string;
}

// ── The visitor-supplied profile ────────────────────────────────────────
// Field-for-field the public subset of elle-worker's grant_organizations,
// so a visitor who converts hands their answers straight to a saved org
// row with no re-keying and no lossy translation.
export type Track = 'nonprofit' | 'business';

export interface OrgProfile {
  track: Track;
  orgType: string | null;        // '501c3' | 'fiscally-sponsored' | 'llc' | 'c-corp' | 'individual' | 'public-agency' | ...
  state: string | null;          // two-letter US code, uppercase
  focus: string | null;          // free text: what the organization actually does
  fundingNeed: number | null;    // dollars sought — the midpoint the visitor picked
  entityStage: string | null;    // 'idea' | 'early' | 'growth' | 'established'
}

export const ORG_TYPES = [
  '501c3', 'fiscally-sponsored', 'nonprofit-other',
  'llc', 'c-corp', 's-corp', 'b-corp',
  'individual', 'public-agency', 'tribal', 'academic',
] as const;

export const ENTITY_STAGES = ['idea', 'early', 'growth', 'established'] as const;

// Buckets the UI offers; the value carried into scoring is the midpoint.
export const FUNDING_BANDS: Array<{ id: string; label: string; midpoint: number }> = [
  { id: 'under-25k', label: 'Under $25,000', midpoint: 15_000 },
  { id: '25k-100k', label: '$25,000 – $100,000', midpoint: 60_000 },
  { id: '100k-500k', label: '$100,000 – $500,000', midpoint: 275_000 },
  { id: '500k-2m', label: '$500,000 – $2M', midpoint: 1_100_000 },
  { id: 'over-2m', label: 'Over $2M', midpoint: 4_000_000 },
];

export function normalizeProfile(input: unknown): OrgProfile {
  const raw = (input ?? {}) as Record<string, unknown>;
  const s = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t ? t : null;
  };
  const track: Track = s(raw.track)?.toLowerCase() === 'business' ? 'business' : 'nonprofit';
  const state = s(raw.state)?.toUpperCase().slice(0, 2) ?? null;
  const orgType = s(raw.orgType)?.toLowerCase() ?? null;
  const entityStage = s(raw.entityStage)?.toLowerCase() ?? null;

  // fundingNeed arrives either as a band id or as a raw number — accept both
  // so an API caller isn't forced through the UI's bucket vocabulary.
  let fundingNeed: number | null = null;
  if (typeof raw.fundingNeed === 'number' && Number.isFinite(raw.fundingNeed) && raw.fundingNeed > 0) {
    fundingNeed = raw.fundingNeed;
  } else {
    const band = FUNDING_BANDS.find((b) => b.id === s(raw.fundingNeed)?.toLowerCase());
    if (band) fundingNeed = band.midpoint;
  }

  return {
    track,
    // Unrecognized org types drop to null rather than through: every rule
    // that reads orgType keys off a closed set, and a value that matches
    // none of them would silently behave as "not charitable" — a real
    // scoring effect from a typo. Null is scored as unknown instead.
    orgType: orgType && (ORG_TYPES as readonly string[]).includes(orgType) ? orgType : null,
    state: state && /^[A-Z]{2}$/.test(state) ? state : null,
    focus: s(raw.focus)?.slice(0, 600) ?? null,
    fundingNeed,
    entityStage: entityStage && (ENTITY_STAGES as readonly string[]).includes(entityStage) ? entityStage : null,
  };
}

// ── Keyword overlap ─────────────────────────────────────────────────────
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'our', 'are', 'was', 'were', 'has', 'have',
  'who', 'you', 'your', 'their', 'them', 'they', 'its', 'not', 'but', 'all', 'any', 'can', 'will',
  'grant', 'grants', 'funding', 'fund', 'funds', 'program', 'programs', 'project', 'projects',
  'organization', 'organizations', 'work', 'working', 'people', 'community', 'support', 'services',
  'new', 'use', 'using', 'help', 'make', 'build', 'building', 'provide', 'providing', 'about',
]);

// Stem-lite: enough to make "veterans"/"veteran" and "housing"/"house" meet,
// without pulling a stemmer dependency into a Worker bundle.
// One suffix class per word, never two: chaining them turns "housing" into
// "hou", which is short enough to collide with words that share nothing
// with it. A missed match costs one signal; a false match corrupts the
// score AND prints a wrong reason in the response.
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * Stem -> the first original word that produced it.
 *
 * Matching happens on stems; every string we show a visitor is written
 * with the original word. "crisis" stems to "crisi", and printing that
 * back at someone as one of their own terms reads as a bug and quietly
 * costs the whole reading its credibility.
 */
export function tokenizeMap(text: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!text) return out;
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    const key = stem(raw);
    if (!out.has(key)) out.set(key, raw);
  }
  return out;
}

export function tokenize(text: string | null | undefined): Set<string> {
  return new Set(tokenizeMap(text).keys());
}

// ── Eligibility matrix ──────────────────────────────────────────────────
// Which funder types structurally accept which applicant track. This is
// about the SHAPE of the applicant, not their merit: an LLC cannot receive
// a 501(c)(3)-restricted foundation grant without a fiscal sponsor, and an
// accelerator does not write checks to charities.
const TRACK_FUNDER_FIT: Record<Track, Partial<Record<FunderType, number>>> = {
  nonprofit: { federal: 1, state: 1, foundation: 1, corporate: 0.9, international: 0.8, accelerator: 0.15 },
  business: { federal: 0.8, state: 0.9, foundation: 0.35, corporate: 0.8, international: 0.4, accelerator: 1 },
};

// Org types that clear a foundation's 501(c)(3) restriction outright.
const CHARITABLE_ORG_TYPES = new Set(['501c3', 'fiscally-sponsored', 'nonprofit-other', 'tribal', 'academic', 'public-agency']);

// Accelerators and most equity-adjacent programs want a formed company at
// an early stage; established entities are usually out of scope.
const STAGE_FIT_ACCELERATOR: Record<string, number> = { idea: 0.6, early: 1, growth: 0.7, established: 0.25 };

// ── US geography ────────────────────────────────────────────────────────
const STATE_NAMES: Record<string, string> = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado',
  CT: 'connecticut', DE: 'delaware', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho',
  IL: 'illinois', IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky', LA: 'louisiana',
  ME: 'maine', MD: 'maryland', MA: 'massachusetts', MI: 'michigan', MN: 'minnesota',
  MS: 'mississippi', MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada',
  NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico', NY: 'new york',
  NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon',
  PA: 'pennsylvania', RI: 'rhode island', SC: 'south carolina', SD: 'south dakota',
  TN: 'tennessee', TX: 'texas', UT: 'utah', VT: 'vermont', VA: 'virginia', WA: 'washington',
  WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming', DC: 'district of columbia',
};

// Which state(s) an opportunity's own text names, if any. Returns null for
// "no geographic signal in the text at all" — which is NOT the same as
// "open to everyone," and is scored as unknown rather than as a match.
export function detectGeographies(text: string): string[] | null {
  const hay = ` ${text.toLowerCase()} `;
  const found = new Set<string>();
  for (const [code, name] of Object.entries(STATE_NAMES)) {
    if (hay.includes(` ${name} `) || hay.includes(`${name},`) || hay.includes(`${name}-`)) found.add(code);
    // Bare two-letter codes only when clearly delimited — "OR"/"IN"/"ME" are
    // ordinary English words, so an all-caps, punctuation-bounded match is
    // the only form we'll accept.
    else if (new RegExp(`(^|[\\s(,\\-])${code}([\\s).,\\-]|$)`).test(text)) found.add(code);
  }
  return found.size ? [...found] : null;
}

// ── Deadline reading ────────────────────────────────────────────────────
// Deadlines in this table are deliberately free text ("Rolling", "FY26
// open", "2026-05-05", "Paused — reauthorization pending") because that is
// how the portals state them. Read what can be read; say so when it can't.
export type DeadlineState = 'open' | 'rolling' | 'passed' | 'paused' | 'unknown';

export function readDeadline(raw: string | null, now: Date): { state: DeadlineState; iso: string | null } {
  if (!raw) return { state: 'unknown', iso: null };
  const t = raw.trim().toLowerCase();
  if (!t) return { state: 'unknown', iso: null };
  if (t.includes('paused') || t.includes('suspend')) return { state: 'paused', iso: null };
  if (t.includes('rolling') || t.includes('continuous') || t.includes('any time') || t.includes('anytime')) {
    return { state: 'rolling', iso: null };
  }

  // ISO first (what both live sources emit), then US M/D/Y (what Grants.gov
  // renders in some fields).
  const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  const usa = t.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  let when: Date | null = null;
  if (iso) when = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
  else if (usa) when = new Date(Date.UTC(+usa[3], +usa[1] - 1, +usa[2]));
  if (when && !Number.isNaN(when.getTime())) {
    const isoStr = when.toISOString().slice(0, 10);
    return { state: when.getTime() >= now.getTime() ? 'open' : 'passed', iso: isoStr };
  }

  // "FY26", "2026" and friends: a year we can compare, but not a date.
  const fy = t.match(/\b(?:fy)?\s?(20\d{2}|\d{2})\b/);
  if (fy) {
    const yr = fy[1].length === 2 ? 2000 + Number(fy[1]) : Number(fy[1]);
    return { state: yr >= now.getUTCFullYear() ? 'open' : 'passed', iso: null };
  }
  return { state: 'unknown', iso: null };
}

// ── The scored row ──────────────────────────────────────────────────────
export interface OpportunityRow {
  id: string;
  source: string;
  funder_name: string;
  funder_type: FunderType;
  program_name: string | null;
  amount_min: number | null;
  amount_max: number | null;
  deadline: string | null;
  stated_priorities: string | null;
  necaif_applicable: number;
  status: string | null;
}

export interface MatchSignal {
  feature: 'focus' | 'eligibility' | 'amount' | 'geography' | 'timing';
  label: string;
  score: number;   // 0..1
  weight: number;
  detail: string;  // why — always plain language, always about the data, never a verdict
}

export interface MatchReading {
  score: number;              // 0..1, renormalized over the features that had data
  band: 'strong' | 'possible' | 'weak';
  signals: MatchSignal[];     // only the features that could be answered
  gaps: string[];             // the features that could NOT be answered, named
  deadline_state: DeadlineState;
  deadline_iso: string | null;
}

const WEIGHTS = { focus: 0.34, eligibility: 0.26, amount: 0.16, geography: 0.14, timing: 0.10 } as const;

function band(score: number): MatchReading['band'] {
  if (score >= 0.66) return 'strong';
  if (score >= 0.38) return 'possible';
  return 'weak';
}

/**
 * Score one opportunity against one profile. Pure — same inputs, same
 * output, no clock of its own (pass `now`), no I/O.
 *
 * Every feature returns either a score with a plain-language reason, or
 * nothing at all. Nothing-at-all leaves the weight OUT of the denominator
 * and lands in `gaps`, so a row with two answerable features is scored on
 * those two rather than being punished for the three we can't see.
 */
export function scoreOpportunity(profile: OrgProfile, opp: OpportunityRow, now: Date): MatchReading {
  const signals: MatchSignal[] = [];
  const gaps: string[] = [];
  const oppText = [opp.funder_name, opp.program_name, opp.stated_priorities].filter(Boolean).join(' ');

  // 1. FOCUS — keyword overlap between what the visitor does and what the
  //    opportunity's own text says it funds.
  const profileTokens = tokenizeMap(profile.focus);
  if (profileTokens.size === 0) {
    gaps.push('You did not describe what your organization does, so mission overlap was not scored.');
  } else {
    const oppTokens = tokenize(oppText);
    // Match on stems, report the visitor's own words.
    const hits = [...profileTokens].filter(([key]) => oppTokens.has(key)).map(([, word]) => word);
    // Denominator caps at 6: matching 6 distinct concepts is already a
    // strong signal, and a longer description must not dilute its own score.
    const score = Math.min(1, hits.length / Math.min(6, Math.max(1, profileTokens.size)));
    signals.push({
      feature: 'focus', label: 'Mission overlap', score, weight: WEIGHTS.focus,
      detail: hits.length
        ? `Shared terms with this listing: ${hits.slice(0, 6).join(', ')}.`
        : 'No shared terms between your description and this listing’s own text.',
    });
  }

  // 2. ELIGIBILITY — structural shape of the applicant vs. the funder type.
  let elig = TRACK_FUNDER_FIT[profile.track][opp.funder_type] ?? 0.5;
  const eligNotes: string[] = [
    `${profile.track === 'business' ? 'A for-profit applicant' : 'A nonprofit applicant'} against a ${opp.funder_type} funder.`,
  ];
  if (opp.funder_type === 'foundation' || opp.funder_type === 'corporate') {
    if (profile.orgType && CHARITABLE_ORG_TYPES.has(profile.orgType)) {
      elig = Math.min(1, elig + 0.1);
      eligNotes.push('Your entity type clears the usual 501(c)(3) restriction directly.');
    } else if (profile.orgType) {
      elig = Math.max(0, elig - 0.1);
      eligNotes.push('Most foundations restrict awards to charitable entities — a fiscal sponsor is the usual route here.');
    }
  }
  if (opp.funder_type === 'accelerator' && profile.entityStage) {
    const stageFit = STAGE_FIT_ACCELERATOR[profile.entityStage] ?? 0.6;
    elig = (elig + stageFit) / 2;
    eligNotes.push(`Accelerators typically target early-stage entities; you selected "${profile.entityStage}".`);
  }
  signals.push({
    feature: 'eligibility', label: 'Entity fit', score: elig, weight: WEIGHTS.eligibility,
    detail: eligNotes.join(' '),
  });

  // 3. AMOUNT — is what you need inside what they give?
  const min = opp.amount_min;
  const max = opp.amount_max;
  if (profile.fundingNeed == null) {
    gaps.push('You did not state how much you need, so award-size fit was not scored.');
  } else if (min == null && max == null) {
    gaps.push(`No award amount is on file for "${opp.program_name ?? opp.funder_name}", so award-size fit was not scored.`);
  } else {
    const lo = min ?? 0;
    const hi = max ?? Number.POSITIVE_INFINITY;
    const need = profile.fundingNeed;
    let score: number;
    let detail: string;
    if (need >= lo && need <= hi) {
      score = 1;
      detail = 'What you need falls inside this award’s stated range.';
    } else {
      // Decay by ratio, not by dollars — being 2x over on a $50k grant is
      // the same kind of miss as being 2x over on a $5M one.
      const ratio = need > hi ? need / Math.max(hi, 1) : Math.max(lo, 1) / Math.max(need, 1);
      score = Math.max(0, 1 - Math.log10(ratio) / 1.5);
      detail = need > hi
        ? 'You need more than this award’s stated ceiling.'
        : 'You need less than this award’s stated floor — many funders will not award below it.';
    }
    signals.push({ feature: 'amount', label: 'Award size', score, weight: WEIGHTS.amount, detail });
  }

  // 4. GEOGRAPHY — only scored when the listing itself names a place.
  const geos = detectGeographies(oppText);
  if (!profile.state) {
    gaps.push('You did not select a state, so geographic scope was not scored.');
  } else if (!geos) {
    if (opp.funder_type === 'federal') {
      signals.push({
        feature: 'geography', label: 'Geographic scope', score: 1, weight: WEIGHTS.geography,
        detail: 'A federal program with no state restriction named in its listing.',
      });
    } else {
      gaps.push(`"${opp.program_name ?? opp.funder_name}" names no geography in its listing, so scope was not scored.`);
    }
  } else {
    const hit = geos.includes(profile.state);
    signals.push({
      feature: 'geography', label: 'Geographic scope', score: hit ? 1 : 0.05, weight: WEIGHTS.geography,
      detail: hit
        ? `This listing names ${profile.state}, where you are.`
        : `This listing names ${geos.join(', ')} — not ${profile.state}.`,
    });
  }

  // 5. TIMING — can you still apply?
  const dl = readDeadline(opp.deadline, now);
  if (dl.state === 'unknown') {
    gaps.push(`The deadline on file (${opp.deadline ? `"${opp.deadline}"` : 'none'}) could not be read as a date.`);
  } else {
    const timingScore = dl.state === 'rolling' ? 1 : dl.state === 'open' ? 0.95 : dl.state === 'paused' ? 0.2 : 0;
    signals.push({
      feature: 'timing', label: 'Deadline', score: timingScore, weight: WEIGHTS.timing,
      detail: {
        rolling: 'Rolling — no fixed close date.',
        open: `Still open${dl.iso ? ` (closes ${dl.iso})` : ''}.`,
        paused: 'The listing itself says this program is paused.',
        passed: 'The stated deadline has passed.',
        unknown: '',
      }[dl.state],
    });
  }

  const totalWeight = signals.reduce((a, s) => a + s.weight, 0);
  const score = totalWeight > 0 ? signals.reduce((a, s) => a + s.score * s.weight, 0) / totalWeight : 0;

  return { score, band: band(score), signals, gaps, deadline_state: dl.state, deadline_iso: dl.iso };
}

// ── Tiers ───────────────────────────────────────────────────────────────
// The pricing page's four tiers, made real. Everything a tier does NOT get
// is removed HERE, server-side, before the response is serialized — never
// sent-and-hidden in the browser.
export type Tier = 'basic' | 'supported' | 'full' | 'enterprise';

export interface TierSpec {
  id: Tier;
  label: string;
  price: string;
  resultLimit: number;
  fitDetail: boolean;   // the numeric score + per-signal breakdown + gaps
  necaif: boolean;      // whether a NECAI-F donor evaluation is offered for this funder
  financials: boolean;  // the funder's 990 overview
  unlocks: string[];    // plain-language, shown in the UI's tier rail
}

export const TIERS: Record<Tier, TierSpec> = {
  basic: {
    id: 'basic', label: 'Basic', price: 'Free — always', resultLimit: 5,
    fitDetail: false, necaif: false, financials: false,
    unlocks: ['Matched opportunities', 'Deadlines', 'Stated requirements'],
  },
  supported: {
    id: 'supported', label: 'Supported', price: '1–3% of the award — $0 if you don’t win', resultLimit: 25,
    fitDetail: true, necaif: true, financials: true,
    unlocks: ['Everything in Basic', 'Fit index with every signal named', 'What the data could not answer', 'NECAI-F donor evaluation', '990 financial overview'],
  },
  full: {
    id: 'full', label: 'Full service', price: '3–5%, or a retainer', resultLimit: 100,
    fitDetail: true, necaif: true, financials: true,
    unlocks: ['Everything in Supported', 'Full result set', 'Proposal development end to end'],
  },
  enterprise: {
    id: 'enterprise', label: 'Enterprise', price: 'Metered', resultLimit: 250,
    fitDetail: true, necaif: true, financials: true,
    unlocks: ['Everything in Full service', 'Metered API access', 'Bulk profile matching'],
  },
};

export const TIER_ORDER: Tier[] = ['basic', 'supported', 'full', 'enterprise'];

export function isTier(v: unknown): v is Tier {
  return typeof v === 'string' && (TIER_ORDER as string[]).includes(v);
}

/**
 * What tier this request is actually entitled to.
 *
 * TIER_KEYS unset (today) = preview mode: the requested tier is honored, so
 * the marketing page can demonstrate every tier without an account existing
 * yet. This is NOT a paywall and must not be described as one. Set TIER_KEYS
 * (`wrangler secret put TIER_KEYS`) to a JSON object mapping entitlement key
 * to tier and the request must then present `X-GI-Entitlement: <key>`;
 * anything unrecognized falls back to basic rather than erroring, so a
 * lapsed key degrades to the free product instead of a broken page.
 */
export function resolveTier(env: GrantSearchEnv, requested: unknown, presentedKey: string | null): {
  tier: Tier; requested: Tier; enforced: boolean;
} {
  const want: Tier = isTier(requested) ? requested : 'basic';
  if (!env.TIER_KEYS) return { tier: want, requested: want, enforced: false };
  let map: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(env.TIER_KEYS);
    if (parsed && typeof parsed === 'object') map = parsed as Record<string, unknown>;
  } catch {
    // A malformed TIER_KEYS must fail closed to the free tier, never open.
    return { tier: 'basic', requested: want, enforced: true };
  }
  const granted = presentedKey ? map[presentedKey] : undefined;
  const tier: Tier = isTier(granted) ? granted : 'basic';
  // Never hand out more than the key grants, and never more than was asked
  // for either (an enterprise key browsing the free view stays free).
  const idx = Math.min(TIER_ORDER.indexOf(tier), TIER_ORDER.indexOf(want));
  return { tier: TIER_ORDER[Math.max(0, idx)], requested: want, enforced: true };
}

// ── The response ────────────────────────────────────────────────────────
export interface FunderFinancials {
  most_recent_filing_year: number | null;
  total_revenue: number | null;
  total_expenses: number | null;
  contributions_received: number | null;
  total_assets_end: number | null;
  source_url: string | null;
}

export interface SearchResultRow {
  id: string;
  source: string;
  funder_name: string;
  funder_type: FunderType;
  program_name: string | null;
  deadline: string | null;
  deadline_state: DeadlineState;
  deadline_iso: string | null;
  amount_min: number | null;
  amount_max: number | null;
  requirements: string | null;
  band: MatchReading['band'];
  // Supported and above only — omitted entirely at Basic.
  score?: number;
  signals?: MatchSignal[];
  gaps?: string[];
  necaif_available?: boolean;
  financials?: FunderFinancials | null;
}

export interface SearchResponse {
  tier: Tier;
  tier_requested: Tier;
  entitlement_enforced: boolean;
  profile: OrgProfile;
  total_matches: number;   // before the tier's result cap
  returned: number;
  withheld: number;        // matches this tier's cap did not return
  locked_fields: string[]; // named, not silently missing
  results: SearchResultRow[];
  disclosure: {
    method: string;
    sources: string[];
    limits: string[];
  };
}

const LOCKED_AT_BASIC = ['score', 'signals', 'gaps', 'necaif_available', 'financials'];

// grant_funder_990_overview stores every figure in cents (integer); the
// response speaks dollars, same as grant_opportunities' amount columns.
function dollarsFromCents(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v / 100 : null;
}

/**
 * The one impure edge: read open opportunities from D1, score them all in
 * memory, then cut to the tier.
 *
 * Scoring in memory rather than in SQL is deliberate — the corpus is in the
 * low thousands of rows, the scoring is explainable line by line only in
 * TypeScript, and every signal string in the response has to come from the
 * same code path the tests cover.
 */
export async function searchOpportunities(
  env: GrantSearchEnv,
  profileInput: unknown,
  tier: Tier,
  now: Date = new Date(),
): Promise<Omit<SearchResponse, 'tier' | 'tier_requested' | 'entitlement_enforced'>> {
  await ensureGrantWorkerSchema(env.DB);
  const profile = normalizeProfile(profileInput);
  const spec = TIERS[tier];

  const { results: rows } = await env.DB.prepare(
    `SELECT id, source, funder_name, funder_type, program_name, amount_min, amount_max,
            deadline, stated_priorities, necaif_applicable, status
       FROM grant_opportunities
      WHERE status = 'open'`
  ).all<OpportunityRow>();

  const scored = (rows ?? [])
    .map((opp) => ({ opp, match: scoreOpportunity(profile, opp, now) }))
    // A listing whose own text says the deadline has passed is not a match,
    // whatever else it scores — the row just hasn't been closed upstream yet.
    .filter(({ match }) => match.deadline_state !== 'passed')
    .sort((a, b) => b.match.score - a.match.score || a.opp.funder_name.localeCompare(b.opp.funder_name));

  const page = scored.slice(0, spec.resultLimit);

  // One financials query for the whole page, not one per row.
  const financialsByFunder = new Map<string, FunderFinancials>();
  if (spec.financials && page.length) {
    const names = [...new Set(page.map((p) => p.opp.funder_name))];
    const placeholders = names.map(() => '?').join(',');
    const fin = await env.DB.prepare(
      `SELECT funder_name, most_recent_filing_year, total_revenue_cents, total_expenses_cents,
              contributions_gifts_grants_cents, total_assets_end_cents, source_url
         FROM grant_funder_990_overview
        WHERE funder_name IN (${placeholders})`
    ).bind(...names).all<Record<string, unknown>>().catch(() => ({ results: [] as Record<string, unknown>[] }));
    for (const r of fin.results ?? []) {
      financialsByFunder.set(String(r.funder_name), {
        most_recent_filing_year: typeof r.most_recent_filing_year === 'number' ? r.most_recent_filing_year : null,
        total_revenue: dollarsFromCents(r.total_revenue_cents),
        total_expenses: dollarsFromCents(r.total_expenses_cents),
        contributions_received: dollarsFromCents(r.contributions_gifts_grants_cents),
        total_assets_end: dollarsFromCents(r.total_assets_end_cents),
        source_url: typeof r.source_url === 'string' ? r.source_url : null,
      });
    }
  }

  const results: SearchResultRow[] = page.map(({ opp, match }) => {
    const row: SearchResultRow = {
      id: opp.id,
      source: opp.source,
      funder_name: opp.funder_name,
      funder_type: opp.funder_type,
      program_name: opp.program_name,
      deadline: opp.deadline,
      deadline_state: match.deadline_state,
      deadline_iso: match.deadline_iso,
      amount_min: opp.amount_min,
      amount_max: opp.amount_max,
      requirements: opp.stated_priorities,
      band: match.band,
    };
    if (spec.fitDetail) {
      row.score = Math.round(match.score * 1000) / 1000;
      row.signals = match.signals;
      row.gaps = match.gaps;
    }
    if (spec.necaif) row.necaif_available = opp.necaif_applicable === 1;
    if (spec.financials) row.financials = financialsByFunder.get(opp.funder_name) ?? null;
    return row;
  });

  return {
    profile,
    total_matches: scored.length,
    returned: results.length,
    withheld: Math.max(0, scored.length - results.length),
    locked_fields: spec.fitDetail ? [] : LOCKED_AT_BASIC,
    results,
    disclosure: {
      method:
        'Structural overlap only, scored in code — mission-term overlap, entity fit, award size, ' +
        'geographic scope, and deadline state. Each feature the data could not answer is dropped ' +
        'from the score and named under "not scored" rather than counted as a miss. This is not a ' +
        'prediction of your outcome, and it is not a recommendation.',
      sources: [
        'Grants.gov search2 API (federal opportunities)',
        'SBIR.gov public solicitations API (NSF)',
        'ProPublica Nonprofit Explorer (IRS 990 filings)',
        'Operator-captured listings from funder portals with no public API',
      ],
      limits: [
        'Only opportunities already ingested into this database are searched — this is not the full federal catalog.',
        'Award amounts are absent on many federal listings; those rows are scored without an award-size signal.',
        'Eligibility here is structural. It is not a legal eligibility determination — read the funder’s own notice.',
      ],
    },
  };
}
