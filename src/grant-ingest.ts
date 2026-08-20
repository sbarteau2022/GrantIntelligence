// ============================================================
// LIVE GRANT OPPORTUNITY INGEST — src/grant-ingest.ts
//
// Moved here from elle-worker's src/grant-ingest.ts (see that repo's PR #324
// and the follow-up that extracted the whole grant data layer into this
// standalone worker) — elle-worker now only reasons over this data via a
// direct D1 binding; it neither ingests nor maintains it.
//
// Two free, keyless federal sources. This is NOT a full-catalog pull, but it
// is no longer pinned to one operator's own strategy document either — the
// public search on the marketing page is only as good as what lands here:
//   - Grants.gov search2 API — a topic-driven query set spanning veterans,
//     mental health, substance use, rural health, workforce, housing,
//     community development, AI, and small-business innovation, plus three
//     agency-pinned slices (VA, HHS/SAMHSA, NSF). See GRANTS_GOV_QUERIES.
//   - SBIR.gov public solicitations API — every agency, open only.
//
// Neither source (nor SEED_OPPORTUNITIES below) covers the private
// foundations/accelerators the map doc also names (Bob Woodruff, Arch
// Grants, Mozilla, McGovern, Open Philanthropy) — those have no public
// opportunity-search API at all and stay sourced by hand or via RAPIDAi's
// atlas-capture browser extension's grants plugin (operator-driven, by
// design not automated — see apps/atlas-capture in the RAPIDAi repo; this
// worker does not yet consume that extension's staging table — see README).
//
// "Maintains the database," not just an inserter: each run also closes any
// previously-open row from a source that fetched cleanly this run but no
// longer contains that row (it closed/expired/withdrew upstream). A source
// that errored this run is left alone entirely — a transient API outage
// must never read as "everything from that source just closed."
//
// This sandbox's outbound network policy blocks both api.grants.gov and
// api.www.sbir.gov, so these request/response shapes are best-effort from
// public API documentation, NOT verified against a live response.
// Normalization is deliberately defensive (every field optional, nothing
// throws on an unexpected shape) so a documentation mismatch degrades to
// "fewer fields populated," never a thrown error that takes the whole
// ingest down. Verify field names against a real response from the
// deployed Worker (unrestricted egress) before trusting amounts/deadlines.
// ============================================================

import { ensureGrantWorkerSchema } from './db/schema';

export interface GrantWorkerEnv {
  DB: D1Database;
}

const USER_AGENT = 'grant-intelligence-worker/live-ingest (+https://github.com/sbarteau2022/GrantIntelligence)';

export type FunderType = 'federal' | 'state' | 'foundation' | 'corporate' | 'international' | 'accelerator';
export type LiveSource = 'grants.gov' | 'sbir.gov';

