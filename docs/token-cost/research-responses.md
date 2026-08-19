# MCP response bloat: a code-grounded accounting

Audit date: 2026-08-19. Read-only. No source file was modified except this
document and `docs/token-cost/measure.mjs`.

All token counts are `cl100k_base` via `gpt-tokenizer`, produced by
`docs/token-cost/measure.mjs` (section F). Fixtures are synthetic but shaped
byte-for-byte the way the server builds its payloads: the capability and
compatibility blocks are copied verbatim from `index.ts`, and the HTML-to-text
and sanitiser functions were executed as exact copies of the shipped source. No
real customer mail appears here.

---

## 0. The headline: every response is emitted twice

This is the finding that dominates all the others, and it explains the
"body emitted TWICE" observation directly.

`index.ts:175-186`:

```ts
function jsonOk(obj, pretty = false) {
  return {
    content: [{ type: "text", text: pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj) }],
    structuredContent: obj,
  };
}
```

Every successful tool result carries the **same object twice**: once serialised
into `content[0].text`, once as `structuredContent`. Nothing anywhere in
`index.ts` strips either copy based on client capability (grep for
`structuredContent` returns 20 hits, none of them a removal). 42 call sites use
`jsonOk`.

The MCP 2025-06-18 spec says a tool returning structured content SHOULD also
return the serialised JSON in a text block, so the server is compliant. But
"compliant" and "cheap" are different things, and a client that forwards both
blocks into the model context pays exactly 2x for 1x of information.

Measured on the fixtures below:

| response | text block | structuredContent | wire frame |
|---|---:|---:|---:|
| `inbox_list`, 4 inboxes | 1,644 tok | 1,149 tok | 3,078 tok |
| `email_read` list, 20 msgs | 3,225 tok | 3,225 tok | 6,578 tok |
| `email_read` read, notification | 725 tok | 725 tok | 1,507 tok |
| `email_read` read, reply w/ history | 1,070 tok | 1,070 tok | 2,229 tok |

A realistic triage turn (inbox_list + one 20-message page + four reads) measures
**7,938 tok if only the text block reaches the model, 15,381 tok if both do**.
The reported 12,700 tok sits between those two, which is what you would expect
from a real client on real mail slightly larger than these fixtures.

Note also that `inbox_list` passes `pretty = true` (`index.ts:5475`), so its
text copy is additionally indented: 1,644 tok pretty versus 1,149 tok compact,
a **43% surcharge for whitespace nobody reads**. Twelve call sites use
`pretty = true` (grep `jsonOk(.*, true)` plus the multi-line `}, true)` form).

---

## A. `inbox_list` response shape

### Where it is built

`executeListInboxes`, `index.ts:5381-5477`. The per-inbox object is assembled at
`index.ts:5455-5471`:

```ts
return {
  inbox_id: row.id,
  email_address: row.email_address,
  display_name: row.display_name ?? row.email_address,
  provider: row.provider,
  service: row.service ?? null,
  sender_identities: senderIdentities,
  sender_identity_status: senderIdentityStatus,
  ...(includeCapabilities
    ? {
        capabilities: getProviderCapabilities(row.provider),
        compatibility: getCompatibilityProfile(row.provider),
      }
    : {}),
};
```

### One entry, exactly

Reproduced here as the server emits it (pretty-printed, since `inbox_list` uses
`pretty = true`). Address and name redacted; sizes unchanged.

```json
{
  "inbox_id": "3f9a1c74-0f3e-4a91-9c2b-1d6f0e5a7b31",
  "email_address": "user1@example.com",
  "display_name": "Example User 1",
  "provider": "imap",
  "service": "fastmail",
  "sender_identities": [
    {
      "email_address": "user1@example.com",
      "display_name": "Example User 1",
      "is_primary": true,
      "is_default": true
    }
  ],
  "sender_identity_status": "available",
  "capabilities": {
    "flags": true,
    "folders": true,
    "labels": false,
    "move": true,
    "copy": true,
    "delete": true,
    "trash_vs_expunge": "both",
    "forward": true,
    "drafts": true,
    "contacts_api": false,
    "contacts_db": true,
    "scheduling": true,
    "original_message": true,
    "search_syntax": "imap"
  },
  "compatibility": {
    "schema_version": "compatibility-v1",
    "profile": "imap-baseline-v1",
    "status": "available",
    "verification": "connector_profile",
    "operations": {
      "search.body": "exact",
      "search.has_attachment": "unavailable",
      "search.flagged": "exact",
      "organization.containers": "exact",
      "organization.move": "different",
      "organization.copy": "exact",
      "delete.permanent": "exact"
    },
    "notes": [
      "This is the IMAP protocol baseline; individual servers can differ.",
      "Attachment-only search is not part of baseline IMAP SEARCH.",
      "Move can use a COPY/delete fallback when an IMAP server lacks MOVE."
    ]
  }
}
```

**1,447 bytes pretty / 1,152 bytes compact / 288 tokens.** Consistent with the
1,309-character entry measured against production.

### Byte weights, 4-inbox page

Compact JSON bytes summed across the four entries:

| field | bytes | share |
|---|---:|---:|
| `compatibility` | 2,276 | 49.6% |
| `capabilities` | 1,034 | 22.5% |
| `sender_identities` | 512 | 11.2% |
| `inbox_id` | 200 | 4.4% |
| `sender_identity_status` | 148 | 3.2% |
| `email_address` | 144 | 3.1% |
| `display_name` | 128 | 2.8% |
| `provider` | 73 | 1.6% |
| `service` | 70 | 1.5% |

**72% of the payload is provider-constant data replicated per inbox.**

### What the `compatibility` block is, and why the IMAP ones are identical

`COMPATIBILITY_PROFILES`, `index.ts:5019-5079`, keyed by `provider` only, read
through `getCompatibilityProfile(provider)` at `index.ts:5081-5083`:

