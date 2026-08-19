# Grant Intelligence — audit

Read of the whole repo as it stood at `232ac11`, before the tiered public
search landed. Findings are ordered by what would hurt first, not by how
interesting they are. Each says plainly whether this branch fixed it.

Baseline at the time of the audit: `tsc --noEmit` clean, 57 tests passing
across 4 suites.

---

## 1. Every `/internal/*` route is open to the internet — NOT FIXED HERE

`isAuthorized()` returns `true` whenever `SERVICE_KEY` is unset, and
`SERVICE_KEY` is unset. That is a deliberate, documented posture ("dormant
until deliberately armed"), and it was defensible while nothing pointed at
the Worker. It is no longer, because the same Worker now serves a public
marketing page — the hostname is meant to be found.

What an anonymous caller can currently do:

| Route | Effect |
| --- | --- |
| `POST /internal/atlas-observation` | **Writes rows into `grant_opportunities`.** These now render on the public search results. |
| `POST /internal/visual-capture` | **Writes arbitrary bytes into R2**, one object per call, unbounded. |
| `POST /internal/enrich-captures` | Spends Workers AI inference on every staged capture. |
| `POST /internal/990-all` | Fans out to ProPublica once per foundation/corporate funder. |
| `POST /internal/run-ingest` | Fans out to Grants.gov and SBIR.gov. |
| `POST /internal/seed` | Rewrites the seeded rows. |

The first two are the serious pair: one lets a stranger publish content on
the site, the other is unmetered storage on the account's bill. The rest
are amplification — cheap for the caller, billed to the operator, and
capable of getting the Worker rate-limited by the upstream APIs it depends
on.

`CORS_HEADERS` is `Access-Control-Allow-Origin: *` on every route including
these, so they are also reachable from any page in any browser.

**Fix:** `wrangler secret put SERVICE_KEY`, then set the same value in
whatever calls `apps/grant-capture`. No code change is required — the gate
is already written and already tested. This is one command, and it is the
single highest-value thing outstanding in this repo.

Left undone here on purpose: setting a production secret is the operator's
call, not a pull request's, and arming it without updating the extension in
the same motion would break capture.

## 2. A silent upstream shape change could close the whole catalogue — FIXED

`runGrantIngest`'s close-stale pass closes every previously-open row from a
source that "fetched cleanly" but no longer lists it. Both source parsers
were written to never throw:

```ts
const hits = Array.isArray(data?.data?.oppHits) ? data!.data!.oppHits! : [];   // grants.gov
for (const s of Array.isArray(data) ? data : []) { … }                          // sbir.gov
```

So an envelope change upstream — a rename, a wrapper object, an error body
returned with HTTP 200 — produced *zero opportunities and zero errors*,
which the close-stale pass reads as "every opportunity from this source
closed simultaneously." One cron tick, whole source marked closed. The
module header itself concedes these shapes are "best-effort from public
API documentation, NOT verified against a live response," which is exactly
the condition under which this fires.

**Fixed** in `src/grant-ingest.ts`: an unrecognized envelope is now an
error (and errors already suppress closing for that source), while a
well-formed empty result still closes stale rows — NSF SBIR genuinely
having no open solicitations must keep working. One existing test asserted
the old tolerant behavior and was rewritten, with the reasoning in place.

## 3. Ingested funder text now reaches a public page — FIXED

`grant-observation.ts` accepts free text scraped by a browser extension
from funder portals — pages nobody here controls — and stores it in
`stated_priorities` and `program_name`. Before this branch that text only
ever went to elle-worker's reasoning. It now renders in search results.

**Fixed** in `public/assets/app.js`: every interpolated value goes through
`esc()` before reaching `innerHTML`, without exception. Any future surface
that renders this data must do the same — the gate normalizes shape, not
markup, and it is not the place to fix this (stripping tags at ingest would
corrupt the corpus elle-worker reasons over).

## 4. The 990 overviews are never refreshed on their own — NOT FIXED

`scheduled()` runs two passes:

```ts
ctx.waitUntil(runGrantIngest(env)…);
ctx.waitUntil(enrichDueCaptures(env)…);
```

`run990OverviewForAllFunders` is not among them. It exists, it works, and
it is reachable only through `POST /internal/990-all` by hand. So
`grant_funder_990_overview` stays empty until someone remembers.

This has a visible consequence now: the Supported tier promises a 990
financial overview, and `searchOpportunities` will correctly return `null`
for every funder because the table has no rows. The code is honest about
it; the product still looks thin.

Not fixed here because the right cadence is a judgment call — 990 filings
change roughly annually, so a daily fan-out to ProPublica across every
foundation on file is mostly wasted requests. A monthly cron, or a
refresh-if-older-than-N-days check inside the existing daily tick, both fit;
that choice belongs with the operator.

## 5. The searchable corpus is thin — NOT FIXED, and it is the real product risk

The live ingest is three Grants.gov queries (VA, HHS-SAMHSA, NSF) plus NSF
SBIR, narrowed to one operator's own strategy document. Everything else is
nine hand-entered seed rows. The private foundations and accelerators that
matter most to the target user have no public search API and arrive only
through the browser extension, one page at a time.

That is a coherent design, and the module headers say so. But the promise
now on the front page is "your details in, the funders that fit, out" — and
a visitor in a state or sector the corpus does not cover gets a short list
and no way to tell whether that means "few matches" or "few records."

Partially mitigated: the search response ships a `disclosure.limits` array
that says this in the visitor's own results, rendered under every search
("Only opportunities already ingested into this database are searched —
this is not the full federal catalog"). Saying it plainly is not the same
as fixing it. Broadening the corpus is the next substantive piece of work
in this repo, ahead of any further UI.

## 6. Smaller things

- **N+1 on every upsert.** `runGrantIngest`, `seedOpportunities`, and
  `ingestAtlasObservations` each run `SELECT id … WHERE id = ?` before the
  `INSERT … ON CONFLICT`, purely to report `inserted` vs `updated`. D1's
  result metadata can distinguish those without the extra round trip. Real,
  low-value at current corpus size, worth doing when the corpus grows.
- **Doc drift.** `grant-worker-index.ts`'s header claimed "there is no
  end-user-facing surface on this worker" while the Worker was already
  serving `public/`. **Fixed** — the header now lists the three route
  classes and how each is gated.
- **`schemaReady` is a module-level flag**, so a schema change needs an
  isolate restart to re-run `ensureGrantWorkerSchema`. Correct for
  `CREATE TABLE IF NOT EXISTS`, worth remembering when a migration that
  isn't idempotent shows up.
- **`timingSafeEqualStr` compares every byte** but branches on length
  first, so it leaks the length of `SERVICE_KEY`. Not worth changing —
  length is not the secret.

---

## What this branch changed

- `src/grant-search.ts` — the tiered public search: profile normalization,
  five-feature structural scoring, tier gating, one D1 read. No LLM call,
  no recommendation, unknown never scored as zero.
- `src/grant-search.test.ts` — 33 tests over the pure parts and the D1 edge.
- `src/grant-worker-index.ts` — `GET /api/tiers`, `POST /api/search`, both
  public; body cap on the search route; header corrected.
- `src/grant-ingest.ts` — finding 2.
- `public/` — the search console, the tier rail, the result renderer with
  its escaping, and the pricing cards wired to the tier they name.
- `wrangler.jsonc` — `/api/*` added to `run_worker_first`.

Tests after: 91 passing across 5 suites, `tsc --noEmit` clean, and the page
was driven end to end against `wrangler dev` with a seeded local D1 —
Basic and Supported views, both tracks, desktop and mobile.
