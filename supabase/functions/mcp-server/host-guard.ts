/**
 * host-guard.ts — SSRF guard for mail hosts, Deno edition.
 *
 * ── Provenance: this file is a MIRROR ──────────────────────────────────────
 *
 * The identical policy exists in two places on purpose:
 *   - apps/web/src/lib/email/host-guard.ts        (Next.js / Node, ingress)
 *   - supabase/functions/mcp-server/host-guard.ts (this file, Deno, egress)
 *
 * They cannot share a module: two runtimes, two build systems, and the edge
 * function is bundled standalone by `supabase functions deploy` with no access
 * to the web app's source tree. The same situation already produced
 * `text-safety.ts` in this directory, and the rule established there applies
 * here unchanged: THE POLICY IS THE CONTRACT. A change to the blocked-range
 * tables, the parsers, the port allowlist or the message strings in EITHER file
 * MUST be made in the OTHER in the same commit. A guard that is stricter at
 * ingress than at egress is a guard with a hole in it, and vice versa.
 *
 * What deliberately differs (runtime, not policy):
 *   - Resolution uses `Deno.resolveDns` rather than `dns.promises.lookup`.
 *     `resolveDns` speaks to the configured nameservers and does NOT consult
 *     /etc/hosts. In the edge sandbox there is no meaningful hosts file, so the
 *     answers match what a connect would reach; if anything it is stricter.
 *   - The connect helper at the bottom (`connectGuardedTcp`) and the per-isolate
 *     validation cache are Deno-only. Node's callers pin through their own
 *     connect helpers; ours pin through this one.
 *
 * ── Why the edge function needs this at all ────────────────────────────────
 *
 * The web guard protects INGRESS: the "connect a mailbox" routes that take a
 * host from a request body. This function never sees that request. It dials
 * hosts that are already STORED, on every ordinary mail operation, which means
 * the attack it is exposed to is not "submit 127.0.0.1" — the ingress guard
 * refuses that — but REBINDING AT REST: connect a host that is genuinely public
 * at validation time, then repoint its A record into a private range and let
 * our own scheduled automations and tool calls dial it forever after.
 *
 * A production audit at the time this shipped found zero bad rows: 216 live
 * inboxes across 93 distinct hosts, none internal, none resolving anywhere
 * internal. So this closes a gap, it does not fix an incident. The point is
 * that the property should hold structurally rather than by evidence, because
 * "we checked and it was fine" expires the moment someone edits a DNS record.
 *
 * ── The four rules (unchanged from the Node file) ──────────────────────────
 *
 *  1. IP literals in non-public ranges are rejected, v4 and v6, INCLUDING the
 *     encodings that only look like hostnames (`2130706433`, `0177.0.0.1`,
 *     `0x7f.0.0.1`, `::ffff:127.0.0.1`, `127.0.0.1.`).
 *  2. Hostnames are RESOLVED and every returned address is checked.
 *  3. The VALIDATED ADDRESS is what gets connected to, not the name. See
 *     `connectGuardedTcp` for how that is achieved in Deno without weakening
 *     certificate validation.
 *  4. Ports are restricted to the mail set.
 *
 * This module imports nothing. It is unit-testable under a plain `deno test`
 * with no network access, via the injectable `lookup` seam.
 */

export type MailProtocol = "imap" | "smtp";

/**
 * The only ports a mail host may be dialled on.
 *
 * IMAP: 993 implicit TLS, 143 STARTTLS.
 * SMTP: 465 implicit TLS, 587 submission STARTTLS, 25 legacy submission (kept
 * because a handful of small hosts still only offer it, and because
 * transport-autodetect tries it).
 *
 * Anything else is refused. A user with a genuinely non-standard mail port is a
 * support ticket; an unrestricted port field is an internal port scanner.
 */
export const ALLOWED_MAIL_PORTS: Readonly<Record<MailProtocol, ReadonlySet<number>>> = {
  imap: new Set([143, 993]),
  smtp: new Set([25, 465, 587]),
};

export function isAllowedMailPort(protocol: MailProtocol, port: unknown): boolean {
  return typeof port === "number" && Number.isInteger(port) && ALLOWED_MAIL_PORTS[protocol].has(port);
}

/* ──────────────────────────────────────────────────────────────────────────
 * IPv4
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Blocked IPv4 ranges, as [dotted base, prefix length, why].
 *
 * The "why" column is not decoration: it is the record of what attack each row
 * stops, and it is the first thing anyone auditing this list will want.
 */
