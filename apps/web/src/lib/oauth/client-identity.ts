// ---------------------------------------------------------------------------
// Who the /authorize consent screen says is asking, and where the code goes.
//
// WHY THIS EXISTS (2026-10-16). /api/oauth/register is anonymous (RFC 7591),
// and it used to store the registrant's own `client_name` and `client_uri`,
// which the consent screen then printed as the requesting party: "Claude ·
// anthropic.com wants access". It never printed the redirect_uri host, which is
// the one fact that decides who receives the authorization code. Because the
// registrant also generates the PKCE pair, PKCE does not help the victim: a
// code delivered to https://attacker.example/cb plus the attacker's verifier
// redeems for a token on the victim's mailboxes.
//
// The CIMD path (cimd.ts) already learnt this: it shows the HOST of the
// client_id URL and throws the document's client_name away. This module applies
// the same idea to every client, keyed on the VALIDATED redirect_uri:
//
//   destination   where the code is delivered: a web host, an app on this
//                 device (custom scheme), or a loopback port on this device.
//   verification  'registered'  a row we seeded ourselves (claude-desktop,
//                               cursor-v1, ...): its name and byline are ours.
//                 'verified'    the code goes to an https host that belongs to
//                               a known vendor (claude.ai, chatgpt.com, ...).
//                               The name keeps the heading but is labelled as
//                               self-reported (vendors put the user's own
//                               connector name there).
//                 'local'       the code stays on the user's device: a
//                               loopback port, or one of the KNOWN native-app
//                               schemes (NATIVE_APP_SCHEMES: claude, cursor,
//                               vscode, windsurf, ...). A remote attacker
//                               cannot receive it from a link.
//                 'unverified'  any other https host, and any other custom
//                               scheme. The heading becomes the DESTINATION
//                               and the self-asserted name is shown only as a
//                               labelled, secondary "calls itself" line. A
//                               custom scheme is not proof of a local app:
//                               microsoft-edge:https://h/, x-safari-https://h/
//                               and intent:// open a web page in a browser
//                               (those are refused outright in
//                               redirect-scheme.ts; this is the backstop).
//   impersonates  the self-asserted name uses a known vendor's name (Claude,
//                 ChatGPT, Cursor, MCP Emails, ...) while the code goes to a
//                 web host or app scheme that is NOT that vendor's. Not raised
//                 when the destination is a known vendor HOST (the code goes
//                 to that vendor regardless) or a loopback port. The screen
//                 warns explicitly. Registration is not refused for it: a host
//                 this list has not met yet must degrade to a warning, never
//                 to a broken connector, because DCR is how Claude, ChatGPT
//                 and Cursor connect.
//
// The legitimate main paths therefore look like this:
//   Claude (claude.ai DCR)          "Claude", Verified · claude.ai
//   ChatGPT (chatgpt.com DCR/CIMD)  "ChatGPT", Verified · chatgpt.com
//   Cursor (cursor:// DCR)          "Cursor", On this device · cursor://
//   Claude Code / Codex / VS Code   name, On this device · 127.0.0.1:port
//
// Hosts are compared EXACTLY against URL.hostname, never by substring or
// suffix (see OPENAI_HOSTS in consent-presets.ts for the incident that taught
// that). Pure: no node: imports, so the rule is unit testable and the same
// object can be handed to the client component.
// ---------------------------------------------------------------------------

import { isBrowserHandoffScheme, isSafeRedirectScheme } from '@/lib/oauth/redirect-scheme';

export type VendorId = 'anthropic' | 'openai' | 'cursor' | 'vscode' | 'mcpemails';

interface Vendor {
  id: VendorId;
  /** The name shown in the impersonation warning. */
  label: string;
  /** Matched as a substring of the squashed name: distinctive enough not to collide. */
  substrings: readonly string[];
  /** Matched only as the start of a word: common English words ("cursor"). */
  words: readonly string[];
  /** Exact https hostnames that vendor receives codes on. */
  hosts: ReadonlySet<string>;
  /** Native-app schemes that vendor registers (without the colon). */
  schemes: ReadonlySet<string>;
}

