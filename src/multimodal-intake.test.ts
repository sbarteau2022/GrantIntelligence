import { describe, it, expect } from 'vitest';
import { describeScreenshot, stageVisualCapture, enrichDueCaptures } from './multimodal-intake';

function fakeAi(run: (model: string, input: unknown) => Promise<unknown>) {
  return { run } as unknown as Ai;
}

describe('describeScreenshot', () => {
  it('parses a clean JSON reply', async () => {
    const ai = fakeAi(async () => ({ description: '{"funder_name":"VA","program_name":"SSG Fox","amount_text":"$750,000","deadline_text":"FY26"}' }));
    const result = await describeScreenshot({ AI: ai } as any, new Uint8Array([1, 2, 3]));
    expect(result).toMatchObject({ funderName: 'VA', programName: 'SSG Fox', amountText: '$750,000', deadlineText: 'FY26' });
  });

  it('extracts JSON even when the model wraps it in prose', async () => {
    const ai = fakeAi(async () => ({ response: 'Sure, here you go:\n```json\n{"funder_name":"NSF","program_name":null,"amount_text":null,"deadline_text":null}\n```' }));
    const result = await describeScreenshot({ AI: ai } as any, new Uint8Array());
    expect((result as any).funderName).toBe('NSF');
    expect((result as any).programName).toBeNull();
  });

  it('returns an error rather than throwing when the model call fails', async () => {
    const ai = fakeAi(async () => { throw new Error('rate limited'); });
    const result = await describeScreenshot({ AI: ai } as any, new Uint8Array());
    expect(result).toEqual({ error: expect.stringMatching(/rate limited/) });
  });

  it('returns an error when the model returns no usable text', async () => {
    const ai = fakeAi(async () => ({}));
    const result = await describeScreenshot({ AI: ai } as any, new Uint8Array());
    expect(result).toEqual({ error: expect.stringMatching(/no text/) });
  });

  it('degrades to empty fields rather than throwing on unparseable JSON', async () => {
    const ai = fakeAi(async () => ({ description: 'not json at all, sorry' }));
    const result = await describeScreenshot({ AI: ai } as any, new Uint8Array());
    expect((result as any).funderName).toBeNull();
    expect((result as any).rawModelText).toContain('not json');
  });
});

// Minimal in-memory D1 + R2 stub.
function fakeEnv() {
  const rows = new Map<string, { id: string; image_ref: string; description_json: string | null; enriched_at: string | null; error: string | null; created_at: string }>();
  const objects = new Map<string, Uint8Array>();
  const db = {
    prepare: (sql: string) => {
      const bound: unknown[] = [];
      const api = {
        bind: (...args: unknown[]) => { bound.push(...args); return api; },
        run: async () => {
          if (sql.startsWith('INSERT INTO grant_visual_captures')) {
            const [id, opportunityId, imageRef] = bound as [string, string | null, string];
            rows.set(id, { id, image_ref: imageRef, description_json: null, enriched_at: null, error: null, created_at: new Date().toISOString() });
          } else if (sql.startsWith('UPDATE grant_visual_captures SET description_json')) {
            const [descriptionJson, id] = bound as [string, string];
            const row = rows.get(id);
            if (row) { row.description_json = descriptionJson; row.enriched_at = 'now'; }
          } else if (sql.startsWith('UPDATE grant_visual_captures SET error')) {
            const [error, id] = bound as [string, string];
            const row = rows.get(id);
            if (row) row.error = error;
          }
          return { meta: { changes: 1 } } as unknown as D1Result;
        },
        all: async <T,>() => {
          if (sql.includes('WHERE enriched_at IS NULL AND error IS NULL')) {
            const limit = bound[0] as number;
            const results = [...rows.values()].filter((r) => !r.enriched_at && !r.error).slice(0, limit).map((r) => ({ id: r.id, image_ref: r.image_ref }));
            return { results } as unknown as D1Result<T>;
          }
          return { results: [] } as unknown as D1Result<T>;
        },
        first: async () => null,
      };
      return api;
    },
    batch: async (_stmts: unknown[]) => [],
  };
  const r2 = {
    put: async (key: string, value: Uint8Array) => { objects.set(key, value); },
    get: async (key: string) => {
      const bytes = objects.get(key);
      if (!bytes) return null;
      return { arrayBuffer: async () => bytes.buffer } as unknown as R2ObjectBody;
    },
  };
  return { DB: db as unknown as D1Database, R2: r2 as unknown as R2Bucket, _rows: rows, _objects: objects };
}

describe('stageVisualCapture', () => {
  it('writes the image to R2 and a row to D1, always succeeding', async () => {
    const env = fakeEnv();
    const { id } = await stageVisualCapture({ ...env, AI: {} as Ai }, new Uint8Array([9, 9, 9]));
    expect(env._objects.has(`visual-captures/${id}.png`)).toBe(true);
    expect(env._rows.get(id)?.enriched_at).toBeNull();
  });
});

describe('enrichDueCaptures', () => {
  it('enriches a due capture using the vision model', async () => {
    const env = fakeEnv();
    const ai = fakeAi(async () => ({ description: '{"funder_name":"VA","program_name":"X","amount_text":"$1","deadline_text":"soon"}' }));
    const { id } = await stageVisualCapture({ ...env, AI: ai }, new Uint8Array([1]));
    const result = await enrichDueCaptures({ ...env, AI: ai });
    expect(result).toEqual({ attempted: 1, enriched: 1, failed: 0 });
    expect(env._rows.get(id)?.enriched_at).toBe('now');
  });

  it('marks a row failed rather than throwing when the model errors, and never retries it in the same run', async () => {
    const env = fakeEnv();
    const ai = fakeAi(async () => { throw new Error('model down'); });
    await stageVisualCapture({ ...env, AI: ai }, new Uint8Array([1]));
    const result = await enrichDueCaptures({ ...env, AI: ai });
    expect(result).toEqual({ attempted: 1, enriched: 0, failed: 1 });
  });

  it('marks a row failed when its stored image is missing from R2', async () => {
    const env = fakeEnv();
    await env.DB.prepare(`INSERT INTO grant_visual_captures (id, opportunity_id, image_ref) VALUES (?,?,?)`).bind('orphan', null, 'visual-captures/gone.png').run();
    const result = await enrichDueCaptures({ ...env, AI: fakeAi(async () => ({})) });
    expect(result.failed).toBe(1);
  });

  it('respects the limit', async () => {
    const env = fakeEnv();
    const ai = fakeAi(async () => ({ description: '{"funder_name":null,"program_name":null,"amount_text":null,"deadline_text":null}' }));
    for (let i = 0; i < 5; i++) await stageVisualCapture({ ...env, AI: ai }, new Uint8Array([i]));
    const result = await enrichDueCaptures({ ...env, AI: ai }, 2);
    expect(result.attempted).toBe(2);
  });
});
