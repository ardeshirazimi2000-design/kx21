/**
 * Smart topic search (جستجوی هوشمند) and related letters (نامه‌های مرتبط).
 *
 * Built in, with no outside service: letters are analysed into weighted Persian terms and phrases
 * (services/textindex.ts) and ranked with BM25, so a topic finds letters that share most of its meaning-bearing
 * words even when the exact phrase is absent. With an AI provider (services/ai.ts) the topic is first expanded
 * with related words, and candidates are re-ranked by embedding similarity.
 */
import type { AuthUser } from '../auth/middleware.js';
import { one, pool, query, tx, type Db } from '../db/pool.js';
import { sha256 } from '../lib/crypto.js';
import { htmlToText } from '../lib/html.js';
import { logger } from '../lib/logger.js';
import { letterVisibleSql } from './access.js';
import { cosine, embed, expandTopic, loadAi } from './ai.js';
import { addTerms, displayTerm, queryTerms, snippet } from './textindex.js';

const K1 = 1.2;
const B = 0.75;

export const letterText = (l: { body: string | null; body_format?: string }) => (l.body ? (l.body_format === 'html' ? htmlToText(l.body) : l.body) : '');

function letterTerms(l: any): { terms: Map<string, number>; len: number; hash: string } {
  const terms = new Map<string, number>();
  addTerms(terms, l.subject, 3);
  addTerms(terms, l.summary, 2);
  addTerms(terms, l.external_org, 2);
  addTerms(terms, l.external_party, 2);
  addTerms(terms, letterText(l), 1);
  let len = 0;
  for (const [t, w] of terms) if (!t.includes('_')) len += w;
  return { terms, len: Math.max(len, 1), hash: sha256(JSON.stringify([...terms])) };
}

/** Indexes letters changed since they were last indexed. One process at a time; others skip. */
export async function refreshIndex(limit = 300): Promise<number> {
  return tx(async (c) => {
    const lock = await one(`SELECT pg_try_advisory_xact_lock(hashtext('letter_index')) AS ok`, [], c);
    if (!lock?.ok) return 0;
    const stale = await query(
      `SELECT l.id, l.subject, l.summary, l.body, l.body_format, l.external_org, l.external_party, li.content_hash
         FROM letters l LEFT JOIN letter_index li ON li.letter_id = l.id
        WHERE li.letter_id IS NULL OR l.updated_at > li.indexed_at ORDER BY l.updated_at DESC LIMIT ${Number(limit)}`,
      [],
      c,
    );
    for (const l of stale) {
      const { terms, len, hash } = letterTerms(l);
      if (hash === l.content_hash) {
        await c.query('UPDATE letter_index SET indexed_at = now() WHERE letter_id = $1', [l.id]);
        continue;
      }
      await c.query('DELETE FROM letter_terms WHERE letter_id = $1', [l.id]);
      if (terms.size) {
        await c.query('INSERT INTO letter_terms (letter_id, term, weight) SELECT $1, * FROM unnest($2::text[], $3::real[])', [
          l.id,
          [...terms.keys()],
          [...terms.values()],
        ]);
      }
      await c.query(
        `INSERT INTO letter_index (letter_id, len, content_hash) VALUES ($1, $2, $3)
         ON CONFLICT (letter_id) DO UPDATE SET len = EXCLUDED.len, content_hash = EXCLUDED.content_hash, indexed_at = now(),
           embedding = NULL, embedding_model = NULL, embedded_at = NULL`,
        [l.id, len, hash],
      );
    }
    return stale.length;
  });
}

/** Embeds unclassified letters for the configured AI model (scheduler). */
export async function embedPending(limit = 64): Promise<number> {
  const ai = await loadAi();
  if (!ai?.embeddingModel) return 0;
  const rows = await query(
    `SELECT l.id, l.subject, l.summary, l.body, l.body_format FROM letters l JOIN letter_index li ON li.letter_id = l.id
      WHERE l.confidentiality = 0 AND (li.embedding IS NULL OR li.embedding_model IS DISTINCT FROM $1) ORDER BY l.updated_at DESC LIMIT ${Number(limit)}`,
    [ai.embeddingModel],
  );
  for (let i = 0; i < rows.length; i += 16) {
    const batch = rows.slice(i, i + 16);
    const vectors = await embed(
      ai,
      batch.map((l) => [l.subject, l.summary, letterText(l)].filter(Boolean).join('\n').slice(0, 4000)),
    );
    for (const [j, l] of batch.entries()) {
      await query('UPDATE letter_index SET embedding = $2, embedding_model = $3, embedded_at = now() WHERE letter_id = $1', [
        l.id,
        vectors[j],
        ai.embeddingModel,
      ]);
    }
  }
  return rows.length;
}

