// ---------------------------------------------------------------------------
// list-unsubscribe.ts: header grammar, one-click detection, DKIM coverage and
// alignment, grouping and the method ladder.
//
// No real mailbox data: every address is under example.com / example.org /
// example.co.uk.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  type AuthservTrust,
  authservIdTrusted,
  authservTrustFor,
  classifySender as classifyWithTrust,
  dkimCoversListHeaders,
  dkimPassAligned as dkimPassAlignedWithTrust,
  dkimPassDomains,
  dkimSigningDomains,
  domainsAligned,
  groupSenders as groupWithTrust,
  isOneClick,
  type ListHeaderRecord,
  looksLikeKeepReceiving,
  normalizeListId,
  organizationalDomain,
  parseListUnsubscribe,
  parseMailto,
  SENDER_KEY_MAX,
  senderKeyOf,
  trustedAuthResults,
} from "./list-unsubscribe.ts";

// The fixtures' Authentication-Results are written by mx.example.net, the
// "user's provider" in these tests. The pinning itself is tested below.
const TRUST: AuthservTrust = { ids: ["mx.example.net"] };
const classifySender = (records: ListHeaderRecord[]) => classifyWithTrust(records, TRUST);
const groupSenders = (records: ListHeaderRecord[], opts: { maxSenders?: number } = {}) =>
  groupWithTrust(records, { ...opts, trust: TRUST });
const dkimPassAligned = (authResults: string[], fromDomain: string, signingDomains: string[]) =>
  dkimPassAlignedWithTrust(authResults, fromDomain, signingDomains, TRUST);

// ── parseListUnsubscribe ────────────────────────────────────────────────────

Deno.test("parseListUnsubscribe: empty, null and undefined give nothing", () => {
  for (const v of [null, undefined, "", "   "]) {
    assertEquals(parseListUnsubscribe(v), { https: [], mailto: [], other: [] });
  }
});

Deno.test("parseListUnsubscribe: one https and one mailto, either order", () => {
  const a = parseListUnsubscribe("<https://example.com/u/1>, <mailto:unsub@example.com>");
  assertEquals(a.https, ["https://example.com/u/1"]);
  assertEquals(a.mailto.map((m) => m.address), ["unsub@example.com"]);
  const b = parseListUnsubscribe("<mailto:unsub@example.com>,<https://example.com/u/1>");
  assertEquals(b.https, ["https://example.com/u/1"]);
  assertEquals(b.mailto.length, 1);
});

Deno.test("parseListUnsubscribe: comments outside brackets are ignored", () => {
  const r = parseListUnsubscribe(
    "(Use this) <mailto:list@example.com?subject=unsubscribe> (or (nested) this), <https://example.com/x>",
  );
  assertEquals(r.mailto[0].address, "list@example.com");
  assertEquals(r.mailto[0].subject, "unsubscribe");
  assertEquals(r.https, ["https://example.com/x"]);
});

Deno.test("parseListUnsubscribe: parentheses inside a URI are kept", () => {
  const r = parseListUnsubscribe("<https://example.com/u/(abc)>");
  assertEquals(r.https, ["https://example.com/u/(abc)"]);
});

Deno.test("parseListUnsubscribe: folded value and whitespace inside brackets", () => {
  const r = parseListUnsubscribe("<https://example.com/unsubscribe?\r\n id=1234\r\n &t=abc>,\r\n <mailto:u@example.com>");
  assertEquals(r.https, ["https://example.com/unsubscribe?id=1234&t=abc"]);
  assertEquals(r.mailto[0].address, "u@example.com");
});

Deno.test("parseListUnsubscribe: many URIs keep their order", () => {
  const r = parseListUnsubscribe("<https://a.example.com/1>, <https://b.example.com/2>, <mailto:a@example.com>, <mailto:b@example.com>");
  assertEquals(r.https, ["https://a.example.com/1", "https://b.example.com/2"]);
  assertEquals(r.mailto.map((m) => m.address), ["a@example.com", "b@example.com"]);
});

