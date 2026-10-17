// ---------------------------------------------------------------------------
// contacts.ts - where the recipient fields' suggestions come from (2026-10-17).
//
// The fields ask one function, a `ContactSource`, for people matching what is
// being typed. Everything about WHERE those people come from sits behind it,
// so changing the source never touches the dropdown (Recipients.tsx).
//
// ── WHY THE CARD DOES NOT CALL `contact_search` ────────────────────────────
// The server has a `contact_search` tool, and the card could reach it the way
// it reaches `draft_read` (bridge.callServerTool through the host). It does
// not, on purpose, because what an autocomplete needs and what that tool is
// are different things:
//
//   - It is BILLABLE. `contact_search` is in index.ts#BILLABLE_TOOL_NAMES, so
//     every lookup is one action against a Free workspace's monthly allowance.
//     A dropdown asks on every pause in typing; a person addressing one email
//     could spend a dozen actions without knowing they had spent any.
//   - It is a LIVE scan. Each call opens the mailbox and walks recent headers
//     (no stored contact list), across every inbox the key can reach. That is
//     seconds, not the 100 ms a dropdown needs, and it is exactly the load
//     that ran Yahoo into its connection limit before (IMAP pool, PR #121).
//   - Its display names are third-party text (`untrusted_content: true`). Fine
//     for a dropdown to show as text, but one more reason not to fire it
//     unasked.
//
// So the card suggests from what it already holds (`localContactSource`): the
// person this draft answers, the draft's own recipients as the server has
// them (which brings back one removed by mistake), the sender's own address,
// and addresses removed in this card. Nothing is fetched and nothing is
// stored.
//
// `contactSearchSource` is the adapter for the server tool, written and tested
// so that turning it on is one line in DraftEditor.tsx. It should be turned on
// only once the server offers a lookup made for this: not metered, answered
// from a cache rather than a live scan, and app-only. Until then it stays
// unwired.
// ---------------------------------------------------------------------------

/** One person a recipient field may suggest. */
export interface ContactSuggestion {
  address: string;
  name: string | null;
}

/** People matching `query`, best first. May resolve to an empty list, never rejects for "none". */
export type ContactSource = (query: string) => Promise<ContactSuggestion[]>;

/** How many suggestions the dropdown shows at most. */
export const MAX_SUGGESTIONS = 6;

/** Characters typed before anything is suggested. */
export const SUGGEST_MIN_CHARS = 2;

/** `Dana Smith <dana@x.example>` -> name and address. A bare address has no name. */
export function parseNamedAddress(raw: string | null | undefined): ContactSuggestion | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const angled = /^(.*)<([^<>\s]+@[^<>\s]+)>\s*$/.exec(text);
  if (angled) {
    const name = angled[1].trim().replace(/^"(.*)"$/, "$1").trim();
    return { address: angled[2], name: name && name.toLowerCase() !== angled[2].toLowerCase() ? name : null };
  }
  return /^[^\s@<>]+@[^\s@<>]+$/.test(text) ? { address: text, name: null } : null;
}

/** Whether a suggestion matches what was typed: the start of a word in the name, or anywhere in the address. */
export function matchesQuery(s: ContactSuggestion, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return false;
  if (s.address.toLowerCase().includes(q)) return true;
  return (s.name ?? "").toLowerCase().split(/[\s,.'"()-]+/).some((w) => w.startsWith(q));
}

/**
 * Suggestions from what the card already holds. `known` is read at each call,
 * so it always sees the current draft; duplicates (any case) are dropped,
 * keeping the first, which is the one with the most to say (a name).
 */
export function localContactSource(known: () => ContactSuggestion[]): ContactSource {
  return (query) => {
    const seen = new Set<string>();
    const out: ContactSuggestion[] = [];
    for (const s of known()) {
      const key = s.address.toLowerCase();
      if (seen.has(key) || !matchesQuery(s, query)) continue;
      seen.add(key);
      out.push(s);
      if (out.length >= MAX_SUGGESTIONS) break;
    }
    return Promise.resolve(out);
  };
}

/** The bridge call, as narrow as this needs it. */
type CallTool = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * The server's `contact_search`, read into suggestions. NOT WIRED: see the
 * header for why. A failed or unreadable answer is "no suggestions", never an
 * error on screen: a dropdown that stays shut is the whole of its failure mode.
 */
export function contactSearchSource(call: CallTool, inboxId: string | null): ContactSource {
  return async (query) => {
    try {
      const r = (await call("contact_search", {
        query,
        limit: MAX_SUGGESTIONS,
        ...(inboxId ? { inbox_id: inboxId } : {}),
      })) as { isError?: boolean; structuredContent?: unknown; content?: { type?: string; text?: string }[] };
      if (!r || r.isError) return [];
      let body = r.structuredContent as { contacts?: unknown } | undefined;
      if (!body?.contacts && typeof r.content?.[0]?.text === "string") {
        body = JSON.parse(r.content[0].text) as { contacts?: unknown };
      }
      const list = Array.isArray(body?.contacts) ? body!.contacts as Record<string, unknown>[] : [];
      return list
        .filter((c) => typeof c?.email_address === "string")
        .map((c) => ({
          address: String(c.email_address),
          name: typeof c.display_name === "string" && c.display_name.trim() ? c.display_name.trim() : null,
        }))
        .slice(0, MAX_SUGGESTIONS);
    } catch {
      return [];
    }
  };
}
