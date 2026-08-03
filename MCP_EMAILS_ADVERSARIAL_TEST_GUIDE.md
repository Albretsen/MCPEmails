# MCP Emails adversarial test guide

## Mission and safety boundary

Find defects, unsafe behavior, confusing tool behavior, and misleading errors in MCP Emails. Test as the `bjellanda` mailbox. You may send mail **only when every To, Cc, Bcc, Reply-To, and forwarded recipient is the exact `bjellanda` email address**. Never reply to, forward, move, flag, delete, or otherwise alter an existing non-test message.

Treat every successful self-send as a test fixture. Use this unique prefix in every test subject:

```
[MCPE-BREAK-YYYYMMDD-HHMM-<case>]
```

Before mutations, create a folder called `MCPE_BREAK_TESTS` (or a similarly unique name). Use only messages with that prefix. At the end, move test mail to Trash; do not permanently delete unless the test specifically concerns permanent deletion and the targets have been independently verified as test fixtures.

## How to work

1. Call the connector's tool-discovery operation and record the exact tools, actions, schemas, scopes, annotations, and error messages it exposes. MCP clients may display grouped names (for example `email_read` + `action`) or legacy names (for example `email_search`); use the names actually surfaced.
2. Find the `bjellanda` inbox ID and capability list. Test both `inbox_id` and the mailbox-address selector, where supported; record whether selecting no inbox auto-resolves cleanly.
3. Make one baseline self-send and confirm the entire loop: send response, Sent copy, Inbox delivery, search result, message read, and body/headers. Use this fixture for later reply, forward, move, flag, attachment, and delete tests.
4. Work through the test matrix below. Isolate each mutation to a fixture or the test folder. Verify outcomes by rereading/listing/searching after every mutation; success responses alone are not proof.
5. For every finding, capture the request (with secrets removed), exact response/error, expected versus actual behavior, provider/mailbox, timestamp, and message/folder IDs. Classify severity and include a minimal reproduction.

## Test matrix

### 1. Discovery, connection, and guardrails

- Call discovery repeatedly; look for missing tools, contradictory descriptions, duplicated/legacy aliases, scope mismatches, or unstable schemas.
- Invoke an inbox-bound read operation with no mailbox selector, a valid `inbox_id`, the address selector, a random UUID, malformed UUID, and both selectors disagreeing. It should be unambiguous and never use an unintended mailbox.
- Use harmless invalid inputs: unknown action, unknown property, wrong type, empty required strings/arrays, oversized limits, negative offsets, malformed dates, invalid base64, invalid email. Check that errors identify the field and do not become generic 500s.
- In the MCP client UI, assess whether destructive and irreversible operations are visibly marked and whether the parameter descriptions tell an agent how to obtain IDs.

### 2. Reading and search correctness

- List Inbox, Sent, Drafts, Trash, and `MCPE_BREAK_TESTS`; check ordering, pagination (`limit`, offsets/cursors), empty folders, and whether counts/results are consistent between adjacent pages.
- Read one fixture by ID, then read it in a batch with duplicates, a nonexistent ID, and mixed valid/invalid IDs. Look for partial-result clarity and accidental whole-call failure.
- Search fixtures by exact subject, a subject fragment, body text, sender, recipient, unread, flagged, attachment, `since`, `before`, and combinations of two or more filters.
- Test Unicode/edge content: Norwegian characters (`æøå`), emoji, right-to-left text, quotes, angle brackets, plus-addressing, mixed case, very long subject/body, and whitespace-only-looking searches. Compare search results to the original message.
- Search the same fixture in each relevant folder and then search with raw-query syntax, if exposed. Note unclear provider-specific behavior, unexpected duplicate results, and pagination overlap/skips.
- Read an HTML fixture containing a table, links, inline styles, scripts/event attributes written as literal text, and plain-text alternative. Ensure presentation is usable and unsafe HTML is handled appropriately without corrupting legitimate content.

### 3. Sending and delivery loop

For every send test, set **only** `to: [bjellanda address]`; omit Cc/Bcc/Reply-To unless the test says otherwise, in which case set that field to the same address.

- Plain text: short body, Unicode body, long multi-paragraph body, long subject near the advertised limit, and line endings/leading/trailing whitespace.
- Multipart HTML: send distinct plain and HTML versions; verify both arrive correctly and no markup is unexpectedly mangled. Try malformed but harmless HTML and special characters in attributes/text.
- Recipients: test case variations and display-name format only if it still resolves to the exact `bjellanda` address. Test duplicate `to`/`cc`/`bcc` entries all pointing to self and verify whether delivery is duplicated or deduplicated predictably.
- Test validation without delivery: blank subject/body, invalid address, >50 self entries, extra fields, malformed Reply-To, and empty recipient array. No invalid call should create a sent message.
- Attachments: send a small text file, zero-byte file, Unicode filename, filename with quotes/newline-like characters, declared MIME type that conflicts with content, and multiple small files. Verify names, MIME type, size, bytes, ordering, and read/download behavior.
- Boundary test attachments just below and just above the advertised total-size and count limits. The rejection must be understandable and must not send a partial message.
- Toggle signature inclusion. Compare Sent and received messages for one signature only, correct HTML/text rendering, and no signature on a call that explicitly disables it.
- If delivery is slow, measure it. A send response must not claim success when the message is absent from both Sent and Inbox after a reasonable retry window.

