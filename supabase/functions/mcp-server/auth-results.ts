// ---------------------------------------------------------------------------
// auth-results.ts - did the mail really come from the domain in its From line?
//
// A forward that runs without approval could be triggered by a faked sender. The
// no-approval check reads the Authentication-Results header to find out. That
// header is plain text in the message, and anyone can write one into a mail they
// send, so which one to believe is most of the problem.
//
// WHICH HEADER IS TRUSTED. RFC 8601 has the receiving server prepend its own, so
// the one it added sits above anything the sender wrote. We walk the headers from
// the top and stop at the first one that fails either test:
//
//   1. Its authserv-id belongs to the receiving side:
//      Gmail       exactly mx.google.com
//      Outlook     no id (Exchange Online writes none), or a Microsoft host
//      IMAP        the same domain (last two labels) as the IMAP host of the inbox
//                  or as a "by" host in the top two Received lines.
//   2. That exact id has not been seen yet. A receiving server has one id per
//      check; a repeat further down is someone else's text.
//
// Of what remains, the first result for a method wins, so a "pass" lower down can
// not overrule the receiver's "fail". An untrusted header reads as no header.
//
// WHAT THIS DOES NOT CATCH. A receiving server that adds no header at all and does
// not strip one naming its own host, when the sender guesses that host. With
// "Verified senders only" on, that mail needs a forged pass in exactly the right
// form; the daily limit and the receipt are what remain behind this.
//
// Nothing here is stored. The verdict is one word.
// ---------------------------------------------------------------------------

export type SenderVerdict = "verified" | "unverified" | "failed";

export interface AuthMethodResult {
  method: string;
  result: string;
  /** header.d, header.i and header.from, lowercased. */
  props: Record<string, string>;
}

export interface ParsedAuthResults {
  /** Lowercased, or null when the header names no server. */
  authservId: string | null;
  results: AuthMethodResult[];
}

/** Every value of one header in a raw block, unfolded, in message order. */
export function headerValues(raw: string, name: string): string[] {
  const wanted = name.toLowerCase();
  const out: string[] = [];
  let current: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      if (current !== null) current += ` ${line.trim()}`;
      continue;
    }
    if (current !== null) out.push(current);
    current = null;
    const colon = line.indexOf(":");
    if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === wanted) current = line.slice(colon + 1).trim();
  }
  if (current !== null) out.push(current);
  return out;
}

/** Comments out, quotes kept: `dkim=pass (2048-bit; good) header.d=a.example`. */
function stripComments(value: string): string {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quoted) {
      out += ch;
      if (ch === "\\" && i + 1 < value.length) out += value[++i];
      else if (ch === '"') quoted = false;
      continue;
    }
    if (depth > 0) {
      if (ch === "\\") i++;
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
      continue;
    }
    if (ch === "(") depth = 1;
    else {
      if (ch === '"') quoted = true;
      out += ch;
    }
  }
  return out;
}

function splitOutsideQuotes(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quoted && ch === "\\" && i + 1 < value.length) {
      current += ch + value[++i];
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (ch === separator && !quoted) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts;
}

const METHOD_RE = /^([a-z0-9_-]+)(?:\/[0-9]+)?\s*=\s*([a-z]+)\b/i;

export function parseAuthenticationResults(value: string): ParsedAuthResults {
  const clean = stripComments(value.replace(/\r?\n[ \t]*/g, " "));
  const segments = splitOutsideQuotes(clean, ";").map((segment) => segment.trim()).filter(Boolean);
  let authservId: string | null = null;
  if (segments.length > 0 && !METHOD_RE.test(segments[0])) {
    // "mx.example.com" or "mx.example.com 1".
    const id = segments.shift()!.split(/\s+/)[0].toLowerCase();
    authservId = id.length > 0 ? id : null;
  }
  const results: AuthMethodResult[] = [];
  for (const segment of segments) {
    const match = METHOD_RE.exec(segment);
    if (!match) continue;
    const props: Record<string, string> = {};
    for (const token of segment.slice(match[0].length).trim().split(/\s+/)) {
      const eq = token.indexOf("=");
      if (eq <= 0) continue;
      const key = token.slice(0, eq).toLowerCase();
      if (key === "header.d" || key === "header.i" || key === "header.from") {
        props[key] = token.slice(eq + 1).replace(/^"|"$/g, "").toLowerCase();
      }
    }
    results.push({ method: match[1].toLowerCase(), result: match[2].toLowerCase(), props });
  }
  return { authservId, results };
}

