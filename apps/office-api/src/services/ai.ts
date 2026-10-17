/**
 * Optional AI provider for the smart search, configured in «یکپارچه‌سازی». Any OpenAI-compatible API works
 * (/embeddings, /chat/completions) — preferably a model on the organisation's own server (e.g. Ollama with a
 * multilingual model), since letter text is sent to it. Classified letters are never sent.
 */
import { one } from '../db/pool.js';
import { decryptText } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';

export interface AiProvider {
  baseUrl: string;
  apiKey: string | null;
  embeddingModel: string | null;
  chatModel: string | null;
}

export async function loadAi(): Promise<AiProvider | null> {
  const r = await one(`SELECT base_url, client_secret_enc, settings FROM integrations WHERE kind = 'ai' AND is_active`);
  if (!r?.base_url) return null;
  return {
    baseUrl: r.base_url,
    apiKey: r.client_secret_enc ? decryptText(r.client_secret_enc) : null,
    embeddingModel: r.settings?.embeddingModel || null,
    chatModel: r.settings?.chatModel || null,
  };
}

async function call<T>(ai: AiProvider, path: string, body: unknown, timeoutMs: number): Promise<T> {
  const res = await fetch(`${ai.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(ai.apiKey ? { authorization: `Bearer ${ai.apiKey}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`AI ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

export async function embed(ai: AiProvider, texts: string[]): Promise<number[][]> {
  if (!ai.embeddingModel) throw new Error('مدل embedding تعریف نشده است');
  const r = await call<{ data: { embedding: number[]; index?: number }[] }>(ai, '/embeddings', { model: ai.embeddingModel, input: texts }, 30_000);
  return [...r.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
}

export async function chat(ai: AiProvider, system: string, user: string, maxTokens = 600): Promise<string> {
  if (!ai.chatModel) throw new Error('مدل گفتگو تعریف نشده است');
  const r = await call<{ choices: { message: { content: string } }[] }>(
    ai,
    '/chat/completions',
    {
      model: ai.chatModel,
      temperature: 0.2,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    },
    60_000,
  );
  return r.choices[0]?.message?.content?.trim() ?? '';
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Related words and phrases an expert would also search for (synonyms, broader and narrower terms). */
export async function expandTopic(ai: AiProvider, q: string): Promise<string[]> {
  try {
    const text = await chat(
      ai,
      'تو دستیار جستجوی بایگانی نامه‌های اداری اتاق بازرگانی هستی. فقط فهرست کلیدواژه‌ها را با ویرگول جدا کن و هیچ توضیحی ننویس.',
      `برای موضوع «${q}» حداکثر ۸ کلیدواژه یا عبارت کوتاه فارسی هم‌معنی یا مرتبط بنویس که احتمالاً در نامه‌های اداری درباره این موضوع آمده است.`,
      120,
    );
    return text
      .split(/[,،\n]/)
      .map((s) => s.replace(/^[\s\d.\-*•]+/, '').trim())
      .filter((s) => s.length >= 2 && s.length <= 40)
      .slice(0, 8);
  } catch (e) {
    logger.warn({ err: e }, 'AI topic expansion failed');
    return [];
  }
}
