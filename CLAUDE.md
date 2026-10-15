# MCPEmails

Instructions for every coding agent working in this repository.

## Keep the public changelog current

When a PR ships something a customer would notice, add an entry to `apps/web/src/lib/changelog/entries.mjs` in the same PR. Read that file's header comment first; it is the full rulebook.

- One or two sentences on what changed for the customer. If the change is a fix, describe what was broken before. Date it the day it lands on `main`.
- Positive or neutral wording only. Describe what works now. Do not describe something that was removed, withheld or made worse.
- Never add an entry about pricing, plans, usage limits or billing, even when a price or limit moved.
- Leave out internal work: CI, tooling, admin and kiosk pages, analytics, internal email settings, refactors, dependency bumps, and perf work a customer cannot feel.
- Leave out anything still behind an internal rollout flag (for example the draft editor card) until it is on for customers.
- Style: straight apostrophes, no em dashes, no angle brackets (`<` breaks next-intl in production).
- Keep the `getEntries`, `getEntriesByMonth` and `getLatestDate` exports; the page imports them.