/** Last two labels. Good enough to say two hosts belong to one receiving service. */
function serviceDomain(host: string): string {
  return host.toLowerCase().replace(/\.$/, "").split(".").slice(-2).join(".");
}

/** The host after "by" in a Received line. */
export function receivedByHost(received: string): string | null {
  const match = /\bby\s+([a-z0-9.-]+\.[a-z]{2,})/i.exec(stripComments(received.replace(/\r?\n[ \t]*/g, " ")));
  return match ? match[1].toLowerCase() : null;
}

export interface ReceivingSide {
  provider: "gmail" | "outlook" | "imap";
  /** The inbox's IMAP host, when it has one. */
  imapHost?: string | null;
}

function trustedAuthserv(id: string | null, side: ReceivingSide, received: readonly string[]): boolean {
  if (side.provider === "gmail") return id === "mx.google.com";
  if (side.provider === "outlook") {
    if (id === null) return true;
    return /(^|\.)(outlook\.com|microsoft\.com|office365\.com)$/.test(id);
  }
  if (id === null) return false;
  const service = serviceDomain(id);
  if (side.imapHost && serviceDomain(side.imapHost) === service) return true;
  return received.slice(0, 2).some((line) => {
    const by = receivedByHost(line);
    return by !== null && serviceDomain(by) === service;
  });
}

/** Headers in message order, top first. An untrusted one reads as no header. */
export function trustedAuthResults(
  authResults: readonly string[],
  received: readonly string[],
  side: ReceivingSide,
): AuthMethodResult[] {
  const seenIds = new Set<string>();
  const seenMethods = new Set<string>();
  const out: AuthMethodResult[] = [];
  for (const header of authResults) {
    const parsed = parseAuthenticationResults(header);
    const key = parsed.authservId ?? "";
    if (!trustedAuthserv(parsed.authservId, side, received) || seenIds.has(key)) break;
    seenIds.add(key);
    const methodsHere = new Set<string>();
    for (const result of parsed.results) {
      if (seenMethods.has(result.method)) continue;
      methodsHere.add(result.method);
      out.push(result);
    }
    for (const method of methodsHere) seenMethods.add(method);
  }
  return out;
}

/** The two domains are one sender under relaxed alignment. */
function aligned(a: string, b: string): boolean {
  const x = a.split("@").pop() ?? "";
  const y = b.split("@").pop() ?? "";
  return x.length > 0 && y.length > 0 && (x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`));
}

const DKIM_FAILURES = new Set(["fail", "permerror"]);

/**
 * failed      dmarc failed, or dkim failed and passed for nothing, for this domain
 * verified    dmarc passed, or dkim passed for this domain
 * unverified  anything else, a missing header among them
 *
 * A signature from another domain (a mailing service's own) says nothing about the
 * sender, whichever way it went. SPF is left out: it speaks for the envelope, not
 * for the address a rule filters on.
 */
export function senderVerdict(results: readonly AuthMethodResult[], senderAddress: string): SenderVerdict {
  const domain = senderAddress.trim().toLowerCase().split("@").pop() ?? "";
  if (!domain || !senderAddress.includes("@")) return "unverified";
  const forSender = (r: AuthMethodResult, ...keys: string[]) =>
    keys.map((key) => r.props[key]).filter(Boolean).some((value) => aligned(value, domain));
  // A dmarc result is about the From domain. header.from only has to agree when present.
  const dmarc = results.filter((r) => r.method === "dmarc" && (!r.props["header.from"] || forSender(r, "header.from")));
  if (dmarc.some((r) => r.result === "fail")) return "failed";
  if (dmarc.some((r) => r.result === "pass")) return "verified";
  const dkim = results.filter((r) => r.method === "dkim" && forSender(r, "header.d", "header.i"));
  if (dkim.some((r) => r.result === "pass")) return "verified";
  if (dkim.some((r) => DKIM_FAILURES.has(r.result))) return "failed";
  return "unverified";
}
