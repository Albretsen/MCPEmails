/**
 * SSRF guard for user-supplied mail hosts.
 *
 * ── There are two of these, and they must not drift ─────────────────────────
 *
 * A line-for-line Deno mirror of this policy lives at
 * `supabase/functions/mcp-server/host-guard.ts`. This file guards INGRESS: the
 * host a user submits when connecting a mailbox. The mirror guards EGRESS: the
 * host already stored on an inbox row, which the edge function dials on every
 * mail operation. Ingress alone is not enough, because a host that is public on
 * the day it is connected can be repointed into a private range afterwards, and
 * nothing re-checks it — that rebinding-at-rest gap is the whole reason the
 * mirror exists.
 *
 * The two runtimes cannot share a module (Node vs Deno, two build systems), the
 * same way `text-safety.ts` cannot. A change to the range tables, the address
 * parsers, the port allowlist or the refusal messages in either file MUST be
 * made in the other in the same commit. The policy is the contract, not the
 * code.
 *
 * ── The hole this closes ────────────────────────────────────────────────────
 *
 * Every "connect a mailbox" route takes a hostname and a port from the request
 * body and hands them straight to `net.connect` / `tls.connect` inside a Vercel
 * function. The only check was a one-liner that asked whether the string was
 * non-empty, space-free and contained a dot. `127.0.0.1`, `10.0.0.7` and
 * `169.254.169.254` all satisfy that, and so does any internal name that
 * resolves into those ranges.
 *
 * That made the connector an authenticated port scanner. The caller does not
 * need to read a byte of the response to learn something: the validator already
 * distinguishes CONNECTION_REFUSED (nothing listening), CONNECTION_TIMEOUT
 * (filtered), TLS_HANDSHAKE_FAILED (something answered but not with TLS) and
 * IMAP_PROTOCOL_ERROR (something answered with a non-IMAP banner), and returns
 * that code in the 422 body. Sweep the port range and you have a map of the
 * private network the function sits in, plus a reachability oracle for the
 * cloud metadata endpoint. The STARTTLS path makes it worse: it opens a
 * PLAINTEXT socket and reads the greeting before upgrading, so the attacker
 * also gets to fingerprint whatever is listening.
 *
 * OWASP ASVS 4.0 §5.2.6 (SSRF) is a Level 1 requirement and this is the
 * control that satisfies it.
 *
 * ── The four rules ──────────────────────────────────────────────────────────
 *
 *  1. IP literals in non-public ranges are rejected, v4 and v6, INCLUDING the
 *     encodings that only look like hostnames (`2130706433`, `0177.0.0.1`,
 *     `0x7f.0.0.1`, `::ffff:127.0.0.1`, `127.0.0.1.`). See parseLooseIpv4 for
 *     why the odd ones matter: `getaddrinfo` accepts every one of them, so a
 *     check written against the pretty dotted-quad form is not a check.
 *
 *  2. Hostnames are RESOLVED and every returned address is checked. The literal
 *     is the toy case; the real attack is `internal.attacker.example` with an A
 *     record pointing at 169.254.169.254, which no amount of string inspection
 *     catches.
 *
 *  3. The VALIDATED ADDRESS is what gets connected to, not the name. Checking a
 *     name and then handing the name to `net.connect` re-resolves it, and DNS
 *     rebinding exists precisely to exploit that window: answer the check with
 *     a public address, answer the connect with 127.0.0.1. The guard returns
 *     the address it approved and the connect helpers dial that, keeping the
 *     original name only as the TLS SNI/certificate name so certificate
 *     validation is unaffected.
 *
 *  4. Ports are restricted to the mail set. Without this the guard still leaves
 *     a scanner pointed at the public internet (our egress IP hitting anyone's
 *     port 22), and it is the cheapest half of the fix. Verified against
 *     production first: of 216 live inboxes, every IMAP row is on 993 and every
 *     SMTP row is on 465 or 587, so no real customer is affected. The wider set
 *     below matches lib/email/transport-autodetect.ts exactly, because that
 *     module retries a failed connection on the other standard transports and
 *     an allowlist narrower than its retry set would reject our own retries.
 *
 * This module is deliberately dependency-free (node built-ins only) and holds
 * no app-alias imports, so it is unit-testable under a plain `node --test`.
 */

import { promises as dns } from 'node:dns';

