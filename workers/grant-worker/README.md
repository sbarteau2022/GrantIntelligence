# grant-intelligence-worker

The Grant Intelligence Suite's data layer — ingests, verifies, dedupes, and
maintains `grant_opportunities`, `grant_recipients`, and
`grant_funder_990_overview`, plus its own multimodal (vision) intake. Moved
out of elle-worker entirely (see elle-worker's `docs/GRANT_INTELLIGENCE_SUITE_MAP.md`
for why) so this worker's uptime, latency, and failure modes never touch
elle-worker's request path.

## What it does

- **`grant-ingest.ts`** — daily pull from Grants.gov's `search2` API and
  SBIR.gov's public solicitations API (both free/keyless), narrowed to the
  funders/topics `corpus/business/grant-strategy-map.md` names (VA, SAMHSA,
  NSF). Upserts, and closes any previously-open row that fell off a
  cleanly-fetched source. Also carries the manual seed
  (`SEED_OPPORTUNITIES`) for funders with no public API (private
  foundations, accelerators).
- **`grant-990.ts`** — pulls funder financial overviews (revenue, expenses,
  assets) from ProPublica's Nonprofit Explorer API for every
  foundation/corporate funder on file.
- **`multimodal-intake.ts`** — this worker's own vision capability
  (`env.AI`, no dependency on elle-worker's PFAR/vFAR or any other worker).
  A screenshot captured alongside a DOM scrape (e.g. RAPIDAi's atlas-capture
  browser extension) stages immediately via `POST /internal/visual-capture`;
  the cron sweep enriches it later, out-of-band, with a vision read —
  a second, independent extraction to cross-check the DOM parse against.
  Never runs inside a live request/response cycle.

## Who reads this data

elle-worker reads `grant_opportunities`/`grant_funder_990_overview` via a
direct D1 binding (`GRANT_DB` in its `wrangler.toml`) — a native binding,
not an HTTP call, so nothing about this worker's health affects
elle-worker's latency or failure modes. elle-worker keeps its own
`grant_organizations` (user-entered applicant profiles) and reasoning
tables (`grant_fit_analyses`, `grant_necaif_evaluations`,
`grant_reasoning_log`) — those are elle's analysis output, not ingested
data.

## Endpoints

All `/internal/*` routes are gated by `SERVICE_KEY` (a bearer token) once
that secret is set — dormant/open until then, matching the rest of this
codebase's convention for "unarmed until deliberately configured."

- `GET /health` — always open.
- `POST /internal/run-ingest` — manual trigger for the live pull (also runs
  daily via cron).
- `POST /internal/seed` — re-run the manual seed.
- `POST /internal/990-all` — refresh every foundation/corporate funder's
  990 overview.
- `POST /internal/enrich-captures` — manual trigger for the vision
  enrichment sweep (also runs daily via cron).
- `POST /internal/visual-capture?opportunity_id=<id>` — stage a screenshot
  (raw image bytes as the body) for later enrichment.

## Not built yet

- **RAPIDAi's atlas-capture browser extension** doesn't call
  `/internal/visual-capture` yet — the endpoint exists and is tested, but
  nothing feeds it a live screenshot end to end. That's the RAPIDAi-side
  half of the "2x accuracy" case and is a separate, scoped follow-up.
- **The long-promised "promotion job"** — consuming RAPIDAi's
  `grant_opportunity_observation` staging table (small-funder grants
  captured by hand via the browser extension) into this worker's
  `grant_opportunities` — still doesn't exist. Grants.gov/SBIR.gov cover
  federal sources only; private foundations/accelerators still need either
  the manual seed or that promotion path, whichever gets built first.

## Deploying

Always pass `--config wrangler.toml` explicitly (the npm scripts already
do) — see the comment at the top of `wrangler.toml` for why this matters
in a repo that also has a root-level, assets-only `wrangler.jsonc` for the
marketing site.
