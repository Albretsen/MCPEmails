# Incident: working briefs with customer PII committed to a public repo

**Date:** 2026-09-16. **Severity:** high (customer PII, public, not rotatable).
**Status:** history rewritten and force-pushed; awaiting GitHub Support GC of the
orphaned objects.

## What happened

`ec14bdb` ("feat: let people turn the draft editor card off") swept eight
local-only working briefs into the commit alongside the feature:

```
docs/PROMPT-ab-testing.md
docs/PROMPT-attach-by-reference-and-bulk-forward.md
docs/PROMPT-connector-first-run-no-account.md
docs/PROMPT-draft-editor-card-remount.md
docs/PROMPT-finish-billing-dunning.md
docs/PROMPT-fix-forward-attachments.md
docs/PROMPT-fix-forward-delivery-status.md
docs/PROMPT-paywall-to-checkout-quality.md
```

Between them they contained a paying customer's personal mailbox address next to
that customer's purchase timestamp, plan and MRR; the outreach suppression list's
third-party address; the founder's own personal address next to provider
configuration; and MRR figures, sale counts and the price catalogue.

`a376fa7` ("revert: untrack the 8 PROMPT briefs I committed by mistake") deleted
them at the tip only. That is not remediation. `ec14bdb` remained an ancestor of
`origin/main`, so the repo's own commit page rendered every file to anyone
browsing history. No blob SHA was needed. The repository is public.

`a376fa7`'s message also claimed a workspace UUID was exposed. A full scan for
UUIDs, in both full and truncated form, found none. That commit message is no
longer the public account of the incident; this file is.

## What was done

1. `git filter-repo --invert-paths` over the eight paths, in a throwaway mirror
   clone so the rewrite could not disturb in-flight worktrees.
2. Verified: the paths appear nowhere in any ref's history; the resulting tip
   tree is byte-identical to the pre-rewrite tip tree; every other branch and tag
   keeps its original SHA. `main` moved `a376fa7` -> `18eaaea`, and the now-empty
   revert commit was pruned.
3. Force-pushed `main` only.
4. Armed two guards so the next `git add -A` cannot repeat it: a `.gitignore`
   rule for `docs/PROMPT-*.md` (with explicit exceptions for the two reviewed
   briefs that are legitimately tracked, both verified free of third-party
   addresses), and `.githooks/pre-commit`, which refuses an unallowlisted brief
   and refuses any consumer-mailbox address added under `docs/`. The hook is
   activated by `git config core.hooksPath .githooks`, which is per-clone and has
   to be set again in a fresh clone.

## What is still open

The pre-rewrite commits stay retrievable by direct SHA until GitHub garbage
collects them. That needs a GitHub Support request naming the repository and
asking for GC of unreachable objects; the same request was filed for the
2026-09-15 purge. Anyone who cloned or forked between 2026-09-16 and the
force-push still holds the objects, and a fork would need the same treatment.

The customer address cannot be rotated the way a leaked key can. Whether the
affected customer is notified is a judgement call that belongs to the founder,
not to this document.

## The rule this came from

Briefs, audit notes and analysis that quote production data stay outside the
repository, or are written with the data masked. The convention was already
"briefs stay untracked", but it was unenforced and inconsistently applied: two
briefs were tracked on `main` the whole time, so their presence offered no
signal that the other eight were different. Conventions that depend on
remembering are not controls; the `.gitignore` rule and the hook are.