const BLOCKED_IPV4_RANGES: readonly (readonly [string, number, string])[] = [
  ["0.0.0.0", 8, "this network / unspecified — 0.0.0.0 is a live alias for localhost on Linux"],
  ["10.0.0.0", 8, "RFC 1918 private"],
  ["100.64.0.0", 10, "RFC 6598 carrier-grade NAT — the shared address space many hosts sit behind"],
  ["127.0.0.0", 8, "loopback — the isolate itself, and anything it has bound locally"],
  ["169.254.0.0", 16, "link-local, and with it 169.254.169.254, the cloud instance metadata endpoint"],
  ["172.16.0.0", 12, "RFC 1918 private"],
  ["192.0.0.0", 24, "IETF protocol assignments"],
  ["192.0.2.0", 24, "TEST-NET-1 documentation range"],
  ["192.88.99.0", 24, "6to4 relay anycast"],
  ["192.168.0.0", 16, "RFC 1918 private"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "TEST-NET-2 documentation range"],
  ["203.0.113.0", 24, "TEST-NET-3 documentation range"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved, and 255.255.255.255 broadcast with it"],
];

/** Strict dotted quad, four decimal octets. Used only for our own constants. */
function parseStrictIpv4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

const BLOCKED_IPV4_MASKS: readonly { base: number; divisor: number }[] = BLOCKED_IPV4_RANGES.map(
  ([base, prefix]) => {
    const parsed = parseStrictIpv4(base);
    if (parsed === null) throw new Error(`Bad blocked-range constant: ${base}`);
    // Division rather than a bitmask on purpose: JavaScript's bitwise operators
    // coerce to SIGNED 32-bit, so `0xFFFFFFFF & mask` goes negative and every
    // comparison in the 224/4 and 240/4 rows silently stops working.
    const divisor = Math.pow(2, 32 - prefix);
    return { base: Math.floor(parsed / divisor), divisor };
  },
);

/**
 * Parse one component of an IPv4 literal the way `inet_aton` does.
 *
 * This is the part a naive guard gets wrong. The resolver does not require the
 * dotted-quad form: it accepts a bare 32-bit integer, accepts fewer than four
 * parts (the last one absorbing the remaining low-order bytes), and reads a
 * leading `0` as octal and a leading `0x` as hex. So `2130706433`, `0177.0.0.1`,
 * `0x7f.0.0.1` and `127.1` are all 127.0.0.1 to the resolver while looking
 * nothing like it to a string check. Every one of those is a documented SSRF
 * filter bypass.
 */
function parseIpv4Component(part: string): number | null {
  if (part.length === 0) return null;
  if (/^0[xX][0-9a-fA-F]+$/.test(part)) return parseInt(part.slice(2), 16);
  if (/^0[0-7]+$/.test(part)) return parseInt(part.slice(1), 8);
  if (/^(0|[1-9][0-9]*)$/.test(part)) return Number(part);
  return null;
}

/**
 * Parse any form the resolver would read as IPv4, returning the 32-bit value.
 * Returns null when the text is not an IPv4 literal at all (i.e. it is a name).
 */
export function parseLooseIpv4(text: string): number | null {
  if (text.length === 0) return null;
  const parts = text.split(".");
  if (parts.length > 4) return null;
  const values: number[] = [];
  for (const part of parts) {
    const value = parseIpv4Component(part);
    if (value === null || !Number.isFinite(value) || value < 0) return null;
    values.push(value);
  }
  // inet_aton semantics: with N parts, the first N-1 are single octets and the
  // last absorbs the remaining 4-(N-1) bytes.
  const trailing = values[values.length - 1];
  const leading = values.slice(0, values.length - 1);
  for (const octet of leading) if (octet > 255) return null;
  const trailingBytes = 4 - leading.length;
  const trailingLimit = Math.pow(256, trailingBytes);
  if (trailing >= trailingLimit) return null;
  let result = 0;
  for (const octet of leading) result = result * 256 + octet;
  return result * trailingLimit + trailing;
}

function isBlockedIpv4Value(value: number): boolean {
  for (const range of BLOCKED_IPV4_MASKS) {
    if (Math.floor(value / range.divisor) === range.base) return true;
  }
  return false;
}

/** Canonical dotted quad, so what we pin and what we log is unambiguous. */
function formatIpv4(value: number): string {
  return [
    Math.floor(value / 16777216) % 256,
    Math.floor(value / 65536) % 256,
    Math.floor(value / 256) % 256,
    value % 256,
  ].join(".");
}

/* ──────────────────────────────────────────────────────────────────────────
 * IPv6
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Parse an IPv6 literal into its 16 bytes, or null if it is not one.
 *
 * Accepts the `::` elision, a bracketed form, a trailing zone id (`%eth0`,
 * which only ever appears on link-local addresses and is discarded because the
 * address itself is blocked anyway), and a trailing embedded dotted quad
 * (`::ffff:127.0.0.1`).
 */
export function parseIpv6(text: string): Uint8Array | null {
  let value = text;
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  // A zone id only ever appears on a link-local address, which is blocked
  // outright below, so it is dropped rather than interpreted.
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  if (value.indexOf(":") < 0) return null;

  // Rewrite a trailing dotted quad into the two hex groups it stands for, so
  // the rest of the parser only ever sees hex. `::ffff:127.0.0.1` becomes
  // `::ffff:7f00:1`, which is the same 16 bytes and one code path instead of
  // two. Only the strict dotted form is accepted here: the resolver does not
  // read `::ffff:0177.0.0.1` as an address either, and inventing a parse nobody
  // else has would create a difference between what we check and what we would
  // have connected to.
  const lastColon = value.lastIndexOf(":");
  const remainder = value.slice(lastColon + 1);
  if (remainder.indexOf(".") >= 0) {
    const embedded = parseStrictIpv4(remainder);
    if (embedded === null) return null;
    value = value.slice(0, lastColon + 1) +
      Math.floor(embedded / 65536).toString(16) +
      ":" +
      (embedded % 65536).toString(16);
  }

  const elision = value.indexOf("::");
  if (elision !== value.lastIndexOf("::")) return null;

  const toGroups = (segment: string): number[] | null => {
    if (segment.length === 0) return [];
    const groups: number[] = [];
    for (const group of segment.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      groups.push(parseInt(group, 16));
    }
    return groups;
  };

  const head = toGroups(elision >= 0 ? value.slice(0, elision) : value);
  const rest = elision >= 0 ? toGroups(value.slice(elision + 2)) : [];
  if (head === null || rest === null) return null;

  if (elision >= 0) {
    // `::` has to stand in for at least one group, so eight explicit groups
    // plus an elision is malformed.
    if (head.length + rest.length > 7) return null;
  } else if (head.length !== 8) {
    return null;
  }

  const bytes = new Uint8Array(16);
  const write = (groups: number[], offset: number) => {
    let at = offset;
    for (const group of groups) {
      bytes[at] = (group >> 8) & 0xff;
      bytes[at + 1] = group & 0xff;
      at += 2;
    }
  };
  write(head, 0);
  if (elision >= 0) write(rest, 16 - rest.length * 2);
  return bytes;
}

function ipv6Prefix(bytes: Uint8Array, byteCount: number): string {
  let out = "";
  for (let i = 0; i < byteCount; i += 1) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

/**
 * Canonical form for pinning: uncompressed hex groups, except that an
 * IPv4-mapped address is rendered as the dotted quad it actually is. Dialling
 * `8.8.8.8` rather than `0:0:0:0:0:ffff:808:808` keeps the socket on the family
 * the address really names, and keeps the pinned value readable in a log line.
 */
function formatIpv6(bytes: Uint8Array): { address: string; family: 4 | 6 } {
  const first10Zero = bytes.slice(0, 10).every((b) => b === 0);
  if (first10Zero && bytes[10] === 0xff && bytes[11] === 0xff) {
    return { address: `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`, family: 4 };
  }
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  return { address: groups.join(":"), family: 6 };
}

function embeddedIpv4(bytes: Uint8Array): { value: number; exempt: boolean } | null {
  const readTail = () => bytes[12] * 16777216 + bytes[13] * 65536 + bytes[14] * 256 + bytes[15];
  const first10Zero = bytes.slice(0, 10).every((b) => b === 0);

  // ::ffff:a.b.c.d — IPv4-mapped. A legitimate way to write an IPv4 address,
  // so a public one stays allowed; the point is that ::ffff:127.0.0.1 must be
  // judged as 127.0.0.1 and not waved through as "some IPv6 address".
  if (first10Zero && bytes[10] === 0xff && bytes[11] === 0xff) return { value: readTail(), exempt: true };

  // ::a.b.c.d — deprecated IPv4-compatible. `::1` and `::` fall in here too and
  // are caught by the v4 policy (127-ish and 0.0.0.0/8 respectively), which is
  // exactly the outcome we want.
  if (first10Zero && bytes[10] === 0 && bytes[11] === 0) return { value: readTail(), exempt: true };

  // 64:ff9b::/96 — NAT64. The embedded v4 is the real destination.
  if (
    bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((b) => b === 0)
  ) {
    return { value: readTail(), exempt: false };
  }

  // 2002::/16 — 6to4. Bytes 2-5 are the embedded IPv4, and 2002:7f00:1:: is a
  // 6to4 wrapper for 127.0.0.1 that sits INSIDE global unicast, so the
  // allowlist below would otherwise pass it.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return { value: bytes[2] * 16777216 + bytes[3] * 65536 + bytes[4] * 256 + bytes[5], exempt: false };
  }

  return null;
}

/**
 * Explicit v6 blocks that live INSIDE global unicast, so the 2000::/3 allowlist
 * below cannot catch them.
 */
const BLOCKED_IPV6_PREFIXES: readonly (readonly [string, string])[] = [
  ["20010db8", "2001:db8::/32 documentation"],
  ["20010000", "2001::/32 Teredo — tunnels an arbitrary IPv4 destination"],
];

function isBlockedIpv6Bytes(bytes: Uint8Array): boolean {
  const embedded = embeddedIpv4(bytes);
  if (embedded !== null) {
    if (isBlockedIpv4Value(embedded.value)) return true;
    // A public IPv4 written in mapped/compatible form is a fine destination and
    // is let through here, skipping the global-unicast allowlist that would
    // otherwise reject its ::ffff: prefix.
    if (embedded.exempt) return false;
  }

  for (const [prefix] of BLOCKED_IPV6_PREFIXES) {
    if (ipv6Prefix(bytes, prefix.length / 2) === prefix) return true;
  }

  // Allowlist, not blocklist: global unicast is 2000::/3 and everything outside
  // it is by definition not a public destination. That single rule covers ::/128
  // (unspecified), ::1/128 (loopback), fc00::/7 (unique local), fe80::/10
  // (link-local, including fe80-scoped metadata equivalents) and ff00::/8
  // (multicast), and it fails closed for any range IANA allocates in future.
  return (bytes[0] & 0xe0) !== 0x20;
}

/* ──────────────────────────────────────────────────────────────────────────
 * The guard
 * ────────────────────────────────────────────────────────────────────────── */

export type HostGuardCode = "host_invalid" | "host_not_allowed" | "host_not_found" | "port_not_allowed";

/**
 * Failure sentences, kept WORD FOR WORD identical to the Node mirror. A user
 * who hits the same wall from the dashboard and from a tool call must be told
 * the same thing; two wordings of one rule is how a support conversation goes
 * wrong.
 */
export const HOST_GUARD_MESSAGES: Record<HostGuardCode, string> = {
  host_invalid: "A valid IMAP and SMTP host is required.",
  // Says nothing about WHICH range matched, and nothing about whether anything
  // was listening. That is the whole point: a message that distinguished
  // "blocked private address" from "blocked loopback" would hand back a slice
  // of the internal map this guard exists to withhold.
  host_not_allowed:
    "That mail host resolves to an address on a private or internal network, which this service will not connect to. Enter the public mail host your provider published.",
  host_not_found:
    "That server name does not exist. Check it for a typo: it is the mail host from your provider, which is often different from your website address.",
  port_not_allowed:
    "Mail servers are reached on their standard ports: 143 or 993 for IMAP, and 25, 465 or 587 for SMTP. Enter one of those under Advanced settings.",
};

export type HostGuardResult =
  | {
    ok: true;
    /** The name as submitted, kept for TLS SNI and certificate validation. */
    host: string;
    /**
     * The address that was checked and must be dialled. See rule 3 at the top
     * of this file: connecting to the NAME instead would re-resolve it and
     * reopen the rebinding window this field exists to close.
     */
    address: string;
    family: 4 | 6;
  }
  | { ok: false; code: HostGuardCode; message: string };

/**
 * Injectable resolver, so the tests never touch the network. Mirrors the shape
 * the Node file uses (`dns.promises.lookup(host, { all: true })`), which keeps
 * the two `guardMailHost` bodies textually comparable.
 */
export type HostLookup = (hostname: string) => Promise<{ address: string; family: number }[]>;

/**
 * One label may be 63 characters, the whole name 253, and only letters, digits
 * and hyphens are legal (an IDN arrives as its `xn--` punycode form). Rejecting
 * everything else also rejects the smuggling characters — `@`, `:`, `/`, `\`,
 * whitespace, NUL — that turn a host field into a URL.
 */
function isValidDnsName(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  const labels = host.split(".");
  // At least two labels: a single-label name can only resolve through a local
  // search domain, which is an internal name by construction.
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return false;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) return false;
  }
  // An all-numeric last label means the string was meant as an IPv4 literal in
  // some encoding and did not parse as one. Never a real mail host.
  return !/^[0-9]+$/.test(labels[labels.length - 1]);
}

