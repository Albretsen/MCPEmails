// ---------------------------------------------------------------------------
// What email_search says when its search runs out of time.
//
// Onboarding read-out of 2026-10-26: `search_timeout` hit 84 workspaces in
// their first sessions, 45 of them Yahoo (a quarter of Yahoo first sessions)
// and 32 generic IMAP. "Try a simpler or more specific query" left the model
// to guess, and it usually retried the same full-text search. On an IMAP
// mailbox the way out is known: the list operation reads the newest messages
// with no server-side search at all, and a search on from or subject bounded
// by a recent since asks the server far less than one over body or text.
//
// Declarative, like the argument hints: it states what each operation does
// and leaves the choice to the caller. Pure so the wording can be tested.
// ---------------------------------------------------------------------------

/**
 * @param provider       the inbox's connector (inboxes.provider).
 * @param budgetSeconds  the search budget that ran out.
 */
export function emailSearchTimeoutText(provider: string, budgetSeconds: number): string {
  const base = `Search timed out after ${budgetSeconds} seconds. Try a simpler or more specific query.`;
  if (provider !== "imap") return base;
  return base +
    " This mail server searches slowly. The list operation reads the newest " +
    "messages without a search (unread true for only unread mail), and a " +
    "search on from or subject with a since a few days back asks the server " +
    "far less than one on body or text.";
}
