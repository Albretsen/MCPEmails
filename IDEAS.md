# Ideas

Raw idea capture. Nothing here is decided, scoped or scheduled. One heading per
idea, newest first, with the date it was captured.

## Inbox handled for you (2026-10-24)

Sell the result instead of the tool ("service as software"). A scheduled agent
triages the inbox and leaves reply drafts for the user to review and send. It
never sends on its own.

- Builds on what exists: automations, scheduling, draft tools and the draft
  card. The new piece is an LLM step inside the automation run, which today is
  rules only.
- Priced per inbox per month or per drafted reply, not per seat.
- We pay the inference, not the customer's own AI chat, so cost per inbox
  decides whether it makes money.

Open questions: inference cost per inbox, how to avoid charging people who
already drive MCPEmails from their own LLM twice, and what counts as a
"handled" email if billing is per outcome.

## Done-for-you unsubscribe and cleanup (2026-10-24)

A one-off job that unsubscribes the user from newsletters and mailing lists
they no longer read, then sorts and archives the backlog.

- Reads List-Unsubscribe headers and acts on them, then moves or archives what
  is left with the existing organize tools.
- The user approves the list of senders before anything is unsubscribed.
- Cheap way to test whether people pay for an outcome before building
  "Inbox handled for you".

Open questions: how to handle senders with no List-Unsubscribe header, whether
one-click unsubscribe (RFC 8058) covers enough senders, and whether this is a
paid one-off or part of a plan.

## Auto-triaging customer support that fixes its own bugs (2026-10-21)

A customer support system built on top of the mailbox tooling we already have.

- Incoming support mail is filtered by JEV (sic, as dictated) on two axes:
  how important it is, and whether it needs a feature build or a bug fix.
- Bug fixes get handed to a Docker sandbox that reproduces the bug, builds the
  fix and opens a PR.
- Feature requests stay on a list for a human to pick from, they do not
  auto-build.

Open questions: what the importance signal actually is, how a sandboxed agent
gets a safe repro of a customer bug without customer data leaving the account,
and what gates a generated PR before a human sees it.