```ts
function getCompatibilityProfile(provider: string): CompatibilityProfile {
  return COMPATIBILITY_PROFILES[provider] ?? COMPATIBILITY_PROFILES.imap;
}
```

There are exactly three profiles: `gmail`, `outlook`, `imap`. Fastmail, iCloud,
Yahoo, Zoho, Yandex and generic IMAP are all stored as `provider = 'imap'` with
a `service` discriminator (see the comment at `index.ts:4939-4944`), and
`getCompatibilityProfile` never looks at `service`. So three IMAP inboxes get
three byte-identical 554-byte blocks. Same for `getProviderCapabilities`
(`index.ts:5000-5002`), 242 bytes each.

Verified programmatically: the three IMAP `compatibility` objects serialise
identically. On a 3-IMAP workspace the two redundant copies alone are
**1,592 bytes / 362 tokens** of pure repetition.

The profile is also, by design, static and derived from the connector, not from
a probe. It is therefore a perfect candidate for hoisting: it can never differ
between two inboxes of the same provider.

### What the model actually needs

To pick an inbox and make a follow-up call, the model needs:

* `inbox_id` (required argument of every other tool)
* `email_address` (how the user names the inbox)
* `display_name` (disambiguation)
* `provider` (drives search syntax and folder-vs-label vocabulary)
* `service` (only when it changes user-visible behaviour, and it currently never
  does at the capability level)

Dead weight on the current shape:

* `compatibility` per inbox: provider-constant, 49.6% of bytes.
* `capabilities` per inbox: provider-constant, 22.5% of bytes.
* `sender_identities` when it contains exactly one entry equal to the inbox's own
  address (the default branch at `index.ts:5430-5435`). That is the common case
  for every non-Gmail inbox, and it restates `email_address` and `display_name`
  verbatim plus two booleans that are both `true` by construction.
* `sender_identity_status: "available"`, which is the value on the success path.

### Proposed shape

```json
{
  "inboxes": [
    { "inbox_id": "...", "email_address": "...", "display_name": "...", "provider": "imap", "service": "fastmail" }
  ],
  "provider_profiles": {
    "imap":  { "capabilities": { ... }, "compatibility": { ... } },
    "gmail": { "capabilities": { ... }, "compatibility": { ... } }
  }
}
```

Rules:

1. Emit each provider's `capabilities` and `compatibility` **once**, under
   `provider_profiles`, keyed by the same `provider` string that appears on each
   inbox. One dictionary lookup for the model, zero information lost.
2. Omit `sender_identities` when it is the single self-identity; omit
   `sender_identity_status` when it is `"available"`. Document both defaults in
   the tool description and in `outputSchema`.
3. Emit compact JSON, not `pretty = true`.
4. Keep `include_capabilities` as the opt-out it already is, but make
   `provider_profiles` the thing it gates.

Measured on the 4-inbox fixture (against the 1,644-token pretty baseline):

| change | tokens | saved |
|---|---:|---:|
| baseline (pretty, per-inbox blocks) | 1,644 | |
| compact JSON only | 1,149 | 30% |
| + hoist to `provider_profiles` | 615 | 63% |
| + `include_capabilities: false` on top | 247 | 85% |

The hoisted shape carries **every byte of information the current one does**.
The slim entry is 158 bytes; the whole 4-inbox payload with profiles omitted is
606 bytes.

---

## B. `email_read` action `"list"`

### Where enforced

* Executor: `executeListInbox`, `index.ts:7565-7692`.
* Default limit: `index.ts:7597`, `const limit = typeof args["limit"] === "number" ? args["limit"] : 20;`
  (identically at `index.ts:12953` for search).
* Range enforcement: `invalidPaginationArgument`, `index.ts:7510-7555`, rejects
  anything outside 1..100. The tool schema declares the same
  (`index.ts:2213-2221`), so 100 is a real ceiling, not advisory.
* Per-message shape: `interface EmailSummary`, `index.ts:6170-6183`. Search adds
  one field, `relevance_score`, via `SearchEmailSummary` at `index.ts:12453`.

### Measured, 20 messages

Fixture: 20 summaries with realistic subject/preview/participant lengths, of
which 5 carry the zero-width preview described in section B2 (a 1-in-4
marketing ratio, which is conservative for a real inbox).

* Payload: **12,291 bytes / 3,225 tokens** (matches the observed ~3,400).
* Wire frame with both copies: 25,646 bytes / 6,578 tokens.
* **Mean per message: 609 bytes / 161 tokens.** Range 484 to 973 bytes.

Field weights, summed across the 20 messages (compact JSON bytes):

| field | bytes | share |
|---|---:|---:|
| `preview` | 5,180 | 42.5% |
| `subject` | 1,550 | 12.7% |
| `from` | 1,520 | 12.5% |
| `to` | 1,220 | 10.0% |
| `date` | 680 | 5.6% |
| `thread_id` | 477 | 3.9% |
| `has_attachments` | 476 | 3.9% |
| `id` | 415 | 3.4% |
| `folder` | 340 | 2.8% |
| `is_read` | 307 | 2.5% |

Top-level scaffolding (`total`, `total_is_estimate`, `has_more`, `next_offset`)
is 72 bytes, 0.6%. Pagination is not the problem.

### B1. The `normalizePreview` zero-width bug (characterised, not fixed)

**`index.ts:6247-6249`:**

```ts
/** Collapses whitespace and trims the input to <=200 characters. */
function normalizePreview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}
```

The regex is `/\s+/g`. In JavaScript `\s` matches
`[\f\n\r\t\v    -     　﻿]`.
It stops at `U+200A`. It does **not** match `U+200B` ZERO WIDTH SPACE,
`U+200C` ZERO WIDTH NON-JOINER, `U+200D` ZERO WIDTH JOINER, `U+200E` LEFT-TO-RIGHT
MARK or `U+200F` RIGHT-TO-LEFT MARK.