const VENDORS: readonly Vendor[] = [
  {
    id: 'anthropic',
    label: 'Claude (Anthropic)',
    substrings: ['claude', 'anthropic'],
    words: [],
    hosts: new Set([
      'claude.ai', 'www.claude.ai', 'claude.com', 'www.claude.com',
      'anthropic.com', 'www.anthropic.com', 'console.anthropic.com', 'platform.claude.com',
    ]),
    schemes: new Set(['claude']),
  },
  {
    id: 'openai',
    label: 'ChatGPT (OpenAI)',
    substrings: ['chatgpt', 'openai'],
    words: ['codex'],
    hosts: new Set(['chatgpt.com', 'chat.openai.com', 'openai.com', 'www.openai.com', 'platform.openai.com']),
    schemes: new Set(),
  },
  {
    id: 'cursor',
    label: 'Cursor',
    substrings: ['anysphere'],
    words: ['cursor'],
    hosts: new Set(['cursor.com', 'www.cursor.com', 'cursor.sh']),
    schemes: new Set(['cursor']),
  },
  {
    id: 'vscode',
    label: 'Visual Studio Code',
    substrings: ['vscode', 'visualstudiocode'],
    words: [],
    hosts: new Set(['vscode.dev', 'insiders.vscode.dev']),
    schemes: new Set(['vscode', 'vscode-insiders']),
  },
  {
    id: 'mcpemails',
    label: 'MCP Emails',
    substrings: ['mcpemail'],
    words: [],
    hosts: new Set(['mcpemails.com', 'www.mcpemails.com']),
    schemes: new Set(),
  },
];

const VENDOR_BY_ID = new Map(VENDORS.map((v) => [v.id, v]));

/**
 * Look-alike characters folded to the Latin letter they imitate, after NFKC
 * (which already folds full-width and most compatibility forms). Only the
 * letters that occur in the vendor names need to be here.
 */
const CONFUSABLES: Record<string, string> = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ӏ: 'l', ԁ: 'd', һ: 'h', ո: 'n', ս: 'u',
  α: 'a', ε: 'e', ο: 'o', ρ: 'p', τ: 't', υ: 'u', ν: 'v', ι: 'i', κ: 'k',
  ɑ: 'a', ɡ: 'g', ı: 'i', ł: 'l', ⅼ: 'l', '0': 'o', '1': 'l', '3': 'e', '@': 'a', $: 's',
};

function foldName(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[\s\S]/gu, (ch) => CONFUSABLES[ch] ?? ch);
}

/**
 * The known vendor whose name a self-asserted client_name uses, or null.
 * Separators, case, accents and common look-alikes do not hide it:
 * "C l a u d e", "Cl-aude", "ＣＬＡＵＤＥ" and "Сlaude" (Cyrillic С) all match.
 */
export function vendorForName(name: string | null | undefined): VendorId | null {
  if (typeof name !== 'string' || name.trim() === '') return null;
  const folded = foldName(name);
  const squashed = folded.replace(/[^a-z0-9]/g, '');
  const tokens = folded.split(/[^a-z0-9]+/).filter(Boolean);
  for (const vendor of VENDORS) {
    if (vendor.substrings.some((s) => squashed.includes(s))) return vendor.id;
    if (vendor.words.some((w) => tokens.some((t) => t.startsWith(w)) || squashed === w)) return vendor.id;
  }
  return null;
}

/** The vendor that owns this exact https hostname, or null. */
export function vendorForHost(hostname: string): VendorId | null {
  const h = hostname.toLowerCase();
  for (const vendor of VENDORS) if (vendor.hosts.has(h)) return vendor.id;
  return null;
}

export function vendorLabel(id: VendorId | null): string | null {
  return id ? VENDOR_BY_ID.get(id)?.label ?? null : null;
}

