/* Word-level diff for draft edits. Port of apps/client/src/lib/diffWords.ts
 * (LCS over whitespace-delimited tokens, adjacent ops merged), with two
 * server-side guards: the common prefix and suffix are trimmed before the
 * table is built, and a pair too large for the table falls back to
 * "everything deleted, everything inserted" instead of allocating it.
 */

import type { DiffSegment } from "./events.ts";

/** Cells of the LCS table we are willing to allocate (4 bytes each). */
const MAX_CELLS = 1_500_000;

export function diffWords(a: string, b: string): DiffSegment[] {
  const A = a.split(/(\s+)/);
  const B = b.split(/(\s+)/);
  const ops: DiffSegment[] = [];
  const push = (k: DiffSegment["k"], t: string) => {
    if (!t) return;
    const last = ops[ops.length - 1];
    if (last && last.k === k) last.t += t;
    else ops.push({ k, t });
  };

  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start++;
  let endA = A.length;
  let endB = B.length;
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) {
    endA--;
    endB--;
  }
  for (let i = 0; i < start; i++) push("keep", A[i] as string);

  const n = endA - start;
  const m = endB - start;
  if (n * m > MAX_CELLS) {
    push("del", A.slice(start, endA).join(""));
    push("ins", B.slice(start, endB).join(""));
  } else if (n > 0 || m > 0) {
    const w = m + 1;
    // dp[i * w + j] = LCS length of A[start+i..endA) and B[start+j..endB).
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = A[start + i] === B[start + j]
          ? (dp[(i + 1) * w + j + 1] as number) + 1
          : Math.max(dp[(i + 1) * w + j] as number, dp[i * w + j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (A[start + i] === B[start + j]) {
        push("keep", A[start + i] as string);
        i++;
        j++;
      } else if ((dp[(i + 1) * w + j] as number) >= (dp[i * w + j + 1] as number)) {
        push("del", A[start + i++] as string);
      } else {
        push("ins", B[start + j++] as string);
      }
    }
    while (i < n) push("del", A[start + i++] as string);
    while (j < m) push("ins", B[start + j++] as string);
  }
  for (let i = endA; i < A.length; i++) push("keep", A[i] as string);
  return ops;
}

/** The text after the edit: every segment except deletions. */
export function applySegments(segments: DiffSegment[]): string {
  return segments.filter((s) => s.k !== "del").map((s) => s.t).join("");
}