Marketing and transactional senders pad the hidden preheader `<div>` with
hundreds of `U+200C` (occasionally alternating `U+200C U+200B`) so that the
recipient's mail client shows only the intended preheader line. Those characters
survive `\s+` collapse untouched, then `.slice(0, 200)` fills the entire preview
budget with them. The result is a 200-character preview containing zero
characters of information.

**The correct character class already exists in the same directory.**
`supabase/functions/mcp-server/text-safety.ts:48-49`:

```ts
const UNSAFE_TEXT =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
```

exposed as `neutralizeText` at `text-safety.ts:52-54`. Note that `UNSAFE_TEXT`
itself is module-private; the exported surface is `neutralizeText`,
`neutralizeMaybe`, `neutralizeList`, `neutralizeDeep`.

**`index.ts` never imports `text-safety.ts` at all.** Verified: `grep -n
"text-safety" index.ts` returns nothing, and `grep -n "neutralizeText" index.ts`
returns nothing. The only consumers are `mcp-app-approvals.ts:47` and
`mcp-app-bulk.ts:67`, both on the approval-card path. The module's own header
comment (`text-safety.ts:15-21`) says "Keep the character class below identical
in all three; it is the actual contract" and names three copies, none of which
is the tool-response path.

**Measured cost.** Across the 20-message fixture the zero-width characters alone
are **3,000 bytes / 500 tokens, 15.5% of the whole page**, contributed by 5 of
20 messages. Density is punishing: 200 consecutive `U+200C` is 600 bytes and
100 tokens; an alternating `U+200C U+200B` run of the same 200 characters is
600 bytes and **200 tokens**, because the alternation defeats the tokeniser's
repeat merging.

Applying `UNSAFE_TEXT` to `preview` cuts the page from **3,225 to 2,720 tokens
(-16%) with zero information loss**, because the characters removed carry none.

### B2. The IMAP paths skip `normalizePreview` entirely

`normalizePreview` has exactly four call sites:

| line | function | provider | path |
|---|---|---|---|
| `index.ts:6448` | `listGmailMessages` | Gmail | list |
| `index.ts:6705` | `listOutlookMessages` | Outlook | list |
| `index.ts:12604` | `searchGmailMessages` | Gmail | search |
| `index.ts:12749` | `searchOutlookMessages` | Outlook | search |

The two IMAP builders assign the raw client value instead:

* `index.ts:6980`, inside `listImapMessages` (`index.ts:6935`): `preview: s.preview,`
* `index.ts:7231`, inside `searchImapMessages` (`index.ts:7125`): `preview: s.preview,`

That value comes from `snippetToPreview` in `imap-client.ts:1213-1244`, which
ends in `cleanPreviewText` at **`imap-client.ts:1247-1249`**:

```ts
/** Strip HTML tags, collapse whitespace, cap at 200 chars. */
function cleanPreviewText(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}
```

So IMAP previews are still length-capped and tag-stripped, but they carry **the
same `\s+` defect**. There are therefore two regexes to fix, not one:
`index.ts:6248` and `imap-client.ts:1248`.

### B3. Is there a duplicated code region?

Not a literal duplicated region, but a genuine copy-paste family, which is
exactly why the normalisation drifted.

The four `normalizePreview` sites are **list/search pairs**, not two copies of
one block:

* `6448` is in `listGmailMessages` (`index.ts:6312`), `12604` is in
  `searchGmailMessages` (`index.ts:12492`). Measured: **102 of 159 lines are
  byte-identical** between the two functions. The diff is confined to
  `total_is_estimate`, `query_normalized`, folder derivation and
  `relevance_score`.
* `6705` is in `listOutlookMessages` (`index.ts:6643`), `12749` is in
  `searchOutlookMessages` (`index.ts:12644`). 48 of 78 lines identical.
* `6980` / `7231` are the IMAP pair, and are the two that lost the call.

Six near-duplicate summary builders is the structural cause: any change to the
summary shape has to be made six times, and the two IMAP ones are the ones that
get missed. Whatever shaping is applied to `EmailSummary` should be applied in
**one** mapper that all six providers call, not inline in each.

### B4. Biggest contributors, ranked

1. `preview` at 42.5% of bytes, of which the zero-width padding alone is 500
   tokens (15.5% of the page). Even clean, 200 characters is generous for a
   triage decision.
2. `to` at 10.0%. On an `INBOX` listing this array is almost always the inbox
   owner, which the model already knows from `inbox_list`. On a bulk mail it can
   be a long undisclosed-recipients string.
3. `folder` at 2.8%, repeated 20 times, always equal to the `folder` argument
   the caller passed (`index.ts:6975`, `folder,` is the literal parameter).
4. `has_attachments` / `is_read` at 6.4% combined, mostly emitting the
   uninteresting value (`false` / `true`).
5. `thread_id` at 3.9%. On IMAP it is `String(s.uid)` (`index.ts:6982`), which
   is the numeric half of `id` (`encodeImapId(folder, s.uid)`), so it is
   derivable from `id` and carries nothing.

---

## C. `email_read` action `"read"`

### The full path

Entry: `executeReadEmail`, `index.ts:8610-8740`. It reads exactly three shaping
flags (`index.ts:8653-8655`) and hands off to `readOneMessage`
(`index.ts:8525`), which dispatches per provider.

* Gmail: `readGmailMessage`, `index.ts:8115-8288`.
  1. `GET /gmail/v1/users/me/messages/{id}?format=full` (`index.ts:8127`).
  2. `walkGmailPayload` (`index.ts:8054-8113`) walks the MIME tree, taking the
     first `text/plain` and the first `text/html` it meets.
  3. Result assembled at `index.ts:8271-8287`.