Deno.test("parseListUnsubscribe: a field not starting with '<' is ignored", () => {
  assertEquals(parseListUnsubscribe("https://example.com/u, <mailto:u@example.com>"), {
    https: [],
    mailto: [],
    other: [],
  });
  assertEquals(parseListUnsubscribe("mailto:u@example.com").mailto.length, 0);
});

Deno.test("parseListUnsubscribe: parsing stops at the first non-bracketed item", () => {
  const r = parseListUnsubscribe("<https://example.com/a>, https://example.com/b, <mailto:u@example.com>");
  assertEquals(r.https, ["https://example.com/a"]);
  assertEquals(r.mailto, []);
});

Deno.test("parseListUnsubscribe: an unterminated bracket stops parsing", () => {
  const r = parseListUnsubscribe("<https://example.com/a>, <https://example.com/b");
  assertEquals(r.https, ["https://example.com/a"]);
});

Deno.test("parseListUnsubscribe: uppercase schemes are recognized", () => {
  const r = parseListUnsubscribe("<HTTPS://EXAMPLE.COM/U>, <MAILTO:U@EXAMPLE.COM>");
  assertEquals(r.https, ["HTTPS://EXAMPLE.COM/U"]);
  assertEquals(r.mailto[0].address, "U@EXAMPLE.COM");
});

Deno.test("parseListUnsubscribe: http, javascript, file and junk go to other", () => {
  const r = parseListUnsubscribe(
    "<http://example.com/u>, <javascript:alert(1)>, <file:///etc/passwd>, <ftp://example.com/x>, <https://>, <https://user:pw@example.com/u>",
  );
  assertEquals(r.https, []);
  assertEquals(r.mailto, []);
  assertEquals(r.other, [
    "http://example.com/u",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "ftp://example.com/x",
    "https://",
    "https://user:pw@example.com/u",
  ]);
});

Deno.test("parseListUnsubscribe: empty brackets are skipped, parsing continues", () => {
  const r = parseListUnsubscribe("<>, <https://example.com/u>");
  assertEquals(r.https, ["https://example.com/u"]);
});

// ── parseMailto ─────────────────────────────────────────────────────────────

Deno.test("parseMailto: subject and body are percent-decoded, + stays a plus", () => {
  const m = parseMailto("mailto:list+unsub@example.com?subject=Please%20remove%20me&body=Remove%0D%0Aplease+now");
  assert(m);
  assertEquals(m.address, "list+unsub@example.com");
  assertEquals(m.subject, "Please remove me");
  assertEquals(m.body, "Remove\r\nplease+now");
  assertEquals(m.raw, "mailto:list+unsub@example.com?subject=Please%20remove%20me&body=Remove%0D%0Aplease+now");
});

Deno.test("parseMailto: control characters in a subject become spaces", () => {
  const m = parseMailto("mailto:u@example.com?subject=a%0D%0ABcc:%20x@example.org");
  assert(m);
  assertEquals(m.subject, "a Bcc: x@example.org");
});

Deno.test("parseMailto: case-insensitive hfield names, first value wins", () => {
  const m = parseMailto("mailto:u@example.com?SUBJECT=one&subject=two&Body=b");
  assert(m);
  assertEquals(m.subject, "one");
  assertEquals(m.body, "b");
});

Deno.test("parseMailto: encoded address and to= hfield", () => {
  assertEquals(parseMailto("mailto:u%40example.com")?.address, "u@example.com");
  assertEquals(parseMailto("mailto:?to=u@example.com&subject=x")?.address, "u@example.com");
  assertEquals(parseMailto("mailto:a@example.com,b@example.com")?.address, "a@example.com");
});

Deno.test("parseMailto: no usable address is null, and goes to other", () => {
  assertEquals(parseMailto("mailto:"), null);
  assertEquals(parseMailto("mailto:?subject=x"), null);
  assertEquals(parseMailto("mailto:not-an-address"), null);
  assertEquals(parseMailto("mailto:a%0D%0A@example.com"), null);
  assertEquals(parseMailto("https://example.com"), null);
  assertEquals(parseListUnsubscribe("<mailto:nobody>").other, ["mailto:nobody"]);
});

