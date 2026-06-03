# MCP Tool Naming & Description Review

_Review of the 34 tools in `supabase/functions/mcp-server/index.ts` (`TOOL_REGISTRY`) against published best practices for writing tools for AI agents._

## Sources consulted

- [Writing effective tools for AI agents — Anthropic](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [Effective context engineering for AI agents — Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [MCP tool descriptions: overview, examples, and best practices — Merge](https://www.merge.dev/blog/mcp-tool-description)
- [5 Best Practices for Building MCP Servers — Snyk](https://snyk.io/articles/5-best-practices-for-building-mcp-servers/)
- [MCP Server Naming Conventions — ZazenCodes](https://zazencodes.com/blog/mcp-server-naming-conventions)
- [SEP-986: Specify Format for Tool Names — modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/986)

## The rules, distilled

1. **Names** — `snake_case`; 1–64 chars; pattern `[prefix]_[action]_[qualifier]`; namespace by service/resource; short, unambiguous, no abbreviations. Distinct names so the agent never confuses two tools.
2. **Descriptions** — lead with the essential fact (agents may not read to the end); describe the tool "as you would to a new hire," making implicit knowledge explicit; state scope, limits, and the preceding tool call in the workflow.
3. **Parameters** — unambiguously named (`user_id`, not `user`); documented with format, defaults, examples, edge cases.
4. **High signal over completeness** — every word competes for the agent's context budget; return/describe only what *changes the agent's behavior*. Avoid low-level technical identifiers the agent can't act on.
5. **Metadata** — use MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), `title`, and `outputSchema` to communicate behavior structurally rather than in prose.

---

## What's already good — and why

### 1. Parameter naming is textbook (rule 3)
`inbox_id`, `message_id`, `destination_folder_id`, `draft_id`, `scheduled_send_id`, `email_address` — every identifier carries its referent. This is exactly the `user_id`-not-`user` principle Anthropic calls out. An agent can never wonder "id of *what*?"

### 2. Workflow chaining is explicit (rule 2)
Descriptions name the prerequisite call and the follow-up:
- `list_inboxes`: *"Call this FIRST to discover the inbox_id values that every other tool requires."*
- `list_messages`: *"Use read_email to fetch the full content… call list_inboxes first."*
- `rename_folder`/`delete_folder`: *"Use list_folders to obtain the folder_id before calling this tool."*

This is the single highest-leverage practice in the Anthropic guidance and it is applied consistently. It tells the agent where each tool sits in the sequence, which is what reduces wrong-tool and missing-argument errors.

### 3. Metadata is best-in-class (rule 5)
`TOOL_ANNOTATIONS` sets `readOnlyHint`/`destructiveHint`/`idempotentHint` per tool, `openWorldHint` for all (every tool hits an external provider), `title` mirrors a human label, and `outputSchema`/`structuredContent` are emitted. Destructive tools (`delete_email`, `bulk_delete`, `delete_folder`, `search_and_delete`) are correctly flagged. This lets clients render confirmations and lets the agent reason about safety **without** spending the prose budget on it — exactly what annotations are for.

### 4. Lead-with-the-essential structure (rule 2)
Almost every description opens with a one-line statement of what the tool does before any detail (*"Move an email message to a different folder…"*, *"Schedule an email to be sent at a future date and time."*). Good for agents that don't read to the end.

### 5. Scope, limits, and irreversibility are stated (rule 2)
Max counts (`Max 50 IDs`, `up to 500`), size budgets (`10 MB total`, shared across batch), pagination caveats (*"not all providers support stable offset-based pagination"*), and `THIS ACTION IS IRREVERSIBLE` warnings give the agent the boundaries it needs before committing.

### 6. High-signal provider quirks are present (rule 4)
The provider differences that **change what the agent should do** are surfaced well:
- *"Gmail does not support copy_email — use move_email instead."*
- *"`query` … ignored on Fastmail."*
- *"you never need to know provider query syntax"* on the structured search tools.

These are the *right* kind of provider detail — they alter tool choice.

### 7. `list_inboxes` ordered first, with a documented reason
The comment ties ordering to a real client bug (tool-index truncation on fresh connect). Intent-preserving and correct.

---

## What can be improved — and why

### A. Trim low-signal provider internals from descriptions  ⭐ highest impact
Most descriptions carry a per-provider implementation catalogue, e.g. `bulk_move`:

> *"IMAP: UID MOVE per source-folder group (falls back to COPY+EXPUNGE if MOVE unsupported); Gmail: messages.batchModify (label swap…); Outlook: per-message Graph move; Fastmail: single JMAP Email/set update…"*

**Why it's a problem:** Anthropic's rule 4 — every token in a description shapes (and competes for) the agent's context, and tools should expose only information the agent can *act on*. The agent does not pick the IMAP command or the Graph endpoint; the server does. "IMAP uses UID MOVE" cannot change any decision the agent makes. Repeated across ~25 tools × 4 providers, this is several hundred tokens of pure noise loaded on every `tools/list`, and it dilutes the high-signal sentences around it.

**Keep** the behavior-changing quirks (Gmail-no-copy, Fastmail-ignores-`query`, soft-vs-permanent delete, unstable offset). **Move** the command-level mechanics (which IMAP verb, which Graph path, which JMAP method) into code comments or developer docs, not the agent-facing `description`. This is the change that would most improve the registry.

### B. Resolve naming inconsistencies (rule 1: distinct, predictable names)
The set is all `snake_case` (good), but the action/qualifier pattern drifts:

| Issue | Current | Why it matters | Suggestion |
|---|---|---|---|
| Singular vs plural distinguishes single-vs-batch | `read_email` / `read_emails` | One missing/extra "s" is the *only* signal separating two tools — high collision risk for an agent | Make the distinction explicit, e.g. `read_email` / `read_emails_batch`, or lean on the title `Read Emails (batch)` and add a "for multiple IDs use read_emails" pointer in `read_email` |
| Suffix inconsistency on state-change tools | `mark_read`, `mark_unread` vs `flag_email`, `unflag_email`, `archive_email` | Same conceptual group, two naming shapes — less predictable for the agent guessing a name | Standardize: either `mark_read`/`mark_flagged`… or `read_email`-style suffixes throughout |
| Scheduling group not parallel | `schedule_send`, `list_scheduled`, `cancel_scheduled` | `schedule_send` is verb_noun; the other two are verb_adjective with the noun ("send") dropped | `schedule_send` / `list_scheduled_sends` / `cancel_scheduled_send` (matches the titles already used) |

None of these are bugs; they're predictability costs. Anthropic notes that namespacing/naming scheme choices have *measurable* eval effects, so consistency is worth a pass.

### C. Consider resource-first namespacing for large groups (rule 1, optional)
Anthropic recommends namespacing by resource (`asana_projects_search`) so related tools cluster. The drafts group (`list_drafts`, `create_draft`, `update_draft`, `send_draft`) and folders group would cluster better as `draft_list`/`draft_create`/… or `folder_create`/`folder_rename`/… Verb-first (the current style) is a legitimate alternative and is *mostly* consistent, so this is a judgment call — but if you ever reorganize, resource-first groups the 34 tools into scannable families. **Don't** add a server-level prefix (`email_*`/`mcpemails_*`): the MCP client already namespaces by server name, so that would be redundant tokens.

### D. Make irreversibility consistent (rule 2)
`send_email`, `forward_email`, and `send_draft` carry *"This action is irreversible — use carefully."* but `reply_to_email` does not — yet it also sends mail irreversibly. Add the same note (and/or the agent relies on `destructiveHint`, but reply is currently `destructiveHint: false`, so the prose is the only signal). Align the three send-paths.

### E. De-duplicate the `inbox_id`/`inbox` blurb (maintainability, not agent-facing)
The identical ~3-line `inbox_id` and `inbox` descriptions are inlined ~30 times. The agent is fine with this (each tool is self-contained), but for maintainability extract a shared `INBOX_ID_PROPERTY` / `INBOX_PROPERTY` constant the way `STRUCTURED_SEARCH_PROPERTIES` and `RAW_QUERY_DESCRIPTION` already are. Reduces drift risk when the wording changes.

### F. Add a few more parameter examples (rule 3, minor)
`read_email.message_id` and `search_contacts.query` include concrete examples — excellent. Extend the same to `destination_folder_id` (already lists aliases — good) and `send_at` (already has ISO examples — good). Mostly done; just verify every opaque-string param has either a format or an example.

---

## Verdict

The registry is **well above average** for an MCP server: parameter naming, workflow chaining, annotations, and output schemas are all done the way the Anthropic guidance prescribes, and the behavior-changing provider quirks are surfaced where they matter. The one substantive win available is **(A) stripping the per-provider command mechanics from the agent-facing descriptions** — it's the clearest violation of the "high signal only" rule and the easiest large token saving across all 34 tools. After that, the naming-consistency cleanups in **(B)** are the next-best polish.