* IMAP: `readImapMessage`, `index.ts:7018-7110`.
  1. `client.fetchMessageRaw(uid)` returns the whole RFC 822 message.
  2. `parseEmail(msg.raw)` (`mime.ts:41-47`) yields `{ headers, text, html,
     attachments }`. `mime.ts:146-152` takes the first `text/plain` and first
     `text/html` leaf.
  3. Result assembled at `index.ts:7085-7108`.
* Outlook: `readOutlookMessage`, `index.ts:8306-8493`.

### C1. Where the body is emitted twice

Two different things are sometimes called "twice". Only one of them is real
duplication.

**Real duplication: `jsonOk`.** As in section 0, `content[0].text` and
`structuredContent` carry the same object, and therefore the same body string,
twice. For the notification fixture: 1,900 bytes of payload go out as 3,991
bytes of wire, and any client forwarding both spends 1,450 tokens for 725
tokens of information. This matches the ~6,100-character read exactly: a
~2,900-character payload emitted twice plus envelope.

**Not duplication: `body_text` and `body_html`.** `index.ts:8283` (Gmail) and
`index.ts:7094` (IMAP) are identical in form:

```ts
body_text: textPlain ?? (textHtml ? stripHtmlToText(textHtml) : null),
body_html: includeHtml && textHtml ? sanitizeEmailHtml(textHtml) : null,
```

`body_html` is `null` unless `include_html: true`, which defaults to `false`
(`index.ts:8653`, `index.ts:2270-2276`). So on a default read there is one body.
**When `include_html: true` is set, however, the same content genuinely does go
out twice in two encodings**, and neither is derived from the other on the wire.
Measured on the notification fixture: `body_html` 4,026 B / 1,460 tok plus
`body_text` 1,344 B / 383 tok, for a wire frame of 12,310 B / 4,289 tok, versus
3,849 B / 1,157 tok for the same message without HTML. Turning on
`include_html` costs **3.7x**.

There is one more, subtler doubling on a multipart/alternative message: when the
sender ships both a `text/plain` and a `text/html` alternative, `body_text` is
the sender's plain part and `body_html` is the sender's HTML part, so with
`include_html: true` the model receives the sender's *own* two renderings of the
same prose, including both copies of every tracking URL.

### C2. Raw MIME leakage through `stripHtmlToText`

`stripHtmlToText`, **`index.ts:7723-7741`**:

```ts
function stripHtmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    // ... 5 more named entities ...
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
```

This is the only HTML-to-text conversion on the read path. It is weak in five
specific, measurable ways. Each row below was produced by running the exact
shipped function:

| input | `body_text` output |
|---|---|
| `<!--[if gte mso 9]><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch>...<![endif]-->OK` | `"96OK"` |
| `<!--[if gte mso 9]><xml><w:WordDocument><w:View>Normal</w:View><w:Zoom>0</w:Zoom>...<![endif]-->OK` | `"Normal0OK"` |
| `<!-- media query: @media (min-width:600px){ .a > .b { display:none } } -->OK` | `".b { display:none } } -->OK"` |
| `<div style="font-family:'Arial'; content:'>'">text</div>OK` | `"'\">text\nOK"` |
| `<div>iVBORw0KGgoAAAANSUhEUg...ErkJggg==</div>OK` | full base64 string, verbatim |

1. **No HTML-comment rule at all.** There is no `.replace(/<!--[\s\S]*?-->/g, "")`.
   Comments only vanish by accident, because `<[^>]+>` happens to swallow a
   comment that contains no `>`.
2. **A comment containing `>` leaks its contents.** Responsive email templates
   put media queries with child selectors inside comments constantly, so this is
   the common case, not the exotic one. The example above leaks raw CSS.
3. **Microsoft Office conditional comments leak their text nodes.** The `<xml>`
   payload is tag-stripped but its character data survives as noise tokens
   (`96`, `Normal0`). Word-authored HTML carries far more of this.
4. **An attribute value containing `>` desynchronises the tag stripper**, leaking
   markup fragments.
5. **Only six named entities are decoded.** `&middot;`, `&mdash;`, `&rsquo;`,
   `&hellip;`, `&#8203;` and every numeric reference pass through verbatim. In
   the fixture, `&middot;` appears three times in the output as literal text.

And crucially: **`<a href>` targets are destroyed.** `<[^>]+>` deletes the whole
anchor tag, so `body_text` derived from HTML contains the link *text* but not a
single URL. Measured on the HTML fixture: 0 URLs in `body_text`. A model asked
"send me that link" from an HTML-only message cannot answer without a second
call with `include_html: true`, which costs 3.7x.

**Zero-width padding leaks straight through the body too.** `stripHtmlToText`
collapses only `[ \t]+`, so the hidden preheader `<div>` full of `U+200C` lands
in `body_text` intact. Measured: **260 zero-width characters = 230 of the 383
body_text tokens, 60%**. Applying `UNSAFE_TEXT` first takes that body from
383 tokens to **123 tokens, a 68% cut with nothing lost**.

`sanitizeEmailHtml` (`index.ts:7775-7826`) removes `style`, `script`, `link`,
`meta`, `iframe`, `object`, `embed`, `base`, `form`, `noscript`, `on*=`
handlers, external `src`, `javascript:` hrefs and form controls. It does **not**
remove comments either, and it deliberately keeps every `href`. Its output on
the fixture is 4,026 of the original 4,682 bytes: it removes 14%. Stripping
presentational attributes (`style`, `class`, `width`, `height`, `cellpadding`,
`cellspacing`, `border`, `align`, `role`, `valign`, `bgcolor`) would take it to
3,175 bytes / 1,172 tokens, a further 20%, without touching a single `href` or
text node.

### C3. Tracking URLs

Preserved verbatim, in two places:

* `body_text`, when the sender's `text/plain` alternative contains them, which
  for marketing and transactional mail it always does. `index.ts:8283` and
  `index.ts:7094` return `parsed.text` / `textPlain` with **no processing
  whatsoever**: no trimming, no normalisation, no cap.