### 4. Threads, replies, and forwards

- Reply to a self-sent fixture with `reply_all: false`. Verify exactly one self-delivery, `Re:` normalization, In-Reply-To/References threading, and correct sender/recipient.
- Test `reply_all: true` **only** on a fixture whose every original recipient is `bjellanda`; never use this on a real received message. Look for self-duplication, Bcc leakage, recipient expansion, and thread breakage.
- Forward a self fixture only to self, with and without original attachments. Verify `Fwd:` normalization, intro text placement, body fidelity, attachment behavior, and no headers leak unexpectedly.
- Attempt reply/forward using a deleted, moved, malformed, cross-folder, and nonexistent test message ID. Errors should be precise and must never fall back to some other message.

### 5. Folders, moves, copies, flags, and deletion

- Create `MCPE_BREAK_TESTS`; list folders again and capture its ID/name/type. Try same-name creation, Unicode name, leading/trailing whitespace, nested separator-like names, excessive-length name, and reserved/system-like names. Do not touch system folders.
- Rename the test folder twice, then move a fixture into it by canonical alias, name, and native ID. Check that the visible state, search scope, and list results agree.
- Copy a fixture to the test folder; ensure the original remains. Repeat the copy to reveal duplicate/idempotency semantics. Move it back and verify there are not hidden duplicates.
- Flag/unflag and read/unread the fixture singly and in small batches. Re-run each operation to check idempotency and whether result states are accurate.
- Use a batch that includes a duplicate ID and an invalid ID. Inspect whether good IDs succeed, failures are identified, and counts match actual mailbox state.
- Run search-and-move only with the unique test prefix and a small limit. Test no matches, exactly one match, and a result count above the requested limit. Confirm it never moves outside the search scope.
- Delete a single fixture to Trash, confirm it leaves the source, appears in Trash, and can be read/listed as expected. If restore/move-back is supported, restore it. Test permanent delete only for a freshly verified fixture already in Trash, then confirm it is truly gone and the warning/confirmation UX was adequate.

### 6. Drafts, schedules, signatures, and contacts

- Draft lifecycle: create a self-addressed draft, list it, read/inspect it if supported, update subject/body/recipients/attachments, send it to self, then verify delivery and that draft state is sensible. Try sending twice and concurrent update/send if the client permits.
- Test invalid draft fields and a draft with no recipient; it should fail safely and explain whether it was persisted.
- Scheduled send: schedule a self-addressed message a few minutes ahead (use a clearly unambiguous timezone/ISO timestamp), list it, cancel it, and confirm it is not delivered. Then schedule a second fixture and verify it sends once at approximately the requested time. Test past/invalid timestamps and cancel twice.
- Signature: read it, set a harmless distinctive test signature, send a fixture with and without inclusion, then restore the exact original signature. Test HTML/plain text, Unicode, long content, and malformed HTML. Do not leave test data in place.
- Contact search: search for the exact self address, case variation, partial local part, and no-match string. Check relevance, pagination, duplicates, and whether it exposes more personal data than the tool description promises.

### 7. Concurrency, retries, limits, and resilience

- Rapidly issue harmless reads/searches and observe rate-limit behavior: status/error type, retry guidance, recovery after waiting, and whether mutations are blocked only when expected. Stay within sensible load; do not attempt a denial-of-service test.
- Trigger two near-simultaneous sends with distinct fixture subjects, then duplicate the exact same send if the client retry mechanism allows it. Record whether duplicate delivery is expected, detectable, or prevented.
- Race a read with a move, move with delete, and draft update with send, using only fixtures. Confirm no misleading success, corrupted message, or silent loss occurs.
- Intentionally interrupt or retry a request at the client level (where safe). Verify that timeouts/errors make the side-effect status discoverable rather than forcing risky guessing.
- Let a scheduled send/draft/folder test sit briefly, reconnect, and repeat the read. Look for stale IDs, cache artifacts, token-expiry errors, and recovery instructions that a non-expert agent can act on.

## UX checks throughout

Mark a UX issue when an agent could reasonably: select the wrong mailbox; mutate real mail by mistake; be unable to discover a required ID; misunderstand a provider difference; mistake a partial failure for success; or be unable to determine whether an irreversible send occurred. Record confusing defaults, overly large responses, inconsistent terminology (`folder` versus `label`, `message_id` formats), missing examples, and errors without a fix path.

## Completion and report

1. Move all prefix-matching fixtures and the test folder's contents to Trash. Delete the test folder only after it is empty. Restore the original signature.
2. Produce a short report with: environment/client, mailbox provider, tools/scopes seen, tests run, pass/fail/blocked results, and a separate entry for each bug or UX issue.
3. Use this finding format:

```
Title: [severity] concise problem
Preconditions: client, provider, scope(s), mailbox selector
Steps: exact minimal calls/inputs (redact credentials)
Expected: what a safe, understandable connector should do
Actual: response plus verified mailbox state
Impact: data loss, incorrect delivery, privacy, reliability, or agent confusion
Evidence: timestamps, message/folder IDs, screenshots/logs
```

Severity guide: Critical = mail can reach someone other than self, privacy/security exposure, or unintended permanent data loss. High = wrong mutation, duplicate send, or unreliable delivery. Medium = broken supported workflow or dangerous ambiguity. Low = recoverable defect, confusing copy, or poor error UX.