export interface NormalizedLiveOpportunity {
  id: string; // stable — derived from the source's own opportunity/solicitation number, so re-ingestion upserts rather than duplicates
  source: LiveSource;
  funder_name: string;
  funder_type: FunderType;
  program_name: string | null;
  amount_min: number | null;
  amount_max: number | null;
  deadline: string | null;
  stated_priorities: string | null;
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

// ── Manual seed — carried over from elle-worker's grant-strategy-map.md
// reading. Kept here (not fetched from elle-worker) so this worker has zero
// startup dependency on anything else, per its own design brief. ─────────
interface SeedOpportunity {
  id: string;
  funder_name: string;
  funder_type: FunderType;
  program_name: string;
  amount_min?: number;
  amount_max?: number;
  deadline?: string;
  stated_priorities?: string;
  necaif_applicable: 0 | 1;
}

export const SEED_OPPORTUNITIES: SeedOpportunity[] = [
  { id: 'ssg-fox-fy26', funder_name: 'U.S. Dept. of Veterans Affairs', funder_type: 'federal', program_name: 'SSG Fox Suicide Prevention Grant', amount_min: 750000, amount_max: 750000, deadline: 'FY26 open', stated_priorities: 'Rural veteran focus; AI peer support in the gap between crisis and care; renewable', necaif_applicable: 0 },
  { id: 'samhsa-recovery-fy26', funder_name: 'Substance Abuse & Mental Health Services Admin.', funder_type: 'federal', program_name: 'SAMHSA Recovery Support Grant', amount_min: 125000, deadline: 'FY26', stated_priorities: 'Substance-use recovery support tool; varies by program', necaif_applicable: 0 },
  { id: 'bob-woodruff-rolling', funder_name: 'Bob Woodruff Foundation', funder_type: 'foundation', program_name: 'Veterans & Military Families (rolling)', deadline: 'Rolling', stated_priorities: 'Private foundation, faster than federal; no nonprofit required from the applicant', necaif_applicable: 1 },
  { id: 'mtc-idea-jul26', funder_name: 'Missouri Technology Corporation', funder_type: 'state', program_name: 'MTC IDEA Fund — July 2026 cycle', amount_max: 5800000, deadline: '2026-05-05', stated_priorities: 'Missouri-based; provisional patent satisfies IP requirement; needs a lead investor', necaif_applicable: 0 },
  { id: 'arch-grants-rolling', funder_name: 'Arch Grants', funder_type: 'accelerator', program_name: 'Arch Grants — St. Louis', amount_min: 75000, amount_max: 75000, deadline: 'Rolling', stated_priorities: 'Equity-free; no institutional requirements beyond LLC formation; St. Louis presence', necaif_applicable: 0 },
  { id: 'mozilla-ai-2026', funder_name: 'Mozilla Foundation', funder_type: 'foundation', program_name: 'Mozilla Democracy × AI Incubator', amount_max: 300000, deadline: '2026', stated_priorities: 'Information ecosystem resilience; community-led AI governance; top 2 of 10 advance', necaif_applicable: 1 },
  { id: 'mcgovern-emergent-ai', funder_name: 'Patrick J. McGovern Foundation', funder_type: 'foundation', program_name: 'Emergent AI', amount_min: 250000, deadline: 'Prep now — letter of inquiry', stated_priorities: 'Emergent AI for public benefit; prior awards $250k-$600k in this space in 2026', necaif_applicable: 1 },
  { id: 'open-phil-ai-safety', funder_name: 'Open Philanthropy Project', funder_type: 'foundation', program_name: 'AI Safety RFP', amount_max: 40000000, deadline: 'Rolling', stated_priorities: '$40M committed across AI-safety directions (2025 cycle); theoretical-alignment track', necaif_applicable: 1 },
  { id: 'nsf-sbir-ai', funder_name: 'National Science Foundation', funder_type: 'federal', program_name: 'NSF SBIR — AI Track', amount_max: 2000000, deadline: 'Paused — reauthorization pending', stated_priorities: 'Non-dilutive, no equity; Human-Computer Interaction track', necaif_applicable: 0 },
];

// ── Grants.gov search2 ──────────────────────────────────────────────────
// Public POST endpoint, no key: https://www.grants.gov/api (search2).
// One query per slice rather than one broad pull, so a single slow/failing
// query doesn't take the others down with it.
//
// This set used to be three agency-pinned queries drawn from one operator's
// own strategy document. That made the public search only as good as that
// document: a visitor outside those three agencies' subject areas got a
// short list and no way to tell whether that meant "few matches" or "few
// records." The set below is topic-driven and mostly agency-agnostic, so
// coverage follows the subject space the product actually serves.
//
// `agencies: null` means no agency filter — the keyword sweeps every
// federal agency posting to Grants.gov. The three original agency-pinned
// queries are kept alongside, because an agency filter surfaces listings
// whose titles don't contain the topic words at all.
//
// Bounded on purpose: one subrequest per entry, and Workers cap outbound
// subrequests per invocation. Adding a topic here is cheap; adding fifty
// is not. Overlap between entries is expected and handled — the same
// opportunity returned by three queries dedupes to one row before any
// write (see runGrantIngest).
const GRANTS_GOV_URL = 'https://api.grants.gov/v1/api/search2';
const GRANTS_GOV_ROWS_PER_QUERY = 25;
export const GRANTS_GOV_QUERIES: Array<{ agencies: string | null; keyword: string }> = [
  // Agency-pinned — the original three, kept for the reason above.
  { agencies: 'VA', keyword: 'veteran suicide prevention' },
  { agencies: 'HHS-SAMHSA', keyword: 'recovery support substance use' },
  { agencies: 'NSF', keyword: 'artificial intelligence human-computer interaction' },
  // Topic sweeps across every agency.
  { agencies: null, keyword: 'veterans military families' },
  { agencies: null, keyword: 'mental health crisis services' },
  { agencies: null, keyword: 'substance use disorder treatment' },
  { agencies: null, keyword: 'rural health access' },
  { agencies: null, keyword: 'workforce development training' },
  { agencies: null, keyword: 'affordable housing homelessness' },
  { agencies: null, keyword: 'community development capacity building' },
  { agencies: null, keyword: 'artificial intelligence research' },
  { agencies: null, keyword: 'small business innovation technology' },
];

interface GrantsGovHit {
  id?: number | string;
  number?: string;
  title?: string;
  agencyCode?: string;
  agency?: string;
  openDate?: string;
  closeDate?: string;
  oppStatus?: string;
}

export function normalizeGrantsGovHit(hit: GrantsGovHit): NormalizedLiveOpportunity | null {
  const number = str(hit.number) ?? (hit.id != null ? String(hit.id) : null);
  const title = str(hit.title);
  if (!number || !title) return null;
  return {
    id: `grants-gov-${number}`,
    source: 'grants.gov',
    funder_name: str(hit.agency) ?? str(hit.agencyCode) ?? 'Unknown federal agency',
    funder_type: 'federal', // every Grants.gov listing is a federal agency by construction
    program_name: title,
    // search2's hit list carries no award-ceiling figure — that lives in the
    // per-opportunity synopsis detail (a second subrequest per hit, not made
    // here to keep this a bounded, small number of calls per run).
    amount_min: null,
    amount_max: null,
    deadline: str(hit.closeDate),
    stated_priorities: null,
  };
}

export async function fetchGrantsGovOpportunities(): Promise<{ opportunities: NormalizedLiveOpportunity[]; errors: string[] }> {
  const opportunities: NormalizedLiveOpportunity[] = [];
  const errors: string[] = [];
  for (const q of GRANTS_GOV_QUERIES) {
    // Names the slice in any error: agency-pinned slices by agency, topic
    // sweeps by keyword. "grants.gov null" would tell an operator nothing.
    const label = `grants.gov ${q.agencies ?? `[${q.keyword}]`}`;
    try {
      const res = await fetch(GRANTS_GOV_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'user-agent': USER_AGENT },
        // The agencies field is omitted entirely (not sent as null) when the
        // slice is agency-agnostic — search2 treats a present-but-empty
        // filter differently from an absent one.
        body: JSON.stringify({
          keyword: q.keyword,
          ...(q.agencies ? { agencies: q.agencies } : {}),
          oppStatuses: 'posted', rows: GRANTS_GOV_ROWS_PER_QUERY, startRecordNum: 0,
        }),
      });
      if (!res.ok) { errors.push(`${label}: HTTP ${res.status}`); continue; }
      const data = (await res.json().catch(() => null)) as { data?: { oppHits?: GrantsGovHit[] } } | null;
      // An envelope we don't recognize is an ERROR, not zero results. These
      // shapes come from public documentation, not a verified live response
      // (see the module header), so a silent upstream change would otherwise
      // read as "every grants.gov opportunity closed at once" and the
      // close-stale pass below would act on it. A well-formed response whose
      // oppHits is empty (or omits the key) is still a real, clean zero and
      // does close stale rows — that distinction is the whole point.
      if (!data || typeof data.data !== 'object' || data.data === null) {
        errors.push(`${label}: unrecognized response envelope (no "data" object)`);
        continue;
      }
      const rawHits = data.data.oppHits;
      if (rawHits != null && !Array.isArray(rawHits)) {
        errors.push(`${label}: unrecognized response envelope ("data.oppHits" is not an array)`);
        continue;
      }
      const hits = rawHits ?? [];
      for (const hit of hits) {
        const norm = normalizeGrantsGovHit(hit);
        if (norm) opportunities.push(norm);
      }
    } catch (e) {
      errors.push(`${label}: ${(e as Error).message}`);
    }
  }
  return { opportunities, errors };
}