interface Filters {
  kinds?: string[] | null;
  from?: string | null;
  to?: string | null;
  exclude?: string | null;
  includeCancelled?: boolean;
}

/** BM25 over the visible letters: [{ letter_id, score, matched }]. */
async function bm25(u: AuthUser, terms: Map<string, number>, f: Filters, limit: number, db: Db = pool) {
  if (!terms.size) return [];
  const params: unknown[] = [[...terms.keys()], [...terms.values()]];
  const add = (v: unknown) => (params.push(v), `$${params.length}`);
  const where = [letterVisibleSql(u, params)];
  if (!f.includeCancelled) where.push(`l.status <> 'cancelled'`);
  if (f.kinds?.length) where.push(`l.kind = ANY(${add(f.kinds)}::text[])`);
  if (f.from) where.push(`COALESCE(l.registered_at, l.created_at) >= ${add(f.from)}::date`);
  if (f.to) where.push(`COALESCE(l.registered_at, l.created_at) < ${add(f.to)}::date + 1`);
  if (f.exclude) where.push(`l.id <> ${add(f.exclude)}`);
  return query<{ letter_id: string; score: number; matched: string[] }>(
    `WITH q AS (SELECT * FROM unnest($1::text[], $2::real[]) AS q(term, qw)),
          stats AS (SELECT count(*)::real AS n, GREATEST(avg(len), 1) AS avglen FROM letter_index),
          df AS (SELECT lt.term, count(*)::real AS df FROM letter_terms lt JOIN q USING (term) GROUP BY lt.term)
     SELECT lt.letter_id, sum(q.qw * ln(1 + (stats.n - df.df + 0.5) / (df.df + 0.5))
              * (lt.weight * ${K1 + 1}) / (lt.weight + ${K1} * (1 - ${B} + ${B} * li.len / stats.avglen)))::float AS score,
            array_agg(lt.term ORDER BY q.qw DESC) AS matched
       FROM letter_terms lt JOIN q USING (term) JOIN df USING (term) JOIN letter_index li ON li.letter_id = lt.letter_id
       JOIN letters l ON l.id = lt.letter_id CROSS JOIN stats
      WHERE ${where.join(' AND ')}
      GROUP BY lt.letter_id ORDER BY score DESC LIMIT ${Number(limit)}`,
    params,
    db,
  );
}

async function embeddingsOf(ids: string[]): Promise<Map<string, number[]>> {
  if (!ids.length) return new Map();
  const rows = await query('SELECT letter_id, embedding FROM letter_index WHERE letter_id = ANY($1::uuid[]) AND embedding IS NOT NULL', [ids]);
  return new Map(rows.map((r) => [r.letter_id, r.embedding as number[]]));
}

const CARD_COLS = `l.id, l.kind, l.number, l.subject, l.status, l.priority, l.confidentiality, l.registered_at, l.created_at, l.external_org, l.external_party,
  l.summary, l.body, l.body_format, l.reply_to_id, ou.name AS owner_unit`;

async function cards(ids: string[]) {
  if (!ids.length) return new Map<string, any>();
  const rows = await query(`SELECT ${CARD_COLS} FROM letters l LEFT JOIN org_units ou ON ou.id = l.owner_unit_id WHERE l.id = ANY($1::uuid[])`, [ids]);
  return new Map(rows.map((r) => [r.id, r]));
}

const unigrams = (terms: Iterable<string>) => new Set([...terms].flatMap((t) => t.split('_')));

