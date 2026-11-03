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
 * Each query word that hits the keywords and is also a whole word of the
 * title adds 3 (2 when the query word reaches that word by one typo, so
 * "outlok" still picks the Outlook article), so among entries whose keywords
 * match equally the one titled for the query wins, while a title-only hit
 * still ranks below ("api key" finds the API key article, not a client page
 * whose terms say "api key"). A
 * title that starts with the first word adds 1 more, then index order decides.
 *
 * TYPOS. One edit (insert, delete, substitute, or swap two neighbours, so
 * "gmial" finds "gmail") is forgiven on words of 4 letters or more. When
 * either word has only 4 letters the first letter must match too, so "gmail"
 * does not find every "mail" and "send" does not find "lend".
 *
 * FILLER ONLY. A query made only of filler ("help", "the") returns nothing, so
 * the page shows the contact link. One exception: a filler phrase of two or
 * more words written verbatim in an entry's keywords ("not working") still
 * finds that entry.
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
  'a', 'am', 'an', 'and', 'are', 'at', 'be', 'by', 'can', 'cannot', 'cant', 'could', 'do', 'does', 'doesnt', 'dont',
  'for', 'from', 'get', 'has', 'have', 'hello', 'hi', 'how', 'i', 'im', 'in', 'is', 'isnt', 'it', 'its', 'me', 'my', 'of', 'on', 'or',
  'help', 'issue', 'issues', 'not', 'our', 'please', 'problem', 'problems', 'should', 'still', 'that', 'the', 'there', 'this', 'to',
  'trouble', 'unable', 'was', 'what', 'when', 'where', 'why', 'will', 'with',
  'wont', 'work', 'working', 'works', 'would', 'you', 'your',
]);
// "error" is deliberately not filler: alone it finds the error codes, and in
// "smtp error" it picks the article about send failures.

const isStopword = (w) => STOPWORDS.has(w.replace(/['’]/g, ''));

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
      titleWords: new Set(words(title)),
      fields: [
        { text: terms, words: words(terms), w: [10, 7, 5, 3] },
        { text: title, words: words(title), w: [8, 6, 4, 3] },
        { text: hint, words: words(hint), w: [4, 3, 2, 0] },
      ],
    };
  });
}

/**
 * True when a and b are at most one edit apart under optimal string alignment:
 * insert, delete, substitute, or swap two neighbouring letters ("gmial").
 */
export function oneEdit(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true; // substitute
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // swap
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/**
 * Typos are forgiven from 4 letters. When either side has only 4, the first
 * letter must match, so "gmal" finds "gmail" but "gmail" does not find "mail".
 */
const typoOk = (q, w) =>
  q.length >= 4 && w.length >= 4 && (Math.min(q.length, w.length) >= 5 || q[0] === w[0]) && oneEdit(q, w);

/** The best score one query word earns in one field. */
function fieldScore(q, field) {
  const [exact, prefix, inside, typo] = field.w;
  let best = 0;
  for (const w of field.words) {
    if (w === q) return exact;
    if (q.length >= 2 && w.startsWith(q)) best = Math.max(best, prefix);
    // "emails" finds "email", "passwords" finds "password".
    else if (w.length >= 4 && q.startsWith(w)) best = Math.max(best, prefix);
    else if (typo && typoOk(q, w)) best = Math.max(best, typo);
  }
  if (best === 0 && q.length >= 3 && field.text.includes(q)) best = inside;
  return best;
}

/**
 * True when a query word is one typo away from a word that is both a keyword
 * and a whole word of the title ("outlok" and the Outlook article), so a typo
 * still earns a (smaller) title bonus.
 */
function typoTitled(q, item) {
  for (const t of item.titleWords) {
    if (typoOk(q, t) && item.fields[0].words.includes(t)) return true;
  }
  return false;
}

/** A filler-only query: only a phrase of 2+ words written verbatim in the keywords counts. */
function fillerPhrase(prepared, all, limit) {
  if (all.length < 2) return [];
  const phrase = ` ${all.join(' ')} `;
  return prepared
    .filter((item) => ` ${item.fields[0].words.join(' ')} `.includes(phrase))
    .slice(0, limit)
    .map((item) => item.entry);
}

export function searchIndex(prepared, query, limit = MAX_RESULTS) {
  const all = normalize(query).split(' ').filter(Boolean);
  if (all.length === 0) return [];
  const q = all.filter((w) => !isStopword(w));
  if (q.length === 0) return fillerPhrase(prepared, all, limit);
  const needed = q.length <= 2 ? q.length : Math.ceil(q.length * 0.6);

  const hits = [];
  for (const item of prepared) {
    let score = 0;
    let matched = 0;
    let titled = 0;
    let typoTitledCount = 0;
    for (const w of q) {
      let best = 0;
      for (const f of item.fields) best = Math.max(best, fieldScore(w, f));
      if (best > 0) matched++;
      score += best;
      // Only a word the keywords also hit: the bonus breaks ties between
      // keyword hits and never lifts a title-only hit over one.
      if (item.titleWords.has(w) && fieldScore(w, item.fields[0]) > 3) titled++;
      else if (typoTitled(w, item)) typoTitledCount++;
    }
    if (matched < needed) continue;
    if (matched === q.length) score += 20;
    score += 3 * titled + 2 * typoTitledCount;
    if (item.title.startsWith(q[0])) score += 1;
    hits.push({ item, score });
  }
  hits.sort((a, b) => b.score - a.score || a.item.order - b.item.order);
  return hits.slice(0, limit).map((h) => h.item.entry);
}
