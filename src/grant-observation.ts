// ============================================================================
// Browser-captured grant observation gate  (src/grant-observation.ts)
//
// This worker's OWN atlas plugin (apps/grant-capture in this repo) posts
// here — NOT RAPIDAi's. "Rapid is not ingesting grants, the grant worker
// is": every path that lands a row in grant_opportunities, whether from
// Grants.gov/SBIR.gov (grant-ingest.ts) or an operator's browser capture
// (this file), is owned by this worker end to end.
//
// Same posture as RAPIDAi's price/tax-observation gates this was adapted
// from: the capture client does best-effort DOM extraction and is NOT
// trusted. The gate (runGrantObservationGate) normalizes every observation,
// requires the minimum identifying fields, and de-duplicates within the
// batch — pure, no D1 access, fully unit-testable without a worker.
// ingestAtlasObservations below is the orchestration layer (gate + upsert
// into grant_opportunities), same split as grant-ingest.ts's
// fetch*/normalize* functions vs. runGrantIngest.
//
// Money is often NOT a clean number on these portals ("up to $50,000",
// "varies", "$250k-$600k") — the raw text is always kept; a numeric cents
// value is best-effort and never required.
// ============================================================================

import { ensureGrantWorkerSchema } from './db/schema';

export interface RawGrantObservation {
  funderName?: unknown;
  programName?: unknown;
  funderType?: unknown; // free text as captured — uncontrolled, normalized to 'foundation' below
  amountText?: unknown; // "$50,000" | "up to $2M" | "varies"
  deadlineText?: unknown; // "2026-05-05" | "Rolling" | "FY26 open"
  eligibilityText?: unknown;
  portalContext?: unknown;
  captureMethod?: unknown;
  observedAt?: unknown;
}

export interface NormalizedGrantObservation {
  id: string; // stable — sha256(funderName+programName+portalContext), so re-capturing the same page upserts rather than duplicates
  funderName: string;
  programName: string;
  funderType: 'federal' | 'state' | 'foundation' | 'corporate' | 'international' | 'accelerator';
  amountText: string | null;
  amountCents: number | null; // best-effort parse of a single figure; null if unparseable/range/prose
  deadlineText: string | null;
  eligibilityText: string | null;
  portalContext: string | null;
  captureMethod: 'dom' | 'vision';
  observedAt: string | null;
}

export interface GrantObservationGateResult {
  valid: NormalizedGrantObservation[];
  rejected: Array<{ index: number; reason: string }>;
}

const VALID_CAPTURE_METHODS = new Set(['dom', 'vision']);
// The portals this plugin targets (small foundations/state programs an
// operator finds by hand) are essentially never federal/international by
// definition — those are covered by grant-ingest.ts's Grants.gov/SBIR.gov
// pull instead. Free-text funderType from the page is mapped onto the
// CHECK-constrained set grant_opportunities enforces; anything unrecognized
// defaults to 'foundation' (the long-tail case this plugin exists for).
const FUNDER_TYPE_MAP: Record<string, NormalizedGrantObservation['funderType']> = {
  federal: 'federal', state: 'state', foundation: 'foundation',
  corporate: 'corporate', international: 'international', accelerator: 'accelerator',
};

function str(val: unknown): string | null {
  if (typeof val !== 'string') return null;
  const t = val.trim();
  return t ? t : null;
}

function normalizeCaptureMethod(val: unknown): 'dom' | 'vision' {
  const s = typeof val === 'string' ? val.trim().toLowerCase() : '';
  return (VALID_CAPTURE_METHODS.has(s) ? s : 'dom') as 'dom' | 'vision';
}

function normalizeFunderType(val: unknown): NormalizedGrantObservation['funderType'] {
  const s = typeof val === 'string' ? val.trim().toLowerCase() : '';
  return FUNDER_TYPE_MAP[s] ?? 'foundation';
}

