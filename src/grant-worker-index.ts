// ============================================================
// GRANT INTELLIGENCE WORKER — src/grant-worker-index.ts
//
// The whole grant DATA layer, moved out of elle-worker: ingests
// (Grants.gov/SBIR.gov live pull + the manual grant-strategy-map.md seed),
// verifies/dedupes (upsert keyed on a stable id derived from each source's
// own identifier), maintains (closes stale rows), and holds its own
// multimodal intake (Workers AI vision, no dependency on elle-worker's
// PFAR/vFAR or any other worker). elle-worker reads this data via a direct
// D1 binding (GRANT_DB) — never HTTP — so nothing here can add latency or
// failure modes to elle-worker's request path.
//
// Three kinds of route live here, and they are gated differently:
//   • /health                 — always open.
//   • /api/*                  — PUBLIC, unauthenticated. The marketing
//                               page's tiered opportunity search (see
//                               grant-search.ts). Read-only, no LLM call.
//   • /internal/*             — service-key-gated machine calls + cron.
// Everything else falls through to the static assets in public/.
// ============================================================

import { runGrantIngest, seedOpportunities, type GrantWorkerEnv } from './grant-ingest';
import { run990OverviewForAllFunders } from './grant-990';
import { enrichDueCaptures, stageVisualCapture, type MultimodalEnv } from './multimodal-intake';
import { ingestAtlasObservations } from './grant-observation';
import {
  searchOpportunities, resolveTier, TIERS, TIER_ORDER, ORG_TYPES, ENTITY_STAGES, FUNDING_BANDS,
  type GrantSearchEnv,
} from './grant-search';

export interface Env extends GrantWorkerEnv, MultimodalEnv, GrantSearchEnv {
  SERVICE_KEY?: string;
}

// The public search reads a few thousand rows and scores them in memory —
// cheap, but not free, and it sits on an unauthenticated route. Cap the
// request body so a multi-megabyte "profile" can't be used to make the
// Worker do work on our bill.
const MAX_SEARCH_BODY_BYTES = 8 * 1024;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a), bb = new TextEncoder().encode(b);
  const n = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

// Same posture as elle-worker's ELLE_SERVICE_KEY / RAPIDAi's
// INGEST_API_TOKEN: a shared secret bearer token for machine callers.
// Dormant (open) until SERVICE_KEY is actually configured, matching this
// codebase's convention elsewhere of "today's behaviour is unchanged" until
// deliberately armed.
function isAuthorized(request: Request, env: Env): boolean {
  if (!env.SERVICE_KEY) return true;
  const presented = request.headers.get('Authorization') || '';
  return timingSafeEqualStr(presented, `Bearer ${env.SERVICE_KEY}`);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ status: 'ok', ts: new Date().toISOString() });
      }

      // ── Public API (no service key) ───────────────────────────────────
      // The vocabulary the search form is built from. Served from the same
      // constants the scorer uses, so the form can never offer an option
      // scoring doesn't understand.
      if (request.method === 'GET' && url.pathname === '/api/tiers') {
        return json({
          tiers: TIER_ORDER.map((t) => TIERS[t]),
          org_types: ORG_TYPES,
          entity_stages: ENTITY_STAGES,
          funding_bands: FUNDING_BANDS,
        });
      }

      // The tiered opportunity search. Body: { profile, tier }.
      // Tier entitlement is resolved server-side (resolveTier) and the
      // fields a tier doesn't get are removed BEFORE serialization — the
      // browser is never sent something it's meant to hide.
      if (request.method === 'POST' && url.pathname === '/api/search') {
        const rawBody = await request.text();
        if (rawBody.length > MAX_SEARCH_BODY_BYTES) {
          return json({ error: 'request body too large' }, 413);
        }
        const body = (rawBody ? safeParse(rawBody) : {}) as { profile?: unknown; tier?: unknown } | null;
        if (!body) return json({ error: 'invalid JSON body' }, 400);
        const { tier, requested, enforced } = resolveTier(
          env, body.tier, request.headers.get('X-GI-Entitlement'),
        );
        const found = await searchOpportunities(env, body.profile, tier);
        return json({ tier, tier_requested: requested, entitlement_enforced: enforced, ...found });
      }

      if (!isAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);

      if (request.method === 'POST' && url.pathname === '/internal/run-ingest') {
        return json(await runGrantIngest(env));
      }
      if (request.method === 'POST' && url.pathname === '/internal/seed') {
        return json(await seedOpportunities(env));
      }
      if (request.method === 'POST' && url.pathname === '/internal/990-all') {
        const results = await run990OverviewForAllFunders(env);
        return json({ funders: results.length, succeeded: results.filter((r) => !('error' in r.result)).length, results });
      }
      if (request.method === 'POST' && url.pathname === '/internal/enrich-captures') {
        return json(await enrichDueCaptures(env));
      }
      // This worker's own atlas plugin (apps/grant-capture in this repo)
      // posts here — the browser-capture counterpart to grant-ingest.ts's
      // Grants.gov/SBIR.gov pull. Body: { observations: RawGrantObservation[] }.
      // Returns each valid observation's stable id so the extension can pair
      // a screenshot to it via /internal/visual-capture?opportunity_id=<id>.
      if (request.method === 'POST' && url.pathname === '/internal/atlas-observation') {
        const body = await request.json().catch(() => null) as { observations?: unknown } | null;
        if (!body) return json({ error: 'invalid JSON body' }, 400);
        return json(await ingestAtlasObservations(env, body.observations), 201);
      }
      // A screenshot captured alongside a DOM scrape (e.g. RAPIDAi's
      // atlas-capture grants plugin) — stages immediately, enriched later by
      // the cron sweep. Body: raw image bytes; ?opportunity_id= optional.
      if (request.method === 'POST' && url.pathname === '/internal/visual-capture') {
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (!bytes.length) return json({ error: 'empty request body — expected raw image bytes' }, 400);
        const opportunityId = url.searchParams.get('opportunity_id') || undefined;
        return json(await stageVisualCapture(env, bytes, opportunityId), 201);
      }

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      console.error('[grant-worker] unhandled error:', (err as Error)?.stack || (err as Error)?.message || err);
      return json({ error: 'grant_worker_failed' }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // One cron trigger, three independent, best-effort passes — a failure in
    // one must never block the others (matches elle-worker's clock-dispatch
    // convention of catching per-job rather than per-tick).
    ctx.waitUntil(runGrantIngest(env).catch((e) => console.error('[CRON] runGrantIngest failed:', (e as Error).message)));
    ctx.waitUntil(enrichDueCaptures(env).catch((e) => console.error('[CRON] enrichDueCaptures failed:', (e as Error).message)));
  },
};
