/**
 * The /help search, as a pure function so it can be tested without a DOM.
 *
 * Case and diacritics are folded (an accented "e" matches a plain "e"), the
 * query is split on whitespace, and every word must appear somewhere in the
 * entry (AND). Entries whose title holds every word rank above those that only
 * match on hint or terms; within that, a title that starts with the first word
 * ranks higher, then the original index order holds. Chinese has no spaces, so a
 * CJK query is one word and is matched as a substring, which is what a reader
 * typing a phrase expects.
 */

export const MAX_RESULTS = 8;

export function normalize(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Adds the folded strings once, so typing does not re-normalise 140 entries per keystroke. */
export function prepareIndex(entries) {
  return (entries ?? []).map((entry, order) => {
    const title = normalize(entry.title);
    return {
      entry,
      order,
      title,
      haystack: `${title} ${normalize(entry.hint)} ${normalize(entry.terms)}`,
    };
  });
}

export function searchIndex(prepared, query, limit = MAX_RESULTS) {
  const words = normalize(query).split(' ').filter(Boolean);
  if (words.length === 0) return [];
  const hits = [];
  for (const item of prepared) {
    if (!words.every((w) => item.haystack.includes(w))) continue;
    const titleAll = words.every((w) => item.title.includes(w));
    const titleStart = item.title.startsWith(words[0]);
    const rank = (titleAll ? 0 : 2) + (titleStart ? 0 : 1);
    hits.push({ item, rank });
  }
  hits.sort((a, b) => a.rank - b.rank || a.item.order - b.item.order);
  return hits.slice(0, limit).map((h) => h.item.entry);
}
