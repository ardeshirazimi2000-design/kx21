import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { query, type Db, pool } from '../db/pool.js';
import { logger } from '../lib/logger.js';

/**
 * Similar resolutions (یافتن مصوبات مشابه). With an embedding engine configured (AI_BASE_URL, e.g. Ollama
 * with bge-m3 on the organisation's server) texts are compared by meaning; otherwise, or when the engine
 * is unreachable, by character trigrams (pg_trgm). Only resolution texts are ever sent to the engine.
 */

export type SimilarityEngine = 'ai' | 'text';

export interface SimilarPair {
  source: string;
  candidate: string;
  score: number;
}

/** Trigram similarity is on a lower scale than cosine similarity of embeddings. */
const TEXT_MIN_SCORE = 0.3;
const BATCH = 16;

/** Unifies Arabic/Persian letters, ZWNJ and spacing so equal words compare equal. */
export function normalizeText(t: string): string {
  return t
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[‌‏‎]/g, ' ')
    .replace(/[ً-ٰٟ]/g, '')
    .replace(/[«»"'()،,.:؛;!؟?\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export const aiEnabled = () => !!config.ai.baseUrl;

export function engineInfo(): { engine: SimilarityEngine; model: string | null } {
  return aiEnabled() ? { engine: 'ai', model: config.ai.embeddingModel } : { engine: 'text', model: null };
}

async function embed(texts: string[]): Promise<number[][]> {
  const res = await fetch(`${config.ai.baseUrl}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(config.ai.apiKey ? { authorization: `Bearer ${config.ai.apiKey}` } : {}) },
    body: JSON.stringify({ model: config.ai.embeddingModel, input: texts }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { data: { embedding: number[]; index?: number }[] };
  return [...body.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
}

const hashOf = (text: string) => createHash('sha1').update(`${config.ai.embeddingModel}\n${normalizeText(text)}`).digest('hex');

/** Embeddings of the given resolutions, computing missing or stale ones (text or model changed). */
export async function ensureEmbeddings(ids: string[], db: Db = pool): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (!ids.length) return out;
  const rows = await query<{ id: string; text: string; text_hash: string | null; embedding: number[] | null }>(
    `SELECT r.id, r.text, e.text_hash, e.embedding FROM resolutions r LEFT JOIN resolution_embeddings e ON e.resolution_id = r.id
      WHERE r.id = ANY($1)`,
    [ids],
    db,
  );
  const missing: { id: string; text: string; hash: string }[] = [];
  for (const r of rows) {
    const hash = hashOf(r.text);
    if (r.embedding && r.text_hash === hash) out.set(r.id, r.embedding);
    else missing.push({ id: r.id, text: r.text, hash });
  }
  for (let i = 0; i < missing.length; i += BATCH) {
    const part = missing.slice(i, i + BATCH);
    const vectors = await embed(part.map((m) => normalizeText(m.text)));
    for (let j = 0; j < part.length; j++) {
      out.set(part[j].id, vectors[j]);
      await db.query(
        `INSERT INTO resolution_embeddings (resolution_id, model, text_hash, embedding) VALUES ($1,$2,$3,$4)
         ON CONFLICT (resolution_id) DO UPDATE SET model = EXCLUDED.model, text_hash = EXCLUDED.text_hash, embedding = EXCLUDED.embedding, created_at = now()`,
        [part[j].id, config.ai.embeddingModel, part[j].hash, vectors[j]],
      );
    }
  }
  return out;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Pairs (source, candidate) whose texts are similar, best first. Falls back to text similarity when the
 * engine fails, so the feature keeps working while the AI server is down.
 */
export async function similarPairs(sources: string[], candidates: string[], db: Db = pool): Promise<{ engine: SimilarityEngine; pairs: SimilarPair[] }> {
  if (!sources.length || !candidates.length) return { engine: engineInfo().engine, pairs: [] };
  if (aiEnabled()) {
    try {
      const vec = await ensureEmbeddings([...new Set([...sources, ...candidates])], db);
      const pairs: SimilarPair[] = [];
      for (const s of sources) {
        const a = vec.get(s);
        if (!a) continue;
        for (const c of candidates) {
          const b = vec.get(c);
          if (!b || s === c) continue;
          const score = cosine(a, b);
          if (score >= config.ai.minScore) pairs.push({ source: s, candidate: c, score });
        }
      }
      return { engine: 'ai', pairs: pairs.sort((x, y) => y.score - x.score) };
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'similarity: AI engine unavailable, using text similarity');
    }
  }
  const NORM = (col: string) =>
    `lower(regexp_replace(translate(${col}, 'يىك‌«»،.؛:()', 'ییک         '), '\\s+', ' ', 'g'))`;
  const rows = await query<SimilarPair>(
    `SELECT a.id AS source, b.id AS candidate, similarity(${NORM('a.text')}, ${NORM('b.text')})::float AS score
       FROM resolutions a, resolutions b
      WHERE a.id = ANY($1) AND b.id = ANY($2) AND a.id <> b.id
        AND similarity(${NORM('a.text')}, ${NORM('b.text')}) >= $3
      ORDER BY score DESC`,
    [sources, candidates, TEXT_MIN_SCORE],
    db,
  );
  return { engine: 'text', pairs: rows };
}

/** Backfills embeddings of resolutions in network commissions (run by the scheduler). */
export async function backfillEmbeddings(limit = 64): Promise<number> {
  if (!aiEnabled()) return 0;
  const rows = await query<{ id: string }>(
    `SELECT r.id FROM resolutions r
      WHERE r.status <> 'cancelled' AND r.commission_id IN (SELECT commission_id FROM network_commissions)
        AND NOT EXISTS (SELECT 1 FROM resolution_embeddings e WHERE e.resolution_id = r.id AND e.model = $1)
      ORDER BY r.created_at DESC LIMIT $2`,
    [config.ai.embeddingModel, limit],
  );
  if (!rows.length) return 0;
  await ensureEmbeddings(rows.map((r) => r.id));
  return rows.length;
}
