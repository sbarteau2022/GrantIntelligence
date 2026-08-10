// ============================================================
// MULTIMODAL INTAKE — src/multimodal-intake.ts
//
// This worker's own vision capability — a screenshot captured alongside a
// DOM scrape (e.g. by RAPIDAi's atlas-capture browser extension's grants
// plugin) gets read by a Workers AI vision model as an independent second
// extraction of the same portal, so a DOM parse and a vision read either
// agree (raising confidence) or disagree (flagging the row for review)
// instead of trusting one shaky parse. That's the whole "x2 accuracy" case
// for this module — it's a cross-check, not a replacement for DOM parsing.
//
// Deliberately self-contained: this worker's OWN `env.AI` Workers AI
// binding, no service binding to elle-worker or anywhere else, no shared
// secret to configure. "Unreliant on anything else" per this worker's
// design brief — its health never depends on another repo's worker being
// up.
//
// Deliberately decoupled from the live path: nothing in this module runs
// inside an ingest request's response cycle. A capture lands in
// grant_visual_captures immediately via stageVisualCapture (fast, always
// succeeds — it's just an R2 write + a D1 insert); enrichDueCaptures runs
// later, out-of-band (the maintenance sweep), and never throws past its own
// boundary — a Workers AI failure/timeout/rate-limit leaves a row
// unenriched, never turns into an error surfaced to whoever captured it.
// ============================================================

import { ensureGrantWorkerSchema } from './db/schema';

export interface MultimodalEnv {
  DB: D1Database;
  R2: R2Bucket;
  AI: Ai;
}

export interface VisualDescription {
  funderName: string | null;
  programName: string | null;
  amountText: string | null;
  deadlineText: string | null;
  rawModelText: string;
}

const VISION_MODEL = '@cf/llava-hf/llava-1.5-7b-hf';

const EXTRACTION_PROMPT =
  'This is a screenshot of a grant-funding portal page. Reply with ONLY a JSON object ' +
  '(no markdown, no commentary) with these exact keys: funder_name, program_name, ' +
  'amount_text, deadline_text. Use the funding amount and deadline exactly as shown on ' +
  'the page (as text, not parsed numbers). Use null for any field not visible.';

// Best-effort JSON extraction from a vision model's free-text reply — models
// routinely wrap JSON in prose or code fences despite being told not to.
function parseModelJson(text: string): Partial<Record<'funder_name' | 'program_name' | 'amount_text' | 'deadline_text', unknown>> {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try {
    const parsed = JSON.parse(match[0]);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null' ? v.trim() : null;
}

// Runs the vision model against one image. Never throws — a model error,
// timeout, or malformed reply all resolve to `{ error }`, exactly like every
// other external call in this codebase (grant-990.ts's fetch, grant-ingest's
// fetches) that degrades rather than propagates.
export async function describeScreenshot(env: MultimodalEnv, imageBytes: Uint8Array): Promise<VisualDescription | { error: string }> {
  let raw: { description?: string; response?: string } | string;
  try {
    raw = await env.AI.run(VISION_MODEL, {
      image: Array.from(imageBytes),
      prompt: EXTRACTION_PROMPT,
      max_tokens: 512,
    }) as { description?: string; response?: string } | string;
  } catch (e) {
    return { error: `vision model call failed: ${(e as Error).message}` };
  }
  const text = typeof raw === 'string' ? raw : (raw.description ?? raw.response ?? '');
  if (!text) return { error: 'vision model returned no text' };
  const parsed = parseModelJson(text);
  return {
    funderName: str(parsed.funder_name),
    programName: str(parsed.program_name),
    amountText: str(parsed.amount_text),
    deadlineText: str(parsed.deadline_text),
    rawModelText: text.slice(0, 4000),
  };
}

// ── Staging: fast, always succeeds ──────────────────────────────────────
export async function stageVisualCapture(
  env: MultimodalEnv, imageBytes: Uint8Array, opportunityId?: string,
): Promise<{ id: string }> {
  await ensureGrantWorkerSchema(env.DB);
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const imageRef = `visual-captures/${id}.png`;
  await env.R2.put(imageRef, imageBytes, { httpMetadata: { contentType: 'image/png' } });
  await env.DB.prepare(
    `INSERT INTO grant_visual_captures (id, opportunity_id, image_ref) VALUES (?,?,?)`
  ).bind(id, opportunityId ?? null, imageRef).run();
  return { id };
}

// ── Enrichment sweep: out-of-band, best-effort, bounded per run ────────
export interface EnrichmentResult {
  attempted: number;
  enriched: number;
  failed: number;
}

export async function enrichDueCaptures(env: MultimodalEnv, limit = 10): Promise<EnrichmentResult> {
  await ensureGrantWorkerSchema(env.DB);
  const due = await env.DB.prepare(
    `SELECT id, image_ref FROM grant_visual_captures WHERE enriched_at IS NULL AND error IS NULL ORDER BY created_at ASC LIMIT ?`
  ).bind(limit).all<{ id: string; image_ref: string }>().catch(() => ({ results: [] }));

  let enriched = 0, failed = 0;
  for (const row of due.results ?? []) {
    try {
      const object = await env.R2.get(row.image_ref);
      if (!object) { failed++; await markFailed(env, row.id, 'stored image missing from R2'); continue; }
      const bytes = new Uint8Array(await object.arrayBuffer());
      const result = await describeScreenshot(env, bytes);
      if ('error' in result) { failed++; await markFailed(env, row.id, result.error); continue; }
      await env.DB.prepare(
        `UPDATE grant_visual_captures SET description_json = ?, enriched_at = datetime('now') WHERE id = ?`
      ).bind(JSON.stringify(result), row.id).run();
      enriched++;
    } catch (e) {
      failed++;
      await markFailed(env, row.id, (e as Error).message).catch(() => {});
    }
  }
  return { attempted: (due.results ?? []).length, enriched, failed };
}

async function markFailed(env: MultimodalEnv, id: string, message: string): Promise<void> {
  await env.DB.prepare(`UPDATE grant_visual_captures SET error = ? WHERE id = ?`).bind(message.slice(0, 500), id).run();
}
