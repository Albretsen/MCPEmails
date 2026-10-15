// ---------------------------------------------------------------------------
// What a refused argument should have been, for the few refusals where "it
// belongs to another action" is true but sends the caller the wrong way.
//
// Measured 2026-10-15 over the -32602 rows of 10-06..10-15 (external
// workspaces only), with the first call the same workspace made within three
// minutes of each refusal:
//
//   email_compose reply + include_attachments   35 calls, 21 workspaces
//   draft reply + to                            24 calls, 14 workspaces
//   email_compose reply + to                    10 calls,  4 workspaces,
//                                               ALL ten followed by email_send
//   draft reply + subject                        9 calls,  5 workspaces
//
// Nearly all of them recovered on the next call, which is the problem with the
// last row: "to is not an argument of action 'reply'; it belongs to actions
// 'send' or 'forward'" is true, and the model did what it says, and sent a
// fresh message outside the thread it was asked to answer. The sentence names
// where the argument is legal; it never says how a reply is addressed, which
// is what the caller was actually trying to do.
//
// So a refusal of one of these arguments carries the fact that answers the
// caller's real question. Keyed by OPERATION (the legacy dispatch name), not
// by tool, because the same operation is reached as `email_compose {action:
// "reply"}` on the consolidated surface and as `email_reply` on the
// per-operation one, and both refusals should say the same thing. Every
// sentence here names only arguments of the operation it is keyed under, so it
// is true on either surface.
//
// Declarative, never imperative, for the reason set out in
// invalid-arguments-message.ts.
//
// Pure and dependency-free so the wording can be tested without booting the
// server.
// ---------------------------------------------------------------------------

/** Operation (legacy dispatch name) → refused property → the fact to add. */
export const ARGUMENT_REMEDIES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  email_reply: {
    to:
      "a reply goes to the sender of message_id, reply_all adds the original To " +
      "and Cc, and cc and bcc add anyone else",
    subject: "a reply keeps the original subject with 'Re:' in front",
    include_attachments:
      "a reply never carries the original's attachments; attachments can name " +
      "them as { source_message_id, attachment_index }",
  },
  draft_reply: {
    to:
      "a reply draft goes to the sender of message_id, reply_all adds the " +
      "original To and Cc, cc and bcc add anyone else, and an update of the " +
      "returned draft_id can change its to",
    subject:
      "a reply draft keeps the original subject with 'Re:' in front, and an " +
      "update of the returned draft_id can change it",
  },
  email_search: {
    folder: "email_search names the folders it searches in include_folders",
    folder_id: "email_search names the folders it searches in include_folders",
  },
};

/** The remedies for one operation, or an empty map. */
export function remediesFor(operation: string): Readonly<Record<string, string>> {
  return ARGUMENT_REMEDIES[operation] ?? {};
}

/** The error shape the server's schema validator produces. */
export interface SchemaErrorLike {
  path: string;
  keyword: string;
  message: string;
}

/** "email_search takes it" / "email_read and email_read_batch take it". */
function takerPhrase(tools: readonly string[]): string {
  if (tools.length === 1) return `${tools[0]} takes it`;
  const head = tools.slice(0, -1).join(", ");
  return `${head} and ${tools[tools.length - 1]} take it`;
}

/**
 * Rewrite the validator's "is not allowed" on a per-operation tool so it names
 * the sibling operation that does take the argument.
 *
 * The per-operation surface (one tool per operation, for OpenAI clients since
 * 2026-10-13) validates each tool against its own closed schema, so a sibling's
 * argument is not a `not` rule there but an unknown property, and the
 * consolidated surface's "it belongs to action 'search'" never fired. What the
 * caller read was "arguments.since is not allowed." and nothing else, and one
 * ChatGPT workspace sent email_list the same since/before/include_folders 32
 * times in a day, 7 of them followed by a successful call.
 *
 * `siblingsByProperty` maps an exposed property name to the LISTED sibling
 * tools that accept it, this tool excluded; the caller builds it from the
 * consolidated argument index, so it cannot name a tool the client was never
 * shown. `action` is handled separately: on a per-operation tool it is never a
 * sibling's argument, it is the selector this surface does not have.
 *
 * Paths and keywords are untouched, so the persisted classification is the
 * same as before.
 */
export function withSiblingOperations<T extends SchemaErrorLike>(
  errors: readonly T[],
  toolName: string,
  siblingsByProperty: Readonly<Record<string, readonly string[]>>,
  remedies: Readonly<Record<string, string>> = {},
  actionNote?: string,
  rootPath = "arguments",
): T[] {
  return errors.map((error) => {
    if (error.keyword !== "additionalProperties") return error;
    const prefix = `${rootPath}.`;
    if (!error.path.startsWith(prefix)) return error;
    const property = error.path.slice(prefix.length);
    if (property.includes(".") || property.includes("[")) return error;
    if (property === "action") {
      return {
        ...error,
        message:
          `is not an argument of ${toolName}, which runs one operation and takes ` +
          `no 'action'` + (actionNote ? `; ${actionNote}` : ""),
      };
    }
    const remedy = remedies[property];
    const siblings = siblingsByProperty[property] ?? [];
    if (!remedy && siblings.length === 0) return error;
    const clauses = [
      ...(remedy ? [remedy] : []),
      ...(siblings.length > 0 ? [takerPhrase(siblings)] : []),
    ];
    return {
      ...error,
      message: `is not an argument of ${toolName}; ${clauses.join("; ")}`,
    };
  });
}