/**
 * Native-app schemes of clients people actually connect, and the vendor each
 * belongs to (null: a known app that is not one of the impersonation-checked
 * vendors). ONLY these count as "an app on this device". Any other custom
 * scheme is unverified: a scheme is just a string the registrant picks, and
 * some (microsoft-edge:, x-safari-https:, intent:, web+...:) open a web page
 * in a browser, which delivers the code to a remote host. Those are refused
 * outright by redirect-scheme.ts; this list is the positive half of the rule.
 */
const NATIVE_APP_SCHEMES: ReadonlyMap<string, VendorId | null> = new Map<string, VendorId | null>([
  ['claude', 'anthropic'],
  ['cursor', 'cursor'],
  ['vscode', 'vscode'],
  ['vscode-insiders', 'vscode'],
  ['vscodium', null],
  ['windsurf', null],
  ['zed', null],
  ['kiro', null],
  ['raycast', null],
  ['warp', null],
]);

export type RedirectDestination =
  /** An https (or, for a seeded row, http) host on the network. */
  | { kind: 'web'; host: string; hostname: string }
  /** A loopback listener on the user's own machine. */
  | { kind: 'loopback'; host: string }
  /**
   * A custom scheme. `native` only for NATIVE_APP_SCHEMES. `webHost` is the
   * remote host a browser hand-off scheme would open, when one can be read.
   */
  | { kind: 'app'; scheme: string; native: boolean; webHost: string | null }
  | { kind: 'invalid' };

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/** The web host a browser hand-off URI points at ("microsoft-edge:https://h/", "x-safari-https://h/"). */
function embeddedWebHost(url: URL): string | null {
  const rest = url.href.slice(url.protocol.length).trim();
  for (const candidate of [rest, `https:${rest}`]) {
    try {
      const inner = new URL(candidate);
      if ((inner.protocol === 'http:' || inner.protocol === 'https:') && inner.hostname) return inner.host;
    } catch {
      // not this shape
    }
  }
  return null;
}

/** Classify a redirect_uri by where a browser delivering the code would go. */
export function describeRedirectDestination(redirectUri: string | null | undefined): RedirectDestination {
  if (typeof redirectUri !== 'string' || redirectUri === '') return { kind: 'invalid' };
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return { kind: 'invalid' };
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    if (isLoopbackHostname(url.hostname)) return { kind: 'loopback', host: url.host };
    if (url.hostname === '') return { kind: 'invalid' };
    return { kind: 'web', host: url.host, hostname: url.hostname };
  }
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  // A hand-off scheme, or any scheme wrapping an http(s) URL, is a web page.
  const handsOff = isBrowserHandoffScheme(scheme) || !isSafeRedirectScheme(redirectUri);
  return {
    kind: 'app',
    scheme,
    native: !handsOff && NATIVE_APP_SCHEMES.has(scheme),
    webHost: handsOff ? embeddedWebHost(url) : null,
  };
}

export type DestinationKind = 'web' | 'loopback' | 'app' | 'other';

export type ClientVerification = 'registered' | 'verified' | 'local' | 'unverified';

export interface ClientIdentity {
  verification: ClientVerification;
  /** The consent heading and the default connection label. */
  displayName: string;
  /**
   * The registrant's own client_name when the screen must show it as a
   * labelled, secondary "calls itself" line (it is not the heading), else null.
   */
  selfReportedName: string | null;
  /** The byline to print, or '' when the byline is self-asserted. */
  byline: string;
  destination: RedirectDestination;
  /**
   * For the screen: 'app' only for a known native-app scheme; 'other' for any
   * other custom scheme (including browser hand-offs) or an unparseable URI.
   */
  destinationKind: DestinationKind;
  /** What to print after "Access will be sent to:". */
  destinationLabel: string;
  /** The vendor that owns the destination (web host or app scheme), or null. */
  destinationVendor: VendorId | null;
  /** Label of the vendor the name imitates while the code goes elsewhere, or null. */
  impersonates: string | null;
}

