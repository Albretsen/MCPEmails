// ---------------------------------------------------------------------------
// list-unsubscribe.ts: reading List-Unsubscribe headers and deciding, per
// sender, which unsubscribe method is safe to run (subscription cleanup).
//
// Pure: no I/O, no clock, no provider calls. The header values come from
// subscription-scan.ts, which fetches them per provider; the decision made
// here is what the cleanup tool acts on, so every rule is unit tested in
// list-unsubscribe.test.ts.
//
// ── The method ladder ───────────────────────────────────────────────────────
//   one_click  an https URI, `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
//              (RFC 8058), a DKIM signature whose h= covers BOTH list headers
//              and whose d= passes aligned with the From domain, and a sender
//              that is otherwise safe. Only this rung lets the server send a
//              request on the user's behalf, which is why it asks the most.
//   mailto     a mailto URI: the cleanup tool writes a draft, never sends.
//   link       an https URI without (or failing the checks for) one-click: the
//              link is handed to the user, never fetched by the server.
//   none       nothing usable in the header.
//
// `safe` is separate from `method`: it says whether the sender is trusted
// enough to act on at all (not in Junk, DKIM pass aligned with From, one sender
// domain behind a list id). An unsafe sender keeps its method so a caller can
// explain what was there, and the caller decides (skip or filter).
//
// ── Authentication-Results: only the topmost one counts ─────────────────────
// Anyone can write an Authentication-Results header into a message they send.
// Receiving servers prepend theirs, so the FIRST instance is the one the
// user's own provider wrote, and later instances are whatever the message
// arrived carrying. Reading only the first keeps a forged "dkim=pass" further
// down from making a sender look safe. A message whose provider wrote none
// (some small IMAP hosts) is simply not safe, which costs a fallback to the
// draft or link rung, never an unwanted request.
// ---------------------------------------------------------------------------

import { decodeEncodedWords } from "./mime.ts";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ParsedMailto {
  /** The first recipient of the mailto URI, percent-decoded. */
  address: string;
  subject?: string;
  body?: string;
  /** The URI exactly as it appeared between the angle brackets (whitespace removed). */
  raw: string;
}

export interface ParsedListUnsubscribe {
  https: string[];
  mailto: ParsedMailto[];
  /** Everything else, http: and unknown schemes included. Never acted on. */
  other: string[];
}

/**
 * One scanned message, as the provider layer hands it over.
 *
 * Header values are the raw (unfolded or folded) field values without the
 * field name. `listId` is the normalized id (see {@link normalizeListId}).
 * `fromName` is already RFC 2047 decoded by the provider layer where it
 * could be; {@link groupSenders} decodes again when it still looks encoded.
 */
export interface ListHeaderRecord {
  messageId: string;
  folder: string;
  fromAddress: string;
  fromName: string;
  listId: string | null;
  listUnsubscribe: string | null;
  listUnsubscribePost: string | null;
  dkimSignatures: string[];
  authResults: string[];
  seen: boolean;
  receivedAt: string;
  inJunk: boolean;
  /**
   * Outlook only: true when this record's `listId` was copied from the
   * newest message of the same From address rather than read from this
   * message (Graph headers are fetched for one message per sender; see
   * subscription-scan.ts). No other header field is ever copied.
   */
  headersInferred?: boolean;
}

export type UnsubscribeMethod = "one_click" | "mailto" | "link" | "none";

export type UnsafeReason = "in_junk" | "dkim_not_aligned" | "mixed_sender_domains";

export interface SenderCandidate {
  senderKey: string;
  displayName: string;
  fromAddress: string;
  domain: string;
  listId: string | null;
  messageCount: number;
  unreadCount: number;
  readShare: number;
  lastReceivedAt: string;
  method: UnsubscribeMethod;
  safe: boolean;
  unsafeReason?: UnsafeReason;
  httpsUrl?: string;
  mailto?: ParsedMailto;
  suggested: boolean;
  /** Up to {@link SAMPLE_MESSAGE_IDS} message ids, newest first. */
  sampleMessageIds: string[];
  /**
   * Every message id of the group, newest first. An addition to the Phase 1
   * contract: the backlog step (archive what is already there) needs the
   * full set, and it is server-held, never shown to the model.
   */
  messageIds: string[];
}

// ── RFC 2369 List-Unsubscribe ───────────────────────────────────────────────