Deno.test("parseMailto: a broken percent escape is kept as written", () => {
  const m = parseMailto("mailto:u@example.com?subject=100%");
  assert(m);
  assertEquals(m.subject, "100%");
});

// ── isOneClick ──────────────────────────────────────────────────────────────

Deno.test("isOneClick: exact value, case and whitespace tolerant", () => {
  assert(isOneClick("List-Unsubscribe=One-Click"));
  assert(isOneClick("list-unsubscribe=one-click"));
  assert(isOneClick("  List-Unsubscribe = One-Click  "));
  assert(isOneClick("List-Unsubscribe=\r\n One-Click"));
});

Deno.test("isOneClick: anything else is false", () => {
  for (const v of [null, undefined, "", "One-Click", "List-Unsubscribe=One-Click; x=y", "List-Unsubscribe=OneClick", "List-Unsubscribe=One-Click-Now"]) {
    assertEquals(isOneClick(v), false, String(v));
  }
});

// ── DKIM ────────────────────────────────────────────────────────────────────

const SIG_COVERING = "v=1; a=rsa-sha256; c=relaxed/relaxed; d=news.example.com; s=s1;\r\n" +
  "\th=From:To:Subject:Date:List-Unsubscribe:\r\n\t List-Unsubscribe-Post:Message-ID; bh=abc=; b=def=";
const SIG_PARTIAL = "v=1; a=rsa-sha256; d=example.org; s=s2; h=from:to:list-unsubscribe; bh=x; b=y";

Deno.test("dkimCoversListHeaders: folded h= with spaces and mixed case", () => {
  assertEquals(dkimCoversListHeaders([SIG_COVERING]), { covered: true, domains: ["news.example.com"] });
});

Deno.test("dkimCoversListHeaders: only the covering signatures' domains", () => {
  assertEquals(dkimCoversListHeaders([SIG_PARTIAL, SIG_COVERING]), { covered: true, domains: ["news.example.com"] });
  assertEquals(dkimCoversListHeaders([SIG_PARTIAL]), { covered: false, domains: [] });
  assertEquals(dkimCoversListHeaders([]), { covered: false, domains: [] });
});

Deno.test("dkimCoversListHeaders: upper-case tag names and domain are normalized", () => {
  const sig = "V=1; D=News.Example.COM; H=LIST-UNSUBSCRIBE : LIST-UNSUBSCRIBE-POST; b=x";
  assertEquals(dkimCoversListHeaders([sig]), { covered: true, domains: ["news.example.com"] });
});

Deno.test("dkimSigningDomains: distinct d= values", () => {
  assertEquals(dkimSigningDomains([SIG_COVERING, SIG_PARTIAL, SIG_COVERING, "garbage"]), ["news.example.com", "example.org"]);
});

Deno.test("organizationalDomain and domainsAligned", () => {
  assertEquals(organizationalDomain("mail.news.example.com"), "example.com");
  assertEquals(organizationalDomain("example.com."), "example.com");
  assertEquals(organizationalDomain("news.example.co.uk"), "example.co.uk");
  assertEquals(organizationalDomain("example.co.uk"), "example.co.uk");
  assertEquals(organizationalDomain("mail.example.com.au"), "example.com.au");
  assertEquals(organizationalDomain("a.b.example.de"), "example.de");
  assert(domainsAligned("bounce.example.com", "news.example.com"));
  assert(domainsAligned("EXAMPLE.com", "example.COM"));
  assert(!domainsAligned("example.com", "example.org"));
  assert(!domainsAligned("other.co.uk", "example.co.uk"));
  assert(!domainsAligned("", "example.com"));
  assert(!domainsAligned("com", "com"));
});

const AR_PASS = "mx.example.net;\r\n dkim=pass header.i=@news.example.com header.s=s1 header.b=abc;\r\n" +
  " spf=pass (sender ip is 192.0.2.1) smtp.mailfrom=bounce.example.com; dmarc=pass header.from=example.com";