export interface ClientIdentityInput {
  clientId: string;
  /** For DCR: self-asserted. For CIMD: already the client_id host (cimd.ts). */
  clientName: string;
  clientByline?: string | null;
  /** True for a CIMD (URL) client_id. */
  isCimd: boolean;
  /** The redirect_uri AFTER the page validated it against the client. */
  redirectUri: string;
}

/** True for an RFC 7591 dynamically registered client (anonymous, self-described). */
export function isDynamicClientId(clientId: string): boolean {
  return clientId.startsWith('dyn_');
}

export function describeClientIdentity({
  clientId,
  clientName,
  clientByline,
  isCimd,
  redirectUri,
}: ClientIdentityInput): ClientIdentity {
  const destination = describeRedirectDestination(redirectUri);
  const destinationLabel =
    destination.kind === 'web' || destination.kind === 'loopback'
      ? destination.host
      : destination.kind === 'app'
        ? destination.native
          ? `${destination.scheme}://`
          : destination.webHost
            ? `${destination.webHost} (${destination.scheme}:)`
            : `${destination.scheme}:`
        : '';
  const destinationVendor =
    destination.kind === 'web'
      ? vendorForHost(destination.hostname)
      : destination.kind === 'app' && destination.native
        ? NATIVE_APP_SCHEMES.get(destination.scheme) ?? null
        : null;
  const destinationKind: DestinationKind =
    destination.kind === 'app' ? (destination.native ? 'app' : 'other') : destination.kind === 'invalid' ? 'other' : destination.kind;

  const name = typeof clientName === 'string' && clientName.trim() ? clientName.trim() : clientId;
  const base = { byline: '', destination, destinationKind, destinationLabel, destinationVendor };

  // A row in oauth_clients that is neither dyn_ nor a URL was put there by a
  // migration we wrote. Its name and byline are ours, not a registrant's.
  if (!isCimd && !isDynamicClientId(clientId)) {
    return { ...base, verification: 'registered', displayName: name, selfReportedName: null, byline: clientByline ?? '', impersonates: null };
  }

  const nameVendor = isCimd ? null : vendorForName(name);
  // A CIMD name is already the client_id host (cimd.ts); nothing self-reported.
  const reported = isCimd ? null : name;

  // A known vendor's own https host, or one of the known native-app schemes.
  // On a vendor HOST the code goes to that vendor whatever the name says:
  // Claude and ChatGPT put the user's own connector name ("MCP Emails") in
  // client_name, so no impersonation alert there. The name keeps the heading
  // and is labelled as self-reported.
  if (destination.kind === 'web' && destinationVendor) {
    return { ...base, verification: 'verified', displayName: name, selfReportedName: reported, impersonates: null };
  }

  // Loopback: the code stays on this machine, and the CLIs that use it (Claude
  // Code, Codex, Gemini CLI, VS Code) all name themselves. Not phishable from
  // a link, so the name stays the heading and no alert is raised.
  if (destination.kind === 'loopback') {
    return { ...base, verification: 'local', displayName: name, selfReportedName: reported, impersonates: null };
  }

  // A known native app, with a name that does not claim ANOTHER vendor.
  const impersonates = nameVendor && nameVendor !== destinationVendor ? vendorLabel(nameVendor) : null;
  if (destination.kind === 'app' && destination.native && !impersonates) {
    return { ...base, verification: 'local', displayName: name, selfReportedName: reported, impersonates: null };
  }

  // Everything else: an unknown web host, an unknown or hand-off scheme, or a
  // vendor's name on someone else's destination. The heading is the
  // destination, the name is a labelled secondary line.
  return {
    ...base,
    verification: 'unverified',
    displayName: isCimd ? name : destinationLabel || name,
    selfReportedName: reported && reported !== destinationLabel ? reported : null,
    impersonates,
  };
}
