// ---------------------------------------------------------------------------
// imap-id.ts — when to identify ourselves with the IMAP ID command (RFC 2971).
//
// NetEase (163.com, 126.com, yeah.net, 188.com, and the Coremail servers that
// run them) accepts the login of a client that has not sent ID, answers LIST
// and STATUS for it, and then refuses every SELECT with
// `NO SELECT Unsafe Login. Please contact kefu@188.com for help`. So folder
// counts and sending work while every list, search and read fails with
// "SELECT failed: NO". Found 2026-10-09 on a 163.com inbox whose every read
// had failed since it was connected.
//
// ID is sent only where it is needed: it costs one round trip on every
// connection, and no other server we serve refuses a client without it.
// ---------------------------------------------------------------------------

/** The ID parameter list we send (RFC 2971 3.3: field/value pairs). */
export const IMAP_CLIENT_ID =
  '("name" "MCP Emails" "version" "1.0" "vendor" "MCP Emails" "support-email" "hello@mcpemails.com")';

/** NetEase mail domains, matched on the IMAP host at a dot boundary. */
const NETEASE_DOMAINS = ["163.com", "126.com", "yeah.net", "188.com", "netease.com"];

/**
 * True when this server refuses SELECT until the client has sent ID: a
 * NetEase host (imap.163.com, imap.vip.126.com, imap.qiye.163.com, ...) or any
 * server whose greeting names Coremail, the server software behind them, which
 * is also what many Chinese company mail systems run under their own domain.
 */
export function imapServerWantsId(host: string, greeting: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (NETEASE_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`))) return true;
  return /\bcoremail\b/i.test(greeting);
}
