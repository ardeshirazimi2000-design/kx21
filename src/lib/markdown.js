// Limited markdown for health-magazine articles, rendered on the server. Everything is escaped
// first; only these forms become HTML: ## / ### headings, paragraphs, - and 1. lists,
// > callouts, **bold** and [links](/path or https://…). No raw HTML is ever passed through.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SAFE_URL = /^(https?:\/\/[^\s]+|\/(?!\/)[^\s]*)$/i;

function inline(raw, siteHost) {
  let t = esc(raw);
  t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
    const u = url.replace(/&amp;/g, '&');
    if (!SAFE_URL.test(u)) return text;
    let host = '';
    if (/^https?:\/\//i.test(u)) { try { host = new URL(u).host; } catch { return text; } }
    const external = !!host && host !== siteHost;
    return `<a href="${esc(u)}"${external ? ' rel="noopener nofollow" target="_blank"' : ''}>${text}</a>`;
  });
  return t;
}

// → { html, headings: [{ id, text, level }], text (plain, for word counts and search) }
export function renderMarkdown(src, { siteHost = '' } = {}) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const headings = [];
  const plain = [];
  let para = [];
  let list = null; // { tag, items }
  let quote = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '), siteHost)}</p>`); plain.push(para.join(' ')); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i, siteHost)}</li>`).join('')}</${list.tag}>`); plain.push(...list.items); list = null; } };
  const flushQuote = () => { if (quote.length) { out.push(`<aside class="callout"><p>${inline(quote.join(' '), siteHost)}</p></aside>`); plain.push(quote.join(' ')); quote = []; } };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (const line of lines) {
    const l = line.trim();
    let m;
    if (!l) { flushAll(); continue; }
    if ((m = /^(#{2,3})\s+(.+)$/.exec(l))) {
      flushAll();
      const level = m[1].length;
      const id = `s-${headings.length + 1}`;
      headings.push({ id, text: m[2].replace(/\*\*/g, ''), level });
      out.push(`<h${level} id="${id}">${inline(m[2], siteHost)}</h${level}>`);
      plain.push(m[2]);
    } else if ((m = /^[-*]\s+(.+)$/.exec(l)) || (m = /^\d+[.)]\s+(.+)$/.exec(l))) {
      flushPara(); flushQuote();
      const tag = /^\d/.test(l) ? 'ol' : 'ul';
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push(m[1]);
    } else if ((m = /^>\s?(.*)$/.exec(l))) {
      flushPara(); flushList();
      quote.push(m[1]);
    } else {
      flushList(); flushQuote();
      para.push(l);
    }
  }
  flushAll();
  return { html: out.join('\n'), headings, text: plain.join(' ').replace(/\*\*|\[|\]\([^)]*\)/g, '') };
}

// Persian reading: about 180 words a minute.
export const readingMinutes = (text) => Math.max(1, Math.round(String(text).split(/\s+/).filter(Boolean).length / 180));