/** Terms that characterise the results beyond the query: suggestions for narrowing the topic. */
async function keywords(ids: string[], exclude: Set<string>): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await query<{ term: string }>(
    `WITH t AS (SELECT term, sum(weight) AS w, count(*) AS c FROM letter_terms WHERE letter_id = ANY($1::uuid[]) AND term <> ALL($2::text[]) GROUP BY term),
          stats AS (SELECT count(*)::real AS n FROM letter_index),
          df AS (SELECT term, count(*)::real AS df FROM letter_terms WHERE term IN (SELECT term FROM t) GROUP BY term)
     SELECT t.term FROM t JOIN df USING (term) CROSS JOIN stats
      WHERE t.c >= $3 AND df.df < stats.n * 0.5
      ORDER BY t.w * ln(1 + stats.n / df.df) * (CASE WHEN t.term LIKE '%\\_%' THEN 1.5 ELSE 1 END) DESC LIMIT 12`,
    [ids, [...exclude], ids.length >= 4 ? 2 : 1],
  );
  // A phrase makes its own words redundant.
  const phrases = rows.filter((r) => r.term.includes('_')).flatMap((r) => r.term.split('_'));
  return rows.filter((r) => r.term.includes('_') || !phrases.includes(r.term)).map((r) => displayTerm(r.term));
}

export interface TopicSearch {
  q: string;
  kinds?: string[] | null;
  from?: string | null;
  to?: string | null;
  includeCancelled?: boolean;
  page: number;
  pageSize: number;
}

export async function topicSearch(u: AuthUser, s: TopicSearch) {
  await refreshIndex().catch((e) => logger.error({ err: e }, 'search index refresh failed'));
  const ai = await loadAi().catch(() => null);
  const terms = queryTerms(s.q);
  const expanded = ai?.chatModel ? await expandTopic(ai, s.q) : [];
  // Related words widen the topic but together weigh half as much as the user's own words.
  const extra = new Map<string, number>();
  for (const phrase of expanded) for (const [t, w] of queryTerms(phrase)) if (!terms.has(t)) extra.set(t, Math.max(extra.get(t) ?? 0, w));
  const own = [...terms.values()].reduce((a, b) => a + b, 0);
  const added = [...extra.values()].reduce((a, b) => a + b, 0);
  for (const [t, w] of extra) terms.set(t, (w * own * 0.5) / added);
  const hits = await bm25(u, terms, s, 100);
  const max = hits[0]?.score ?? 1;
  let ranked = hits.map((h) => ({ ...h, relevance: h.score / max }));
  let reranked = false;
  if (ai?.embeddingModel && hits.length) {
    try {
      const [qv] = await embed(ai, [s.q]);
      const vectors = await embeddingsOf(hits.map((h) => h.letter_id));
      if (vectors.size) {
        ranked = ranked
          .map((h) => {
            const v = vectors.get(h.letter_id);
            return v ? { ...h, relevance: 0.6 * h.relevance + 0.4 * Math.max(0, cosine(qv, v)) } : { ...h, relevance: 0.6 * h.relevance };
          })
          .sort((a, b) => b.relevance - a.relevance);
        reranked = true;
      }
    } catch (e) {
      logger.warn({ err: e }, 'AI re-ranking failed');
    }
  }
  const pageHits = ranked.slice((s.page - 1) * s.pageSize, s.page * s.pageSize);
  const byId = await cards(pageHits.map((h) => h.letter_id));
  const hitWords = unigrams(terms.keys());
  const items = pageHits.flatMap((h) => {
    const l = byId.get(h.letter_id);
    if (!l) return [];
    const { body, body_format, ...card } = l;
    return [
      {
        ...card,
        relevance: Math.round(h.relevance * 100),
        matched: [...new Set(h.matched.map(displayTerm))].slice(0, 8),
        snippet: snippet(letterText({ body, body_format }), hitWords),
      },
    ];
  });
  return {
    items,
    total: ranked.length,
    page: s.page,
    pageSize: s.pageSize,
    keywords: await keywords(
      ranked.slice(0, 30).map((h) => h.letter_id),
      new Set([...terms.keys(), ...hitWords]),
    ),
    expanded,
    ai: { enabled: !!ai, expanded: expanded.length > 0, reranked, canSummarize: !!ai?.chatModel },
  };
}

