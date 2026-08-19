# MCP token-cost research: ecosystem craft

Research date: 2026-08-19. Scope: how good MCP servers keep tool RESULTS small and write terse schemas.
Two facts are taken as already established and are not re-argued here: only `name`, `description` and
`input_schema` reach the model; and the spec has no tool filtering/groups/namespaces.

## Bottom line

Our real cost is tool RESULTS, not tool schemas, and the ecosystem's answer is consistent: ship a lean
default projection, let the model opt IN to detail, and never let a capped list look complete.

1. For an email server the single largest lever is content cleaning, not protocol cleverness. Quoted reply
   chains, signatures, tracking pixels, base64 images, signed redirect URLs and full header sets are most
   of a raw message and almost none of its information. Mature libraries exist (talon, planer,
   email-reply-parser, html-to-text) and their heuristics are cheap to reimplement.
2. Copy GitHub's `fields` + `Minimal*` pattern. A lean default shape, plus a per-tool `fields` enum whose
   description names the heaviest fields explicitly.
3. Budget for a few THOUSAND characters per response, not Anthropic's 25,000 token ceiling. Clients cut at
   700 B to 10 KB and cut badly.
4. Every truncation marker must name a recovery action your own server accepts. A marker promising a
   recovery path that fails is documented to send agents into confusion loops.
5. Description budget: one sentence for the tool, the real detail in the action enum's property
   description, 3 to 8 words for everything else. Measured benchmark from github/github-mcp-server:
   median 1,215 bytes per tool across 117 tools.

Where evidence is thin, this document says so: consolidation-vs-splitting has no controlled eval,
Markdown-vs-JSON accuracy claims are overstated, and explicit truncation-marker wording has not converged.

---

## 1. Response shaping

### 1.1 The single most cited primary source

Anthropic, "Writing effective tools for AI agents, using AI agents"
<https://www.anthropic.com/engineering/writing-tools-for-agents>

Verbatim rules worth copying:

- "Implement some combination of pagination, range selection, filtering, and/or truncation with
  sensible default parameter values."
- "For Claude Code, we restrict tool responses to 25,000 tokens by default."
- "If you choose to truncate responses, be sure to steer agents with helpful instructions. You can
  directly encourage agents to pursue more token-efficient strategies, like making many small and
  targeted searches instead of a single, broad search."
- "Tool implementations should take care to return only high signal information back to agents. They
  should prioritize contextual relevance over flexibility, and eschew low-level technical identifiers
  (for example: `uuid`, `256px_image_url`, `mime_type`)."
- Error responses should be prompt-engineered "to clearly communicate specific and actionable
  improvements, rather than opaque error codes or tracebacks."

Measured number from that article: a `response_format` enum with `concise` / `detailed` on a Slack
tool produced 72 tokens concise vs 206 tokens detailed, roughly a 3x saving. That is Anthropic's own
number, and it is the clearest published evidence that a verbosity enum is worth the extra schema bytes.

### 1.2 Field selection: the GitHub MCP server is the best worked example

Source: <https://github.com/github/github-mcp-server/blob/main/pkg/github/minimal_types.go>

GitHub ships a `fields` array parameter on its heavy list/search tools, backed by a per-tool enum of
allowed field names, plus a `filterFields` helper that marshals the full object to JSON and picks only
the requested keys. Their own code comments name the specific expensive fields, which is a useful
habit:

- `list_issues`: "The body and field_values fields are the heaviest, so omitting them is the main lever
  for shrinking large result sets."
- `list_pull_requests`: "The body field is the heaviest..."
- `search_code`: "The repository and text_matches fields are the heaviest..."
- `list_commits`: "The commit field (message plus author/committer metadata) is the heaviest..."

Two design details worth copying:

1. The enum is per-tool and lists only fields that tool can actually emit. Their comment on
   `listIssuesItemFieldEnum` notes that fields only the REST path populates "are never emitted here and
   are intentionally omitted", so the model is never offered a field that will silently come back empty.