/** Trim, lowercase, unwrap brackets and drop the FQDN root dot. */
export function normalizeMailHost(raw: unknown): string {
  let host = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  // `127.0.0.1.` is the same destination as `127.0.0.1` to the resolver, and
  // the trailing dot was enough to slip past a check that compared strings.
  while (host.endsWith(".") && host.length > 1) host = host.slice(0, -1);
  return host;
}

/**
 * Judge one already-resolved literal address. Split out of `guardMailHost`
 * because the post-connect backstop in `connectGuardedTcp` needs exactly this
 * decision about `conn.remoteAddr.hostname` and must not re-implement it.
 */
export function isAllowedAddress(rawAddress: string): boolean {
  const address = normalizeMailHost(rawAddress);
  if (address.indexOf(":") >= 0) {
    const bytes = parseIpv6(address);
    return bytes !== null && !isBlockedIpv6Bytes(bytes);
  }
  const value = parseLooseIpv4(address);
  return value !== null && !isBlockedIpv4Value(value);
}

export interface MailHostGuardOptions {
  protocol: MailProtocol;
  port: number;
  /** Test seam; defaults to the `Deno.resolveDns` lookup below. */
  lookup?: HostLookup;
}

/**
 * The single entry point every connect path must call before opening a mail
 * socket.
 *
 * Returns the address to dial on success. Callers MUST dial that address rather
 * than the name — see rule 3.
 */
