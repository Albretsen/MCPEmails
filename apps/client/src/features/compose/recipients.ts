/* Recipient field logic, free of React so it can be tested on its own.
 *
 * The compose store keeps each address line as ONE comma-separated string of
 * bare addresses ("a@x.co, b@y.co"): that is what `parseAddressList` and the
 * send / draft calls read. The chips in the field are a view of that string.
 */

/** Good enough to catch typos; the server is the real judge. */
const ADDRESS = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@.<>(),;:"]{2,}$/;

export function isValidAddress(address: string): boolean {
  return ADDRESS.test(address.trim());
}

/** Splits typed or pasted text into addresses. Understands "Name <a@b.co>",
 *  and commas, semicolons, new lines or spaces between addresses. */
export function splitRecipients(text: string): string[] {
  const out: string[] = [];
  // "Name <address>" (the name may be quoted and hold a comma) becomes just the address.
  const bare = text.replace(/(?:"[^"]*"\s*|[^,;<>\n\r"]*)<([^<>]*)>/g, (_m, address: string) => `,${address.trim()},`);
  for (const part of bare.split(/[,;\n\r]+/)) {
    for (const token of part.split(/\s+/)) {
      const t = token
        .trim()
        .replace(/^mailto:/i, "")
        .replace(/^["']|["']$/g, "");
      if (t) out.push(t);
    }
  }
  return out;
}

/** The chips of a stored address line. */
export function chipsOf(value: string): string[] {
  return splitRecipients(value);
}

export function joinRecipients(list: readonly string[]): string {
  return list.join(", ");
}

/** Adds addresses to a stored line, skipping ones already there (case-insensitive). */
export function addRecipients(value: string, incoming: string | readonly string[]): string {
  const list = chipsOf(value);
  const seen = new Set(list.map((a) => a.toLowerCase()));
  const add = typeof incoming === "string" ? splitRecipients(incoming) : incoming;
  for (const a of add) {
    const k = a.toLowerCase();
    if (!a || seen.has(k)) continue;
    seen.add(k);
    list.push(a);
  }
  return joinRecipients(list);
}

export function removeRecipientAt(value: string, index: number): string {
  return joinRecipients(chipsOf(value).filter((_, i) => i !== index));
}

/** Keys that turn the typed text into a chip. */
export function isCommitKey(key: string): boolean {
  return key === "," || key === ";" || key === " " || key === "Enter";
}

/** Pasted text that should become chips at once (more than one address, or a
 *  "Name <address>" form) instead of landing in the input. */
export function looksLikeList(text: string): boolean {
  return /[,;\n\r<>]/.test(text) || splitRecipients(text).length > 1;
}

export type SuggestionMove = "next" | "prev" | "first" | "last";

/** The option index after an arrow key in a list of `count` (-1 = none active). */
export function moveActive(active: number, count: number, move: SuggestionMove): number {
  if (count <= 0) return -1;
  if (move === "first") return 0;
  if (move === "last") return count - 1;
  if (active < 0) return move === "next" ? 0 : count - 1;
  return (active + (move === "next" ? 1 : -1) + count) % count;
}