// ── SBIR.gov public solicitations ───────────────────────────────────────
// Public GET endpoint, no key. Open solicitations only — a paused federal
// SBIR program (see the seed's own "Paused — reauthorization pending" row)
// should read as absent from an "open" filter, not as an error.
//
// The agency filter is gone. This was pinned to NSF because one strategy
// document named NSF SBIR's AI/HCI track; but SBIR/STTR is eleven agencies,
// every one of them non-dilutive money a small company can actually reach,
// and pinning to one of them hid the other ten from every visitor on the
// business track. Still one subrequest either way.
const SBIR_URL = 'https://api.www.sbir.gov/public/api/solicitations?open=1';

interface SbirSolicitation {
  solicitation_number?: string;
  solicitation_title?: string;
  agency?: string;
  branch?: string;
  close_date?: string;
  open_date?: string;
  current_status?: string;
}

export function normalizeSbirSolicitation(s: SbirSolicitation): NormalizedLiveOpportunity | null {
  const number = str(s.solicitation_number);
  const title = str(s.solicitation_title);
  if (!number || !title) return null;
  return {
    id: `sbir-gov-${number}`,
    source: 'sbir.gov',
    // Was 'National Science Foundation' — safe while the query itself was
    // pinned to NSF, a fabrication now that it isn't. A solicitation with no
    // agency field names no funder, and says so.
    funder_name: str(s.agency) ?? 'Unknown SBIR/STTR agency',
    funder_type: 'federal',
    program_name: title,
    amount_min: null,
    amount_max: null,
    deadline: str(s.close_date),
    stated_priorities: str(s.branch),
  };
}