export async function guardMailHost(
  rawHost: unknown,
  options: MailHostGuardOptions,
): Promise<HostGuardResult> {
  const deny = (code: HostGuardCode): HostGuardResult => ({ ok: false, code, message: HOST_GUARD_MESSAGES[code] });

  // Port first: it is synchronous and free, and a rejected port should never
  // spend a DNS round trip.
  if (!isAllowedMailPort(options.protocol, options.port)) return deny("port_not_allowed");

  const host = normalizeMailHost(rawHost);
  if (host.length === 0) return deny("host_invalid");

  // An IPv6 literal is checked before IPv4, because the v4 parser would happily
  // read the front of something it should not.
  if (host.indexOf(":") >= 0) {
    const bytes = parseIpv6(host);
    if (bytes === null) return deny("host_invalid");
    if (isBlockedIpv6Bytes(bytes)) return deny("host_not_allowed");
    const formatted = formatIpv6(bytes);
    return { ok: true, host, address: formatted.address, family: formatted.family };
  }

  const literal = parseLooseIpv4(host);
  if (literal !== null) {
    if (isBlockedIpv4Value(literal)) return deny("host_not_allowed");
    // Canonicalised: a user who typed 0x08080808 gets 8.8.8.8 dialled, so what
    // we connect to is never a form we did not fully parse.
    return { ok: true, host, address: formatIpv4(literal), family: 4 };
  }

  if (!isValidDnsName(host)) return deny("host_invalid");

  let resolved: { address: string; family: number }[];
  try {
    resolved = await (options.lookup ?? denoLookup)(host);
  } catch {
    // NXDOMAIN, SERVFAIL, timeout: no answer is not a security event, and the
    // "that server name does not exist" copy is the right advice.
    return deny("host_not_found");
  }
  if (!Array.isArray(resolved) || resolved.length === 0) return deny("host_not_found");

  // EVERY answer must be acceptable, not merely the one we intend to dial. A
  // name that returns a public address alongside 127.0.0.1 is a rebinding setup
  // being staged in a single response, and there is no legitimate mail host
  // that answers that way.
  const approved: { address: string; family: 4 | 6 }[] = [];
  for (const entry of resolved) {
    const address = normalizeMailHost(entry.address);
    if (address.indexOf(":") >= 0) {
      const bytes = parseIpv6(address);
      if (bytes === null || isBlockedIpv6Bytes(bytes)) return deny("host_not_allowed");
      approved.push(formatIpv6(bytes));
    } else {
      const value = parseLooseIpv4(address);
      if (value === null || isBlockedIpv4Value(value)) return deny("host_not_allowed");
      approved.push({ address: formatIpv4(value), family: 4 });
    }
  }

  // Prefer IPv4 when the name has both. Our egress is IPv4, and pinning the
  // AAAA on a dual-stack host would start failing connections that work today.
  const chosen = approved.find((entry) => entry.family === 4) ?? approved[0];
  return { ok: true, host, address: chosen.address, family: chosen.family };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Deno-only below this line.
 *
 * Everything above mirrors apps/web/src/lib/email/host-guard.ts. Everything
 * below is the edge runtime's half of the job: resolution, the per-isolate
 * cache the latency budget requires, and the pinned connect.
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * Raised when the guard refuses a host. Deliberately NOT one of the
 * `*_auth_failed` sentinel strings: this is not a credential problem and
 * telling the user to reconnect their mailbox would send them round a loop that
 * cannot terminate.
 *
 * Every IMAP/SMTP call site in index.ts already wraps its provider work in a
 * catch that reports the thrown message verbatim under `error_code:
 * "provider_error"` — the same route `ImapConnectionLimitError` takes. The
 * message below is therefore written to be read by the model and the user as
 * it stands, with no mapping needed at any of the 26 connect sites. See
 * `providerErrorCode` in index.ts for the one place that does look at the
 * class, so the automation runner can log `mail_host_blocked` rather than a
 * generic provider error.
 */
export class MailHostBlockedError extends Error {
  readonly code: HostGuardCode;
  constructor(code: HostGuardCode, host: string, port: number, protocol: MailProtocol) {
    super(
      `${protocol.toUpperCase()} host refused (${code}): ${host}:${port} — ${HOST_GUARD_MESSAGES[code]} ` +
        `Fix the server settings for this inbox in the MCP Emails dashboard; retrying will not help.`,
    );
    this.name = "MailHostBlockedError";
    this.code = code;
  }
}

/**
 * Total wall-clock budget for resolving one host, across both record types.
 *
 * A tool call has roughly 25 seconds end to end, so an unbounded DNS step is
 * not a slow path, it is a failed call. Five seconds is far above the 5-40ms a
 * healthy answer takes and far below anything that would threaten the call
 * budget. A host that cannot be resolved inside it is reported as
 * `host_not_found`, which is not cached, so a genuine blip costs one slow
 * attempt rather than a minute of hard failure.
 */
const RESOLVE_TIMEOUT_MS = 5_000;

/**
 * Set when `Deno.resolveDns` is unavailable or fails for a reason that is not
 * "this name does not exist". Passed per-call rather than held in a module
 * global so it stays honest under concurrency and under test.
 */
export interface ResolverState {
  unavailable: boolean;
}

function isNotFound(err: unknown): boolean {
  // NXDOMAIN, and also "no records of this type", which is what an A-only host
  // answers to an AAAA query.
  return err instanceof Deno.errors.NotFound ||
    (err instanceof Error && /not\s*found|no records|nxdomain/i.test(err.message));
}

/**
 * The production resolver.
 *
 * ── Why A first, and AAAA only if A is empty ──────────────────────────────
 *
 * The obvious implementation queries A and AAAA together and waits for both.
 * Measured, that is a latency trap: `Deno.resolveDns` uses its own stub
 * resolver, and when a name has NO record of the requested type it works
 * through the resolver's search domains before giving up. On a host with A
 * records and no AAAA — imap.fastmail.com and imappro.zoho.eu, both real
 * customer hosts — the AAAA query took THIRTY SECONDS to return NotFound while
 * the A query answered in 5ms. Waiting for both would have put a 30s stall in
 * front of a mail operation that has a ~25s budget, i.e. it would have taken
 * those mailboxes offline. This is not hypothetical; it is what the first
 * version of this function did on this machine.
 *
 * So the query is ordered rather than parallel. A is asked first because the
 * guard pins IPv4 whenever a name offers it (our egress is IPv4) — the AAAA
 * set of a dual-stack host is never the address we dial, so paying for it is
 * pure cost. AAAA is asked only when A yields nothing, which is the one case
 * where a v6 answer could actually be dialled.
 *
 * The policy is untouched by this. `guardMailHost` still checks EVERY address
 * this function returns and refuses the whole name if any of them is
 * non-public; what changes is only that a dual-stack host's unusable AAAA set
 * is not fetched. It cannot widen what we will connect to, because the pinned
 * address is always drawn from the set that was checked.
 *
 * A failure that is NOT an NXDOMAIN marks the resolver degraded, so
 * `connectGuardedTcp` can fall back to its post-connect check rather than take
 * the whole mail system down. See there for why that trade is the right one.
 */
function makeDenoLookup(state: ResolverState): HostLookup {
  return async (hostname) => {
    const resolveDns = (Deno as { resolveDns?: typeof Deno.resolveDns }).resolveDns;
    if (typeof resolveDns !== "function") {
      state.unavailable = true;
      throw new Error("Deno.resolveDns is unavailable in this runtime");
    }

    // One deadline for the whole step, not one per query, so the worst case is
    // RESOLVE_TIMEOUT_MS and not a multiple of it.
    const deadline = Date.now() + RESOLVE_TIMEOUT_MS;

    // Typed through `string[]` rather than the union `resolveDns` returns for
    // its record-type overloads: A and AAAA only ever answer with addresses.
    const query = (recordType: "A" | "AAAA"): Promise<string[]> => {
      const p = resolveDns.call(Deno, hostname, recordType) as Promise<string[]>;
      // The loser of the race below still settles later. Without this its
      // rejection is unhandled, which in Deno is a process-level event.
      p.catch(() => {});
      let timer: number | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`DNS resolution timed out after ${RESOLVE_TIMEOUT_MS}ms`)),
          Math.max(0, deadline - Date.now()),
        );
      });
      return Promise.race([p, timeout]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
    };

    const failures: unknown[] = [];

    try {
      const v4 = await query("A");
      if (v4.length > 0) return v4.map((address) => ({ address, family: 4 }));
    } catch (err) {
      failures.push(err);
    }

    try {
      const v6 = await query("AAAA");
      if (v6.length > 0) return v6.map((address) => ({ address, family: 6 }));
    } catch (err) {
      failures.push(err);
    }

    // Nothing came back. Distinguish "the name has no records" (a user typo,
    // fail closed with host_not_found) from "the resolver could not answer"
    // (an infrastructure problem, degrade rather than deny).
    if (failures.length > 0 && !failures.every((err) => isNotFound(err))) {
      state.unavailable = true;
    }
    throw failures[0] ?? new Error("no DNS records");
  };
}

