# Cutting the MCP server's context cost

Decision record for the 2026-08-19 investigation. The four `research-*.md` files
next to this one hold the full evidence; this file records what we concluded,
what we changed, and what we deliberately did not.

## What the measurements actually said

Every byte figure below is measured, not estimated. Token figures are labelled
where they are estimates: no Anthropic API key was reachable from this session,
so `count_tokens` could not be called, and the per-tool token numbers in
`research-toolslist.md` come from `tiktoken` cl100k_base, which is GPT's
tokenizer rather than Claude's. Percentages are trustworthy; absolute token
counts carry a margin. Bytes are exact.

### The brief's premise was wrong in three places

1. **`tools/list` is not ~28,000 characters.** It is **55,450 bytes** for a
   full-scope key and **50,186** for a normal one. Two reasons the earlier
   estimate came in at half: `signature` is a tenth mail tool that is easy to
   miss, and the `allOf` action-gating rules are *generated* at runtime by
   `buildConsolidatedTool`, so 13,822 bytes of the payload never appear as
   literal text in the source.

2. **Most of that payload is not context.** Only `name`, `description` and
   `input_schema` reach the model. `title`, `outputSchema`, `annotations`,
   `icons` and `_meta` are consumed client-side. That is **4,776 bytes, 8.6% of
   the wire, at zero token cost**. The number a normal user's model actually
   pays is **47,023 bytes**.

   This matters because it inverts an obvious-looking optimisation. Deleting
   `outputSchema` or the `destructiveHint` annotations would save nothing at all
   while breaking the delete-confirmation flow and the MCP Apps cards.

3. **The schema may not be paid per conversation at all.** Claude Code defers
   MCP tool definitions by default: only tool *names* load at session start.
   This was confirmed directly, not inferred, since this server's own tools
   arrived deferred in the session that did the work. Whether Claude.ai
   connectors do the same is **unverified**, and it decides whether the schema
   tax is real for most users.

### Where the cost provably is

Tool *results* are never deferred. They land in context in full, on every call.
Measured against the live production server:

| Call | Measured |
|---|---|
| `inbox_list`, 4 inboxes | 4,843 bytes, of which **1,592 (32.9%) is byte-identical duplication** |
| `email_read` action list, limit 5 | 2,640 bytes, ~512 bytes/message, `preview` is 38% of it |
| `email_read` action list, limit 20 (default) | ~10,232 bytes |

## What we changed

**Preview and body text hygiene.** `normalizePreview` collapsed whitespace with
`/\s+/`, and JS `\s` stops at U+200A, so the U+200B..U+200F padding senders put
in the hidden preheader survived and `.slice(0, 200)` spent the whole preview on
it. Fixed using the character class already in `text-safety.ts`, and applied on
the IMAP list and search paths that skipped normalisation entirely.

Three things were found while fixing it that the original report did not
predict:

- `imap-client.ts`'s `cleanPreviewText` carried the same defect one layer down,
  and **capped at 200 characters before anything stripped the padding**. Calling
  `normalizePreview` afterwards would have turned a wasteful preview into an
  empty one. The cap has to come last.
- Entities shipped undecoded. Live previews contained literal `&nbsp;`, six
  bytes for one space, eight in one observed message.
- `stripHtmlToText` had no HTML-comment rule at all, so Office conditional
  comments leaked Word's view and zoom settings, and any comment containing a
  `>` leaked raw CSS, because `<[^>]+>` cannot see past it.

`body_text` now also keeps link targets. It previously deleted every anchor, so
an HTML-only message arrived with no URLs and "send me that link" forced a
second read with `include_html` at 3.7x the cost. Empty anchors are dropped
whole, so tracking pixels leave nothing behind.

### Measured effect

| Case | Before | After |
|---|---|---|
| Marketing email body | 1,854 B | **139 B** (-92.5%) |
| Marketing email preview | 600 B | **29 B** (-95.2%) |
| Real production previews, 5 messages | 999 B | 1,000 B (**+1**) |

The last row is the honest one and it corrects an extrapolation made earlier in
the investigation. Previews are capped at 200 **characters**, so decoding
`&nbsp;` does not save bytes: it frees budget that immediately refills with more
text. On ordinary mail this is a **quality** fix (real words replacing `&nbsp;`
noise), not a token fix. The token win is decisive only where the preview was
*entirely* padding, because the cleaned text is then genuinely short.

A regression surfaced by re-reading the live server after deploying: a preview
ended in a literal `<table class`, because an IMAP snippet is a partial body
fetch that can stop mid-tag. Always present, only visible once decoding freed
enough budget to reach the end of the snippet. Fixed and redeployed.

## What we deliberately did not change

**`outputSchema`, `annotations` and `title`.** Zero token cost, and removing
them breaks the confirmation flow and the MCP Apps cards. A trap, not a saving.

**`inbox_list` response shape.** The largest single response win available:
hoisting the provider-constant `capabilities` and `compatibility` blocks out of
the per-inbox loop is **-31% with no information lost** (4,843 to 3,340 bytes,
prototyped and measured). Not shipped, because it is a **breaking change to a
documented response shape** while a directory submission is in flight. It needs
an explicit owner decision, not a quiet edit.

Note the existing `include_capabilities: false` already gives -68%, but by
discarding capability data the model may need, and nothing ever tells the model
to set it. Deduplication is strictly better than flipping that default.

**The `allOf` action-gating rules (13,822 bytes).** The server validates against
the same object it emits (`index.ts:4843`), so this cannot be deleted, only
decoupled into separate internal and wire schemas. Worth roughly 11,500 bytes,
but it is meaningful **only while the tools stay consolidated**. Held pending
the read/write split decision.

**Serving a small tool list and expanding it later.** Explicitly disallowed by
the current spec: the tool set must not vary per-connection or as a side effect
of other requests. Varying by *authorization* is permitted, and
`handleToolsList` already does it.

**A per-action `oneOf` refactor.** Root-level `anyOf`/`oneOf`/`allOf` is
rejected by the API and gets flattened with a sentence prepended, so this would
*grow* the payload.

**Truncating bodies.** There is currently no cap on `body_text`, and
`read_batch` concatenates up to 50 uncapped results. This is a real risk worth
fixing, but a cap is only safe with an explicit, actionable continuation marker.
The documented failure mode (microsoft/vscode#311068) is a truncation hint that
names a recovery path the server does not accept, which strands the agent. Doing
this properly is its own change.

## Coordination with the read/write tool split

Per-tool fixed overhead is about 560 bytes. Turning 35 actions into up to 35
tools implies roughly 20,000 bytes of new fixed cost, against the ~11,500 bytes
that dropping `allOf` would return. **The split as a token measure looks
net-negative.** That is not an argument against it (the directory submission is
an acquisition lever and may well be worth the tokens), but it should be an
informed trade rather than a surprise.

Description compression and shared-boilerplate removal (~10,800 bytes) **survive
the split and grow in value**, since `inbox_id` and `inbox` duplicate across more
tools. Those are the changes to make first, whichever way the split goes.
