// ============================================================
// GRANT FUNDER 990 OVERVIEW — src/grant-990.ts
//
// Moved here from elle-worker's src/grant-990.ts + the persist990Overview/
// persist990Error/run990Overview functions that lived in
// grant-intelligence.ts — this worker owns funder financial-overview data
// end to end now; elle-worker reads grant_funder_990_overview via its
// GRANT_DB binding when it needs it for reasoning.
//
// Pulls from ProPublica's Nonprofit Explorer API (public, no key needed) —
// revenue, expenses, assets, contributions/grants received — for every
// foundation/corporate funder on file.
//
// Scope, honestly: ProPublica's organization endpoint exposes SUMMARY
// financial figures per filing year, not itemized grants-paid recipient
// lists. This module is the overview layer only.
//
// A private foundation that only files on paper has NO structured data on
// ProPublica (filings_without_data — PDF link only). That is surfaced
// explicitly (pdfOnlyFilingYears), never silently treated as "no data means
// zero revenue."
// ============================================================

import { ensureGrantWorkerSchema } from './db/schema';
import type { GrantWorkerEnv } from './grant-ingest';

const PROPUBLICA_SEARCH_URL = 'https://projects.propublica.org/nonprofits/api/v2/search.json';
const propublicaOrgUrl = (ein: string) => `https://projects.propublica.org/nonprofits/api/v2/organizations/${ein}.json`;
const USER_AGENT = 'grant-intelligence-worker/990-overview (+https://github.com/sbarteau2022/GrantIntelligence)';

interface ProPublicaSearchOrg {
  ein: number;
  name: string;
  city?: string;
  state?: string;
  ntee_code?: string | null;
}
interface ProPublicaSearchResponse {
  organizations?: ProPublicaSearchOrg[];
}
interface ProPublicaFiling {
  tax_prd_yr?: number;
  totrevenue?: number;
  totfuncexpns?: number;
  totassetsend?: number;
  totliabend?: number;
  totcntrbgfts?: number;
  totprgmrevn?: number;
}
interface ProPublicaFilingNoData {
  tax_prd_yr?: number;
  pdf_url?: string;
}
interface ProPublicaOrgResponse {
  organization?: { name: string; ein: number; city?: string; state?: string; ntee_code?: string | null };
  filings_with_data?: ProPublicaFiling[];
  filings_without_data?: ProPublicaFilingNoData[];
}

export interface Funder990Overview {
  funderName: string;
  ein: string;
  nteeCode: string | null;
  city: string | null;
  state: string | null;
  mostRecentFilingYear: number | null;
  totalRevenueCents: number | null;
  totalExpensesCents: number | null;
  totalAssetsEndCents: number | null;
  totalLiabilitiesEndCents: number | null;
  contributionsGiftsGrantsCents: number | null;
  programRevenueCents: number | null;
  pdfOnlyFilingYears: number[];
  sourceUrl: string;
  fetchedAt: string;
}

function dollarsToCents(n: number | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) : null;
}

