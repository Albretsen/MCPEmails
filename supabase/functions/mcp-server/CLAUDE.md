# mcp-server

Rules for the MCP server edge function. The root `CLAUDE.md` still applies.

- Business, quota and upstream failures return a tool result with `isError: true`. JSON-RPC errors are only for malformed or unroutable requests. Machine-readable fields go in `_meta`, not `structuredContent`.
- Never loosen an advertised input schema (for example into string-or-array unions). Accept looser input in `argument-coercion.ts` instead.
- Keep new tool `outputSchema`s loose at the top level (`additionalProperties: true`, no `required`), and do not tighten existing ones without measuring the token cost: a strict union cost far more tokens.
- Never rename `inbox_list`, `email_delete` or `email_organize`: billing, funnel metrics and the bulk-approval flow use those names. Keep read and write tools as separate tools.
- Never run two commands at once on one `ImapClient`; wrap them in `runExclusive`. IMAP search covers INBOX only unless a folder is given, on purpose. Treat the folder part of a message id as opaque.
- Automations run unattended with no LLM in the loop. Delete is not an automation action, `filter.raw` stays refused, and the allow-lists are pinned by parity tests.
- Forward relays the original MIME byte for byte, with one ledger row per message.
- Email HTML and signature HTML share one allow-list sanitizer. Change it in one place.
- Sending a draft requires the `send:email` scope; no alternative scope may reopen it. Never content-type-check a CIMD document.