/** The default resolver used when `guardMailHost` is called without a seam. */
const denoLookup: HostLookup = makeDenoLookup({ unavailable: false });

/* ── Per-isolate validation cache ──────────────────────────────────────────
 *
 * WHY: a single tool call routinely opens several IMAP connections (bulk moves
 * fan out per folder, the triage runner walks every rule), and the whole call
 * lives inside a ~25s budget. Paying a DNS round trip per connect would be a
 * new, unbudgeted cost on the hot path of a live mail system, and IMAP
 * connection churn has bitten this codebase before. So the verdict — the deny,
 * or the approved pinned address — is memoised for the life of the isolate.
 *
 * TTL: 60 seconds, one number for both allow and deny.
 *   - Short enough that a pinned address is never more stale than a typical
 *     mail-host DNS TTL (300s and up for every provider we serve), so we cannot
 *     keep dialling an address the operator has moved away from.
 *   - Long enough that every connect in one tool call, and every connect in a
 *     burst of calls landing on the same warm isolate, pays for resolution
 *     once. Edge isolates are recycled often, so in practice this is closer to
 *     "once per isolate per host" than to a 60-second window.
 *   - It does NOT weaken the rebinding property: the address is still checked
 *     before it is dialled, and the socket still goes to a checked address. A
 *     rebind that lands mid-TTL is caught by the post-connect backstop in
 *     `connectGuardedTcp`, because the OS cannot connect us anywhere other than
 *     the literal we handed it.
 *
 * `host_not_found` is deliberately NOT cached: it is usually transient (a
 * SERVFAIL, a cold recursive resolver) and caching it would turn a blip into a
 * minute of hard failure for a working mailbox.
 *
 * A cache hit costs one Map lookup and one Date.now(). Nothing else.
 */