Deno.test("dkimPassDomains: header.d, header.i, comments and other methods", () => {
  assertEquals(dkimPassDomains(AR_PASS), ["news.example.com"]);
  assertEquals(dkimPassDomains("mx.example.net; dkim=pass (2048-bit key) header.d=Example.com header.s=x"), ["example.com"]);
  assertEquals(dkimPassDomains("mx.example.net; dkim=fail header.d=example.com; dkim=pass header.d=example.org"), ["example.org"]);
  assertEquals(dkimPassDomains("mx.example.net; spf=pass smtp.mailfrom=example.com"), []);
  assertEquals(dkimPassDomains("mx.example.net; DKIM=PASS header.d=example.com"), ["example.com"]);
  // The authserv-id segment is never read as a result.
  assertEquals(dkimPassDomains("dkim=pass header.d=example.com"), []);
});

Deno.test("dkimPassAligned: pass aligned with From, relaxed", () => {
  assert(dkimPassAligned([AR_PASS], "example.com", []));
  assert(dkimPassAligned([AR_PASS], "mail.example.com", ["news.example.com"]));
});

Deno.test("dkimPassAligned: fail cases", () => {
  // Wrong organization.
  assert(!dkimPassAligned([AR_PASS], "example.org", []));
  // Passing domain is not one of the signing domains asked about.
  assert(!dkimPassAligned([AR_PASS], "example.com", ["other.example.com"]));
  // dkim=fail / none.
  assert(!dkimPassAligned(["mx.example.net; dkim=fail header.d=example.com"], "example.com", []));
  assert(!dkimPassAligned(["mx.example.net; dkim=none"], "example.com", []));
  // No headers or no From domain.
  assert(!dkimPassAligned([], "example.com", []));
  assert(!dkimPassAligned([AR_PASS], "", []));
});

Deno.test("dkimPassAligned: only the topmost TRUSTED Authentication-Results counts", () => {
  const real = "mx.example.net; dkim=fail header.d=example.com";
  const forgedSameId = "mx.example.net; dkim=pass header.d=example.com";
  const forgedOtherId = "mx.example.com; dkim=pass header.d=example.com";
  // A forged pass below the provider's own fail is ignored, whatever it names.
  assert(!dkimPassAligned([real, forgedSameId], "example.com", []));
  assert(!dkimPassAligned([real, forgedOtherId], "example.com", []));
  // A forged pass ABOVE it (a provider that wrote none, or a header added on
  // the way) is ignored when its authserv-id is not the trusted one.
  assert(!dkimPassAligned([forgedOtherId, real], "example.com", []));
  // The trusted header is found below untrusted ones.
  assert(dkimPassAligned([forgedOtherId.replace("pass", "fail"), forgedSameId], "example.com", []));
});

Deno.test("dkimPassAligned: no trusted authserv-id means not aligned", () => {
  assert(!dkimPassAlignedWithTrust([AR_PASS], "example.com", [], { ids: [] }));
  assert(!dkimPassAlignedWithTrust([AR_PASS], "example.com", [], { ids: ["mx.example.org"] }));
  assert(dkimPassAlignedWithTrust([AR_PASS], "example.com", [], { ids: ["*.example.net"] }));
});

Deno.test("authserv-id pinning: wildcards, exact ids and Microsoft's id-less header", () => {
  assert(authservIdTrusted("mx.google.com", { ids: ["mx.google.com"] }));
  assert(!authservIdTrusted("mx.google.com.example.org", { ids: ["mx.google.com"] }));
  assert(authservIdTrusted("am6pr01mb1234.eurprd01.prod.outlook.com", { ids: ["*.outlook.com"] }));
  assert(authservIdTrusted("outlook.com", { ids: ["*.outlook.com"] }));
  assert(!authservIdTrusted("evil-outlook.com", { ids: ["*.outlook.com"] }));
  const ms = "spf=pass (sender IP is 192.0.2.1) smtp.mailfrom=example.com; dkim=pass (signature was verified) header.d=example.com";
  const microsoft = authservTrustFor("outlook");
  // Topmost and id-less: Microsoft's own.
  assert(dkimPassAlignedWithTrust([ms], "example.com", [], microsoft));
  // Id-less but not topmost: something the message arrived carrying.
  assertEquals(trustedAuthResults(["mx.example.org; dkim=none", ms], microsoft), null);
  // A provider that does not write id-less headers never trusts one.
  assertEquals(trustedAuthResults([ms], authservTrustFor("gmail")), null);
});