* `body_html` when `include_html: true`, since `sanitizeEmailHtml` keeps `href`.

The cost is far worse than byte count suggests, because click-tracking URLs are
opaque base64/hex and tokenise at roughly 2.2 bytes per token instead of prose's
4.

Measured on a 4-link notification fixture (246 bytes per URL, in line with the
observed 280-character average):

| | bytes | tokens |
|---|---:|---:|
| whole `body_text` | 1,418 | 565 |
| 4 tracking URLs | 984 | **456** |
| everything else | 434 | 109 |

**81% of the body's tokens are four URLs.** One 246-byte URL costs 114 tokens,
roughly the same as a paragraph of prose.

**A safe stripping rule.** The hard constraint is that the model must still be
able to hand the user a working link, and the tracking blob *is* the path, so it
cannot be trimmed. What can be done without losing anything:

1. **De-inline and dedupe.** Replace each URL occurrence in `body_text` (and in
   `body_html`) with a marker `[1]`, `[2]`, and emit a `links` array once:
   `[{ "n": 1, "url": "https://..." }]`. Zero information lost. On the fixture
   this is neutral in isolation (769 vs 725 tokens, because there is nothing to
   dedupe), but it wins whenever a URL repeats, which it does in every
   `include_html: true` read of a multipart/alternative message: the same
   4 URLs currently appear in both `body_text` and `body_html`, so deduping
   halves them.
2. **Drop 1x1 tracking pixels.** An `<img>` with `width="1"` and `height="1"`,
   or an `open.` / `pixel.` host with a `.gif` path, is never something a user
   wants a link to. Safe to omit unconditionally; note the count in a
   `tracking_pixels_removed` integer so the omission is visible.
3. **Offer a `links` mode the model can opt out of.** Default `"table"` (full
   URLs, deduped, out of line: no loss). Add `"hosts"` for triage, where each
   entry becomes `{ n, host, path_prefix, chars }`. Measured: the notification
   read drops from 725 to **378 tokens (-48%)**. This must be **opt-in**, and
   the response must carry `links_mode: "hosts"` plus an explicit instruction
   that re-reading with `links: "full"` returns the working URLs. A model doing
   pure classification never needs the URL; a model asked for a link does, and
   must be able to get it.

Never rewrite the URL itself: no `utm_*` stripping, no shortening, no proxying.
The tracking path segment is load-bearing for the link to work at all.

### C4. Quoted history and signature blocks

Included in full, verbatim, always. There is no quote detection anywhere on the
read path (grep for `wrote:`, `>` quoting, `-----Original Message-----` finds
nothing in the reader).

Measured on a four-deep reply fixture:

| segment | bytes | tokens |
|---|---:|---:|
| whole `body_text` | 3,033 | 840 |
| the new reply text | 41 | **12** |
| signature block | 143 | 40 |
| quoted history | 2,567 | 689 |

**82% of the body is quoted history the model has usually already read**, for
12 tokens of new content. `body_text` is 85.3% of the whole payload;
`references` (the RFC 5322 chain, 4 message-ids) is the next largest field at
3.1%.

Folding the quoted history behind a marker while keeping the full byte count
visible takes the read from 1,070 to **252 tokens (-76%)**.

The recovery path matters here: emit
`{ "body_text": "<new text only>", "quoted_history": { "omitted_bytes": 2567,
"depth": 4, "first_line": "On Tue, 13 Aug 2026 at 13:03, ... wrote:" } }` and
document that `quote: "full"` returns the whole thing. The `first_line` is what
lets the model decide whether it needs the rest without a round trip.

### C5. Is there a size cap on the body?

**No. None at all.** This is the single most important structural finding in
section C.

* `body_text` is assigned directly at `index.ts:8283` (Gmail), `index.ts:7094`
  (IMAP) and `index.ts:8489` (Outlook), with no length check.
* `body_html` likewise, `sanitizeEmailHtml` output straight through.
* The only caps in the whole reader are on **attachments**:
  `ATTACHMENT_DATA_BUDGET` (10 MB per call), `BULK_ATTACHMENT_MAX_BYTES` (2 MB
  per file on the bulk path), `ORIGINAL_MESSAGE_MAX_BYTES` (25 MB,
  `index.ts:8745`), and `EXTRACTION_MAX_CHARS` / `EXTRACTION_MAX_BYTES` for
  `action: "extract"` (`capExtractedText`, `index.ts:6795-6798`, which is the
  one place in the file that does truncation *properly*, returning
  `{ text, truncated }` and a warning string, `index.ts:6851`).

`email_read_batch` is worse: `executeReadEmails` (`index.ts:9434`) accepts up to
50 message ids and concatenates 50 uncapped `ReadEmailResult` objects
(`index.ts:9588`, `messages.push(readResult)`), then `jsonOk` doubles the lot.
At the notification fixture's 725 tokens per message that is 36,000 tokens
visible and 72,000 on the wire, from one tool call, with nothing in the code
able to stop it.

**Commit 19692b6, "fix(mcp): stop edge isolates OOMing on large IMAP messages"
(2026-08-18), is directly relevant and shows the shape of the right fix.** It
was written because 11% of `/api/mcp` requests were 5xx: the Supabase isolate
was hitting its 256 MB limit (306 worker kills in one day against 0-30 on the
preceding six) because a single raw MIME message was copied four times with no
size ceiling anywhere. Its fixes were:

* `DEFAULT_MAX_LITERAL_BYTES` (40 MB) in `imap-client.ts`, a hard ceiling on any
  IMAP literal, with oversized literals *drained* rather than poisoning the
  connection.
* `fetchMessageRaw` capture mode, cutting retained full-size copies from 4 to 1.
* `fill()` growing in bounded steps and shrinking back to 64 KB.
* And, decisively: the observation that `email_original` "checked its 25MB cap
  only AFTER all of the above, so the guard could not prevent the OOM it existed
  to prevent", fixed by deciding from the *declared* size while the bytes are
  still on the wire (`OriginalMessageTooLargeError`, `index.ts:8770-8785`).