export async function fetchSbirOpportunities(): Promise<{ opportunities: NormalizedLiveOpportunity[]; errors: string[] }> {
  try {
    const res = await fetch(SBIR_URL, { headers: { 'user-agent': USER_AGENT } });
    if (!res.ok) return { opportunities: [], errors: [`sbir.gov: HTTP ${res.status}`] };
    const data = (await res.json().catch(() => null)) as SbirSolicitation[] | null;
    // Same rule as grants.gov above: a non-array body is an unrecognized
    // envelope (an error), never an empty catalogue. An actual empty array
    // IS a clean zero — NSF SBIR genuinely has no open solicitations while
    // reauthorization is pending — and does close stale rows.
    if (!Array.isArray(data)) {
      return { opportunities: [], errors: ['sbir.gov: unrecognized response envelope (expected a JSON array)'] };
    }
    const opportunities: NormalizedLiveOpportunity[] = [];
    for (const s of data) {
      const norm = normalizeSbirSolicitation(s);
      if (norm) opportunities.push(norm);
    }
    return { opportunities, errors: [] };
  } catch (e) {
    return { opportunities: [], errors: [`sbir.gov: ${(e as Error).message}`] };
  }
}

// ── Manual seed upsert — idempotent, safe to re-run as the hand-copied list
// above changes. ─────────────────────────────────────────────────────────
export async function seedOpportunities(env: GrantWorkerEnv): Promise<{ inserted: number; updated: number }> {
  await ensureGrantWorkerSchema(env.DB);
  let inserted = 0, updated = 0;
  for (const o of SEED_OPPORTUNITIES) {
    const existing = await env.DB.prepare(`SELECT id FROM grant_opportunities WHERE id = ?`).bind(o.id).first();
    await env.DB.prepare(
      `INSERT INTO grant_opportunities (id, source, funder_name, funder_type, program_name, amount_min, amount_max, deadline, stated_priorities, necaif_applicable, status)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'open')
       ON CONFLICT(id) DO UPDATE SET
         funder_name=excluded.funder_name, funder_type=excluded.funder_type, program_name=excluded.program_name,
         amount_min=excluded.amount_min, amount_max=excluded.amount_max, deadline=excluded.deadline,
         stated_priorities=excluded.stated_priorities, necaif_applicable=excluded.necaif_applicable,
         updated_at=datetime('now')`
    ).bind(
      o.id, 'grant-strategy-map', o.funder_name, o.funder_type, o.program_name,
      o.amount_min ?? null, o.amount_max ?? null, o.deadline ?? null, o.stated_priorities ?? null, o.necaif_applicable,
    ).run();
    if (existing) updated++; else inserted++;
  }
  return { inserted, updated };
}