const VALIDATION_TTL_MS = 60_000;

/**
 * Bounded so a long-lived isolate cannot accumulate an entry per host forever.
 * 512 is far above the 93 distinct hosts production actually uses, so the
 * eviction path below is effectively unreachable; it exists so that "effectively"
 * never has to be relied on.
 */
const VALIDATION_CACHE_MAX = 512;

const validationCache = new Map<string, { at: number; result: HostGuardResult }>();

function cacheKey(protocol: MailProtocol, host: string, port: number): string {
  return `${protocol} ${host} ${port}`;
}

/** Drop a verdict, so the next attempt re-resolves. Used when a pinned dial fails. */
function invalidateValidation(protocol: MailProtocol, host: string, port: number): void {
  validationCache.delete(cacheKey(protocol, host, port));
}

/** `guardMailHost` with the per-isolate memo in front of it. */
export async function guardMailHostCached(
  rawHost: unknown,
  options: MailHostGuardOptions & { now?: () => number },
): Promise<HostGuardResult> {
  const now = options.now ?? Date.now;
  const host = normalizeMailHost(rawHost);
  const key = cacheKey(options.protocol, host, options.port);

  const hit = validationCache.get(key);
  if (hit !== undefined && now() - hit.at < VALIDATION_TTL_MS) return hit.result;

  const result = await guardMailHost(rawHost, options);

  // Cache the durable verdicts only. `host_invalid` and `port_not_allowed` are
  // synchronous and free to recompute; `host_not_found` is transient.
  if (result.ok || result.code === "host_not_allowed") {
    if (validationCache.size >= VALIDATION_CACHE_MAX) {
      for (const [k, v] of validationCache) {
        if (now() - v.at >= VALIDATION_TTL_MS) validationCache.delete(k);
      }
      if (validationCache.size >= VALIDATION_CACHE_MAX) validationCache.clear();
    }
    validationCache.set(key, { at: now(), result });
  }
  return result;
}