That commit put a memory ceiling on the transport. It put **no ceiling on the
response**. A 4 MB HTML newsletter is now safely fetched, parsed and then
serialised in full, twice, into a model's context window. The same
"decide from the declared size, before you materialise it" discipline should be
applied to `body_text` / `body_html`, and the same explicit-continuation pattern
that `capExtractedText` already uses should be applied to the result.

---

## D. Response-shaping controls that already exist

Everything found, with its default and whether it is in the tool schema.

| control | tool / action | schema line | default | verdict |
|---|---|---|---|---|
| `include_capabilities` | `inbox_list` | `index.ts:2177-2186` | `true` | **Wrong default.** Turns off the two provider-constant blocks that are 72% of the payload. Almost no caller needs them. |
| `provider` | `inbox_list` | `index.ts:2169-2176` | none | Fine. Filters rows, not fields. |
| `limit` | `email_read` list / search | `index.ts:2213-2221` | `20` | Reasonable. Enforced 1..100 at `index.ts:7510`. |
| `offset` | `email_read` list / search | `index.ts:2222-2230` | `0` | Fine. |
| `folder`, `unread_only` | `email_read` list | `index.ts:2231-2245` | `INBOX`, `false` | Row filters, not shape. |
| `include_html` | `email_read` read / read_batch | `index.ts:2270-2277` | `false` | **Correct default**, and it is doing real work: turning it on costs 3.7x. |
| `include_attachments` | `email_read` read / read_batch | `index.ts:2278-2290` | `false` | **Correct default**, well documented, with a stated recovery path (`action: "attachment"` by `attachment_index`). This is the model the rest of the API should copy. |
| `attachment_index` / `filename` | `email_read` attachment / extract | `index.ts:2384-2398` | none | Good. Precise single-item retrieval. |
| `message_ids` maxItems 50 | `email_read` read_batch | `index.ts:2322-2331` | none | Item cap only. No byte cap behind it. |

**What does not exist:** there is no `fields`, no `format`, no `verbosity`, no
`preview_only`, no `max_body_length`, no `max_length`, no `body_format`, no
`quote` or `links` control, anywhere. The only response-shaping vocabulary the
API has is three booleans, and two of them are about attachments.

The pattern to extend is the `include_attachments` one: **default to the cheap
shape, state in the response how to get the expensive shape, and make the
retrieval path precise enough that recovering one item does not refetch
everything.**

---

## E. Prioritised shaping plan

Savings are measured against the fixtures in this document. "Recovery" is how a
model that turns out to need the omitted data gets it, which is the hard
constraint: a cut that forces a blind round trip is not a saving.

### P0. Apply `UNSAFE_TEXT` to previews and to `body_text`

**Change.** Import `neutralizeText` from `text-safety.ts` into `index.ts` (it is
not currently imported at all) and apply it to `preview` in one shared summary
mapper, and to `body_text` before it is returned. Fix both defective regexes:
`index.ts:6248` and `imap-client.ts:1248`. While there, add the two missing IMAP
call sites (`index.ts:6980`, `index.ts:7231`), ideally by routing all six
providers through one mapper.

**Saving.** List page of 20: 3,225 to 2,720 tokens (-16%, -505). A single read of
an HTML notification: `body_text` 383 to 123 tokens (-68%). Scales with how much
marketing mail the inbox holds.

**Risk: none, and this is the only item on the list with no downside.** Every
character removed is by definition invisible and carries no information. The
project has already made exactly this judgement for the approval card, and the
module header at `text-safety.ts:23-34` explicitly reasons about which fields
are safe to neutralise. One caveat that reasoning raises: `U+200E` / `U+200F` and
the isolates matter for Hebrew, Arabic, Persian and Urdu prose, and
`text-safety.ts:24-29` deliberately declines to neutralise message *bodies* for
that reason. So for `body_text` apply the narrower zero-width subset
(`[​-‍⁠-⁤﻿]`) and leave the bidi marks alone; for
`preview`, which is a scanned structural field, the full `UNSAFE_TEXT` is
correct and matches the existing contract.

**Recovery.** Not needed. Nothing is lost.

### P1. Hoist provider-constant data out of the per-inbox loop, and stop pretty-printing

**Change.** `index.ts:5455-5471` and `index.ts:5475`. Emit `capabilities` and
`compatibility` once per distinct provider under `provider_profiles`; omit the
trivial self-only `sender_identities` and the `"available"` status; drop
`pretty = true`.

**Saving.** 1,644 to 615 tokens (-63%) on a 4-inbox workspace, more as inbox
count grows, since the redundancy is linear in inboxes and constant in
providers. Dropping `pretty` alone is -30% and is a one-character change.

**Risk: very low.** `provider_profiles` is a dictionary keyed by a string that
appears on every inbox entry, so no information is lost and no round trip is
introduced. The one real risk is a client that reads
`inboxes[i].capabilities.move` by path; mitigate by shipping both shapes for one
release, or by keying the change to the existing `include_capabilities` flag.

**Recovery.** Nothing to recover. If `include_capabilities: false` was used, the
model calls `inbox_list` again with it true, at 615 tokens.

### P2. Fix `stripHtmlToText`, and preserve links while doing it

**Change.** `index.ts:7723`. Add `.replace(/<!--[\s\S]*?-->/g, "")` **before**
the tag strip. Handle attribute values containing `>`. Decode numeric and the
common named entities. Convert `<a href="U">T</a>` to `T [n]` and collect `U`
into a `links` array rather than discarding the URL. Strip 1x1 tracking pixels.

**Saving.** Removes the MSO / conditional-comment / CSS noise entirely (in the
adversarial cases above, 100% of the leaked garbage). On the fixture the
comment-and-entity leakage is modest in isolation; on Word-authored and
responsive-template mail it is the difference between a clean body and a body
padded with CSS fragments.

