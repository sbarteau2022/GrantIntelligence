# GrantIntelligence

A single Cloudflare Worker with two jobs:

- **Public surface**: serves `public/` — the marketing page and its tiered
  opportunity search (a visitor describes their organization and gets the
  matching opportunities back, scored); the authenticated app UI later.
- **Grant data layer**: ingests, verifies, dedupes, and maintains
  `grant_opportunities`, `grant_recipients`, and `grant_funder_990_overview`,
  plus its own multimodal (vision) intake. Moved out of elle-worker entirely
  so this data layer's uptime, latency, and failure modes never touch
  elle-worker's request path. elle-worker (and its own analysis output —
  fit analysis, NECAI-F evaluations, reasoning log) reads this data via a
  direct D1 binding, never HTTP.

Both jobs are one Worker (`grantintelligence`) on purpose — see
"Why one Worker" below.

- **Design system**: "Industry" (steel-blue wireframe — `public/assets/industry.css`
  is the verbatim token sheet from the design handoff; `site.css` is page layout
  on top of it, no hard-coded values the tokens already carry).
- **Static site, no build step**: `public/` is plain HTML/CSS/vanilla JS.
- **Worker code has a build step**: `src/` is TypeScript, typechecked and
  tested in CI (`.github/workflows/check.yml`).

## Layout

```
public/
  index.html         marketing page markup
  assets/
    industry.css      design-system tokens (source of truth for the look)
    site.css          page layout on top of the tokens
    app.js             vanilla JS: the search console, NECAI-F/990 trace, cascade reveal, hero tilt
src/
  grant-worker-index.ts   fetch/scheduled entry point — /health, /api/*, /internal/*, cron
  grant-search.ts         the public tiered search: profile -> structural score -> tier gate
  grant-ingest.ts         daily pull from Grants.gov + SBIR.gov, plus the manual seed
  grant-990.ts            funder financial overviews via ProPublica's Nonprofit Explorer
  grant-observation.ts    gate/upsert for apps/grant-capture's browser-captured rows
  multimodal-intake.ts    vision intake (env.AI) for screenshots captured alongside a DOM scrape
  db/schema.ts            D1 schema
apps/grant-capture/       browser extension that posts observations to this Worker
wrangler.jsonc            one Worker: assets (public/) + Worker script (src/) + bindings + cron
package.json              npm scripts (dev, deploy, typecheck, test) + devDependencies
docs/AUDIT.md             repo audit — what's fixed, what's outstanding, and why
```

## Why one Worker

This repo used to split into two Cloudflare Workers — an assets-only
`grantintelligence` at the root and a separate `grant-worker` under
`workers/grant-worker` with its own `wrangler.toml`. That split caused
real, recurring problems: Wrangler's config auto-discovery can't always
tell the two apart, and Cloudflare's dashboard-side Workers Builds
git integration requires the Worker name in its config to match the
directory it resolves — a mismatch between the two configs broke deploys
outright. Folding the data layer into the same Worker as the static site
removes the ambiguity: there's exactly one `wrangler.jsonc` in this repo.

`/health`, `/api/*` and `/internal/*` are routed to the Worker script ahead
of the SPA fallback via `assets.run_worker_first` in `wrangler.jsonc` — everything
else falls through to `public/`'s static assets (or `index.html` if
nothing matches, since the marketing page is currently a single-page app).

## Endpoints

`/api/*` is public and read-only. All `/internal/*` routes require
`SERVICE_KEY` (a bearer token) and **fail closed**: with the secret unset
they return `503`, not open access. See "Arming SERVICE_KEY" below — this
is the one setup step the Worker will not do for you.

- `GET /health` — always open.
- `GET /api/tiers` — the tier specs and the form vocabulary (entity types,
  stages, funding bands), served from the same constants the scorer uses so
  the form can't offer an option scoring doesn't understand.
- `POST /api/search` — body `{ profile, tier }`. Scores every open
  opportunity against the profile and returns the tier's slice. See
  "The tiered search" below.
- `POST /internal/run-ingest` — manual trigger for the live pull (also runs
  daily via cron).