/** Test-only: drop every memoised verdict. */
export function clearValidationCacheForTests(): void {
  validationCache.clear();
}

export interface GuardedConnectOptions {
  host: string;
  port: number;
  protocol: MailProtocol;
  /** Test seam. Defaults to the Deno.resolveDns lookup. */
  lookup?: HostLookup;
  /**
   * Test seam, paired with `lookup`. The production resolver owns this object
   * and sets `unavailable` when it cannot answer for a reason that is not
   * NXDOMAIN; an injected lookup has to be handed one explicitly, or the
   * degraded branch below could never be exercised.
   */
  resolverState?: ResolverState;
  /** Test seam. Defaults to Deno.connect. */
  connect?: (options: { hostname: string; port: number }) => Promise<Deno.TcpConn>;
}

/**
 * Open a validated, PINNED TCP connection to a mail host.
 *
 * ── How pinning is done in Deno without weakening TLS ──────────────────────
 *
 * `Deno.connectTls({ hostname, port })` uses one string for two jobs: it is the
 * dial target AND the name the certificate is checked against. Handing it the
 * approved IP would therefore validate the certificate against the IP and fail
 * every real mail host; handing it the name would re-resolve and reopen the
 * rebinding window. Neither is acceptable.
 *
 * The split that works — and this is verified behaviour, not a hope — is to
 * dial the IP with `Deno.connect` and then upgrade with
 * `Deno.startTls(conn, { hostname: <the real name> })`. `startTls` takes the
 * certificate/SNI name from its own option and the peer from the socket it is
 * handed, so the socket lands on the address we approved while the certificate
 * is still checked against the hostname. Confirmed against a live host: a
 * pinned dial to imap.gmail.com's A record upgraded with the wrong hostname
 * fails with `invalid peer certificate: certificate not valid for name ...`,
 * so certificate validation is provably still on. Callers do that upgrade;
 * this function returns the raw TCP connection, which is also exactly what the
 * STARTTLS paths already want.
 *
 * ── The backstop ──────────────────────────────────────────────────────────
 *
 * After connecting we re-check `conn.remoteAddr.hostname`, the address the
 * kernel actually reached. With a pinned literal that is a tautology; it is not
 * a tautology on the degraded path below, and it costs one string check.
 *
 * ── Degrading instead of falling over ─────────────────────────────────────
 *
 * If `Deno.resolveDns` is missing or the resolver cannot answer for a reason
 * other than NXDOMAIN, we do NOT deny every mailbox in the fleet — that would
 * convert a resolver hiccup into a total outage of a paid product. Instead we
 * dial the NAME and let the backstop judge the address we actually reached. The
 * property that matters is preserved: no byte is ever written to, and no byte
 * ever read from, an internal address. What is given up on that path is the
 * bare TCP SYN, which is a far weaker oracle than the authenticated session
 * this code performed before the guard existed.
 */
