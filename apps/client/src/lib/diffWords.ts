export type DiffOp = { k: "keep" | "del" | "ins"; t: string };

/** Word-level diff (LCS over whitespace-delimited tokens), ported from the
 *  design prototype. Adjacent ops of the same kind are merged. Used to show an
 *  assistant edit of a draft as struck-through deletions and highlighted
 *  insertions. */
export function diffWords(a: string, b: string): DiffOp[] {
  const A = a.split(/(\s+)/);
  const B = b.split(/(\s+)/);
  const n = A.length;
  const m = B.length;
  const w = m + 1;
  // Flat table: dp[i * w + j] = LCS length of A[i..] and B[j..].
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        A[i] === B[j]
          ? (dp[(i + 1) * w + j + 1] as number) + 1
          : Math.max(dp[(i + 1) * w + j] as number, dp[i * w + j + 1] as number);
    }
  }
  const ops: DiffOp[] = [];
  const push = (k: DiffOp["k"], t: string) => {
    const last = ops[ops.length - 1];
    if (last && last.k === k) last.t += t;
    else ops.push({ k, t });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      push("keep", A[i] as string);
      i++;
      j++;
    } else if ((dp[(i + 1) * w + j] as number) >= (dp[i * w + j + 1] as number)) {
      push("del", A[i++] as string);
    } else {
      push("ins", B[j++] as string);
    }
  }
  while (i < n) push("del", A[i++] as string);
  while (j < m) push("ins", B[j++] as string);
  return ops;
}