**Risk: low, and it is net information *gain*.** Today an HTML-only message
yields a `body_text` with zero URLs in it; after this change the model can
answer "send me that link" without a 3.7x `include_html` re-read. The one thing
to watch is the comment-strip ordering: it must run before the tag strip, or
`<!--[if !mso]><!-->` downlevel-revealed content will be eaten along with the
comment.

**Recovery.** `include_html: true` still returns the full sanitised HTML,
unchanged.

### P3. Put a real cap on `body_text` / `body_html`, with explicit continuation

**Change.** Introduce `MAX_BODY_CHARS` (suggest 8,000 for a single read, 2,000
per message inside `read_batch`) applied in `readOneMessage` and in
`executeReadEmails`. Follow the pattern that already exists at
`index.ts:6795-6798`: return `{ text, truncated }`, not a silent slice. The
response gains `body_truncated: true`, `body_total_chars: N`, and
`body_offset`/`body_next_offset` so the remainder is fetchable.

**Saving.** Zero on typical mail (the fixtures are all under the cap). It is a
tail-risk fix: it converts the current unbounded worst case (a 4 MB newsletter,
or a 50-id `read_batch` at 72,000 wire tokens) into a bounded one.

**Risk: this is the item most capable of breaking the model's job, and it must
be built as continuation, never as truncation.** A silent slice at 8,000
characters that drops the OTP code at the bottom of a long message is exactly
the failure the constraint forbids. Requirements: (a) the cap is generous enough
that ordinary mail never hits it, (b) hitting it is always announced in the
payload, (c) the continuation is a cheap, precise call that does not refetch the
prefix.

**Recovery.** `email_read` with `body_offset: 8000`, returning the next window.

### P4. Fold quoted history behind a marker

**Change.** Detect the quote boundary in `body_text` (the `On ... wrote:`
attribution line, `-----Original Message-----`, and leading `>` runs) and return
only the new text plus
`quoted_history: { omitted_bytes, depth, first_line }`. Add a `quote: "new" |
"full"` parameter defaulting to `"new"`.

**Saving.** Reply fixture: 1,070 to 252 tokens (-76%). On a real reply-heavy
inbox this is the largest per-read saving available.

**Risk: medium, and the highest of any item here.** Quote detection is heuristic
and locale-dependent: `On ... wrote:` is English, Outlook uses
`-----Original Message-----`, and many clients use neither. A false positive
truncates real content. Mitigations: require *both* an attribution line and a
following block that is majority-quoted before folding; never fold when the
detected boundary is in the first 20% of the body; always report
`omitted_bytes` and `first_line` so the model can see what it did not get.

**Recovery.** `quote: "full"` on the same `message_id`. Because `first_line` is
included, the model can decide whether it needs the round trip without guessing.

### P5. De-inline links into a `links[]` table

**Change.** Replace URL occurrences in `body_text` and `body_html` with `[n]`
markers, emit `links: [{ n, url }]` once, deduped across both bodies. Add a
`links: "table" | "hosts" | "inline"` parameter defaulting to `"table"`.

**Saving.** Neutral on a single body with no repeats. Roughly halves link cost
on any `include_html: true` read, since the same URLs currently appear in both
bodies. With `links: "hosts"` (opt-in): notification read 725 to 378 tokens
(-48%).

**Risk: low for `"table"`, which loses nothing; medium for `"hosts"`, which is
why it must not be the default.** The response must carry `links_mode` and say
plainly that `links: "full"` returns the working URLs. Never rewrite a URL: the
tracking path segment is what makes it work.

**Recovery.** Re-read with `links: "table"`.

### P6. Slim the `EmailSummary` shape

**Change.** In the single shared mapper: drop `to` on a single-recipient INBOX
listing, drop `folder` when it equals the requested folder, drop `thread_id`
when it is derivable from `id`, and emit `unread: true` / `has_attachments:
true` only when true. Shorten the preview budget from 200 to 120 characters
(after P0, 120 clean characters carry more than 200 padded ones do today).

**Saving.** Combined with P0: 3,225 to 1,955 tokens (-39%) on a 20-message page.

**Risk: low but not zero.** Omitting keys rather than emitting `false` is only
safe if `outputSchema` (`index.ts:3900` region) and the tool description state
the defaults explicitly, and if `required` is loosened accordingly. The 200 to
120 preview cut is the one judgement call: it is the difference between "enough
to classify" and "enough to summarise". If in doubt, keep 200 and take only the
free P0 saving, which is most of the win anyway.

**Recovery.** `email_read` with `action: "read"` on the specific `message_id`
returns everything, and the model already knows to do this.

### P7. Emit only one of `content[0].text` and `structuredContent`

**Change.** `index.ts:175-186`. Negotiate at `initialize`: when the client
declares it reads `structuredContent`, send a short text block
(`"See structuredContent."`) instead of the full serialisation. When it does
not, send the text block and omit `structuredContent`.

**Saving.** Exactly 50% of every response payload, on every tool, unconditionally.
On the measured triage turn: 15,381 to 7,938 tokens.

**Risk: this is the largest saving and also the one most likely to break a
client, which is why it is last rather than first.** The MCP spec's SHOULD
exists precisely for backward compatibility, and a client that silently reads
neither field would break invisibly. It needs a capability check, a staged
rollout, and verification against the actual Claude.ai connector before it ships.
Until then, P1's `pretty = false` captures a third of the same win on
`inbox_list` at no risk at all.

**Recovery.** Not applicable: the information is identical in both copies.

### Summary table

