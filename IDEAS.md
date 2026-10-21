# Ideas

Raw idea capture. Nothing here is decided, scoped or scheduled. One heading per
idea, newest first, with the date it was captured.

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
