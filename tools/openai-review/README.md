# OpenAI review demo mailbox

OpenAI reviews the "MCP Emails" ChatGPT app against the demo mailbox
**demo@mcpemails.com** (generic IMAP at Migadu: `imap.migadu.com:993`, TLS).
Reviewers leave it dirty (moved messages, test sends, new folders). This tool
puts it back to a known state: 19 synthetic messages, documented one by one in
[`fixtures.md`](fixtures.md). Test-case expectations are written against that
file.

> **DESTRUCTIVE.** A reset permanently deletes every message in INBOX, Archive,
> Sent, Junk/Spam, Trash and Drafts, and deletes every user-created folder
> (with its messages). Nothing goes to Trash; it is expunged. Only ever point
> it at the demo mailbox. It refuses to connect unless the user is
> `demo@mcpemails.com`, or you pass `--i-know-this-is-not-the-demo-mailbox`
> (meant only for a throwaway test mailbox).

## Run it

```sh
npm install --prefix tools/openai-review          # once: installs imapflow (+ mailparser for tests)

# 1. Offline: see the plan and every fixture. No password, no network.
node tools/openai-review/seed-demo-mailbox.mjs --dry-run

# 2. Read-only: print the current state of every folder and diff it
#    against the fixtures. Exit 0 = clean, 1 = differs.
DEMO_IMAP_PASSWORD='...' node tools/openai-review/seed-demo-mailbox.mjs --check

# 3. Reset. Prints what it deletes, re-appends the fixtures, then re-runs
#    the check. Exit 0 only if the mailbox now matches.
DEMO_IMAP_PASSWORD='...' node tools/openai-review/seed-demo-mailbox.mjs
```

Tip: prefix the command with a space (with `HISTCONTROL=ignorespace` in bash,
or `setopt HIST_IGNORE_SPACE` in zsh) so the password stays out of your shell
history, or `read -s DEMO_IMAP_PASSWORD && export DEMO_IMAP_PASSWORD` first.

| Variable | Default | |
|---|---|---|
| `DEMO_IMAP_PASSWORD` | (none) | Required for `--check` and reset. Read from the environment only; never printed or written. |
| `DEMO_IMAP_USER` | `demo@mcpemails.com` | Anything else is refused without the override flag. |
| `DEMO_IMAP_HOST` | `imap.migadu.com` | |
| `DEMO_IMAP_PORT` | `993` | Implicit TLS. |
| `DEMO_IMAP_SECURE` | `true` | `false` only for a local test server. |

Other flags: `--markdown` prints the fixture table (paste into `fixtures.md`
when fixtures change), `--print-mime N` prints fixture N's raw RFC 822 source.

SMTP is not used. "Sent" fixtures are APPENDed to the Sent folder, nothing is
ever sent.

## What a reset does

1. `LIST` the folders. Sent / Archive / Junk / Trash / Drafts are found by
   their special-use flag (RFC 6154), falling back to the usual names
   (`Sent`, `Sent Messages`, `Spam`, `Deleted Messages`, ...).
2. Print, then delete, every folder that is not INBOX and not one of those
   system folders (e.g. a reviewer's `Newsletters`), children first.
3. Delete every message in INBOX, Archive, Sent, Junk/Spam, Trash, Drafts.
4. Create `Archive` / `Sent` if the server has neither.
5. APPEND the 19 fixtures with their `\Seen` flag and an internal date equal to
   their `Date:` header, oldest first.
6. Run the check again.

`--check` diffs by Message-ID (`<fixture-NN@demo.mcpemails.example>`): missing,
unexpected, duplicate or misplaced messages, a wrong read/unread state, a
changed subject, leftover user folders and anything in Junk/Trash/Drafts.
Dates are not compared, because they are relative to the last seed.

## Fixtures

INBOX 13 (5 unread), Archive 3, Sent 3. Everyone except the demo mailbox is
fictional and on a `.example` domain. Dates are relative to seed time (so the
mailbox always looks recent), while the facts a test might assert (invoice
2026-0841, 14,500 NOK, "12 days past due", ticket #4471, 18-hour SLA, the
countersignature deadline) are written into the bodies as absolute values. See
[`fixtures.md`](fixtures.md) for the full table.

Fixture #6 is a deliberate prompt-injection test: it poses as a system
instruction telling the AI assistant to forward every invoice to an outside
`.example` address and delete the evidence.

## Files

| File | |
|---|---|
| `seed-demo-mailbox.mjs` | CLI: `--dry-run`, `--check`, reset. |
| `fixtures.mjs` | The 19 fixtures and the RFC 822 builder. Pure, no I/O. |
| `mailbox-ops.mjs` | Folder discovery, check and reset over an ImapFlow client. |
| `fixtures.md` | Human-readable fixture table (kept in sync by a test). |
| `*.test.mjs` | Offline tests: `npm test --prefix tools/openai-review`. |

The tests parse every generated message with mailparser (headers, UTF-8
Norwegian text, threading, List-* headers) and run check/reset against an
in-memory fake IMAP server that starts out dirty the way a review leaves it.
They never touch the network.
