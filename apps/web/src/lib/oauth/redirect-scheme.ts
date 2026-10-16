// ---------------------------------------------------------------------------
// Which URL schemes may ever be an OAuth redirect_uri.
//
// WHY THIS EXISTS (2026-10-16). isValidRedirectUri used to wave through every
// scheme that was not http or https, on the reasoning that a custom scheme
// (cursor://, vscode://, claude://) is for a native app and cannot reach a
// private address over HTTP. That is true of native-app schemes and false of
// the browser's own pseudo-schemes: `javascript:`, `data:` and `vbscript:` run
// or render content, and `file:`, `blob:`, `about:` and friends open local or
// browser-internal documents. An anonymous /api/oauth/register call could store
// `javascript:...` as a redirect_uri, and the consent screen then assigns the
// redirect to window.location on Allow AND on Deny, on the mcpemails.com
// origin. The nonce CSP stops that today; this module stops it without relying
// on the CSP.
//
// The check runs on the PARSED protocol, never on the raw string: the WHATWG
// URL parser (and the browser's navigation, which uses the same parser) strips
// leading spaces and C0 controls and drops tabs and newlines anywhere, so
// " JaVa\tScript:alert(1)" is `javascript:` by the time it would run. A
// string-prefix test would miss it.
//
// A block-list rather than RFC 8252's reverse-DNS rule ("com.example.app:") on
// purpose: Cursor (cursor://), VS Code (vscode://) and Claude Desktop
// (claude://) all register plain single-label schemes and are the main way
// people connect. Requiring a dot would cut them off.
//
// Pure (no node: imports) so the consent component can run the same check in
// the browser before it navigates.
// ---------------------------------------------------------------------------

/**
 * Schemes a redirect must never use. Lower-case with the trailing colon, which
 * is how URL#protocol reports them.
 */
export const BLOCKED_REDIRECT_SCHEMES: ReadonlySet<string> = new Set([
  // Execute script or render attacker-supplied content in the navigating origin.
  'javascript:',
  'vbscript:',
  'livescript:',
  'data:',
  // Local files, in-memory and browser-internal documents.
  'file:',
  'blob:',
  'filesystem:',
  'about:',
  'view-source:',
  'jar:',
  'mhtml:',
  'ms-its:',
  'res:',
  'chrome:',
  'edge:',
  'opera:',
  'brave:',
  'resource:',
  'moz-icon:',
]);

/**
 * True when `uri` parses as a URL whose scheme is not on the block-list.
 *
 * This is ONLY the scheme rule. It says nothing about which hosts are allowed
 * (isValidRedirectUri in redirect-uri.ts adds the https/loopback and SSRF
 * rules) or whether the URI is registered for the client.
 */
export function isSafeRedirectScheme(uri: unknown): boolean {
  if (typeof uri !== 'string' || uri === '') return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  return !BLOCKED_REDIRECT_SCHEMES.has(url.protocol.toLowerCase());
}