2. They also define `Minimal*` structs (`MinimalIssue`, `MinimalPullRequest`, `MinimalUser`, ...) so the
   DEFAULT shape is already trimmed, and `fields` narrows further. Field selection is a second lever on
   top of a lean default, not a substitute for one.

Email analogue: default `email_read` list items to `id, from, subject, date, snippet, has_attachments,
unread`, and gate `body_text`, `body_html`, `headers`, `to/cc` full lists, and attachment metadata behind
an opt-in `fields` enum.

### 1.3 "More exists" signalling

GitHub's pattern, from <https://github.com/github/github-mcp-server/blob/main/pkg/github/issues.go>:

- Search responses carry `total_count`, `incomplete_results`, `items`.
- Embedded sub-lists carry a count plus a capped reference list. Their comment:
  "Only a few references are embedded, so total_count is what distinguishes a complete list from a
  truncated one" and "totalCount is selected so that a truncated list is never mistaken for the complete
  set."
- Their newer UI tools return an explicit boolean: `"has_more": hasMore`
  (<https://github.com/github/github-mcp-server/blob/main/pkg/github/ui_tools.go>), with the comment
  "Results past the cap are truncated and surfaced via a `has_more`" flag.

Rule that falls out: never let a capped list look complete. Ship either `total_count` (so the model can
compare against `len(items)`) or an explicit `has_more` boolean. A bare array is the anti-pattern.

MCP's own transport-level pagination is opaque-cursor based
(<https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/pagination>), but that applies
to `tools/list`, `resources/list` etc., NOT to tool call results. Tool result pagination is entirely
yours to invent, which is why every server does it differently.

### 1.4 Explicit truncation markers: real wording found in the wild

- GitHub MCP server, log lines: keeps the first 1000 chars then appends the literal string
  `"... [TRUNCATED]"`. Constants: `maxDisplayLength = 1000`, `maxLineSize = 10MB`, ring buffer default
  `maxJobLogLines = 500`, hard cap 100000.
  <https://github.com/github/github-mcp-server/blob/main/pkg/buffer/buffer.go>
- Sentry MCP names the truncated fields in a machine-readable list rather than only marking the text:
  "Truncated `genAi` fields are listed in `genAi.truncatedFields`".
  <https://github.com/getsentry/sentry-mcp/blob/main/docs/specs/ai-conversations.md>
- Claude Code's own convention, widely quoted in MCP guides, is a marker that names the recovery action:
  `[Output truncated. Use 'offset' parameter to read more.]`

Evidence quality note: I found plenty of servers that truncate, but very few that emit a marker naming
BOTH the amount dropped AND the exact follow-up call. The "[truncated, 12000 more chars, call X with
cursor Y]" shape is a good idea that the ecosystem has largely not converged on. Treat it as a
recommended improvement, not as an established convention.

What IS well established, from Anthropic directly: "If you choose to truncate responses, be sure to steer
agents with helpful instructions." Silent truncation is the failure mode everyone reports (see section 3).

### 1.5 IDs plus a fetch-detail tool

Anthropic's guidance pushes in a slightly different direction than "return IDs, fetch later". They warn
against cryptic identifiers: return "natural language names, terms, or identifiers" and "eschew low-level
technical identifiers (for example: `uuid`, `256px_image_url`, `mime_type`)". For email this means the
list result should carry a stable message id the fetch tool accepts, but the HUMAN-legible handles
(sender address, subject, date) should be present too so the model can reason without a second call.

The `get_customer_context` pattern from the same article is the counterweight to over-splitting:
"Instead of implementing `get_customer_by_id`, `list_transactions`, and `list_notes` tools, implement a
`get_customer_context` tool which compiles all of a customer's recent and relevant information all at
once." So: split for SIZE, consolidate for round-trips. If the detail fetch is nearly always the next
call, inline a trimmed version instead.

### 1.6 Markdown versus JSON for tool results

The honest answer is that the evidence is real but weaker than the blog posts imply.