/** Unfold a header value (CRLF + WSP is a fold, RFC 5322 2.2.3). */
function unfold(value: string): string {
  return value.replace(/\r?\n(?=[ \t])/g, "");
}

/**
 * Remove RFC 5322 comments (nested, with quoted-pair escapes) that sit OUTSIDE
 * angle brackets. Parentheses inside a URI are part of the URI.
 */
function stripCommentsOutsideBrackets(value: string): string {
  let out = "";
  let depth = 0;
  let inBracket = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (depth > 0) {
      if (ch === "\\") i++;
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
      continue;
    }
    if (inBracket) {
      if (ch === ">") inBracket = false;
      out += ch;
      continue;
    }
    if (ch === "(") {
      depth = 1;
      out += " ";
      continue;
    }
    if (ch === "<") inBracket = true;
    out += ch;
  }
  return out;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// deno-lint-ignore no-control-regex
const CONTROLS = /[\x00-\x1F\x7F]/;

/**
 * A mailto URI (RFC 6068) as a {@link ParsedMailto}, or null when it names no
 * usable address. `+` is a literal plus in mailto, not a space.
 */
export function parseMailto(raw: string): ParsedMailto | null {
  if (!/^mailto:/i.test(raw)) return null;
  const rest = raw.slice("mailto:".length);
  const q = rest.indexOf("?");
  const toPart = q === -1 ? rest : rest.slice(0, q);
  const query = q === -1 ? "" : rest.slice(q + 1);
  const recipients: string[] = toPart ? safeDecode(toPart).split(",") : [];
  let subject: string | undefined;
  let body: string | undefined;
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const name = safeDecode(eq === -1 ? pair : pair.slice(0, eq)).toLowerCase();
    const value = safeDecode(eq === -1 ? "" : pair.slice(eq + 1));
    if (name === "subject" && subject === undefined) subject = value;
    else if (name === "body" && body === undefined) body = value;
    else if (name === "to") recipients.push(...value.split(","));
  }
  const address = recipients.map((r) => r.trim()).find((r) => r.length > 0) ?? "";
  // One mailbox, nothing that could break a header or an SMTP line.
  if (!/^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(address) || CONTROLS.test(address)) return null;
  const out: ParsedMailto = { address, raw };
  // A subject is one header line: control characters become spaces. A body
  // may legitimately carry line breaks, so it is kept as written.
  // deno-lint-ignore no-control-regex
  if (subject !== undefined) out.subject = subject.replace(/[\x00-\x1F\x7F]+/g, " ").trim();
  if (body !== undefined) out.body = body;
  return out;
}

