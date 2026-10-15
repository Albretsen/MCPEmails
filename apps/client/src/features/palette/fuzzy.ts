/* Fuzzy matching for the command palette. Pure, synchronous and cheap: a few
 * dozen candidates are ranked on every keystroke with no debounce.
 *
 * Ranking, best first:
 *   1. the text starts with the query            ("arc"  -> "Archive")
 *   2. a word in the text starts with the query  ("trash" -> "Move to Trash")
 *   3. the query appears inside a word           ("chiv" -> "Archive")
 *   4. the query is a subsequence of the text    ("mtt"  -> "Move to Trash")
 * Within a tier, earlier and tighter matches win, then shorter texts.
 */

export const TIER = { prefix: 4000, wordStart: 3000, substring: 2000, subsequence: 1000 } as const;

const isBoundary = (text: string, i: number): boolean => i === 0 || !/[\p{L}\p{N}]/u.test(text[i - 1] ?? "");

/** Scores one query token against lower-cased text. Null = no match. */
function scoreToken(q: string, text: string): number | null {
  if (!q) return 0;
  if (text.startsWith(q)) return TIER.prefix - Math.min(text.length, 200);

  let from = 0;
  let inside = -1;
  for (;;) {
    const at = text.indexOf(q, from);
    if (at < 0) break;
    if (isBoundary(text, at)) return TIER.wordStart - Math.min(at, 200);
    if (inside < 0) inside = at;
    from = at + 1;
  }
  if (inside >= 0) return TIER.substring - Math.min(inside, 200);

  // Subsequence. It must start at the beginning of a word ("mtt" finds "Move
  // to Trash", "tra" does not find "Star"): without that anchor, short queries
  // match almost everything. Greedy from each anchor; characters that begin a
  // word or continue a run are rewarded, gaps are penalised.
  let best: number | null = null;
  const head = q[0] ?? "";
  for (let start = text.indexOf(head); start >= 0; start = text.indexOf(head, start + 1)) {
    if (!isBoundary(text, start)) continue;
    let bonus = 12;
    let gaps = 0;
    let last = start;
    let ok = true;
    for (let qi = 1; qi < q.length; qi++) {
      const at = text.indexOf(q[qi] ?? "", last + 1);
      if (at < 0) {
        ok = false;
        break;
      }
      if (isBoundary(text, at)) bonus += 12;
      else if (at === last + 1) bonus += 6;
      gaps += at - last - 1;
      last = at;
    }
    if (!ok) continue;
    const score = Math.max(1, TIER.subsequence - 500 + bonus * 4 - gaps * 3 - Math.min(start, 100) - Math.min(text.length, 100));
    if (best == null || score > best) best = score;
  }
  return best;
}

/** Scores `text` against `query`. Higher is better; null means no match.
 *  Case-insensitive. A query of several words matches when the whole phrase
 *  does, or when every word does on its own (ranked below a phrase match). */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  const t = text.toLowerCase();
  if (!q) return 0;

  const whole = scoreToken(q, t);
  const tokens = q.split(" ");
  if (tokens.length === 1) return whole;
  if (whole != null && whole > TIER.subsequence) return whole;

  let sum = 0;
  for (const token of tokens) {
    const sc = scoreToken(token, t);
    if (sc == null) return whole;
    sum += sc;
  }
  // Every word matched, but not as a phrase: never outrank a phrase match of the same tier.
  const each = Math.min(TIER.substring - 1, sum / tokens.length - 1);
  return whole == null ? each : Math.max(whole, each);
}

export interface Ranked<T> {
  item: T;
  score: number;
}

/** Filters and orders `items` for `query`. Stable: ties keep their original
 *  order, and an empty query returns everything in its original order. */
export function rank<T>(items: readonly T[], query: string, text: (item: T) => string, limit = Infinity): Ranked<T>[] {
  const out: (Ranked<T> & { i: number })[] = [];
  items.forEach((item, i) => {
    const score = fuzzyScore(query, text(item));
    if (score != null) out.push({ item, score, i });
  });
  out.sort((a, b) => b.score - a.score || a.i - b.i);
  return out.slice(0, limit).map(({ item, score }) => ({ item, score }));
}