Deno.test("authservTrustFor: per provider, IMAP by host", () => {
  assertEquals(authservTrustFor("gmail").ids.includes("mx.google.com"), true);
  const yahoo = authservTrustFor("imap", "imap.mail.yahoo.com");
  assert(authservIdTrusted("atlas-production.v2.mail.yahoo.com", yahoo));
  assert(!authservIdTrusted("mx.google.com", yahoo));
  const fastmail = authservTrustFor("imap", "imap.fastmail.com");
  assert(authservIdTrusted("mx3.messagingengine.com", fastmail));
  // An unknown host trusts its own organizational domain only.
  const small = authservTrustFor("imap", "mail.example.org");
  assert(authservIdTrusted("mx1.example.org", small));
  assert(!authservIdTrusted("mx.google.com", small));
  assertEquals(authservTrustFor("imap", null).ids, []);
});

// ── Grouping and classification ─────────────────────────────────────────────

let seq = 0;
function rec(over: Partial<ListHeaderRecord> = {}): ListHeaderRecord {
  seq++;
  return {
    messageId: `INBOX:${seq}`,
    folder: "INBOX",
    fromAddress: "news@example.com",
    fromName: "Example News",
    listId: "weekly.example.com",
    listUnsubscribe: "<https://example.com/u/1>, <mailto:unsub@example.com?subject=unsubscribe>",
    listUnsubscribePost: "List-Unsubscribe=One-Click",
    dkimSignatures: [SIG_COVERING],
    authResults: [AR_PASS],
    seen: false,
    receivedAt: new Date(Date.UTC(2026, 9, 1) + seq * 60_000).toISOString(),
    inJunk: false,
    ...over,
  };
}

Deno.test("normalizeListId and senderKeyOf", () => {
  assertEquals(normalizeListId('"Weekly" <Weekly.Example.COM>'), "weekly.example.com");
  assertEquals(normalizeListId("weekly.example.com"), "weekly.example.com");
  assertEquals(normalizeListId(normalizeListId("Weekly <weekly.example.com>")), "weekly.example.com");
  assertEquals(normalizeListId(""), null);
  assertEquals(normalizeListId(null), null);
  assertEquals(senderKeyOf({ listId: "<a.example.com>", fromAddress: "X@Example.com" }), "list:a.example.com");
  assertEquals(senderKeyOf({ listId: null, fromAddress: " X@Example.com " }), "from:x@example.com");
});

Deno.test("classifySender: full one-click ladder rung", () => {
  const c = classifySender([rec(), rec(), rec()]);
  assertEquals(c.method, "one_click");
  assertEquals(c.safe, true);
  assertEquals(c.unsafeReason, undefined);
  assertEquals(c.httpsUrl, "https://example.com/u/1");
  assertEquals(c.mailto?.address, "unsub@example.com");
  assertEquals(c.senderKey, "list:weekly.example.com");
  assertEquals(c.domain, "example.com");
  assertEquals(c.messageCount, 3);
  assertEquals(c.unreadCount, 3);
  assertEquals(c.readShare, 0);
  assertEquals(c.suggested, true);
  assertEquals(c.displayName, "Example News");
});

Deno.test("classifySender: one-click without h= coverage falls to mailto, then link", () => {
  const partial = classifySender([rec({ dkimSignatures: [SIG_PARTIAL, "v=1; d=example.com; h=from:to; b=x"] })]);
  assertEquals(partial.method, "mailto");
  const linkOnly = classifySender([
    rec({ dkimSignatures: ["v=1; d=news.example.com; h=from:to; b=x"], listUnsubscribe: "<https://example.com/u/2>" }),
  ]);
  assertEquals(linkOnly.method, "link");
  assertEquals(linkOnly.safe, true);
  assertEquals(linkOnly.httpsUrl, "https://example.com/u/2");
});

