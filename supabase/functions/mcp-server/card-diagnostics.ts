// ---------------------------------------------------------------------------
// `diagnostics: true`, the one server source for the card's protocol
// diagnostics line.
//
// ── What the line is ───────────────────────────────────────────────────────
// `apps/mcp-app/src/components/App.tsx#Diagnostics` renders one row of
// protocol facts under a card: host name and version, display mode, whether a
// tool result / tool input / stored envelope arrived, two timings, the
// handshake attempt count, and accepted/foreign message counters. It exists
// because Phase 0's open questions about the real Claude host cannot be
// answered from outside the frame: we cannot read Claude's logs.
//
// It carries NO mail content. The only attacker-influenced string in it is the
// dispatched tool name, neutralised and sliced to 64 characters by the card's
// own `store.ts#toolInfoFrom`.
//
// ── Why it needs a gate at all ─────────────────────────────────────────────
// It was rendered unconditionally, on every card kind, while three files
// called it INTERNAL v1 ONLY. The draft editor is gated by
// `workspaces.draft_editor_enabled`, but the other two cards are not gated by
// anything of ours: they appear because a CUSTOMER turned on
// `inboxes.send_approval_required` or set `bulk_review_mode = 'plan'`. So five
// non-internal workspaces were reading `hs 1 · rx 8/0` under a send they were
// being asked to approve. Not a disclosure, but not something a customer
// should ever be shown.
//
// ── Why the flag rides on the envelope ─────────────────────────────────────
// The card is a static bundle served from the edge function. It has no
// credentials, no identity and no idea whose workspace it is rendering in, so
// "is this us?" is a question only the server can answer, and the envelope is
// the only channel it has. The card's `diagnostics.ts` reads the field with a
// strict `=== true`; nothing else in this repo may set it.
//
// ── Where it may NOT go ────────────────────────────────────────────────────
// `structuredContent` only. Contract §8 commits to `content` being byte-for-
// byte unchanged on every path, and `content` is what reaches the model: the
// flag is a rendering hint for one iframe, and putting it in the model's
// channel would be both a contract break and a pointless token.
// ---------------------------------------------------------------------------

/** The envelope field the card's `diagnosticsEnabled` reads. */
export const DIAGNOSTICS_FIELD = "diagnostics";

/**
 * The card envelope inside a tool result's `structuredContent`, or null.
 *
 * The test is the card's own `isEnvelope`: `schema_version` and `card`, both
 * strings. Deliberately the same two keys and not a list of card kinds, because a new
 * card kind must not be able to ship without its gate, which is the mistake
 * this module exists to make unrepeatable.
 *
 * Note that for a draft result this object is the payload MERGED with the
 * envelope (`mcp-app-drafts.ts#draftCardToolResult`), so the returned object is
 * the live `structuredContent` itself and stamping it lands the field at the
 * top level, where the card looks for it.
 */
export function cardEnvelopeIn(structured: unknown): Record<string, unknown> | null {
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return null;
  const obj = structured as Record<string, unknown>;
  if (typeof obj.schema_version !== "string" || typeof obj.card !== "string") return null;
  return obj;
}

/**
 * Turn the diagnostics line on for this envelope.
 *
 * Only ever writes `true`. The field's absence is the off state, so a `false`
 * would be a larger payload saying the same thing, and it would invite a
 * reader somewhere to treat "present" as "on".
 */
export function stampDiagnostics(envelope: Record<string, unknown>): void {
  envelope[DIAGNOSTICS_FIELD] = true;
}
