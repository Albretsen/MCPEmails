/**
 * The /help search, as a pure function so it can be tested without a DOM.
 *
 * Case and diacritics are folded (an accented "e" matches a plain "e") and the
 * query is split on whitespace. Filler words ("my", "the", "cant") are dropped,
 * so a reader can type a sentence instead of guessing keywords.
 *
 * SCORING. Each remaining query word scores its best hit in the entry, by field
 * and by how closely it matches:
 *
 *                exact word   word prefix / plural   inside a word   one typo
 *   keywords        10              7                     5             3
 *   title            8              6                     4             3
 *   hint             4              3                     2             -
 *
 * Keywords (the article's search terms) weigh most, so the entry written for
 * a word wins over one that only mentions it. An entry that matches every
 * word gets a large bonus, so a precise keyword query still ranks first. With
 * one or two words every word must match; with more, at least 60 percent must,
 * so one stray word ("claude cant see my emails") no longer empties the list.
 * Ties go to a title that starts with the first word, then index order.
 *
 * Chinese has no spaces, so a CJK query is one word and matches as a
 * substring, which is what a reader typing a phrase expects.
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

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'at', 'be', 'by', 'can', 'cant', 'could', 'do', 'does', 'doesnt', 'dont',
  'for', 'from', 'get', 'how', 'i', 'im', 'in', 'is', 'isnt', 'it', 'its', 'me', 'my', 'of', 'on', 'or',
  'help', 'issue', 'not', 'our', 'please', 'problem', 'should', 'the', 'this', 'to', 'was', 'what', 'when', 'where', 'why', 'will', 'with',
  'wont', 'work', 'working', 'works', 'would', 'you', 'your',
]);

const words = (text) => text.split(/[^\p{L}\p{N}@.]+/u).filter(Boolean);

/** Adds the folded strings once, so typing does not re-normalise 140 entries per keystroke. */
export function prepareIndex(entries) {
  return (entries ?? []).map((entry, order) => {
    const title = normalize(entry.title);
    const hint = normalize(entry.hint);
    const terms = normalize(entry.terms);
    return {
      entry,
      order,
      title,
      fields: [
        { text: terms, words: words(terms), w: [10, 7, 5, 3] },
        { text: title, words: words(title), w: [8, 6, 4, 3] },
        { text: hint, words: words(hint), w: [4, 3, 2, 0] },
      ],
    };
  });
}

/** True when a and b differ by at most one edit (insert, delete or substitute). */
function oneEdit(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** The best score one query word earns in one field. */
function fieldScore(q, field) {
  const [exact, prefix, inside, typo] = field.w;
  let best = 0;
  for (const w of field.words) {
    if (w === q) return exact;
    if (q.length >= 2 && w.startsWith(q)) best = Math.max(best, prefix);
    // "emails" finds "email", "passwords" finds "password".
    else if (w.length >= 4 && q.startsWith(w)) best = Math.max(best, prefix);
    else if (typo && q.length >= 5 && w.length >= 5 && oneEdit(q, w)) best = Math.max(best, typo);
  }
  if (best === 0 && q.length >= 3 && field.text.includes(q)) best = inside;
  return best;
}

export function searchIndex(prepared, query, limit = MAX_RESULTS) {
  const all = normalize(query).split(' ').filter(Boolean);
  if (all.length === 0) return [];
  const meaningful = all.filter((w) => !STOPWORDS.has(w.replace(/'/g, '')));
  const q = meaningful.length > 0 ? meaningful : all;
  const needed = q.length <= 2 ? q.length : Math.ceil(q.length * 0.6);

  const hits = [];
  for (const item of prepared) {
    let score = 0;
    let matched = 0;
    for (const w of q) {
      let best = 0;
      for (const f of item.fields) best = Math.max(best, fieldScore(w, f));
      if (best > 0) matched++;
      score += best;
    }
    if (matched < needed) continue;
    if (matched === q.length) score += 20;
    if (item.title.startsWith(q[0])) score += 1;
    hits.push({ item, score });
  }
  hits.sort((a, b) => b.score - a.score || a.item.order - b.item.order);
  return hits.slice(0, limit).map((h) => h.item.entry);
}