| # | change | typical saving | risk |
|---|---|---|---|
| P0 | zero-width strip on preview + body | -16% list, -68% of an HTML body | none |
| P1 | hoist provider profiles, drop pretty | -63% `inbox_list` | very low |
| P2 | fix `stripHtmlToText`, keep links | removes leaked markup, gains URLs | low |
| P3 | body cap with continuation | 0% typical, bounds the tail | medium if built as truncation |
| P4 | fold quoted history | -76% on replies | medium (heuristic) |
| P5 | `links[]` table | -48% opt-in, halves link cost with HTML | low as default, medium opt-in |
| P6 | slim `EmailSummary` | -39% list with P0 | low |
| P7 | one copy, not two | -50% everywhere | high, needs negotiation |

P0 through P2 together are free in the strict sense: no information is lost, no
round trip is introduced, and P2 is a net gain. They should land first.

---

## F. Measurement harness

`docs/token-cost/measure.mjs` (also in the session scratchpad as `measure.mjs`).

```
node docs/token-cost/measure.mjs <file.json> [...]
cat response.json | node docs/token-cost/measure.mjs
node docs/token-cost/measure.mjs --self-test
```

It accepts a full JSON-RPC envelope, a bare MCP tool result, a raw payload
object, or NDJSON, and prints:

* wire bytes/tokens for the whole frame
* `content[0].text` bytes/tokens, flagged when pretty-printed, with the compact
  equivalent and the whitespace surcharge
* `structuredContent` bytes/tokens, with an explicit duplication warning
* per-item mean/min/max for `messages[]`, `inboxes[]`, `folders[]`, `drafts[]`,
  `contacts[]` or `scheduled_sends[]`
* a sorted bar chart of per-item field weights and of top-level field weights,
  so the field buying the tokens is visible at a glance

**Tokenizer.** It resolves, in order: the npm `gpt-tokenizer` package
(cl100k_base) from cwd or from its own directory, then python `tiktoken`, then a
`bytes / 3.7` fallback that is **labelled `[ESTIMATE]`** in the output. Neither
tokenizer is currently present at the repo root, so install one before trusting
the numbers:

```
npm i gpt-tokenizer          # or: pip install tiktoken
```

Every figure in this document was produced with `gpt-tokenizer` and is exact for
cl100k_base.

**Fixtures.** There are no real email payloads checked into this repo.
`apps/mcp-app/harness/fixtures.mjs` (403 lines) holds approval-card fixtures,
not tool responses: its `HOSTILE_HTML` is a deliberately adversarial body used
for sanitiser testing, and it is a useful input for the `stripHtmlToText`
checks in section C2 but is not a `email_read` response. The `*.test.ts` files
alongside `index.ts` test the app-card, attachment-validation, text-safety and
usage-limit modules; none carries a captured response payload.

The fixtures used in this audit were generated to match the server's exact
construction and live in the session scratchpad (`inbox_list.json`,
`email_list_20.json`, `email_read_plain.json`, `email_read_reply.json`,
`email_read_one.json`, `email_read_one_html.json`). To reproduce, capture a real
response with a read-only call and pipe it into the harness:

```
node docs/token-cost/measure.mjs captured-inbox-list.json
```

Do not commit captured responses: they contain real subjects and addresses.

---

## Appendix: exact locations

| what | where |
|---|---|
| double emission (`jsonOk`) | `index.ts:175-186` |
| `inbox_list` executor | `index.ts:5381-5477` |
| per-inbox entry assembly | `index.ts:5455-5471` |
| `pretty = true` on `inbox_list` | `index.ts:5475` |
| `PROVIDER_CAPABILITIES` | `index.ts:4945-4993` |
| `getProviderCapabilities` | `index.ts:5000-5002` |
| `COMPATIBILITY_PROFILES` | `index.ts:5019-5079` |
| `getCompatibilityProfile` | `index.ts:5081-5083` |
| `include_capabilities` schema | `index.ts:2177-2186` |
| `EmailSummary` | `index.ts:6170-6183` |
| `SearchEmailSummary` | `index.ts:12453-12460` |
| **`normalizePreview` (the bug)** | **`index.ts:6247-6249`, regex `/\s+/g`** |
| **`cleanPreviewText` (same bug)** | **`imap-client.ts:1247-1249`, regex `/\s+/g`** |
| **correct class `UNSAFE_TEXT`** | **`text-safety.ts:48-49`, exported via `neutralizeText` at `:52`** |
| preview call site, Gmail list | `index.ts:6448` |
| preview call site, Outlook list | `index.ts:6705` |
| preview call site, Gmail search | `index.ts:12604` |
| preview call site, Outlook search | `index.ts:12749` |
| **IMAP list, no normalisation** | **`index.ts:6980`, `preview: s.preview,`** |
| **IMAP search, no normalisation** | **`index.ts:7231`, `preview: s.preview,`** |
| `listGmailMessages` | `index.ts:6312` |
| `searchGmailMessages` | `index.ts:12492` (102/159 lines identical to the above) |
| default limit 20 | `index.ts:7597`, `index.ts:12953` |
| limit range enforcement | `index.ts:7510-7555` |
| `executeListInbox` | `index.ts:7565-7692` |
| `ReadEmailResult` | `index.ts:7946-7980` |
| `executeReadEmail` | `index.ts:8610-8740` |
| `readImapMessage` | `index.ts:7018-7110` |
| `readGmailMessage` | `index.ts:8115-8288` |
| `readOutlookMessage` | `index.ts:8306-8493` |
| body assembly, IMAP | `index.ts:7094-7095` |
| body assembly, Gmail | `index.ts:8283-8284` |
| `stripHtmlToText` | `index.ts:7723-7741` |
| `sanitizeEmailHtml` | `index.ts:7775-7826` |
| `executeReadEmails` (batch, 50 ids) | `index.ts:9434-9596` |
| `capExtractedText` (correct truncation pattern) | `index.ts:6795-6798` |
| `OriginalMessageTooLargeError` (19692b6) | `index.ts:8770-8785` |
| `mime.ts` body selection | `mime.ts:146-152` |
| `snippetToPreview` | `imap-client.ts:1213-1244` |