Best benchmark I found with published per-format numbers:
<https://www.improvingagents.com/blog/best-nested-data-format/>
1,000 questions per format, retrieving values from deeply nested (6 to 7 levels) Terraform-like config,
across three small models:

| Model | Best accuracy | JSON | Markdown | Tokens JSON vs Markdown |
|---|---|---|---|---|
| GPT-5 Nano | YAML 62.1% | 50.3% | 54.3% | 57,933 vs 38,357 |
| Llama 3.2 3B | JSON 52.7% | 52.7% | 48.0% | 35,808 vs 23,692 |
| Gemini 2.5 Flash Lite | YAML 51.9% | 43.1% | 48.2% | 220,892 vs 137,708 |

Caveats the author states outright: "This does not mean you would see 40-60% accuracy in practice.
Accuracy is close to 100% with much smaller amounts of data." No significance testing is reported, and
the models tested are all small/cheap ones, not Claude. Llama reverses the ordering.

What survives across sources: Markdown and YAML are consistently 30 to 40 percent cheaper in tokens than
equivalent JSON, because JSON pays for braces, quotes and repeated keys on every row. Accuracy differences
are small, model dependent, and only show up on large deeply nested payloads.

Practical read for an email server: use compact Markdown or a plain line-oriented text table for LISTS
(the repeated-key tax is largest there), and JSON only where the model must feed a value back verbatim
into a later call. Do not claim a big accuracy win from Markdown; the defensible claim is the token win.

---

## 2. Description writing craft

### 2.1 Anthropic's published rules, quoted

<https://www.anthropic.com/engineering/writing-tools-for-agents>

- "Think of how you would describe your tool to a new hire on your team. Consider the context that you
  might implicitly bring, specialized query formats, definitions of niche terminology, relationships
  between underlying resources, and make it explicit."
- "Input parameters should be unambiguously named: instead of a parameter named `user`, try a parameter
  named `user_id`."
- "Namespacing (grouping related tools under common prefixes) can help delineate boundaries between lots
  of tools", with the note that "We have found selecting between prefix- and suffix-based namespacing to
  have non-trivial effects on our tool-use evaluations."
- "Prompt-engineering your tool descriptions and specifications" is called out as among the most impactful
  optimizations available.

### 2.2 What goes where

Derived from reading `issue_read.snap` and its siblings, plus the Anthropic rules:

- TOOL description: one sentence saying what the tool operates on and the scope. GitHub's `issue_read`
  description is literally 61 characters: "Get information about a specific issue in a GitHub repository."
  Everything else lives in properties.
- ACTION/method property description: the per-action semantics, including what each action returns and
  any non-obvious enrichment. This is where GitHub spends its budget, and it is the right place: it is
  read only when the model is already choosing an action.
- Other property descriptions: 3 to 8 words. "The owner of the repository". "The number of the issue".
  "Page number for pagination (min 1)". Constraints go in JSON Schema keywords (`minimum`, `maximum`,
  `enum`), not in prose, because the client renders them anyway.
- NOWHERE: examples of full JSON responses, changelogs, marketing, security disclaimers, "always call
  inbox_list first" style workflow lectures repeated on every tool, restating a constraint already
  expressed by `enum`/`required`/`minimum`, and anything a client shows separately (title, annotations).

### 2.3 A measured bytes-per-tool benchmark

I measured the github/github-mcp-server committed tool-schema snapshots, which are pretty-printed JSON
containing name + description + inputSchema + annotations:
<https://github.com/github/github-mcp-server/tree/main/pkg/github/__toolsnaps__>

- n = 117 tools
- total 185,310 bytes
- mean 1,584 bytes per tool
- median 1,215 bytes per tool
- p90 2,767 bytes
- largest 10,533 bytes (`projects_write`, a many-action write tool)
- `issue_read`, a five-action consolidated read tool, is 1,833 bytes pretty-printed

