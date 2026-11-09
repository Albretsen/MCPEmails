/**
 * The agent-facing text for a mailbox whose sign-in was refused.
 *
 * OAuth providers (gmail, outlook) keep the text they always had: their token
 * was revoked or expired, and the inbox is marked 'error'.
 *
 * Every other provider signs in with a password (imap, fastmail). The old text
 * told the agent about an "OAuth token" for those too, which sent customers
 * looking for an OAuth setting their mailbox does not have. A refused password
 * also leaves the inbox 'active' with a refusal marker in `last_error`
 * (inbox-health.ts), so "marked 'error'" was wrong for them as well.
 *
 * @param action human-readable verb phrase, e.g. "access" / "send a reply via".
 * @param url the reconnect link (reconnectUrl in index.ts).
 */
export function authFailedText(provider: string, action: string, url: string): string {
  if (provider === "gmail" || provider === "outlook") {
    return `Unable to ${action} the ${provider} inbox: its OAuth token has been ` +
      `revoked or expired, so the inbox has been marked 'error'. Ask the user ` +
      `to reconnect it by opening this link in their browser (they may need ` +
      `to sign in to MCPEmails first): ${url}`;
  }
  return `Unable to ${action} the ${provider} inbox: its mail server refused ` +
    `the saved password. This inbox signs in with a password, not OAuth. Ask ` +
    `the user to check the password (or the app password their provider ` +
    `issued) and reconnect the inbox by opening this link in their browser ` +
    `(they may need to sign in to MCPEmails first): ${url} . If the dashboard ` +
    `accepts the same password, the provider may be refusing sign-ins from ` +
    `MCPEmails' servers; the user can email support@mcpemails.com.`;
}