- `POST /internal/seed` — re-run the manual seed.
- `POST /internal/990-all` — refresh every foundation/corporate funder's
  990 overview.
- `POST /internal/enrich-captures` — manual trigger for the vision
  enrichment sweep (also runs daily via cron).
- `POST /internal/atlas-observation` — apps/grant-capture's DOM-scrape batch.
- `POST /internal/visual-capture?opportunity_id=<id>` — stage a screenshot
  (raw image bytes as the body) for later enrichment.

## Arming SERVICE_KEY

Required. Until it is set, every `/internal/*` route returns `503` with the
fix command in the body — including the two that write (browser capture into
D1, screenshots into R2). This is deliberate: the Worker also serves a public
marketing page, so leaving those open by default meant anyone who found the
host could publish rows onto the public search results and fill an R2 bucket
on the operator's bill.

```bash
wrangler secret put SERVICE_KEY   # use the value already in grant-capture's Settings
```

`apps/grant-capture` already sends `Authorization: Bearer <token>` from its
Settings and already refuses to post without one, so matching the two values
is the whole migration. Cron is unaffected either way — `scheduled()` calls
the ingest functions directly rather than through `fetch()`.

## Scheduled work

One daily cron trigger (`0 6 * * *`), three independent best-effort passes —
a failure in one never blocks the others:

| Pass | What it does |
| --- | --- |
| `runGrantIngest` | Grants.gov (12 query slices) + SBIR.gov (all agencies), upsert and close-stale |
| `enrichDueCaptures` | Vision enrichment for staged screenshots |
| `refreshStale990Overviews` | The stalest slice of funder 990 overviews — never-fetched first, then oldest |

The 990 pass is bounded rather than a full sweep: anything older than 30
days, at most 8 funders per tick. A 990 is an annual filing, so re-pulling
every funder daily would be hundreds of ProPublica requests a month to learn
nothing. `POST /internal/990-all` still forces a full re-pull on demand.

## The tiered search

`src/grant-search.ts`. A visitor supplies the public subset of the profile
elle-worker stores in `grant_organizations` — track, entity type, state,
stage, funding needed, and what the organization actually does — and every
open row in `grant_opportunities` is scored against it on five structural
features: mission-term overlap, entity fit, award size, geographic scope,
and deadline state.

Two rules the code holds to, both inherited from the engine spec:

- **No recommendation.** Every signal used is named and explained; nothing
  is ever ranked as "you should apply here." The applicant decides.
- **Unknown is not zero.** A feature the data can't answer (no award amount
  on file, a deadline that doesn't parse, a field the visitor skipped) is
  dropped from the denominator and reported in `gaps` — never scored as a
  miss. A thin record must not read as a bad match.

It is deliberately not an LLM call: it runs unauthenticated on every
search, so it has to be cheap, deterministic, and explainable line by line.
elle-worker's `runFitAnalysis` — the LLM fit index with a sealed reasoning
log — is the authenticated counterpart this pre-filters for.

**Tiers** (`TIERS` in the same file) mirror the pricing section: Basic gets
matches, deadlines and requirements; Supported and above add the fit index,
the signal breakdown, the NECAI-F flag and the 990 overview. The fields a
tier doesn't get are stripped server-side *before* serialization — the
browser is never sent something it is meant to hide.

**Entitlement** is resolved by `resolveTier()`. With `TIER_KEYS` unset
(today) every tier is open to preview, and the UI says so rather than
implying a paywall exists. Set it — `wrangler secret put TIER_KEYS`, a JSON
object mapping entitlement key to tier — and requests must then present
`X-GI-Entitlement: <key>`; anything unrecognized, including malformed
`TIER_KEYS`, falls back to Basic rather than erroring, so a lapsed key
degrades to the free product instead of a broken page.

## Getting started

```bash
npm install
npm run dev        # local preview (wrangler dev)
npm run typecheck
npm test
npm run deploy     # wrangler deploy (assets + Worker script + bindings)
```

Deploys to production happen automatically via Cloudflare's Workers Builds
git integration on push to `main` — `npm run deploy` above is for manual/
local use.
