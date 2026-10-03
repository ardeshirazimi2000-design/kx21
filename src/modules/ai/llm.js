// Text generation. The design doc requires a self-hosted model (vLLM, OpenAI-compatible API)
// for any message containing patient data. When LLM_BASE_URL is not configured, or the call
// fails, the assistant falls back to grounded templates so it still answers from the KB.

const SYSTEM_PROMPT = `تو دستیار یک پلتفرم ویزیت از راه دور هستی و فقط فارسی پاسخ می‌دهی.
قواعد غیرقابل تغییر:
- هرگز تشخیص بیماری، دوز دارو یا تغییر درمان اعلام نکن؛ این‌ها فقط کار پزشک است.
- فقط بر اساس «منابع تأییدشده» زیر پاسخ بده. اگر پاسخ در منابع نیست، بگو نمی‌دانی.
- کوتاه، روشن و محترمانه پاسخ بده (حداکثر ۴ جمله).`;

export function createLlm(config) {
  const enabled = !!config.llmBaseUrl;

  async function generate({ question, chunks }) {
    if (!enabled) return { text: templateAnswer(chunks), model_version: 'template-v1' };
    const context = chunks.map((c, i) => `[${i + 1}] ${c.title}: ${c.text}`).join('\n');
    try {
      const res = await fetch(`${config.llmBaseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.llmApiKey ? { Authorization: `Bearer ${config.llmApiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.llmModel,
          temperature: 0.2,
          max_tokens: 400,
          messages: [
            { role: 'system', content: `${SYSTEM_PROMPT}\n\nمنابع تأییدشده:\n${context}` },
            { role: 'user', content: question },
          ],
        }),
        signal: AbortSignal.timeout(config.llmTimeoutMs),
      });
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error('empty LLM response');
      return { text, model_version: `${config.llmModel}` };
    } catch (e) {
      console.warn('[llm] falling back to template:', e.message);
      return { text: templateAnswer(chunks), model_version: 'template-v1', fallback: true };
    }
  }

  return { enabled, generate };
}

function templateAnswer(chunks) {
  const [top] = chunks;
  return `${top.text}`;
}
