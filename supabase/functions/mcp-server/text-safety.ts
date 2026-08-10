// ---------------------------------------------------------------------------
// Neutralising invisible characters in attacker-controlled *plain text*.
//
// Provenance: this is the server-side mirror of `neutralizeText` /
// `neutralizeDeep` in `apps/mcp-app/src/sanitize.ts`. The card discovered the
// problem — a harness fixture named `invoice<U+202E> fdp.exe` renders as
// `invoiceexe.pdf`, because RIGHT-TO-LEFT OVERRIDE flips the tail so an
// executable looks like a PDF — and fixed it at its own ingestion boundary. But
// the same strings also reach the dashboard queue, the approve page at
// `apps/web/app/approvals/[id]/` and the audit log, none of which run the
// card's code. A card that protects only itself leaves three spoofable
// surfaces, so the neutralisation happens here too, before the string is
// stored or handed to a renderer.
//
// The identical implementation exists in three places on purpose:
//   - apps/mcp-app/src/sanitize.ts   (the card, Vite/browser)
//   - supabase/functions/mcp-server/text-safety.ts   (this file, Deno)
//   - apps/web/src/lib/textSafety.ts (Next.js, Node)
// They cannot share a module — three runtimes, three build systems — and the
// alternative (a package) is not worth a dependency for 6 lines. Keep the
// character class below identical in all three; it is the actual contract.
//
// ── WHAT IS DELIBERATELY *NOT* NEUTRALISED ─────────────────────────────────
// Message bodies. Bidi control characters are legitimate in Hebrew, Arabic,
// Persian and Urdu prose, and stripping them from a body would silently corrupt
// mail we are only meant to be showing. Bodies are rendered as plain text (the
// approve page never renders body HTML) or through the card's allow-list
// sanitizer, so the residual risk there is visual reordering inside a block a
// reviewer is already reading as untrusted content.
//
// Neutralised instead: the short, structural, high-risk fields a reviewer scans
// rather than reads — subjects, sender/recipient display names, attachment
// filenames, folder and scope labels. Those are the ones that decide whether a
// reviewer clicks Approve.
// ---------------------------------------------------------------------------

// The control characters ARE the point of the character class below.
// deno-lint-ignore-file no-control-regex

/**
 * Invisible characters that let attacker-controlled plain text lie about
 * itself.
 *
 * Stripped: C0/C1 controls (except \t \n \r), zero-width characters, the
 * bidi overrides/embeddings (U+202A-U+202E), the Unicode bidi isolates
 * (U+2066-U+2069), the invisible-operator block (U+2060-U+2064), and the BOM.
 */
const UNSAFE_TEXT =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** Strip the invisible characters from one string. Everything else survives. */
export function neutralizeText(value: string): string {
  return value.replace(UNSAFE_TEXT, "");
}

/** `neutralizeText` for a value that may be null/undefined or not a string. */
export function neutralizeMaybe<T>(value: T): T {
  return typeof value === "string" ? neutralizeText(value) as unknown as T : value;
}

/** Neutralise every string in a list, dropping non-strings. */
export function neutralizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map(neutralizeText);
}

/**
 * Deep-clone a payload, neutralising every string in it.
 *
 * Bounded in depth and array length because the payload is not trusted to be
 * well-formed either. Mirrors `neutralizeDeep` in the card.
 */
export function neutralizeDeep<T>(value: T, depth = 0): T {
  if (depth > 12) return value;
  if (typeof value === "string") return neutralizeText(value) as unknown as T;
  if (Array.isArray(value)) {
    return value
      .slice(0, 500)
      .map((v) => neutralizeDeep(v, depth + 1)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = neutralizeDeep(v, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}