/** Letters linked to this one (reply chain, same meeting) and letters on the same subject. */
export async function relatedLetters(u: AuthUser, letterId: string, limit = 12) {
  await refreshIndex().catch((e) => logger.error({ err: e }, 'search index refresh failed'));
  const reasons = new Map<string, Set<string>>();
  const note = (id: string, why: string) => {
    if (id === letterId) return;
    if (!reasons.has(id)) reasons.set(id, new Set());
    reasons.get(id)!.add(why);
  };
  const thread = await query(
    `WITH RECURSIVE up AS (SELECT id, reply_to_id, 0 AS d FROM letters WHERE id = $1
        UNION ALL SELECT l.id, l.reply_to_id, up.d + 1 FROM letters l JOIN up ON l.id = up.reply_to_id WHERE up.d < 8),
      root AS (SELECT id FROM up ORDER BY d DESC LIMIT 1),
      down AS (SELECT id, 0 AS d FROM root UNION ALL SELECT l.id, down.d + 1 FROM letters l JOIN down ON l.reply_to_id = down.id WHERE down.d < 8)
     SELECT id FROM down`,
    [letterId],
  );
  for (const r of thread) note(r.id, 'thread');
  const meeting = await query(
    `WITH m AS (
       SELECT meeting_external_id AS mid FROM resolutions_cache WHERE letter_id = $1
       UNION SELECT requested_meeting_id FROM letter_meeting_refs WHERE letter_id = $1 AND requested_meeting_id IS NOT NULL
       UNION SELECT meeting_external_id FROM meeting_invitation_letters WHERE letter_id = $1)
     SELECT letter_id FROM resolutions_cache WHERE meeting_external_id IN (SELECT mid FROM m) AND letter_id IS NOT NULL
     UNION SELECT letter_id FROM letter_meeting_refs WHERE requested_meeting_id IN (SELECT mid FROM m)
     UNION SELECT letter_id FROM meeting_invitation_letters WHERE meeting_external_id IN (SELECT mid FROM m) LIMIT 50`,
    [letterId],
  );
  for (const r of meeting) note(r.letter_id, 'meeting');

  // Same subject: the letter's most distinctive terms as a query.
  const top = await query<{ term: string; w: number }>(
    `WITH stats AS (SELECT count(*)::real AS n FROM letter_index),
          df AS (SELECT term, count(*)::real AS df FROM letter_terms WHERE term IN (SELECT term FROM letter_terms WHERE letter_id = $1) GROUP BY term)
     SELECT lt.term, (lt.weight * ln(1 + stats.n / df.df))::float AS w FROM letter_terms lt JOIN df USING (term) CROSS JOIN stats
      WHERE lt.letter_id = $1 ORDER BY w DESC LIMIT 25`,
    [letterId],
  );
  const similarity = new Map<string, number>();
  if (top.length) {
    const q = new Map(top.map((t) => [t.term, t.w / top[0].w]));
    const self = (await bm25(u, q, { includeCancelled: true }, 1))[0];
    const hits = await bm25(u, q, { exclude: letterId }, 15);
    const selfScore = Math.max(self?.letter_id === letterId ? self.score : (hits[0]?.score ?? 1), 1e-6);
    for (const h of hits) similarity.set(h.letter_id, Math.min(1, h.score / selfScore));
    const ai = await loadAi().catch(() => null);
    if (ai?.embeddingModel) {
      const vectors = await embeddingsOf([letterId, ...hits.map((h) => h.letter_id)]);
      const mine = vectors.get(letterId);
      if (mine)
        for (const h of hits)
          if (vectors.has(h.letter_id))
            similarity.set(h.letter_id, 0.5 * similarity.get(h.letter_id)! + 0.5 * Math.max(0, cosine(mine, vectors.get(h.letter_id)!)));
    }
    for (const [id, sim] of similarity) if (sim >= 0.15) note(id, 'subject');
  }

  // Only letters this user may see.
  const ids = [...reasons.keys()];
  if (!ids.length) return [];
  const params: unknown[] = [ids];
  const visible = await query(`SELECT l.id FROM letters l WHERE l.id = ANY($1::uuid[]) AND ${letterVisibleSql(u, params)}`, params);
  const byId = await cards(visible.map((v) => v.id));
  return [...byId.values()]
    .map(({ body: _b, body_format: _f, ...l }) => ({
      ...l,
      reasons: [...reasons.get(l.id)!],
      similarity: similarity.has(l.id) ? Math.round(similarity.get(l.id)! * 100) : null,
    }))
    .sort((a, b) => b.reasons.length - a.reasons.length || (b.similarity ?? 0) - (a.similarity ?? 0))
    .slice(0, limit);
}
