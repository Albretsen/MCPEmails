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
  // Microsoft Office URI handlers: `ms-word:ofe|u|https://h` opens a web
  // document, and none of them is an OAuth client.
  'ms-word:',
  'ms-excel:',
  'ms-powerpoint:',
  'ms-visio:',
  'ms-access:',
  'ms-project:',
  'ms-publisher:',
  'ms-spd:',
  'ms-infopath:',
  // iOS enterprise app install: fetches a manifest from a web URL.
  'itms-services:',
]);

/**
 * Scheme prefixes that hand the rest of the URI to a WEB BROWSER, so a code
 * "for an app on this device" is in fact delivered to a remote web host
 * (added 2026-10-16 after verification of the first fix):
 *
 *   microsoft-edge:https://attacker.example/cb   Edge on Windows/iOS
 *   x-safari-https://attacker.example/cb         Safari on iOS
 *   googlechromes://attacker.example/cb          Chrome on iOS
 *   intent://attacker.example/cb#Intent;scheme=https;end   Android
 *   firefox://open-url?url=..., opera-https://..., brave://open-url?...
 *   web+foo:...                                  registerProtocolHandler, i.e. a website
 *
 * Matched as a prefix of the lower-cased scheme (without the colon), so the
 * -http / -https / -focus variants are covered.
 */
const BROWSER_HANDOFF_PREFIXES: readonly string[] = [
  'microsoft-edge', 'msedge', 'x-safari-', 'googlechrome', 'firefox', 'fennec', 'opera', 'brave',
  'vivaldi', 'duckduckgo', 'ddgquicklink', 'yandexbrowser', 'samsunginternet', 'sbrowser', 'ucbrowser',
  'intent', 'web+',
];

/** True when `scheme` (lower-case, no colon) hands its URL to a web browser. */
export function isBrowserHandoffScheme(scheme: string): boolean {
  const s = scheme.toLowerCase();
  return BROWSER_HANDOFF_PREFIXES.some((p) => s.startsWith(p));
}

/** An http(s) URL start, tolerant of the slash/backslash spellings a browser accepts. */
const EMBEDDED_WEB_URL = /https?:[\/\\]{2}/i;

/**
 * Up to this many rounds of percent-decoding. Each round can only shorten the
 * string, and real native redirects need none, so a small bound is enough to
 * unwrap `%2568ttps` (double-encoded) and still terminate on anything.
 */
const MAX_DECODE_ROUNDS = 4;

const DROPPED_CHARS = /[\u0000-\u0020\u007f]/g;

function remainderCarriesWebUrl(start: string): boolean {
  let rest = start.normalize('NFKC').replace(DROPPED_CHARS, '');
  for (let round = 0; round <= MAX_DECODE_ROUNDS; round++) {
    if (EMBEDDED_WEB_URL.test(rest)) return true;
    let decoded: string;
    try {
      decoded = decodeURIComponent(rest);
    } catch {
      // Malformed escapes elsewhere: decode what can be decoded, byte by byte.
      decoded = rest.replace(/%([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    }
    decoded = decoded.normalize('NFKC').replace(DROPPED_CHARS, '');
    if (decoded === rest) return false;
    rest = decoded;
  }
  return EMBEDDED_WEB_URL.test(rest);
}

/**
 * True when anything after `scheme:` contains an http(s):// URL, plainly or
 * percent-encoded (once or nested), anywhere: right after the colon
 * (`anything:https://h`, `cursor://https://h`), in a path, a query value
 * (`cursor:redirect?u=https://h`, `itms-services://?action=...&url=https://h`)
 * or a handler argument (`ms-word:ofe|u|https://h`). Whatever app handles such
 * a URI is being handed a web address it may open, which delivers the code to
 * a remote host. Applies to EVERY custom scheme, allow-listed native ones
 * included; no legitimate native-app redirect carries a web URL.
 */
function containsWebUrl(uri: string, url: URL): boolean {
  // Both the raw string (after the first colon, with the characters a URL
  // parser drops removed) and the parser's own serialisation are checked, so
  // neither an encoding the parser adds nor one it removes hides the URL.
  const raw = uri.replace(DROPPED_CHARS, '');
  return (
    remainderCarriesWebUrl(raw.slice(raw.indexOf(':') + 1)) ||
    remainderCarriesWebUrl(url.href.slice(url.protocol.length))
  );
}

/**
 * True when `uri` parses as a URL whose scheme is neither on the block-list nor
 * a browser hand-off scheme, and (for a custom scheme) carries no http(s) URL
 * anywhere in its remainder, encoded or not.
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
  const protocol = url.protocol.toLowerCase();
  if (BLOCKED_REDIRECT_SCHEMES.has(protocol)) return false;
  if (protocol === 'http:' || protocol === 'https:') return true;
  if (isBrowserHandoffScheme(protocol.slice(0, -1))) return false;
  if (containsWebUrl(uri, url)) return false;
  return true;
}
