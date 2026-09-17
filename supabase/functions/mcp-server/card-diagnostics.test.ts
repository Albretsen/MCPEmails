// Tests for card-diagnostics.ts: which tool results can carry the card's
// protocol diagnostics flag, and what the flag looks like on the wire.

import { cardEnvelopeIn, DIAGNOSTICS_FIELD, stampDiagnostics } from "./card-diagnostics.ts";

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const ENVELOPE = {
  schema_version: "review-card-v1",
  card: "outbound_review",
  dashboard_url: "https://mcpemails.com/dashboard/approvals",
  state: "pending",
};

Deno.test("an envelope is recognised by schema_version + card, whatever the kind", () => {
  // The same two keys the card's own isEnvelope uses, and deliberately not a
  // list of card kinds: a new kind must be gated the day it ships.
  for (const kind of ["outbound_review", "bulk_plan", "receipt", "draft_editor", "future_kind"]) {
    assert(
      cardEnvelopeIn({ ...ENVELOPE, card: kind }) !== null,
      `card ${kind} should be recognised`,
    );
  }
});

Deno.test("a result with no card is not an envelope", () => {
  // The overwhelming majority of tool results. These must cost one typeof and
  // never reach the database.
  for (
    const notEnvelope of [
      null,
      undefined,
      "review-card-v1",
      42,
      [ENVELOPE],
      // An array is never an envelope, even carrying the two keys: the card
      // switches on `card` and would read length, not a state.
      Object.assign([], ENVELOPE),
      {},
      { messages: [] },
      { schema_version: "review-card-v1" },
      { card: "outbound_review" },
      { schema_version: 1, card: "receipt" },
      { schema_version: "review-card-v1", card: null },
    ]
  ) {
    assertEquals(
      cardEnvelopeIn(notEnvelope),
      null,
      `should not be an envelope: ${JSON.stringify(notEnvelope)}`,
    );
  }
});

Deno.test("the returned object is the live envelope, so stamping it is visible", () => {
  // draftCardToolResult merges payload and envelope into ONE structuredContent
  // object, and the card reads `diagnostics` off the top level of that object.
  // If this returned a copy, the flag would be stamped into nothing.
  const structured: Record<string, unknown> = { draft_id: "d1", ...ENVELOPE, card: "draft_editor" };
  const envelope = cardEnvelopeIn(structured);
  assert(envelope !== null, "draft envelope should be recognised");
  stampDiagnostics(envelope!);
  assertEquals(structured[DIAGNOSTICS_FIELD], true, "the caller's object must carry the flag");
});

Deno.test("the flag is exactly `true`, never a false", () => {
  // The card reads it with a strict === true, and absence is the off state. A
  // `diagnostics: false` would be a bigger payload saying the same thing, and
  // would invite someone to read "present" as "on".
  const envelope: Record<string, unknown> = { ...ENVELOPE };
  assert(!(DIAGNOSTICS_FIELD in envelope), "off is the absence of the field");
  stampDiagnostics(envelope);
  assertEquals(envelope[DIAGNOSTICS_FIELD], true, "on is exactly true");
  stampDiagnostics(envelope);
  assertEquals(envelope[DIAGNOSTICS_FIELD], true, "stamping twice is stamping once");
});

Deno.test("stamping adds one key and rewrites nothing else", () => {
  // It runs after the audit log and the idempotency snapshot, on an envelope
  // that is already the published contract. It must not touch the contract.
  const envelope: Record<string, unknown> = { ...ENVELOPE, actor: { can_decide: true } };
  const before = JSON.parse(JSON.stringify(envelope));
  stampDiagnostics(envelope);
  const { [DIAGNOSTICS_FIELD]: flag, ...rest } = envelope;
  assertEquals(flag, true, "the flag is set");
  assertEquals(rest, before, "every other key is untouched");
});

Deno.test("the card reads the same field this server writes", async () => {
  // A drift test, in the repo's existing style (see utf7-copies.test.ts). The
  // bug this whole module exists to fix had a second half: the card was gated
  // on a server flag that no server ever sent, so the line rendered for nobody
  // while everyone believed it was on internally. A rename on either side puts
  // us straight back there, silently, because a missing envelope field reads as
  // "off" and off looks exactly like working.
  const here = new URL(".", import.meta.url).pathname;
  const card = await Deno.readTextFile(`${here}../../../apps/mcp-app/src/diagnostics.ts`);
  // Matched loosely on the property read, not the whole expression: the card
  // reaches it through a cast, and the shape of that cast is its business. The
  // FIELD NAME and the strict `=== true` are the contract.
  assert(
    new RegExp(`\\.${DIAGNOSTICS_FIELD}\\s*===\\s*true`).test(card),
    `apps/mcp-app/src/diagnostics.ts no longer reads \`.${DIAGNOSTICS_FIELD} === true\`; ` +
      "the card and this server have drifted and the line is off for everyone",
  );
  // And the retired source stays retired: any same-origin page could write it,
  // and whether Claude's sandbox shares one origin across MCP Apps is a host
  // detail the card cannot read from inside the frame. Matches the READ, not
  // the word, because the file explains at length why it does not do this.
  assert(
    !card.includes("localStorage.getItem"),
    "apps/mcp-app/src/diagnostics.ts reads localStorage again; the only source may be the server",
  );
});