Those figures include JSON indentation and the client-side-only `annotations` block, so the on-the-wire
model cost is lower. As a working target: a well-written tool is roughly 1.2 to 1.6 KB of pretty JSON,
call it 300 to 400 tokens. A tool over about 3 KB should be justified by carrying many actions.

---

## 1.7 Email and document specific shaping

This is where an email MCP server can win the most, because raw email bodies are mostly not content.

**Quoted reply chains and signatures.** Three libraries are the ecosystem standard, all with public
test corpora:

- Mailgun `talon` (Python): quotation AND signature extraction, from both text and HTML, with an ML
  signature model. <https://github.com/mailgun/talon>
- Lever `planer` (JavaScript/Node): an explicit JS port of talon's quotation removal. Lever's own writeup
  says they needed it because talon is Python and their stack is Node. Planer does quotations only, not
  signatures. <https://github.com/lever/planer> and
  <https://fulcrum.lever.co/levers-planer-extract-reply-text-from-emails-in-javascript-25871c516b6a>
- `email-reply-parser` (npm, descendant of GitHub's Ruby EmailReplyParser): regex/heuristic based,
  handles roughly 10 locales including French, Spanish, Portuguese, Italian, Japanese, Chinese, which
  matters because the `On DATE, NAME <EMAIL> wrote:` header is localized.
  <https://www.npmjs.com/package/email-reply-parser>
- `mailstrip` (Teamwork) is another JS port of the same GitHub heuristic.
  <https://github.com/Teamwork/mailstrip>

The concrete heuristics these encode, worth reimplementing directly if you cannot take a dependency in a
Deno edge function:

1. Strip lines beginning with `>` (and repeated `>>`), which covers plain-text quoting.
2. Cut at a localized "On <date>, <name> wrote:" / "-----Original Message-----" / "From: ... Sent: ..."
   header line.
3. In HTML, drop `blockquote` elements, and the well-known client wrappers: `div.gmail_quote`,
   `div.gmail_extra`, `#divRplyFwdMsg` and `div[id^=divRplyFwdMsg]` (Outlook), `blockquote[type=cite]`
   (Apple Mail), `div.yahoo_quoted`, `#yiv...`.
4. Cut at a signature delimiter line `-- ` (dash dash space) per the old Usenet convention.
5. Cap the retained tail anyway: even after stripping, take the first N characters of the new content.

Sigparser's writeup is a good plain-language catalogue of the same heuristics:
<https://www.sigparser.com/developers/extract-reply-chains-from-emails>

**HTML to text.** For a JS/Deno server, `html-to-text` (<https://www.npmjs.com/package/html-to-text>) is
the workhorse: it has explicit per-selector formatters, so you can set `img: {format: 'skip'}` and
`a: {options: {ignoreHref: true}}` and get a large win immediately. `@mozilla/readability` is the other
option when you want main-content extraction from newsletters, but it is tuned for articles and is
heavier than needed for most mail.

**Tracking pixels.** Cheap high-yield filters, in rough order of value:
1. Drop every `<img>` whose rendered width or height is 1 or 0, or whose style computes to 1px.
2. Drop `<img>` with no `alt` text at all (decorative or tracking, either way not information).
3. Drop known tracker hostnames: `open.convertkit-mail`, `click.*`, `*.list-manage.com`,
   `track.*`, `email.*/o/`, `sendgrid.net/wf/open`, `mailchimp` `list-manage` beacons.
4. Convert remaining images to `[image: alt text]` and drop the URL entirely. A base64 data URI inlined
   in an email body can be tens of thousands of tokens on its own, so this must be unconditional.

**Redirect and tracking URLs.** Link hrefs are frequently 300 to 600 characters of signed redirect. Two
options: (a) strip hrefs entirely and keep only anchor text, which is right for a summarize/triage read;
or (b) unwrap the common wrappers and keep only the final destination host plus path. Concretely: strip
`utm_*`, `mc_cid`, `mc_eid`, `ck_subscriber_id`, `_hsenc`, `_hsmi`, `fbclid`, `gclid`, `mkt_tok`; and for
`click.*`/`links.*` wrappers where the real URL is a base64 or percent-encoded query parameter, decode it.
Anthropic's rule applies here too: "eschew low-level technical identifiers", and a signed redirect token
is exactly that.

**Headers.** Return `from`, `to`, `cc`, `subject`, `date`, `message_id`, `in_reply_to` and nothing else by
default. `Received:` chains, DKIM signatures, `X-*` headers and `List-*` headers are pure noise for the
model and can be hundreds of tokens per message. Gate them behind `fields: ["headers_full"]`.

**Attachments.** Return `filename`, `size`, `mime_type` is arguably worth keeping here despite Anthropic's
general advice, plus an index. Never inline base64.

Evidence quality note: I did not find a published MCP email server that documents measured token savings
from these steps. The libraries and heuristics are well established in the email-processing world; the
MCP-specific evidence is absent, so treat the exact ordering above as engineering judgement.

---

## 3. Anti-patterns, with evidence

### 3.1 Truncation that names an impossible recovery path

The single best-documented failure. microsoft/vscode issue 311068: VS Code truncates a large
`get_file_contents` result from the GitHub MCP server, marks it `isTruncated=true`, and tells the agent
"you can read the full contents of any truncated resources by passing their URIs as the absolutePath to
the read_file tool" with a `vscode-chat-response-resource://` URI. Passing that URI to `read_file` fails
with "File is outside of the workspace, and not open in an editor, and can't be read." The reporter's
summary is the lesson: "The hint instructs a recovery action that is impossible to perform. This causes AI
agents to enter a confused state where they have been told a recovery path exists, attempt it, fail, and
have no clear way forward."
<https://github.com/microsoft/vscode/issues/311068>

Rule: a truncation marker must name a recovery action YOUR server can actually service. A marker pointing
at a client capability, or at a cursor you did not issue, is worse than no marker.

### 3.2 Silent truncation by the client, below your own limits

- github/copilot-cli issue 1732: "MCP tool responses silently truncated to 10KB before large-output-to-file
  mechanism can save them", with the marker `<output too long - dropped N characters from the middle>`.
  <https://github.com/github/copilot-cli/issues/1732>
- anthropics/claude-code issue 2638: an 8,046 character MCP response displayed at roughly 700 characters,
  cut mid-sentence. <https://github.com/anthropics/claude-code/issues/2638>
- lobehub uses `DEFAULT_TOOL_RESULT_MAX_LENGTH = 6000` characters.
- openai/codex PR 20260 adds truncation of large MCP tool outputs in rollouts.
  <https://github.com/openai/codex/pull/20260>

Implication: clients truncate at wildly different and much smaller limits than Anthropic's 25,000 token
guidance. If your default response is 30 KB you are not choosing what gets cut, the client is, and it will
cut from the middle or the end. Budget for a few thousand characters, not 25,000 tokens.

### 3.3 Truncation middleware breaking structured output

PrefectHQ/fastmcp issue 3717: "ResponseLimitingMiddleware truncation breaks tools with outputSchema".
Generic size-limiting middleware truncates the payload and the result then fails schema validation, so the
model gets a validation error instead of a partial answer. Truncate at the FIELD level inside your own
formatter, never as a blind byte cut over a serialized structured result.
<https://github.com/PrefectHQ/fastmcp/issues/3717>

### 3.4 Truncation that silently corrupts a WRITE

github/github-mcp-server issue 2182: `create_or_update_file` silently truncates files of roughly 500+
lines, "with the tool reporting success but delivering truncated content". Size limits applied to write
paths are a data-loss bug, not a token optimization. Never truncate an input you are about to persist, and
never report success on a partial write.
<https://github.com/github/github-mcp-server/issues/2182>

### 3.5 Models ignoring pagination

Repeatedly reported, though I found no controlled study. The consistent community claim is that models
ignore cursors unless the tool DESCRIPTION says pagination exists, and that adding explicit notices to the
description makes agents follow pagination links consistently. See
<https://chatforest.com/guides/mcp-pagination-patterns/>. Contradicting risk: an agent told "more exists"
will often drain the whole list anyway, which is worse than one large response because each page repeats
the overhead. Mitigation used by GitHub is a hard server-side cap plus `has_more`, so draining is bounded.
Treat "models will paginate sensibly" as unproven.

### 3.6 Consolidated action tool versus many narrow tools

Evidence here is genuinely thin and mostly one-sided advocacy. What can be said:

FOR consolidation:
- Anthropic explicitly recommends it, on workflow grounds rather than token grounds: "Instead of
  implementing a `list_users`, `list_events`, and `create_event` tools, consider implementing a
  `schedule_event` tool which finds availability and schedules an event."
  <https://www.anthropic.com/engineering/writing-tools-for-agents>
- GitHub's own MCP server moved to consolidated action tools: `issue_read` with a `method` enum of five
  actions, `issue_write`, `pull_request_read`, `projects_write`, `actions_list`, `label_write`.
  Vendor-scale production evidence that the shape works.
  <https://github.com/github/github-mcp-server/tree/main/pkg/github/__toolsnaps__>
- A frequently cited figure: 3 consolidated tools covering 27 actions at roughly 5,000 tokens versus
  Playwright's 21 tools at roughly 9,700 tokens, i.e. 181 vs 464 tokens per function. This comes from
  vendor/blog material, not a controlled eval, so treat the ratio as illustrative only.

AGAINST, and the caveats:
- AWS's tool-design article notes the failure mode consolidation invites: "failed tool calls, wrong
  parameter values, and retries that waste context" when semantics are unclear, and recommends "keeping
  tool parameter counts around eight or fewer".
  <https://aws.amazon.com/blogs/machine-learning/mcp-tool-design-practical-approaches-and-tradeoffs/>
  A consolidated tool naturally accumulates parameters, so the union of all actions' parameters is the
  thing to police.
- Anthropic's namespacing finding cuts the other way: they report prefix vs suffix namespacing has
  "non-trivial effects on our tool-use evaluations", which implies the model is genuinely sensitive to
  tool NAME surface, and a single tool gives it less name signal to work with.
- The destructive-annotation problem is real and structural: with one tool per resource, a client can only
  see one `destructiveHint` for the whole tool, so a delete action rides on the same annotation as a
  harmless read.

Honest verdict: I found NO published controlled evaluation measuring accuracy of a single action-enum tool
versus N narrow tools. The strongest available evidence is that the largest first-party server (GitHub)
chose consolidation and ships it at scale, and that Anthropic recommends it. The mitigation that shows up
in GitHub's schemas is to spend real description budget on the action enum itself, enumerating what each
action does and returns, which is exactly what a narrow tool's description would have said.

---

## 4. Distilled checklist

Tagged "safe, do it" (no plausible client-behaviour downside) or "risky, depends on client behaviour".

| # | Practice | Tag | Source |
|---|---|---|---|
| 1 | Make the DEFAULT response shape minimal (a `Minimal*` projection), not the full upstream object. Field selection narrows further; it does not replace a lean default. | safe, do it | <https://github.com/github/github-mcp-server/blob/main/pkg/github/minimal_types.go> |
| 2 | Strip quoted reply chains, signatures, tracking pixels and redirect query params from email bodies before they ever reach the model. Largest single win for an email server. | safe, do it | <https://github.com/mailgun/talon>, <https://github.com/lever/planer> |
| 3 | Never inline base64 attachment data or data-URI images. Return filename, size, mime type, index. | safe, do it | <https://www.anthropic.com/engineering/writing-tools-for-agents> |
| 4 | Return only `from,to,cc,subject,date,message_id,in_reply_to` headers by default. Gate `Received`, DKIM, `X-*`, `List-*` behind an opt-in. | safe, do it | same |
| 5 | Add a `fields` array parameter with a per-tool enum listing only fields that tool can actually emit. Name the heaviest fields in the description so the model knows what to drop. | safe, do it | <https://github.com/github/github-mcp-server/blob/main/pkg/github/minimal_types.go> |
| 6 | Add a `response_format` / verbosity enum (`concise` \| `detailed`) so the model OPTS IN to detail rather than being forced into a lossy summary. Anthropic measured 72 vs 206 tokens on their example. | safe, do it | <https://www.anthropic.com/engineering/writing-tools-for-agents> |
| 7 | Never return a bare capped array. Always ship `total_count` or an explicit `has_more` boolean so a truncated list cannot be mistaken for a complete one. | safe, do it | <https://github.com/github/github-mcp-server/blob/main/pkg/github/ui_tools.go> |
| 8 | Truncate at the FIELD level in your own formatter, never as a blind byte cut over a serialized result. Blind cuts break structured output validation. | safe, do it | <https://github.com/PrefectHQ/fastmcp/issues/3717> |
| 9 | Every truncation marker must name a recovery action YOUR server can service (a parameter you accept, a cursor you issued). Never point at a client capability. | safe, do it | <https://github.com/microsoft/vscode/issues/311068> |
| 10 | Never truncate on a WRITE path, and never report success on a partial write. | safe, do it | <https://github.com/github/github-mcp-server/issues/2182> |
| 11 | Keep the tool description to one sentence; put per-action semantics in the action enum's property description; keep other property descriptions to 3 to 8 words; express constraints as JSON Schema keywords, not prose. Target 1.2 to 1.6 KB per tool. | safe, do it | <https://github.com/github/github-mcp-server/tree/main/pkg/github/__toolsnaps__> (n=117, median 1,215 B) |
| 12 | Prompt-engineer error responses to state the fix, not the error code. Errors are a free steering channel. | safe, do it | <https://www.anthropic.com/engineering/writing-tools-for-agents> |
| 13 | Budget your default response for a few thousand characters, not 25,000 tokens. Clients truncate at 700 B to 10 KB and you will not choose what gets cut. | safe, do it | <https://github.com/github/copilot-cli/issues/1732>, <https://github.com/anthropics/claude-code/issues/2638> |
| 14 | Prefer compact Markdown or a line-oriented table over JSON for LIST results (30 to 40 percent fewer tokens); keep JSON where a value must be fed back verbatim. | risky, depends on client behaviour | <https://www.improvingagents.com/blog/best-nested-data-format/> (accuracy ordering is model dependent and reverses on Llama) |
| 15 | Rely on the model to paginate rather than capping server-side. State pagination in the description AND cap hard, because agents both ignore cursors and drain them. | risky, depends on client behaviour | <https://chatforest.com/guides/mcp-pagination-patterns/> (no controlled study found) |
| 16 | Consolidate related operations into one tool with an action enum. Cheaper and vendor-proven, but no controlled accuracy eval exists, parameter counts creep past the recommended eight, and destructive annotations get smeared across safe actions. | risky, depends on client behaviour | <https://aws.amazon.com/blogs/machine-learning/mcp-tool-design-practical-approaches-and-tradeoffs/>, <https://github.com/github/github-mcp-server/tree/main/pkg/github/__toolsnaps__> |

### Where the evidence is thin, stated plainly

- No controlled eval of action-enum consolidation vs narrow tools exists publicly. Item 16 rests on
  vendor adoption plus Anthropic's recommendation, not measurement.
- The "[truncated, N more chars, call X with cursor Y]" marker shape is a good idea the ecosystem has
  NOT converged on. Real servers mostly emit bare markers like `... [TRUNCATED]`.
- Markdown-vs-JSON accuracy claims are overstated in blog posts. The token saving is solid; the accuracy
  ordering flips by model and only matters on large deeply nested payloads.
- No published MCP email server documents measured token savings from HTML-to-text, quote stripping or
  pixel removal. The libraries are mature, the MCP-specific numbers do not exist.
