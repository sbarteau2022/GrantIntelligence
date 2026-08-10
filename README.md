# GrantIntelligence

A single Cloudflare Worker with two jobs:

- **Public surface**: serves `public/` — the marketing page now, the
  authenticated app UI later.
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
    app.js             vanilla JS: NECAI-F/990 trace, cascade reveal, hero tilt
src/
  grant-worker-index.ts   fetch/scheduled entry point — /health, /internal/*, cron
  grant-ingest.ts         daily pull from Grants.gov + SBIR.gov, plus the manual seed
  grant-990.ts            funder financial overviews via ProPublica's Nonprofit Explorer
  grant-observation.ts    gate/upsert for apps/grant-capture's browser-captured rows
  multimodal-intake.ts    vision intake (env.AI) for screenshots captured alongside a DOM scrape
  db/schema.ts            D1 schema
apps/grant-capture/       browser extension that posts observations to this Worker
wrangler.jsonc            one Worker: assets (public/) + Worker script (src/) + bindings + cron
package.json              npm scripts (dev, deploy, typecheck, test) + devDependencies
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

`/health` and `/internal/*` are routed to the Worker script ahead of the
SPA fallback via `assets.run_worker_first` in `wrangler.jsonc` — everything
else falls through to `public/`'s static assets (or `index.html` if
nothing matches, since the marketing page is currently a single-page app).

## Endpoints

All `/internal/*` routes are gated by `SERVICE_KEY` (a bearer token) once
that secret is set — dormant/open until then.

- `GET /health` — always open.
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
