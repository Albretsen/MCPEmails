/**
 * Tiny, dependency-free Markdown → HTML renderer for blog posts.
 *
 * Blog content is authored by us (trusted), so this favours a small, fast,
 * server-side render over a heavyweight client library: the full article HTML
 * lands in the SSR payload (great for crawlers and LCP) and ships zero
 * client-side JavaScript for the prose itself.
 *
 * Supported: ATX headings (with auto-slug ids), fenced code blocks,
 * blockquotes, unordered/ordered lists, horizontal rules, images,
 * paragraphs, and inline bold / italic / code / links.
 */

/** Slugify heading text into a stable, URL-safe anchor id. */
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '') // strip any inline html that slipped in
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** Estimated reading time in whole minutes (200 wpm, min 1). */
export function readingTime(markdown) {
  const words = markdown
    .replace(/```[\s\S]*?```/g, ' ') // drop code blocks from the count
    .replace(/[#>*`_\-[\]()!]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Inline formatting: code, bold, italic, links. Operates on escaped text. */
function inline(text) {
  let out = escapeHtml(text);
  // inline code first so its contents aren't touched by other rules
  out = out.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  // images  ![alt](src)
  out = out.replace(
    /!\[([^\]]*)\]\(([^)\s]+)\)/g,
    (_m, alt, src) => `<img src="${src}" alt="${alt}" loading="lazy" decoding="async" />`,
  );
  // links  [text](href)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, href) => {
    const ext = /^https?:\/\//.test(href);
    const rel = ext ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<a href="${href}"${rel}>${label}</a>`;
  });
  // bold then italic
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  return out;
}

/**
 * Render markdown to an HTML string and collect headings for a table of
 * contents. Returns { html, headings: [{ id, text, level }] }.
 */
export function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const html = [];
  const headings = [];
  let i = 0;

  const flushParagraph = (buf) => {
    if (buf.length) html.push(`<p>${inline(buf.join(' '))}</p>`);
    return [];
  };

  let paragraph = [];

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    if (/^```/.test(line)) {
      paragraph = flushParagraph(paragraph);
      const lang = line.slice(3).trim();
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      const cls = lang ? ` class="language-${lang}"` : '';
      html.push(`<pre><code${cls}>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    // headings
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      paragraph = flushParagraph(paragraph);
      const level = h[1].length;
      const text = h[2].trim();
      const id = slugify(text);
      if (level === 2 || level === 3) headings.push({ id, text, level });
      html.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      i++;
      continue;
    }

    // horizontal rule
    if (/^---+\s*$/.test(line)) {
      paragraph = flushParagraph(paragraph);
      html.push('<hr />');
      i++;
      continue;
    }

    // blockquote (one or more consecutive > lines)
    if (/^>\s?/.test(line)) {
      paragraph = flushParagraph(paragraph);
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      html.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`);
      continue;
    }

    // unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      paragraph = flushParagraph(paragraph);
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      html.push(`<ul>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</ul>`);
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      paragraph = flushParagraph(paragraph);
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      html.push(`<ol>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</ol>`);
      continue;
    }

    // blank line ends a paragraph
    if (/^\s*$/.test(line)) {
      paragraph = flushParagraph(paragraph);
      i++;
      continue;
    }

    // standalone image line → figure
    const img = line.match(/^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/);
    if (img) {
      paragraph = flushParagraph(paragraph);
      const caption = img[1] ? `<figcaption>${inline(img[1])}</figcaption>` : '';
      html.push(
        `<figure><img src="${img[2]}" alt="${img[1]}" loading="lazy" decoding="async" />${caption}</figure>`,
      );
      i++;
      continue;
    }

    // accumulate paragraph text
    paragraph.push(line.trim());
    i++;
  }

  flushParagraph(paragraph);
  return { html: html.join('\n'), headings };
}