export type MailProtocol = 'imap' | 'smtp';

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
  return typeof port === 'number' && Number.isInteger(port) && ALLOWED_MAIL_PORTS[protocol].has(port);
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
  ['0.0.0.0', 8, 'this network / unspecified — 0.0.0.0 is a live alias for localhost on Linux'],
  ['10.0.0.0', 8, 'RFC 1918 private'],
  ['100.64.0.0', 10, 'RFC 6598 carrier-grade NAT — the shared address space many hosts sit behind'],
  ['127.0.0.0', 8, 'loopback — the function itself, and anything it has bound locally'],
  ['169.254.0.0', 16, 'link-local, and with it 169.254.169.254, the cloud instance metadata endpoint'],
  ['172.16.0.0', 12, 'RFC 1918 private'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.0.2.0', 24, 'TEST-NET-1 documentation range'],
  ['192.88.99.0', 24, '6to4 relay anycast'],
  ['192.168.0.0', 16, 'RFC 1918 private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'TEST-NET-2 documentation range'],
  ['203.0.113.0', 24, 'TEST-NET-3 documentation range'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved, and 255.255.255.255 broadcast with it'],
];

/** Strict dotted quad, four decimal octets. Used only for our own constants. */
function parseStrictIpv4(text: string): number | null {
  const parts = text.split('.');
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
    /* c8 ignore next */
    if (parsed === null) throw new Error(`Bad blocked-range constant: ${base}`);
    // Division rather than a bitmask on purpose: JavaScript's bitwise operators
    // coerce to SIGNED 32-bit, so `0xFFFFFFFF & mask` goes negative and every
    // comparison in the 224/4 and 240/4 rows silently stops working.
    const divisor = Math.pow(2, 32 - prefix);
    return { base: Math.floor(parsed / divisor), divisor };
  }
);

/**
 * Parse one component of an IPv4 literal the way `inet_aton` does.
 *
 * This is the part a naive guard gets wrong. `getaddrinfo`, which is what
 * `net.connect` ultimately calls, does not require the dotted-quad form: it
 * accepts a bare 32-bit integer, accepts fewer than four parts (the last one
 * absorbing the remaining low-order bytes), and reads a leading `0` as octal
 * and a leading `0x` as hex. So `2130706433`, `0177.0.0.1`, `0x7f.0.0.1` and
 * `127.1` are all 127.0.0.1 to the resolver while looking nothing like it to a
 * string check. Every one of those is a documented SSRF filter bypass.
 */
function parseIpv4Component(part: string): number | null {
  if (part.length === 0) return null;
  if (/^0[xX][0-9a-fA-F]+$/.test(part)) return parseInt(part.slice(2), 16);
  if (/^0[0-7]+$/.test(part)) return parseInt(part.slice(1), 8);
  if (/^(0|[1-9][0-9]*)$/.test(part)) return Number(part);
  return null;
}

/**
 * Parse any form `getaddrinfo` would read as IPv4, returning the 32-bit value.
 * Returns null when the text is not an IPv4 literal at all (i.e. it is a name).
 */
export function parseLooseIpv4(text: string): number | null {
  if (text.length === 0) return null;
  const parts = text.split('.');
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
  ].join('.');
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
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  // A zone id only ever appears on a link-local address, which is blocked
  // outright below, so it is dropped rather than interpreted.
  const zone = value.indexOf('%');
  if (zone >= 0) value = value.slice(0, zone);
  if (value.indexOf(':') < 0) return null;

  // Rewrite a trailing dotted quad into the two hex groups it stands for, so
  // the rest of the parser only ever sees hex. `::ffff:127.0.0.1` becomes
  // `::ffff:7f00:1`, which is the same 16 bytes and one code path instead of
  // two. Only the strict dotted form is accepted here: getaddrinfo does not
  // read `::ffff:0177.0.0.1` as an address either, and inventing a parse
  // nobody else has would create a difference between what we check and what
  // we would have connected to.
  const lastColon = value.lastIndexOf(':');
  const remainder = value.slice(lastColon + 1);
  if (remainder.indexOf('.') >= 0) {
    const embedded = parseStrictIpv4(remainder);
    if (embedded === null) return null;
    value =
      value.slice(0, lastColon + 1) +
      Math.floor(embedded / 65536).toString(16) +
      ':' +
      (embedded % 65536).toString(16);
  }

  const elision = value.indexOf('::');
  if (elision !== value.lastIndexOf('::')) return null;

  const toGroups = (segment: string): number[] | null => {
    if (segment.length === 0) return [];
    const groups: number[] = [];
    for (const group of segment.split(':')) {
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
  let out = '';
  for (let i = 0; i < byteCount; i += 1) out += bytes[i].toString(16).padStart(2, '0');
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
  return { address: groups.join(':'), family: 6 };
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
  ['20010db8', '2001:db8::/32 documentation'],
  ['20010000', '2001::/32 Teredo — tunnels an arbitrary IPv4 destination'],
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

export type HostGuardCode = 'host_invalid' | 'host_not_allowed' | 'host_not_found' | 'port_not_allowed';

/**
 * Failure sentences, in the same voice as IMAP_VALIDATION_MESSAGES: one
 * paragraph that names what happened and what to do about it. The dashboard
 * leads with a localised headline keyed off `error_code` and folds this in
 * behind "What to check"; an unknown code falls back to its generic headline,
 * so these codes degrade gracefully on a client that has not shipped a string
 * for them yet.
 *
 * `host_invalid` deliberately keeps the exact sentence the route used before,
 * so the common typo case reads identically to what shipped.
 */
export const HOST_GUARD_MESSAGES: Record<HostGuardCode, string> = {
  host_invalid: 'A valid IMAP and SMTP host is required.',
  // Says nothing about WHICH range matched, and nothing about whether anything
  // was listening. That is the whole point: a message that distinguished
  // "blocked private address" from "blocked loopback" would hand back a slice
  // of the internal map this guard exists to withhold.
  host_not_allowed:
    'That mail host resolves to an address on a private or internal network, which this service will not connect to. Enter the public mail host your provider published.',
  host_not_found:
    'That server name does not exist. Check it for a typo: it is the mail host from your provider, which is often different from your website address.',
  port_not_allowed:
    'Mail servers are reached on their standard ports: 143 or 993 for IMAP, and 25, 465 or 587 for SMTP. Enter one of those under Advanced settings.',
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
 * of `dns.promises.lookup(host, { all: true })`.
 */
export type HostLookup = (hostname: string) => Promise<{ address: string; family: number }[]>;

const defaultLookup: HostLookup = async (hostname) => {
  // `lookup`, not `resolve4`/`resolve6`: lookup is what net.connect and
  // tls.connect call internally, so it is the only resolver whose answers match
  // what an unguarded connect would have reached — including /etc/hosts and any
  // platform search domain, both of which a `resolve*` check would miss.
  const result = await dns.lookup(hostname, { all: true, verbatim: true });
  return result.map((entry) => ({ address: entry.address, family: entry.family }));
};

/**
 * One label may be 63 characters, the whole name 253, and only letters, digits
 * and hyphens are legal (an IDN arrives as its `xn--` punycode form). Rejecting
 * everything else also rejects the smuggling characters — `@`, `:`, `/`, `\`,
 * whitespace, NUL — that turn a host field into a URL.
 */
function isValidDnsName(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  const labels = host.split('.');
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
  let host = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  // `127.0.0.1.` is the same destination as `127.0.0.1` to the resolver, and
  // the trailing dot was enough to slip past a check that compared strings.
  while (host.endsWith('.') && host.length > 1) host = host.slice(0, -1);
  return host;
}

export interface MailHostGuardOptions {
  protocol: MailProtocol;
  port: number;
  /** Test seam; defaults to dns.promises.lookup. */
  lookup?: HostLookup;
}

/**
 * The single entry point every route must call before opening a mail socket.
 *
 * Returns the address to dial on success. Callers MUST pass that address
 * through to the connect helper (`pinnedAddress`) rather than passing the name
 * again — see rule 3.
 */
export async function guardMailHost(
  rawHost: unknown,
  options: MailHostGuardOptions
): Promise<HostGuardResult> {
  const deny = (code: HostGuardCode): HostGuardResult => ({ ok: false, code, message: HOST_GUARD_MESSAGES[code] });

  // Port first: it is synchronous and free, and a rejected port should never
  // spend a DNS round trip.
  if (!isAllowedMailPort(options.protocol, options.port)) return deny('port_not_allowed');

  const host = normalizeMailHost(rawHost);
  if (host.length === 0) return deny('host_invalid');

  // An IPv6 literal is checked before IPv4, because the v4 parser would happily
  // read the front of something it should not.
  if (host.indexOf(':') >= 0) {
    const bytes = parseIpv6(host);
    if (bytes === null) return deny('host_invalid');
    if (isBlockedIpv6Bytes(bytes)) return deny('host_not_allowed');
    const formatted = formatIpv6(bytes);
    return { ok: true, host, address: formatted.address, family: formatted.family };
  }

  const literal = parseLooseIpv4(host);
  if (literal !== null) {
    if (isBlockedIpv4Value(literal)) return deny('host_not_allowed');
    // Canonicalised: a user who typed 0x08080808 gets 8.8.8.8 dialled, so what
    // we connect to is never a form we did not fully parse.
    return { ok: true, host, address: formatIpv4(literal), family: 4 };
  }

  if (!isValidDnsName(host)) return deny('host_invalid');

  let resolved: { address: string; family: number }[];
  try {
    resolved = await (options.lookup ?? defaultLookup)(host);
  } catch {
    // ENOTFOUND, EAI_AGAIN, SERVFAIL: no answer is not a security event, and
    // the existing "that server name does not exist" copy is the right advice.
    return deny('host_not_found');
  }
  if (!Array.isArray(resolved) || resolved.length === 0) return deny('host_not_found');

  // EVERY answer must be acceptable, not merely the one we intend to dial. A
  // name that returns a public address alongside 127.0.0.1 is a rebinding setup
  // being staged in a single response, and there is no legitimate mail host
  // that answers that way.
  const approved: { address: string; family: 4 | 6 }[] = [];
  for (const entry of resolved) {
    const address = normalizeMailHost(entry.address);
    if (address.indexOf(':') >= 0) {
      const bytes = parseIpv6(address);
      if (bytes === null || isBlockedIpv6Bytes(bytes)) return deny('host_not_allowed');
      approved.push(formatIpv6(bytes));
    } else {
      const value = parseLooseIpv4(address);
      if (value === null || isBlockedIpv4Value(value)) return deny('host_not_allowed');
      approved.push({ address: formatIpv4(value), family: 4 });
    }
  }

  // Prefer IPv4 when the name has both. Our egress is IPv4, and pinning the
  // AAAA on a dual-stack host would start failing connections that work today.
  const chosen = approved.find((entry) => entry.family === 4) ?? approved[0];
  return { ok: true, host, address: chosen.address, family: chosen.family };
}