Deno.test("classifySender: covering signature must be the one that passed", () => {
  // The covering signature is by a third party; only example.com's own passed.
  const third = "v=1; d=esp.example.org; h=list-unsubscribe:list-unsubscribe-post; b=x";
  const own = "v=1; d=example.com; h=from:to; b=x";
  const c = classifySender([
    rec({
      dkimSignatures: [third, own],
      authResults: ["mx.example.net; dkim=pass header.d=example.com; dkim=pass header.d=esp.example.org"],
      listUnsubscribe: "<https://example.com/u/3>",
    }),
  ]);
  assertEquals(c.safe, true);
  assertEquals(c.method, "link");
});

Deno.test("classifySender: no Post header is not one-click", () => {
  const c = classifySender([rec({ listUnsubscribePost: null, listUnsubscribe: "<https://example.com/u>" })]);
  assertEquals(c.method, "link");
});

Deno.test("classifySender: mailto-only and none", () => {
  assertEquals(classifySender([rec({ listUnsubscribe: "<mailto:u@example.com>" })]).method, "mailto");
  const none = classifySender([rec({ listUnsubscribe: null, listUnsubscribePost: null })]);
  assertEquals(none.method, "none");
  assertEquals(none.suggested, false);
  assertEquals(none.httpsUrl, undefined);
  assertEquals(none.mailto, undefined);
});

Deno.test("classifySender: junk is unsafe and never one-click", () => {
  const c = classifySender([rec({ inJunk: true, folder: "Junk" }), rec({ inJunk: true, folder: "Junk" }), rec({ inJunk: true, folder: "Junk" })]);
  assertEquals(c.safe, false);
  assertEquals(c.unsafeReason, "in_junk");
  assertEquals(c.method, "mailto");
  assertEquals(c.suggested, false);
});

Deno.test("classifySender: an inbox copy is preferred over a junk copy", () => {
  const inbox = rec();
  const junk = rec({ inJunk: true, folder: "Junk" });
  const c = classifySender([inbox, junk]);
  assertEquals(c.safe, true);
  assertEquals(c.method, "one_click");
  assertEquals(c.lastReceivedAt, junk.receivedAt);
});

Deno.test("classifySender: DKIM not aligned is unsafe", () => {
  const c = classifySender([rec({ authResults: ["mx.example.net; dkim=pass header.d=example.org"] })]);
  assertEquals(c.safe, false);
  assertEquals(c.unsafeReason, "dkim_not_aligned");
  assertEquals(c.method, "mailto");
});

Deno.test("classifySender: no trusted Authentication-Results is auth_unverified, never one-click", () => {
  const none = classifySender([rec({ authResults: [] })]);
  assertEquals(none.unsafeReason, "auth_unverified");
  assertEquals(none.safe, false);
  // A forged pass from an untrusted authserv-id, alone or on top.
  const forged = classifySender([rec({ authResults: ["mx.example.com; dkim=pass header.i=@news.example.com"] })]);
  assertEquals(forged.unsafeReason, "auth_unverified");
  assertEquals(forged.method, "mailto");
  const linkOnly = classifySender([
    rec({ authResults: ["mx.example.com; dkim=pass header.d=example.com"], listUnsubscribe: "<https://example.com/u/9>" }),
  ]);
  assertEquals(linkOnly.method, "link");
  assertEquals(linkOnly.suggested, false);
  // The same record under a trust that names that authserv-id is one-click.
  const trusted = classifyWithTrust([rec({ authResults: ["mx.example.com; dkim=pass header.i=@news.example.com"] })], {
    ids: ["mx.example.com"],
  });
  assertEquals(trusted.method, "one_click");
});