export async function connectGuardedTcp(options: GuardedConnectOptions): Promise<Deno.TcpConn> {
  const { host, port, protocol } = options;
  const state: ResolverState = options.resolverState ?? { unavailable: false };
  const lookup = options.lookup ?? makeDenoLookup(state);
  const connect = options.connect ?? ((o) => Deno.connect(o));

  const verdict = await guardMailHostCached(host, { protocol, port, lookup });

  let dialHost: string;
  if (verdict.ok) {
    dialHost = verdict.address;
  } else if (verdict.code === "host_not_found" && state.unavailable) {
    // Degraded path. The host string already passed every syntactic check
    // inside guardMailHost (it only reaches the resolver if it is a well-formed
    // multi-label name), so what we are dialling here is a name, never a
    // literal, and the backstop below still decides whether we may speak to it.
    console.error("[mcp-server] host_guard: resolver_unavailable", { host, port, protocol });
    dialHost = normalizeMailHost(host);
  } else {
    throw new MailHostBlockedError(verdict.code, normalizeMailHost(host) || String(host), port, protocol);
  }

  let conn: Deno.TcpConn;
  try {
    conn = await connect({ hostname: dialHost, port });
  } catch (err) {
    // A pinned address that will not accept a connection may simply be stale.
    // Drop the memo so the retry (IMAP retries connection-limit refusals, and
    // the user retries everything else) resolves again rather than replaying
    // the same dead address for the rest of the TTL.
    invalidateValidation(protocol, normalizeMailHost(host), port);
    throw err;
  }

  const peer = (conn.remoteAddr as Deno.NetAddr).hostname;
  if (!isAllowedAddress(peer)) {
    try {
      conn.close();
    } catch {
      // Nothing was written and nothing was read; a close failure here is not
      // interesting and must not mask the refusal below.
    }
    invalidateValidation(protocol, normalizeMailHost(host), port);
    console.error("[mcp-server] host_guard: blocked_peer_address", { host, port, protocol });
    throw new MailHostBlockedError("host_not_allowed", normalizeMailHost(host) || String(host), port, protocol);
  }

  return conn;
}
