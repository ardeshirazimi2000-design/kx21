import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requirePerm } from '../auth/middleware.js';
import { one, query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { encryptText } from '../lib/crypto.js';
import { badRequest } from '../lib/errors.js';
import { body, dateStr, listParam, param, parse, uuid } from '../lib/validate.js';
import { letterVisibleSql, loadVisibleLetter } from '../services/access.js';
import { chat, embed, loadAi } from '../services/ai.js';
import { letterText, relatedLetters, topicSearch } from '../services/search.js';

export const searchRouter = Router();

/** «جستجوی هوشمند»: letters on a topic, ranked by relevance, with related keywords. */
searchRouter.get('/search', async (req, res) => {
  const u = currentUser(req);
  const f = parse(
    z.object({
      q: z.string().trim().min(2, 'موضوع جستجو را وارد کنید').max(300),
      kind: z.string().optional(),
      from: dateStr.optional(),
      to: dateStr.optional(),
      cancelled: z.enum(['0', '1']).default('0'),
      page: z.coerce.number().int().min(1).max(10).default(1),
      pageSize: z.coerce.number().int().min(1).max(50).default(20),
    }),
    req.query,
  );
  res.json(await topicSearch(u, { ...f, kinds: listParam(f.kind), includeCancelled: f.cancelled === '1' }));
});

searchRouter.get('/letters/:id/related', async (req, res) => {
  const u = currentUser(req);
  const l = await loadVisibleLetter(u, param(req, 'id'));
  res.json(await relatedLetters(u, l.id));
});

/** AI summary of what the chosen letters say about the topic. Classified letters are never sent to the model. */
searchRouter.post('/search/summary', async (req, res) => {
  const u = currentUser(req);
  const b = body(req, z.object({ q: z.string().trim().min(2).max(300), letterIds: z.array(uuid).min(1).max(12) }));
  const ai = await loadAi();
  if (!ai?.chatModel) throw badRequest('هوش مصنوعی برای خلاصه‌سازی تنظیم نشده است');
  const params: unknown[] = [b.letterIds];
  const letters = await query(
    `SELECT l.id, l.kind, l.number, l.subject, l.summary, l.body, l.body_format, l.external_org, l.registered_at, l.created_at
       FROM letters l WHERE l.id = ANY($1::uuid[]) AND l.confidentiality = 0 AND ${letterVisibleSql(u, params)}
      ORDER BY COALESCE(l.registered_at, l.created_at)`,
    params,
  );
  if (!letters.length) throw badRequest('نامه قابل خلاصه‌سازی (غیرطبقه‌بندی‌شده) انتخاب نشده است');
  const context = letters
    .map((l, i) =>
      [
        `[${i + 1}] نامه ${l.number ?? 'پیش‌نویس'} — ${new Date(l.registered_at ?? l.created_at).toISOString().slice(0, 10)}${l.external_org ? ` — ${l.external_org}` : ''}`,
        `موضوع: ${l.subject}`,
        l.summary ? `خلاصه: ${l.summary}` : '',
        letterText(l).slice(0, 1500),
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
  const text = await chat(
    ai,
    'تو دستیار دبیرخانه اتاق بازرگانی هستی. فقط بر اساس نامه‌های داده‌شده و به فارسی رسمی و کوتاه پاسخ بده؛ چیزی از خودت اضافه نکن و برای هر ادعا شماره نامه را در کروشه بیاور، مانند [۲].',
    `موضوع: «${b.q}»\n\nنامه‌ها:\n${context}\n\nدر حداکثر ۸ جمله بگو این نامه‌ها درباره این موضوع چه می‌گویند، چه تصمیم یا درخواستی در آنهاست و آخرین وضعیت چیست.`,
    700,
  ).catch((e) => {
    throw badRequest(`پاسخ هوش مصنوعی دریافت نشد: ${(e as Error).message}`);
  });
  res.json({ summary: text, letters: letters.map((l, i) => ({ ref: i + 1, id: l.id, number: l.number, subject: l.subject })) });
});

// ─────────────── AI provider settings («یکپارچه‌سازی») ───────────────

searchRouter.get('/integrations/ai', async (req, res) => {
  requirePerm(currentUser(req), 'integration.manage');
  const r = await one(`SELECT base_url, client_secret_enc, settings, is_active, updated_at FROM integrations WHERE kind = 'ai'`);
  const [stats] = await query(
    `SELECT (SELECT count(*) FROM letters)::int AS letters, count(*)::int AS indexed, count(embedding)::int AS embedded FROM letter_index`,
  );
  res.json({
    baseUrl: r?.base_url ?? '',
    hasApiKey: !!r?.client_secret_enc,
    embeddingModel: r?.settings?.embeddingModel ?? '',
    chatModel: r?.settings?.chatModel ?? '',
    isActive: r?.is_active ?? false,
    updatedAt: r?.updated_at ?? null,
    stats,
  });
});

searchRouter.put('/integrations/ai', async (req, res) => {
  requirePerm(currentUser(req), 'integration.manage');
  const b = body(
    req,
    z.object({
      baseUrl: z
        .string()
        .url()
        .transform((s) => s.replace(/\/+$/, '')),
      apiKey: z.string().max(500).nullish(), // undefined keeps the stored key, null or '' removes it
      embeddingModel: z.string().max(200).nullish(),
      chatModel: z.string().max(200).nullish(),
      isActive: z.boolean().default(true),
    }),
  );
  if (!b.embeddingModel && !b.chatModel) throw badRequest('دست‌کم یکی از مدل‌ها را وارد کنید');
  await tx(async (c) => {
    await c.query(
      `INSERT INTO integrations (kind, name, base_url, client_secret_enc, settings, is_active) VALUES ('ai','هوش مصنوعی (جستجوی هوشمند)',$1,$2,$3,$4)
       ON CONFLICT (kind) DO UPDATE SET base_url = EXCLUDED.base_url,
         client_secret_enc = CASE WHEN $5::boolean THEN EXCLUDED.client_secret_enc ELSE integrations.client_secret_enc END,
         settings = EXCLUDED.settings, is_active = EXCLUDED.is_active, updated_at = now()`,
      [
        b.baseUrl,
        b.apiKey ? encryptText(b.apiKey) : null,
        JSON.stringify({ embeddingModel: b.embeddingModel || null, chatModel: b.chatModel || null }),
        b.isActive,
        b.apiKey !== undefined,
      ],
    );
    await audit(c, req, {
      action: 'integration.ai_configured',
      entity: 'integration',
      entityId: 'ai',
      after: { baseUrl: b.baseUrl, embeddingModel: b.embeddingModel, chatModel: b.chatModel, isActive: b.isActive, apiKeyChanged: b.apiKey !== undefined },
    });
  });
  res.status(204).end();
});

searchRouter.post('/integrations/ai/test', async (req, res) => {
  requirePerm(currentUser(req), 'integration.manage');
  const ai = await loadAi();
  if (!ai) throw badRequest('هوش مصنوعی تنظیم یا فعال نشده است');
  const result: Record<string, unknown> = {};
  if (ai.embeddingModel) {
    try {
      const [v] = await embed(ai, ['آزمون اتصال جستجوی هوشمند']);
      result.embedding = { ok: true, dimensions: v.length };
    } catch (e) {
      result.embedding = { ok: false, error: (e as Error).message };
    }
  }
  if (ai.chatModel) {
    try {
      result.chat = { ok: true, reply: (await chat(ai, 'کوتاه پاسخ بده.', 'فقط بنویس: آماده', 20)).slice(0, 100) };
    } catch (e) {
      result.chat = { ok: false, error: (e as Error).message };
    }
  }
  res.json(result);
});