/** True for an absolute https URI with a host and no userinfo. */
function isUsableHttps(uri: string): boolean {
  if (!/^https:\/\//i.test(uri)) return false;
  try {
    const url = new URL(uri);
    return url.protocol === "https:" && url.hostname.length > 0 && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

/**
 * Parse a List-Unsubscribe field value (RFC 2369).
 *
 *   * Each URI is in angle brackets; items are comma separated; whitespace
 *     inside the brackets is ignored (folded long URIs).
 *   * Comments outside the brackets are ignored.
 *   * A field that does not start with "<" is ignored entirely, and parsing
 *     stops at the first item that is not bracketed (RFC 2369 section 2).
 *   * Schemes are case-insensitive. Only https and mailto are classified;
 *     http, javascript, file and anything else go to `other`.
 */
export function parseListUnsubscribe(value: string | null | undefined): ParsedListUnsubscribe {
  const out: ParsedListUnsubscribe = { https: [], mailto: [], other: [] };
  if (!value) return out;
  const s = stripCommentsOutsideBrackets(unfold(value));
  let i = 0;
  const skipWs = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  skipWs();
  if (s[i] !== "<") return out;
  while (i < s.length) {
    skipWs();
    if (s[i] !== "<") break;
    const close = s.indexOf(">", i + 1);
    if (close === -1) break;
    const uri = s.slice(i + 1, close).replace(/\s+/g, "");
    i = close + 1;
    if (uri) {
      if (/^https:/i.test(uri)) {
        if (isUsableHttps(uri)) out.https.push(uri);
        else out.other.push(uri);
      } else if (/^mailto:/i.test(uri)) {
        const parsed = parseMailto(uri);
        if (parsed) out.mailto.push(parsed);
        else out.other.push(uri);
      } else {
        out.other.push(uri);
      }
    }
    skipWs();
    if (s[i] !== ",") break;
    i++;
  }
  return out;
}

// ── RFC 8058 one-click ──────────────────────────────────────────────────────

/** True only for `List-Unsubscribe=One-Click` (case and whitespace tolerant). */
export function isOneClick(postHeader: string | null | undefined): boolean {
  if (!postHeader) return false;
  return /^\s*list-unsubscribe\s*=\s*one-click\s*$/i.test(unfold(postHeader));
}

// ── DKIM ────────────────────────────────────────────────────────────────────

/** The tag=value pairs of one DKIM-Signature value, FWS removed from values. */
export function parseDkimTags(signature: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const part of unfold(signature).split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).replace(/\s+/g, "");
    if (name && !tags.has(name)) tags.set(name, value);
  }
  return tags;
}

function cleanDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

/** Every distinct d= domain across the signatures, lowercased. */
export function dkimSigningDomains(dkimSignatureHeaders: string[]): string[] {
  const out = new Set<string>();
  for (const sig of dkimSignatureHeaders) {
    const d = parseDkimTags(sig).get("d");
    if (d) out.add(cleanDomain(d));
  }
  return [...out];
}

/**
 * Does any signature's h= list cover both List-Unsubscribe and
 * List-Unsubscribe-Post (RFC 8058 section 4)? `domains` are the d= domains of
 * the signatures that do, so a caller can check that one of THOSE passed,
 * rather than some other signature on the same message.
 */
export function dkimCoversListHeaders(dkimSignatureHeaders: string[]): { covered: boolean; domains: string[] } {
  const domains = new Set<string>();
  for (const sig of dkimSignatureHeaders) {
    const tags = parseDkimTags(sig);
    const h = (tags.get("h") ?? "").split(":").map((n) => n.trim().toLowerCase());
    const d = tags.get("d");
    if (d && h.includes("list-unsubscribe") && h.includes("list-unsubscribe-post")) domains.add(cleanDomain(d));
  }
  return { covered: domains.size > 0, domains: [...domains] };
}

// Second-level labels under a two-letter country code that act as a public
// suffix (co.uk, com.au, ne.jp, ...). A heuristic, deliberately small: getting
// it wrong in the strict direction only makes a sender not aligned.
const COUNTRY_SECOND_LEVEL = new Set(["co", "com", "net", "org", "ac", "gov", "edu", "ne", "or", "go", "gob", "nic"]);

/** The organizational domain of a host name (relaxed alignment, RFC 7489 3.2). */
export function organizationalDomain(domain: string): string {
  const labels = cleanDomain(domain).split(".").filter((l) => l.length > 0);
  if (labels.length <= 2) return labels.join(".");
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  const keep = tld.length === 2 && COUNTRY_SECOND_LEVEL.has(sld) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

/** Relaxed alignment: both names share an organizational domain. */
export function domainsAligned(a: string, b: string): boolean {
  if (!a || !b) return false;
  const oa = organizationalDomain(a);
  return oa.includes(".") && oa === organizationalDomain(b);
}

/** RFC 5322 comments removed (used on Authentication-Results). */
function stripComments(value: string): string {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quoted) {
      out += ch;
      if (ch === "\\") out += value[++i] ?? "";
      else if (ch === '"') quoted = false;
      continue;
    }
    if (depth > 0) {
      if (ch === "\\") i++;
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
      continue;
    }
    if (ch === "(") {
      depth = 1;
      out += " ";
    } else {
      if (ch === '"') quoted = true;
      out += ch;
    }
  }
  return out;
}

/** The domains of every `dkim=pass` result in one Authentication-Results value. */
export function dkimPassDomains(authResult: string): string[] {
  const out: string[] = [];
  const parts = stripComments(unfold(authResult)).split(";");
  // parts[0] is the authserv-id (and version); results follow.
  for (const part of parts.slice(1)) {
    const m = /^\s*dkim\s*=\s*([a-z]+)/i.exec(part);
    if (!m || m[1].toLowerCase() !== "pass") continue;
    const d = /\bheader\.d\s*=\s*"?([^\s";]+)"?/i.exec(part)?.[1];
    const i = /\bheader\.i\s*=\s*"?([^\s";]+)"?/i.exec(part)?.[1];
    const domain = d ?? (i ? i.slice(i.lastIndexOf("@") + 1) : "");
    if (domain) out.push(cleanDomain(domain));
  }
  return out;
}

