// ---------------------------------------------------------------------------
// result-notes.ts - putting a server note where the caller will actually read it.
//
// ── The bug this exists to fix ──────────────────────────────────────────────
// The argument-leniency disclosure (see consolidated-arguments.ts) was built
// correctly, attached correctly, and never seen by anybody.
//
// `email_read {action: "list", subject: "..."}` drops `subject` and runs an
// unfiltered list. That is deliberate — refusing the call was the largest error
// class on the product — but it is only defensible because the result SAYS the
// filter went unapplied. Proven against production on 2026-08-31: the server
// logged `ignored_extra_arguments { action: "list", misplaced: ["subject"] }`,
// so the review ran, the note was built and appendResultNote was called; the
// client still received nothing but 80,610 unfiltered messages. An agent
// filtering by subject held what looked like a narrow result set and actually
// held the whole mailbox.
//
// The note was written to the tool result's `content` array, as a second
// TextContent block, on the reasoning that this "is what a model reads anyway".
// That reasoning is what broke: a tool result carries `structuredContent` as
// well, and a client that surfaces the structured payload does not render the
// `content` blocks beside it. The note was spec-legal and invisible, written to
// the one channel these results do not reach the model on.
//
// ── Why the note now goes in the JSON, and why that was avoided before ──────
// Two objections originally kept it out of the payload, and both were about the
// payload staying valid rather than about the payload being the wrong place:
//
//   1. `content[0].text` is the serialized `structuredContent`, so a sentence
//      appended to it stops the block parsing as JSON. Still true, and this
//      module never appends prose to it. `notes` is a first-class ARRAY OF
//      STRINGS inside the object, so the JSON stays JSON — and the serialized
//      mirror is regenerated from the object rather than patched.
//   2. Some output schemas are `additionalProperties: false`, so an unannounced
//      key fails a strict client's validation. Also still true, and the reason
//      withResultNotesProperty exists. It matters for a narrower set than it
//      first appears. It used to matter for a narrower set still: the
//      consolidated tools clients actually call (email_read, email_organize, …)
//      published NO outputSchema at all, so nothing validated their payloads.
//      They now publish one (buildConsolidatedOutputSchema in index.ts), but it
//      is deliberately additionalProperties: true, so `notes` could not fail
//      there in any case. The strict schemas are inbox_list, contact_search and
//      the legacy per-operation tools, and those are the results that would
//      have been rejected. Declaring it in the loop that attaches the schemas
//      costs nothing and removes the question permanently.
//
// The `content` block is still written as well. Costing one duplicated sentence
// to serve both kinds of client is the right trade against a disclosure that
// silently reaches neither.
// ---------------------------------------------------------------------------

/** The key notes are published under, in `structuredContent` and in schemas. */
export const RESULT_NOTES_PROPERTY = "notes";

/**
 * The schema for the notes array, declared on every tool output schema.
 *
 * Described as being about the CALL rather than about the mail, because the one
 * thing a reader must not do is mistake a server note for message content: the
 * results these tools return are untrusted third-party data, and this field is
 * the one part of the payload that is not.
 */
export const RESULT_NOTES_SCHEMA: Record<string, unknown> = {
  type: "array",
  items: { type: "string" },
  description:
    "Server notes about how this call was handled — for example an argument " +
    "that was not applied because the selected action does not accept it. " +
    "Written by MCP Emails, not taken from any message, and absent when there " +
    "is nothing to report.",
};

/**
 * A copy of `schema` that also declares the optional notes property.
 *
 * Returns the schema untouched when it is not a plain object with a
 * `properties` map (nothing to declare on), or when it already declares the
 * key — so this is safe to run over every schema unconditionally, which is the
 * point: applied in one loop, it cannot drift away from the results it
 * describes the way the disclosure itself did.
 */
export function withResultNotesProperty(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return schema;
  }
  if (RESULT_NOTES_PROPERTY in (properties as Record<string, unknown>)) return schema;
  return {
    ...schema,
    properties: {
      ...(properties as Record<string, unknown>),
      [RESULT_NOTES_PROPERTY]: RESULT_NOTES_SCHEMA,
    },
  };
}

// The response parameter below is deliberately `unknown` rather than a declared
// shape. Callers hand over a success-or-error union: an error response carries
// `error` and no `result` at all, and every structural type that admits both
// ends up either rejecting one arm or demanding an index signature the real
// types do not have. Narrowing here costs three lines, keeps this module free of
// the server's JSON-RPC types, and makes "an error response is ignored" a
// runtime guarantee rather than a claim about the type.

/**
 * Attach a server note to a successful tool result, on EVERY channel a client
 * might be reading it from.
 *
 * There are three, and the defect was serving only the third:
 *
 *   structuredContent      what a client with structured-output support
 *                          surfaces. This is the one whose absence hid the
 *                          disclosure completely.
 *   content[0].text        the serialized mirror of that object, for clients
 *                          that predate structured output. jsonOk stringifies
 *                          it BEFORE this runs, so mutating the object alone
 *                          leaves this copy stale — it is re-serialized below,
 *                          in the same style, but only when it is provably that
 *                          mirror and nothing else.
 *   a trailing text block  what a reader scanning prose sees.
 *
 * Only successful results are annotated. A failure already carries its own
 * explanation, and a note about an argument dropped on the way to it would only
 * compete with the reason the call failed.
 */
export function attachResultNote(response: unknown, note: string): void {
  if (!response || typeof response !== "object") return;
  const envelope = response as { result?: unknown };
  if (!envelope.result || typeof envelope.result !== "object") return;
  const result = envelope.result as {
    content?: unknown;
    isError?: unknown;
    structuredContent?: unknown;
  };
  if (result.isError === true) return;

  const content = Array.isArray(result.content) ? result.content : null;
  const structured = result.structuredContent;
  const hasStructured = !!structured && typeof structured === "object" && !Array.isArray(structured);

  // Is content[0] the serialization of this exact object? Compare before
  // mutating, and only re-serialize on an exact match: a handler that builds
  // its text block by some other route keeps whatever it wrote, because
  // replacing prose we did not write with JSON would be a worse bug than the
  // one being fixed. jsonOk offers exactly two styles, so there are two
  // candidates to test.
  const first = content && content[0] && typeof content[0] === "object"
    ? content[0] as { text?: unknown }
    : null;
  let mirrorIndent: number | null = null;
  if (hasStructured && first && typeof first.text === "string") {
    if (first.text === JSON.stringify(structured)) mirrorIndent = 0;
    else if (first.text === JSON.stringify(structured, null, 2)) mirrorIndent = 2;
  }

  if (hasStructured) {
    const payload = structured as Record<string, unknown>;
    const existing = payload[RESULT_NOTES_PROPERTY];
    payload[RESULT_NOTES_PROPERTY] = Array.isArray(existing) ? [...existing, note] : [note];
  }

  if (first && mirrorIndent !== null) {
    first.text = mirrorIndent === 0
      ? JSON.stringify(structured)
      : JSON.stringify(structured, null, mirrorIndent);
  }

  if (content) content.push({ type: "text", text: note });
}
