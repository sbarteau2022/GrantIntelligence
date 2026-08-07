# Grant Capture

A Chrome (MV3) extension that captures small-funder grant opportunities
directly into this repo's own **grant-worker** — where no API exists
(Grants.gov/SBIR.gov cover federal sources; this covers the long tail of
foundations and state programs an operator finds by hand).

This is a fork-in-spirit of RAPIDAi's `apps/atlas-capture` grants plugin,
but standalone and grant-worker-native: "Rapid is not ingesting grants, the
grant worker is — it needs its own atlas browser plugin as well." Nothing
in this extension talks to RAPIDAi's ingestion worker at all.

## What's new versus the RAPIDAi version

RAPIDAi's atlas-capture README says explicitly: *"A future vision fallback
(screenshot → model) is intentionally not shipped here — it would send page
imagery off-device and warrants its own review before it exists."* That
review happened this session — the grant-worker's `multimodal-intake.ts`
exists specifically for this. So this extension, unlike RAPIDAi's, **does**
capture a screenshot (opt-out checkbox, on by default) alongside the DOM
read, so the grant-worker can run an independent vision extraction and
cross-check it against the DOM parse: agreement raises confidence,
disagreement flags the row for review, instead of trusting one shaky parse
alone.

## Posture — read this first

Same as RAPIDAi's atlas-capture, unchanged:

- **Nothing runs on its own.** No content script loads with the page, no
  alarm, no background polling. The adapter is injected only when the
  operator clicks Capture (`activeTab` + `chrome.scripting`).
- **It reads what's already on screen.** DOM-first extraction of whatever
  the operator is already looking at, in their own session. No navigation,
  no credential/cookie access.
- **The screenshot, if taken, is of the visible tab only**, taken in the
  same user-gesture context as the DOM read, and only ever sent to this
  repo's own grant-worker — never a third party.

## How it flows

```
operator on a funder/foundation page ──click Capture──▶ popup injects grants-adapter.js
        │                                                          │
        │                                          adapter reads the page's DOM
        │                                                          ▼
        │                                background worker POSTs the batch
        ▼                                                          │
  grant-worker  POST /internal/atlas-observation  ◀── Bearer <operator token> ┘
        │
   server-side gate: normalize · sanity-check · de-dupe (grant-observation.ts)
        ▼
   grant_opportunities  (source='atlas-capture')
        │
        │  (if the screenshot checkbox was on)
        ▼
   POST /internal/visual-capture?opportunity_id=<id>  — staged for the
   cron sweep's independent vision read (multimodal-intake.ts)
```

The extension is **not trusted** — `grant-observation.ts` re-validates,
normalizes, and de-duplicates everything before a row is written, exactly
like the RAPIDAi gates this pattern comes from.

## Install (unpacked, per operator)

1. Chrome → Extensions → enable Developer mode → **Load unpacked** →
   select `apps/grant-capture`.
2. Click the toolbar icon → **Settings**:
   - **grant-worker URL** — the deployed grant-worker's base URL
     (`https://grant-intelligence-worker.…workers.dev`).
   - **Operator token** — matches the grant-worker's `SERVICE_KEY` secret
     (`wrangler secret put SERVICE_KEY` in `workers/grant-worker`). Treat it
     as extractable — anything shipped in an extension is.
3. Open a funder/foundation portal page and click **Capture from this
   page**. Leave "Also capture a screenshot" checked for the vision
   cross-check, or uncheck it for a DOM-only capture.

## Tuning the selectors

Same two-strategy shape as the adapter this was ported from — `SELECTORS`
(stubbed, fill in per portal from the live DOM) and `HEURISTIC` (a generic
scan that works as a best-effort fallback). See
`content/grants-adapter.js`'s own header comment.

## Files

| file | role |
| --- | --- |
| `manifest.json` | MV3 manifest — `activeTab` + `scripting`, no host_permissions (arbitrary small-funder domains, covered by `activeTab`'s per-click grant) |
| `content/grants-adapter.js` | DOM extraction — selectors → heuristic |
| `popup/*` | the only place capture is initiated; settings live here |
| `background.js` | authenticated delivery of the DOM batch AND the optional screenshot, routed to the grant-worker; survives popup close |

Server side: `workers/grant-worker/src/grant-observation.ts` (the gate +
upsert into `grant_opportunities`), `workers/grant-worker/src/multimodal-intake.ts`
(the vision cross-check the screenshot feeds).
