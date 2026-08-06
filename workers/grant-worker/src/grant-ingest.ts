// ============================================================
// LIVE GRANT OPPORTUNITY INGEST — src/grant-ingest.ts
//
// Moved here from elle-worker's src/grant-ingest.ts (see that repo's PR #324
// and the follow-up that extracted the whole grant data layer into this
// standalone worker) — elle-worker now only reasons over this data via a
// direct D1 binding; it neither ingests nor maintains it.
//
// Two free, keyless federal sources, narrowed to the funders/topics
// corpus/business/grant-strategy-map.md (elle-worker's corpus) names — this
// is NOT a full-catalog pull:
//   - Grants.gov search2 API  — VA, HHS/SAMHSA, NSF; veteran/recovery/AI terms
//   - SBIR.gov public solicitations API — NSF, open only (map doc names NSF
//     SBIR's AI/HCI track specifically)
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
// One query per named agency/topic slice rather than one broad pull, so a
// single slow/failing query doesn't take the others down with it.
const GRANTS_GOV_URL = 'https://api.grants.gov/v1/api/search2';
const GRANTS_GOV_QUERIES: Array<{ agencies: string; keyword: string }> = [
  { agencies: 'VA', keyword: 'veteran suicide prevention' },
  { agencies: 'HHS-SAMHSA', keyword: 'recovery support substance use' },
  { agencies: 'NSF', keyword: 'artificial intelligence human-computer interaction' },
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
    try {
      const res = await fetch(GRANTS_GOV_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'user-agent': USER_AGENT },
        body: JSON.stringify({ keyword: q.keyword, agencies: q.agencies, oppStatuses: 'posted', rows: 25, startRecordNum: 0 }),
      });
      if (!res.ok) { errors.push(`grants.gov ${q.agencies}: HTTP ${res.status}`); continue; }
      const data = (await res.json().catch(() => null)) as { data?: { oppHits?: GrantsGovHit[] } } | null;
      const hits = Array.isArray(data?.data?.oppHits) ? data!.data!.oppHits! : [];
      for (const hit of hits) {
        const norm = normalizeGrantsGovHit(hit);
        if (norm) opportunities.push(norm);
      }
    } catch (e) {
      errors.push(`grants.gov ${q.agencies}: ${(e as Error).message}`);
    }
  }
  return { opportunities, errors };
}

// ── SBIR.gov public solicitations ───────────────────────────────────────
// Public GET endpoint, no key. Narrowed to NSF, open solicitations only —
// the map doc names NSF SBIR's AI/HCI track specifically, and a paused
// federal SBIR program (see the seed's own "Paused — reauthorization
// pending" row) should read as absent from an "open" filter, not an error.
const SBIR_URL = 'https://api.www.sbir.gov/public/api/solicitations?agency=NSF&open=1';

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
    funder_name: str(s.agency) ?? 'National Science Foundation',
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
    const opportunities: NormalizedLiveOpportunity[] = [];
    for (const s of Array.isArray(data) ? data : []) {
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
  fetched: number;
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

  let inserted = 0;
  let updated = 0;
  const seenIds = new Set<string>();
  for (const o of opportunities) {
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

  return { fetched: opportunities.length, inserted, updated, closed, errors };
}