Deno.test("organizationalDomain: shared hosting suffixes are public", () => {
  assertEquals(organizationalDomain("a.github.io"), "a.github.io");
  assertEquals(organizationalDomain("mail.a.github.io"), "a.github.io");
  assert(!domainsAligned("a.github.io", "b.github.io"));
  assert(!domainsAligned("x.netlify.app", "y.netlify.app"));
  assert(!domainsAligned("x.blogspot.com", "y.blogspot.com"));
  assert(domainsAligned("mail.a.vercel.app", "a.vercel.app"));
  // Substack newsletters come From the bare domain, signed by a subdomain.
  assert(domainsAligned("substack.com", "mg.substack.com"));
});

Deno.test("classifySender: two shared-hosting tenants under one list id are mixed", () => {
  const c = classifySender([
    rec({ fromAddress: "news@a.github.io", authResults: ["mx.example.net; dkim=pass header.d=a.github.io"] }),
    rec({ fromAddress: "news@b.github.io", authResults: ["mx.example.net; dkim=pass header.d=b.github.io"] }),
  ]);
  assertEquals(c.unsafeReason, "mixed_sender_domains");
});

Deno.test("classifySender: a list id shared across organizations is unsafe", () => {
  const c = classifySender([rec(), rec({ fromAddress: "news@example.org" })]);
  assertEquals(c.safe, false);
  assertEquals(c.unsafeReason, "mixed_sender_domains");
  // Subdomains of one organization are fine.
  const ok = classifySender([rec(), rec({ fromAddress: "hello@mail.example.com" })]);
  assertEquals(ok.safe, true);
});

Deno.test("classifySender: headers come from the newest message carrying them", () => {
  const old = rec({ listUnsubscribe: "<https://example.com/old>" });
  const mid = rec({ listUnsubscribe: "<https://example.com/new>", listUnsubscribePost: null });
  const newestNoHeader = rec({ listUnsubscribe: null, listUnsubscribePost: null });
  const c = classifySender([old, newestNoHeader, mid]);
  assertEquals(c.httpsUrl, "https://example.com/new");
  assertEquals(c.method, "link");
  assertEquals(c.sampleMessageIds[0], newestNoHeader.messageId);
});

Deno.test("classifySender: suggestion rules", () => {
  // Fewer than three messages.
  assertEquals(classifySender([rec(), rec()]).suggested, false);
  // Read share of 1/3 is not below 20 %.
  assertEquals(classifySender([rec({ seen: true }), rec(), rec()]).suggested, false);
  // 1 of 6 read (16.7 %) is suggested.
  const six = classifySender([rec({ seen: true }), rec(), rec(), rec(), rec(), rec()]);
  assertEquals(six.readShare, 1 / 6);
  assertEquals(six.suggested, true);
  // Billing-looking senders are never suggested.
  assertEquals(classifySender([rec({ fromName: "Example Billing" }), rec(), rec()]).suggested, false);
  assertEquals(
    classifySender([rec({ fromAddress: "invoices@example.com" }), rec({ fromAddress: "invoices@example.com" }), rec({ fromAddress: "invoices@example.com" })]).suggested,
    false,
  );
  assertEquals(classifySender([rec({ listId: "statements.example.com" }), rec({ listId: "statements.example.com" }), rec({ listId: "statements.example.com" })]).suggested, false);
});

Deno.test("looksLikeKeepReceiving: token prefixes, not substrings", () => {
  assert(looksLikeKeepReceiving("Bank of Example"));
  assert(looksLikeKeepReceiving(null, "accounts@example.com"));
  assert(looksLikeKeepReceiving("no-reply-security@example.com"));
  assert(looksLikeKeepReceiving("Your receipts"));
  assert(!looksLikeKeepReceiving("Example News", "news@example.com", "weekly.example.com"));
  // "embankment" contains "bank" but no token starts with it.
  assert(!looksLikeKeepReceiving("Embankment Weekly"));
});

