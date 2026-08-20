# Grant Intelligence — audit

Read of the whole repo as it stood at `232ac11`, before the tiered public
search landed. Findings are ordered by what would hurt first, not by how
interesting they are. Each says plainly whether it has been fixed, and
finding 1 carries a correction to what an earlier revision of this document
claimed.

Baseline at the time of the audit: `tsc --noEmit` clean, 57 tests passing
across 4 suites. Now: 112 tests across 6 suites.

---

## 1. Every `/internal/*` route was open to the internet — FIXED

`isAuthorized()` returned `true` whenever `SERVICE_KEY` was unset, and
`SERVICE_KEY` was unset. That was a deliberate, documented posture ("dormant
until deliberately armed"), and it was defensible while nothing pointed at
the Worker. It stopped being defensible the moment the same Worker started
serving a marketing page — the hostname is meant to be found.

What an anonymous caller could do:

| Route | Effect |
| --- | --- |
| `POST /internal/atlas-observation` | **Wrote rows into `grant_opportunities`.** Those render on the public search results. |
| `POST /internal/visual-capture` | **Wrote arbitrary bytes into R2**, one object per call, unbounded. |
| `POST /internal/enrich-captures` | Spent Workers AI inference on every staged capture. |
| `POST /internal/990-all` | Fanned out to ProPublica once per foundation/corporate funder. |
| `POST /internal/run-ingest` | Fanned out to Grants.gov and SBIR.gov. |
| `POST /internal/seed` | Rewrote the seeded rows. |

**Correction to the previous revision of this audit.** It said arming
`SERVICE_KEY` "without updating the extension in the same motion would break
capture," and used that to justify leaving the hole open. That was wrong, and
checking `apps/grant-capture/background.js` would have shown it: the
extension already refuses to post without an operator token and already
sends it as `Authorization: Bearer <token>` on both endpoints. There was no
migration to do. The only real obstacle was that running
`wrangler secret put` needs credentials a pull request doesn't have — which
is an argument for changing the default, not for leaving it open.

**Fixed** in `src/grant-worker-index.ts`: `authorizeInternal()` fails
**closed**. Unset `SERVICE_KEY` now returns `503` on every `/internal/*`
route, with the exact command to fix it in the error body and a warning in
the Worker log. A wrong or absent token against an armed key returns `401`.

This is a deliberate breaking change, stated plainly: **until
`wrangler secret put SERVICE_KEY` is run, browser capture and the manual
internal triggers will return 503.** Setting it to the value already in the
extension's Settings restores both. Cron is unaffected — `scheduled()` calls
the ingest functions directly rather than through `fetch()`, so it never
passes through the gate.

`Access-Control-Allow-Origin` stays `*`, on purpose. The extension's MV3
service worker declares no `host_permissions` (the endpoint is operator-
configurable, so pinning one would mean requesting `<all_urls>`), so its
fetch **is** subject to CORS and a narrower policy would break capture. With
the gate failing closed, a permissive origin policy costs nothing: a hostile
page can issue the request and still cannot authenticate it.

`src/grant-worker-index.test.ts` is new and pins all of this — the entry
point previously had no tests at all, which is how it shipped open.

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

## 4. The 990 overviews were never refreshed on their own — FIXED

`scheduled()` ran two passes — `runGrantIngest` and `enrichDueCaptures`.
`run990OverviewForAllFunders` was not among them. It existed, it worked, and
it was reachable only by hand through `POST /internal/990-all`. So
`grant_funder_990_overview` stayed empty until someone remembered, and the
Supported tier's financials panel rendered blank against the real database.

**Fixed** in `src/grant-990.ts` + the cron: `refreshStale990Overviews()`
takes a small, bounded slice per daily tick — funders never fetched first,
then the oldest — instead of re-pulling every funder daily. A 990 is an
annual filing; a daily full sweep would be hundreds of ProPublica requests a
month to learn nothing, which is why the previous revision of this audit
left it alone rather than doing the obvious wrong thing.

Defaults: refresh anything older than 30 days, at most 8 funders per run.
That is 240 funder-refreshes a month — comfortably more than this corpus
holds, and a rounding error against ProPublica. `POST /internal/990-all`
still exists for a deliberate "re-pull everything now."

Per-funder errors are already persisted by `run990Overview` (the row keeps
its `error` column), so one funder ProPublica can't resolve never stops the
rest of the slice. Verified against a real local D1: the query is valid, the
never-fetched-first ordering holds, and a fully-current corpus correctly
selects nothing.

## 5. The searchable corpus was thin — BROADENED, not solved

The live ingest was three Grants.gov queries (VA, HHS-SAMHSA, NSF) plus NSF
SBIR, narrowed to one operator's own strategy document. Everything else was
nine hand-entered seed rows. That made the public search only as good as
that document: a visitor outside those three agencies' subject areas got a
short list and no way to tell whether it meant "few matches" or "few
records."

**Broadened** in `src/grant-ingest.ts`:

- **Grants.gov: 3 queries → 12.** The three agency-pinned slices are kept
  (an agency filter surfaces listings whose titles don't contain the topic
  words at all), and nine agency-agnostic topic sweeps are added across
  veterans, mental health, substance use, rural health, workforce, housing,
  community development, AI, and small-business innovation. The `agencies`
  field is now omitted entirely rather than sent as `null` for those —
  search2 treats present-but-empty differently from absent.
- **SBIR.gov: NSF only → every agency.** SBIR/STTR is eleven agencies, all
  of them non-dilutive money a small company can actually reach; pinning to
  NSF hid the other ten from every visitor on the business track. Still one
  subrequest either way.

Two consequences that had to be handled rather than discovered later:

- **Overlap is now the norm.** A rural veterans' mental-health grant answers
  three topic queries. Without dedup, the same opportunity was written once
  per query that found it, every duplicate after the first reported as an
  "update," and the run summary became fiction. `runGrantIngest` now dedupes
  by stable id before touching D1, and reports both `fetched` (distinct,
  what gets written) and `fetched_raw` (hits before dedup).
- **`normalizeSbirSolicitation` defaulted a missing agency to "National
  Science Foundation."** Harmless while the query itself was NSF-pinned; a
  fabricated funder name the moment it isn't. Now `'Unknown SBIR/STTR
  agency'`.

The tests that asserted "fans out across all three queries" now derive their
counts from `GRANTS_GOV_QUERIES.length`, so adding a topic broadens coverage
without editing magic numbers in four assertions.

**Still not solved.** This is a wider federal pull, not a full catalog, and
it does nothing for the private foundations and accelerators that matter
most to the target user — those have no public search API and still arrive
one page at a time through the browser extension. The search's own
`disclosure.limits` continues to say so in the visitor's results. The
honest next step is a foundation-side source (Candid/FDO is the obvious
one, and it is not free), which is a purchasing decision, not a code change.

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

## What has changed since the audit

**First branch** (merged as #12) — the tiered public search, findings 2 and
3, and the doc drift under 6.

**This branch:**

- `src/grant-worker-index.ts` — finding 1: the gate fails closed, with the
  fix command in the 503 body and a Worker-log warning. Cron unaffected.
- `src/grant-worker-index.test.ts` — new; 10 tests over the gate and the
  public routing that had none.
- `src/grant-990.ts` + cron — finding 4: `refreshStale990Overviews`, a
  bounded stale-first slice per tick, plus the pure `is990Stale` predicate.
- `src/grant-ingest.ts` — finding 5: the broadened query set, the optional
  agency filter, all-agency SBIR, id-level dedup, and the SBIR funder-name
  fallback fix.
- Tests: 112 passing across 6 suites, `tsc --noEmit` clean.

Verified against a live `wrangler dev` with a local D1, not just stubs:
every `/internal/*` route returns 503 unarmed and 401 on a bad token;
`/health`, `/api/*` and the marketing page keep serving throughout; an
extension-shaped capture with the right token lands a row and that row
appears in the public search; the 990 refresh SQL runs on real D1 with
never-fetched-first ordering intact.

## What is left

1. **Run `wrangler secret put SERVICE_KEY`.** Capture and the manual
   internal triggers return 503 until it is set — that is the fix working as
   intended, not a regression. Use the value already in the grant-capture
   extension's Settings.
2. **A foundation-side opportunity source.** Finding 5's remainder, and a
   purchasing decision rather than an engineering one.
3. **The N+1 upserts** under finding 6, when the corpus is large enough to
   care.
