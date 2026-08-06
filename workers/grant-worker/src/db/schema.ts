// ============================================================
// GRANT WORKER — D1 schema (src/db/schema.ts)
//
// Owns the grant DATA layer moved out of elle-worker: opportunities, past
// recipients, and funder 990-PF overviews. elle-worker reads this data via
// a direct D1 binding (GRANT_DB) — the same native-binding pattern it
// already uses for RAPID_DB — never an HTTP call, so nothing about this
// worker's health or latency can affect elle-worker's request path.
//
// elle-worker keeps grant_organizations (user-entered applicant profiles,
// tied to its own user_id) and its OWN reasoning tables
// (grant_fit_analyses, grant_necaif_evaluations, grant_reasoning_log) —
// those are elle's analysis output, not ingested data, and stay put.
// ============================================================

let schemaReady = false;

export async function ensureGrantWorkerSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;

  const creates: string[] = [
    `CREATE TABLE IF NOT EXISTS grant_opportunities (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, funder_name TEXT NOT NULL,
      funder_type TEXT NOT NULL CHECK (funder_type IN ('federal','state','foundation','corporate','international','accelerator')),
      program_name TEXT, program_track TEXT,
      amount_min REAL, amount_max REAL, deadline TEXT, requirements_json TEXT,
      stated_priorities TEXT, actual_priorities_json TEXT, observer_position TEXT,
      necaif_applicable INTEGER NOT NULL DEFAULT 0,
      status TEXT DEFAULT 'open', updated_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_grant_opportunities_deadline ON grant_opportunities(status, deadline)`,
    `CREATE INDEX IF NOT EXISTS idx_grant_opportunities_funder_type ON grant_opportunities(funder_type, necaif_applicable)`,

    `CREATE TABLE IF NOT EXISTS grant_recipients (
      id TEXT PRIMARY KEY, opportunity_id TEXT NOT NULL,
      recipient_type_profile TEXT, award_amount REAL, award_year INTEGER,
      source_filing TEXT, created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_grant_recipients_opportunity ON grant_recipients(opportunity_id)`,

    // funder_name PRIMARY KEY — one row per funder, replaced on re-fetch (a
    // filing-year snapshot, not an append-only series). Verbatim shape from
    // elle-worker's grant_funder_990_overview so the ported persist logic
    // needs no reshaping.
    `CREATE TABLE IF NOT EXISTS grant_funder_990_overview (
      funder_name TEXT PRIMARY KEY, ein TEXT, ntee_code TEXT, city TEXT, state TEXT,
      most_recent_filing_year INTEGER,
      total_revenue_cents INTEGER, total_expenses_cents INTEGER,
      total_assets_end_cents INTEGER, total_liabilities_end_cents INTEGER,
      contributions_gifts_grants_cents INTEGER, program_revenue_cents INTEGER,
      pdf_only_filing_years TEXT, source_url TEXT, fetched_at TEXT, error TEXT
    )`,

    // Staged, unenriched multimodal captures — a screenshot lands here
    // immediately (fast, no dependency on the vision call succeeding); the
    // maintenance sweep enriches it out-of-band. See multimodal-intake.ts.
    `CREATE TABLE IF NOT EXISTS grant_visual_captures (
      id TEXT PRIMARY KEY, opportunity_id TEXT, image_ref TEXT NOT NULL,
      description_json TEXT, enriched_at TEXT, error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
  ];

  await db.batch(creates.map((sql) => db.prepare(sql)));
  schemaReady = true;
}
