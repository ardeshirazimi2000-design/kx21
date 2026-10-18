import sanitizeHtml from 'sanitize-html';

/** What the letter editor produces; anything else (scripts, event handlers, images, iframes, foreign styles) is dropped. */
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p',
    'br',
    'strong',
    'b',
    'em',
    'i',
    'u',
    's',
    'h1',
    'h2',
    'h3',
    'h4',
    'ul',
    'ol',
    'li',
    'blockquote',
    'hr',
    'span',
    'table',
    'colgroup',
    'col',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'a',
  ],
  allowedAttributes: {
    '*': ['style', 'dir'],
    a: ['href', 'target', 'rel'],
    td: ['colspan', 'rowspan', 'colwidth', 'style'],
    th: ['colspan', 'rowspan', 'colwidth', 'style'],
    col: ['style', 'span'],
  },
  allowedStyles: {
    '*': {
      'text-align': [/^(right|left|center|justify|start|end)$/],
      color: [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s.,%]+\)$/i],
      'background-color': [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s.,%]+\)$/i],
      'font-size': [/^\d{1,2}(\.\d+)?(px|pt|em|rem)$/],
      'font-family': [/^[\w\s,'"-]{1,80}$/],
      width: [/^\d{1,4}(px|%)$/],
      'min-width': [/^\d{1,4}px$/],
    },
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: { a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }) },
};

export function sanitizeLetterHtml(html: string): string {
  return sanitizeHtml(html, OPTIONS).trim();
}

/** Plain text of a rich-text body (notifications, previews). */
export function htmlToText(html: string): string {
  return sanitizeHtml(html.replace(/<\/(p|h\d|li|tr|blockquote)>|<br\s*\/?>/gi, '\n'), { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