/**
 * Did DKIM pass for a domain aligned (relaxed) with `fromDomain`, according to
 * the topmost Authentication-Results header (see the file header for why only
 * that one)? When `signingDomains` is non-empty the passing domain must also be
 * one of them, so "the signature covering the list headers passed" can be
 * asked by passing `dkimCoversListHeaders(...).domains`.
 */
export function dkimPassAligned(authResults: string[], fromDomain: string, signingDomains: string[]): boolean {
  const top = authResults[0];
  if (!top || !fromDomain) return false;
  const allowed = new Set(signingDomains.map(cleanDomain));
  return dkimPassDomains(top).some((d) =>
    domainsAligned(d, fromDomain) && (allowed.size === 0 || allowed.has(d))
  );
}

// ── Grouping and classification ─────────────────────────────────────────────

/** How many sample ids a candidate carries. */
export const SAMPLE_MESSAGE_IDS = 5;

/** Suggest only senders with at least this many messages in the window. */
export const SUGGEST_MIN_MESSAGES = 3;

/** Suggest only senders the user reads less than this share of. */
export const SUGGEST_MAX_READ_SHARE = 0.2;

/**
 * List-Id (RFC 2919) normalized for grouping: the bracketed id, lowercased, or
 * the whole trimmed value when there are no brackets. Idempotent.
 */
export function normalizeListId(value: string | null | undefined): string | null {
  if (!value) return null;
  const unfolded = unfold(value);
  const bracketed = /<([^<>]+)>/.exec(unfolded)?.[1];
  const id = (bracketed ?? stripComments(unfolded)).replace(/\s+/g, "").toLowerCase();
  return id.length > 0 ? id : null;
}

/** `list:<listId>` when the message has one, else `from:<lowercased address>`. */
export function senderKeyOf(record: Pick<ListHeaderRecord, "listId" | "fromAddress">): string {
  const listId = normalizeListId(record.listId);
  return listId ? `list:${listId}` : `from:${record.fromAddress.trim().toLowerCase()}`;
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "" : cleanDomain(address.slice(at + 1));
}

// Words that mark mail people need to keep receiving: banks, bills, receipts,
// security notices, account mail. Matched as token PREFIXES on the display
// name, the address and the list id ("invoices", "accountservices",
// "bankofexample" all match), so it errs towards NOT suggesting. It only
// removes the pre-tick; the sender is still listed and the user can pick it.
const KEEP_RECEIVING_WORDS = [
  "bank",
  "invoice",
  "billing",
  "receipt",
  "payment",
  "security",
  "account",
  "statement",
  "tax",
  "password",
  "verification",
];

/** True when the sender looks like billing, banking or account mail. */
export function looksLikeKeepReceiving(...values: Array<string | null | undefined>): boolean {
  for (const value of values) {
    if (!value) continue;
    for (const token of value.toLowerCase().split(/[^a-z0-9]+/)) {
      if (token && KEEP_RECEIVING_WORDS.some((w) => token.startsWith(w))) return true;
    }
  }
  return false;
}

function cleanDisplayName(name: string): string {
  const decoded = /=\?[^?]+\?[bq]\?/i.test(name) ? decodeEncodedWords(name) : name;
  // deno-lint-ignore no-control-regex
  return decoded.replace(/[\x00-\x1F\x7F]+/g, " ").replace(/\s+/g, " ").trim();
}

function byNewest(a: ListHeaderRecord, b: ListHeaderRecord): number {
  const ta = Date.parse(a.receivedAt);
  const tb = Date.parse(b.receivedAt);
  return (Number.isFinite(tb) ? tb : -Infinity) - (Number.isFinite(ta) ? ta : -Infinity);
}

/**
 * Decide one sender's method and safety from the records of one group (all
 * records must share a sender key; {@link groupSenders} guarantees it).
 *
 * The headers are read from ONE representative message: the newest one that
 * carries a List-Unsubscribe header and is not in Junk, else the newest one
 * with a header at all, else the newest message. Mixing headers from several
 * messages would let one message's URL ride on another message's signature.
 */