// Resolves a funder name to an EIN via ProPublica's search endpoint. Exact
// case-insensitive name match wins over ProPublica's own relevance ranking.
export async function resolveFunderEin(funderName: string): Promise<{ ein: string } | { error: string }> {
  const url = `${PROPUBLICA_SEARCH_URL}?q=${encodeURIComponent(funderName)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  } catch (e) {
    return { error: `ProPublica search request failed: ${(e as Error).message}` };
  }
  if (!res.ok) return { error: `ProPublica search failed: HTTP ${res.status}` };
  const data = (await res.json().catch(() => null)) as ProPublicaSearchResponse | null;
  const orgs = data?.organizations ?? [];
  if (!orgs.length) return { error: `no ProPublica match for "${funderName}"` };
  const exact = orgs.find((o) => o.name?.toLowerCase() === funderName.toLowerCase());
  const best = exact ?? orgs[0];
  return { ein: String(best.ein) };
}

export async function fetch990Overview(
  funderName: string, einOverride?: string,
): Promise<Funder990Overview | { error: string }> {
  let ein = einOverride;
  if (!ein) {
    const resolved = await resolveFunderEin(funderName);
    if ('error' in resolved) return resolved;
    ein = resolved.ein;
  }

  const orgUrl = propublicaOrgUrl(ein);
  let res: Response;
  try {
    res = await fetch(orgUrl, { headers: { 'user-agent': USER_AGENT } });
  } catch (e) {
    return { error: `ProPublica organization request failed: ${(e as Error).message}` };
  }
  if (!res.ok) return { error: `ProPublica organization lookup failed: HTTP ${res.status}` };
  const data = (await res.json().catch(() => null)) as ProPublicaOrgResponse | null;
  const org = data?.organization;
  if (!org) return { error: `ProPublica returned no organization for EIN ${ein}` };

  const filings = [...(data?.filings_with_data ?? [])].sort((a, b) => (b.tax_prd_yr ?? 0) - (a.tax_prd_yr ?? 0));
  const latest = filings[0];

  return {
    funderName: org.name ?? funderName,
    ein: String(org.ein ?? ein),
    nteeCode: org.ntee_code ?? null,
    city: org.city ?? null,
    state: org.state ?? null,
    mostRecentFilingYear: latest?.tax_prd_yr ?? null,
    totalRevenueCents: dollarsToCents(latest?.totrevenue),
    totalExpensesCents: dollarsToCents(latest?.totfuncexpns),
    totalAssetsEndCents: dollarsToCents(latest?.totassetsend),
    totalLiabilitiesEndCents: dollarsToCents(latest?.totliabend),
    contributionsGiftsGrantsCents: dollarsToCents(latest?.totcntrbgfts),
    programRevenueCents: dollarsToCents(latest?.totprgmrevn),
    pdfOnlyFilingYears: (data?.filings_without_data ?? []).map((f) => f.tax_prd_yr).filter((y): y is number => typeof y === 'number'),
    sourceUrl: orgUrl,
    fetchedAt: new Date().toISOString(),
  };
}

// ── Persistence — one row per funder_name, replaced on re-fetch ─────────
async function persist990Overview(env: GrantWorkerEnv, overview: Funder990Overview): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO grant_funder_990_overview
       (funder_name, ein, ntee_code, city, state, most_recent_filing_year,
        total_revenue_cents, total_expenses_cents, total_assets_end_cents, total_liabilities_end_cents,
        contributions_gifts_grants_cents, program_revenue_cents, pdf_only_filing_years, source_url, fetched_at, error)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
     ON CONFLICT(funder_name) DO UPDATE SET
       ein=excluded.ein, ntee_code=excluded.ntee_code, city=excluded.city, state=excluded.state,
       most_recent_filing_year=excluded.most_recent_filing_year,
       total_revenue_cents=excluded.total_revenue_cents, total_expenses_cents=excluded.total_expenses_cents,
       total_assets_end_cents=excluded.total_assets_end_cents, total_liabilities_end_cents=excluded.total_liabilities_end_cents,
       contributions_gifts_grants_cents=excluded.contributions_gifts_grants_cents,
       program_revenue_cents=excluded.program_revenue_cents, pdf_only_filing_years=excluded.pdf_only_filing_years,
       source_url=excluded.source_url, fetched_at=excluded.fetched_at, error=NULL`
  ).bind(
    overview.funderName, overview.ein, overview.nteeCode, overview.city, overview.state, overview.mostRecentFilingYear,
    overview.totalRevenueCents, overview.totalExpensesCents, overview.totalAssetsEndCents, overview.totalLiabilitiesEndCents,
    overview.contributionsGiftsGrantsCents, overview.programRevenueCents,
    JSON.stringify(overview.pdfOnlyFilingYears), overview.sourceUrl, overview.fetchedAt,
  ).run();
}

async function persist990Error(env: GrantWorkerEnv, funderName: string, errorMessage: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO grant_funder_990_overview (funder_name, fetched_at, error) VALUES (?,?,?)
     ON CONFLICT(funder_name) DO UPDATE SET fetched_at=excluded.fetched_at, error=excluded.error`
  ).bind(funderName, new Date().toISOString(), errorMessage).run();
}

export async function run990Overview(
  env: GrantWorkerEnv, funderName: string, einOverride?: string,
): Promise<Funder990Overview | { error: string }> {
  await ensureGrantWorkerSchema(env.DB);
  const result = await fetch990Overview(funderName, einOverride);
  if ('error' in result) { await persist990Error(env, funderName, result.error); return result; }
  await persist990Overview(env, result);
  return result;
}

// Every distinct foundation/corporate funder already on file. Runs
// sequentially (ProPublica has no documented bulk endpoint) so one
// slow/failing lookup doesn't race another's write to the same PK row.
export async function run990OverviewForAllFunders(
  env: GrantWorkerEnv,
): Promise<{ funderName: string; result: Funder990Overview | { error: string } }[]> {
  await ensureGrantWorkerSchema(env.DB);
  const rows = await env.DB.prepare(
    `SELECT DISTINCT funder_name FROM grant_opportunities WHERE funder_type IN ('foundation','corporate') ORDER BY funder_name`
  ).all<{ funder_name: string }>().catch(() => ({ results: [] }));
  const out: { funderName: string; result: Funder990Overview | { error: string } }[] = [];
  for (const row of rows.results ?? []) {
    out.push({ funderName: row.funder_name, result: await run990Overview(env, row.funder_name) });
  }
  return out;
}