function normalizeObservedAt(val: unknown): string | null {
  const s = str(val);
  if (!s) return null;
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

// Best-effort single-figure dollar parse. Handles "$50,000", "$2M", "$250k".
// A range ("$250k-$600k") or prose ("varies", "TBD") intentionally yields
// null — the raw amountText is the source of truth either way.
export function parseLooseAmountCents(raw: unknown): number | null {
  const s = str(raw);
  if (!s) return null;
  const m = s.match(/\$?\s*([\d,]+(?:\.\d+)?)\s*(k|m|b)?/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const mult = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[m[2]?.toLowerCase() as 'k' | 'm' | 'b'] ?? 1;
  return Math.round(n * mult * 100);
}

// SHA-256 of the same key used for within-batch dedup below, so a capture
// made today and a re-capture of the same listing next month land on the
// same grant_opportunities row (upsert) instead of duplicating.
export async function stableObservationId(funderName: string, programName: string, portalContext: string | null): Promise<string> {
  const key = `${funderName.toLowerCase()}|${programName.toLowerCase()}|${(portalContext ?? '').toLowerCase()}`;
  const bytes = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `atlas-capture-${hex.slice(0, 24)}`;
}

export async function runGrantObservationGate(input: unknown): Promise<GrantObservationGateResult> {
  const valid: NormalizedGrantObservation[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];

  if (!Array.isArray(input)) {
    return { valid, rejected: [{ index: -1, reason: 'observations must be an array' }] };
  }

  // Dedupe within the batch: the same funder+program from the same portal
  // page is one data point, however many times the page repeats it.
  const seen = new Set<string>();

  for (let index = 0; index < input.length; index++) {
    const raw = (input[index] ?? {}) as RawGrantObservation;

    const funderName = str(raw.funderName);
    if (!funderName) { rejected.push({ index, reason: 'missing funderName' }); continue; }
    const programName = str(raw.programName);
    if (!programName) { rejected.push({ index, reason: 'missing programName' }); continue; }

    const portalContext = str(raw.portalContext);
    const key = `${funderName.toLowerCase()}|${programName.toLowerCase()}|${(portalContext ?? '').toLowerCase()}`;
    if (seen.has(key)) { rejected.push({ index, reason: 'duplicate within batch' }); continue; }
    seen.add(key);

    valid.push({
      id: await stableObservationId(funderName, programName, portalContext),
      funderName,
      programName,
      funderType: normalizeFunderType(raw.funderType),
      amountText: str(raw.amountText),
      amountCents: parseLooseAmountCents(raw.amountText),
      deadlineText: str(raw.deadlineText),
      eligibilityText: str(raw.eligibilityText),
      portalContext,
      captureMethod: normalizeCaptureMethod(raw.captureMethod),
      observedAt: normalizeObservedAt(raw.observedAt),
    });
  }

  return { valid, rejected };
}

// ── Orchestration: gate + upsert into grant_opportunities ────────────────
export interface GrantObservationEnv {
  DB: D1Database;
}

export interface IngestAtlasObservationsResult {
  inserted: number;
  updated: number;
  rejected: Array<{ index: number; reason: string }>;
  ids: string[]; // every valid observation's stable id, in gate order — pair a screenshot to one via POST /internal/visual-capture?opportunity_id=<id>
}

export async function ingestAtlasObservations(
  env: GrantObservationEnv, input: unknown,
): Promise<IngestAtlasObservationsResult> {
  await ensureGrantWorkerSchema(env.DB);
  const { valid, rejected } = await runGrantObservationGate(input);

  let inserted = 0, updated = 0;
  const ids: string[] = [];
  for (const o of valid) {
    ids.push(o.id);
    const existing = await env.DB.prepare(`SELECT id FROM grant_opportunities WHERE id = ?`).bind(o.id).first();
    const necaifApplicable = o.funderType === 'foundation' || o.funderType === 'corporate' ? 1 : 0;
    // A single captured figure becomes a point estimate (min=max) — the raw
    // amountText stays the source of truth in stated_priorities regardless,
    // same "keep the text even when the number can't be trusted" rule as
    // parseLooseAmountCents itself.
    const amountDollars = o.amountCents != null ? o.amountCents / 100 : null;
    await env.DB.prepare(
      `INSERT INTO grant_opportunities (id, source, funder_name, funder_type, program_name, amount_min, amount_max, deadline, stated_priorities, necaif_applicable, status)
       VALUES (?,'atlas-capture',?,?,?,?,?,?,?,?, 'open')
       ON CONFLICT(id) DO UPDATE SET
         funder_name=excluded.funder_name, funder_type=excluded.funder_type, program_name=excluded.program_name,
         amount_min=excluded.amount_min, amount_max=excluded.amount_max,
         deadline=excluded.deadline, stated_priorities=excluded.stated_priorities,
         necaif_applicable=excluded.necaif_applicable, status='open', updated_at=datetime('now')`
    ).bind(
      o.id, o.funderName, o.funderType, o.programName, amountDollars, amountDollars, o.deadlineText,
      [o.amountText, o.eligibilityText].filter(Boolean).join(' — ') || null,
      necaifApplicable,
    ).run();
    if (existing) updated++; else inserted++;
  }

  return { inserted, updated, rejected, ids };
}