// ── Orchestration: ingest + maintain ────────────────────────────────────
export interface GrantIngestResult {
  fetched: number;      // distinct opportunities after dedup — what was written
  fetched_raw: number;  // hits before dedup; fetched_raw >> fetched means the query set overlaps heavily
  inserted: number;
  updated: number;
  closed: number;
  errors: string[];
}

export async function runGrantIngest(env: GrantWorkerEnv): Promise<GrantIngestResult> {
  await ensureGrantWorkerSchema(env.DB);

  const [grantsGov, sbir] = await Promise.all([fetchGrantsGovOpportunities(), fetchSbirOpportunities()]);
  const opportunities = [...grantsGov.opportunities, ...sbir.opportunities];
  const errors = [...grantsGov.errors, ...sbir.errors];

  // Dedupe by stable id before touching D1. The topic query set overlaps by
  // design (a rural veterans' mental-health grant answers three of them), so
  // without this the same opportunity is written once per query that found
  // it, and every duplicate after the first reports as an "update" — turning
  // the run summary into fiction and doing N times the D1 writes.
  const uniqueById = new Map<string, NormalizedLiveOpportunity>();
  for (const o of opportunities) if (!uniqueById.has(o.id)) uniqueById.set(o.id, o);

  let inserted = 0;
  let updated = 0;
  const seenIds = new Set<string>();
  for (const o of uniqueById.values()) {
    seenIds.add(o.id);
    const existing = await env.DB.prepare(`SELECT id FROM grant_opportunities WHERE id = ?`).bind(o.id).first();
    // necaif_applicable is always 0 here — both sources are exclusively
    // federal agencies, and NECAI-F only ever evaluates foundation/corporate
    // funders (elle-worker's runNecaifEvaluation enforces the same gate).
    await env.DB.prepare(
      `INSERT INTO grant_opportunities (id, source, funder_name, funder_type, program_name, amount_min, amount_max, deadline, stated_priorities, necaif_applicable, status)
       VALUES (?,?,?,?,?,?,?,?,?, 0, 'open')
       ON CONFLICT(id) DO UPDATE SET
         funder_name=excluded.funder_name, funder_type=excluded.funder_type, program_name=excluded.program_name,
         amount_min=excluded.amount_min, amount_max=excluded.amount_max, deadline=excluded.deadline,
         stated_priorities=excluded.stated_priorities, status='open', updated_at=datetime('now')`
    ).bind(
      o.id, o.source, o.funder_name, o.funder_type, o.program_name,
      o.amount_min, o.amount_max, o.deadline, o.stated_priorities,
    ).run();
    if (existing) updated++; else inserted++;
  }

  // Maintain: close any previously-open row owned by a source that fetched
  // cleanly this run but no longer contains that row. A source with ANY
  // error this run is skipped entirely for closing — an outage on one of
  // three grants.gov queries must never read as "the other two queries'
  // rows all closed."
  let closed = 0;
  const cleanSources: LiveSource[] = [];
  if (grantsGov.errors.length === 0) cleanSources.push('grants.gov');
  if (sbir.errors.length === 0) cleanSources.push('sbir.gov');
  for (const source of cleanSources) {
    const openRows = await env.DB.prepare(
      `SELECT id FROM grant_opportunities WHERE source = ? AND status = 'open'`
    ).bind(source).all<{ id: string }>().catch(() => ({ results: [] }));
    for (const row of openRows.results ?? []) {
      if (!seenIds.has(row.id)) {
        await env.DB.prepare(
          `UPDATE grant_opportunities SET status = 'closed', updated_at = datetime('now') WHERE id = ?`
        ).bind(row.id).run();
        closed++;
      }
    }
  }

  return { fetched: uniqueById.size, fetched_raw: opportunities.length, inserted, updated, closed, errors };
}