export function classifySender(records: ListHeaderRecord[]): SenderCandidate {
  if (records.length === 0) throw new Error("classifySender: no records");
  const sorted = records.slice().sort(byNewest);
  const newest = sorted[0];
  const withHeader = sorted.filter((r) => r.listUnsubscribe && r.listUnsubscribe.trim());
  const rep = withHeader.find((r) => !r.inJunk) ?? withHeader[0] ?? newest;

  const fromAddress = rep.fromAddress.trim();
  const domain = domainOf(fromAddress);
  const listId = normalizeListId(rep.listId);
  const senderKey = senderKeyOf(rep);

  const uris = parseListUnsubscribe(rep.listUnsubscribe);
  const signingDomains = dkimSigningDomains(rep.dkimSignatures);
  const aligned = dkimPassAligned(rep.authResults, domain, signingDomains);
  // A list id shared by senders of different organizations is not one sender:
  // a forged List-Id must not borrow a real list's name and history.
  const orgs = new Set(records.map((r) => organizationalDomain(domainOf(r.fromAddress))).filter((d) => d));
  const mixed = listId !== null && orgs.size > 1;

  let unsafeReason: UnsafeReason | undefined;
  if (rep.inJunk) unsafeReason = "in_junk";
  else if (mixed) unsafeReason = "mixed_sender_domains";
  else if (!aligned) unsafeReason = "dkim_not_aligned";
  const safe = unsafeReason === undefined;

  const cover = dkimCoversListHeaders(rep.dkimSignatures);
  const oneClick = safe && uris.https.length > 0 && isOneClick(rep.listUnsubscribePost) && cover.covered &&
    dkimPassAligned(rep.authResults, domain, cover.domains);

  const method: UnsubscribeMethod = oneClick
    ? "one_click"
    : uris.mailto.length > 0
    ? "mailto"
    : uris.https.length > 0
    ? "link"
    : "none";

  const messageCount = records.length;
  const unreadCount = records.filter((r) => !r.seen).length;
  const readShare = messageCount === 0 ? 0 : (messageCount - unreadCount) / messageCount;
  const displayName = cleanDisplayName(sorted.find((r) => r.fromName.trim())?.fromName ?? "") || fromAddress;

  const suggested = messageCount >= SUGGEST_MIN_MESSAGES && readShare < SUGGEST_MAX_READ_SHARE &&
    method !== "none" && safe &&
    // Every name and address the group used, not just the newest: a bank that
    // once wrote "Example Bank Alerts" is still a bank.
    !looksLikeKeepReceiving(
      displayName,
      listId,
      ...new Set(records.flatMap((r) => [cleanDisplayName(r.fromName), r.fromAddress])),
    );

  const messageIds = sorted.map((r) => r.messageId);
  const candidate: SenderCandidate = {
    senderKey,
    displayName,
    fromAddress,
    domain,
    listId,
    messageCount,
    unreadCount,
    readShare,
    lastReceivedAt: newest.receivedAt,
    method,
    safe,
    suggested,
    sampleMessageIds: messageIds.slice(0, SAMPLE_MESSAGE_IDS),
    messageIds,
  };
  if (unsafeReason) candidate.unsafeReason = unsafeReason;
  if (uris.https.length > 0) candidate.httpsUrl = uris.https[0];
  if (uris.mailto.length > 0) candidate.mailto = uris.mailto[0];
  return candidate;
}

/**
 * Group scanned records by sender key and classify each group, most messages
 * first (ties: most recent first). Records without a From address are
 * dropped: there is nobody to unsubscribe from.
 */
export function groupSenders(records: ListHeaderRecord[], opts: { maxSenders?: number } = {}): SenderCandidate[] {
  const groups = new Map<string, ListHeaderRecord[]>();
  for (const record of records) {
    if (!record.fromAddress || !record.fromAddress.includes("@")) continue;
    const key = senderKeyOf(record);
    const group = groups.get(key);
    if (group) group.push(record);
    else groups.set(key, [record]);
  }
  const out = [...groups.values()].map(classifySender);
  out.sort((a, b) => {
    if (b.messageCount !== a.messageCount) return b.messageCount - a.messageCount;
    const ta = Date.parse(a.lastReceivedAt);
    const tb = Date.parse(b.lastReceivedAt);
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });
  return opts.maxSenders !== undefined ? out.slice(0, Math.max(0, opts.maxSenders)) : out;
}