Deno.test("classifySender: RFC 2047 display names are decoded and cleaned", () => {
  const c = classifySender([rec({ fromName: "=?UTF-8?B?w4ZnaXIgTmV3cw==?=" })]);
  assertEquals(c.displayName, "Ægir News");
  const ctl = classifySender([rec({ fromName: "Bad\r\nName" })]);
  assertEquals(ctl.displayName, "Bad Name");
  const empty = classifySender([rec({ fromName: "" })]);
  assertEquals(empty.displayName, "news@example.com");
});

Deno.test("classifySender: empty input throws", () => {
  assertThrows(() => classifySender([]));
});

Deno.test("groupSenders: by List-Id, else by From, sorted by count", () => {
  const records = [
    rec(),
    rec({ fromAddress: "other@example.com" }), // same list id -> same group
    rec({ listId: null, fromAddress: "Promo@Example.org", authResults: ["mx.example.net; dkim=pass header.d=example.org"] }),
    rec({ listId: null, fromAddress: "promo@example.org", authResults: ["mx.example.net; dkim=pass header.d=example.org"] }),
    rec({ listId: null, fromAddress: "promo@example.org", authResults: ["mx.example.net; dkim=pass header.d=example.org"] }),
    rec({ listId: null, fromAddress: "solo@example.co.uk" }),
    rec({ fromAddress: "" }), // dropped
  ];
  const out = groupSenders(records);
  assertEquals(out.map((c) => [c.senderKey, c.messageCount]), [
    ["from:promo@example.org", 3],
    ["list:weekly.example.com", 2],
    ["from:solo@example.co.uk", 1],
  ]);
  assertEquals(groupSenders(records, { maxSenders: 1 }).length, 1);
  assertEquals(out[0].messageIds.length, 3);
});

Deno.test("groupSenders: personal correspondents (no List-Id, no List-Unsubscribe) are never listed", () => {
  const out = groupSenders([
    rec({ listId: null, listUnsubscribe: null, listUnsubscribePost: null, fromAddress: "friend@example.org" }),
    rec({ listId: null, listUnsubscribe: null, listUnsubscribePost: null, fromAddress: "friend@example.org" }),
    rec({ listId: null, listUnsubscribe: "  ", listUnsubscribePost: null, fromAddress: "blank@example.org" }),
    rec({ listId: "only-id.example.com", listUnsubscribe: null, listUnsubscribePost: null }),
    rec({ listId: null, fromAddress: "promo@example.com" }),
  ]);
  assertEquals(out.map((c) => c.senderKey).sort(), ["from:promo@example.com", "list:only-id.example.com"]);
  // A List-Id alone still lists the sender, with nothing to run.
  assertEquals(out.find((c) => c.listId === "only-id.example.com")?.method, "none");
});

Deno.test("senderKeyOf: an over-long List-Id is shortened stably and stays distinct", () => {
  const a = `${"x".repeat(800)}.example.com`;
  const b = `${"x".repeat(800)}.example.org`;
  const ka = senderKeyOf({ listId: a, fromAddress: "n@example.com" });
  assert(ka.length <= SENDER_KEY_MAX);
  assertEquals(ka, senderKeyOf({ listId: `<${a}>`, fromAddress: "other@example.com" }));
  assert(ka !== senderKeyOf({ listId: b, fromAddress: "n@example.com" }));
  const out = groupSenders([rec({ listId: a }), rec({ listId: a })]);
  assertEquals(out.length, 1);
  assertEquals(out[0].senderKey, ka);
});

Deno.test("groupSenders: ties sort most recent first", () => {
  const a = rec({ listId: "a.example.com" });
  const b = rec({ listId: "b.example.com" });
  assertEquals(groupSenders([a, b]).map((c) => c.listId), ["b.example.com", "a.example.com"]);
});

Deno.test("groupSenders: sample ids are capped and newest first", () => {
  const records = Array.from({ length: 8 }, () => rec());
  const [c] = groupSenders(records);
  assertEquals(c.sampleMessageIds.length, 5);
  assertEquals(c.sampleMessageIds[0], records[7].messageId);
  assertEquals(c.messageIds.length, 8);
});
