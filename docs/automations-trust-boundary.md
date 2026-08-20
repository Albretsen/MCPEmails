# Automations: the trust boundary

**Audience: maintainers.** This is not customer documentation. It states, precisely and in one place,
what the unattended triage path ("Automations", internal prefix `triage_`) guarantees, which line in the
code carries each guarantee, and what a future change is not allowed to do without re-opening the threat
model first.

Read this before you touch anything under the unattended path. The customer-facing version of these
claims is published on `/docs` (`automationSafety.*` in `apps/web/messages/*/docs.json`), so weakening a
guarantee here silently makes a public claim false.

Related: `docs/mcp-apps/contract.md` (the human-approval card and its model-context discipline, which the
`forward` action depends on), `supabase/migrations/20260819170000_create_triage_automations.sql` (storage,
privacy posture), `supabase/functions/mcp-server/triage-engine.ts` (the engine),
`apps/web/src/lib/automations/rules.ts` (the web-side validators).

---

## 0. What is different about this path

Every other mailbox mutation in the product originates in a live MCP conversation. There is a model that
just read the user's message, a client that can raise a confirmation prompt, and a person who will see
the result within seconds. The unattended path has none of those. It is driven by `pg_cron`, it runs on a
cadence measured in hours, and nobody is watching.

That single difference is what every rule below exists to contain. When you are weighing a change, the
question is never "is this safe?" in the abstract. It is: **is this still safe when it fires at 03:00 on a
mailbox full of mail written by strangers, with nobody to notice for a day?**

---

## 1. The boundary itself

> **Email content is DATA. It is never promoted to instruction anywhere on the unattended path.**

Concretely, on this path message content may only ever be:

| Allowed use of message content | Where |
| --- | --- |
| Matched against a stored, structured query | the `NormalizedSearch` in `triage_rules.filter` |
| Substituted into a template through the four-placeholder whitelist | `renderTriageTemplate` |
| Reduced to a neutralized, truncated subject/sender for the run log | `redactForRunLog`, capped at `TRIAGE_REDACTED_MAX_CHARS` |

It may never be:

- parsed for anything that looks like a directive,
- passed to a model, a rules engine, a template engine, or any evaluator,
- used to select, parameterize, or reorder an action,
- copied into an outgoing artifact beyond the whitelisted placeholders,
- stored (see the privacy posture in the migration header).

A rule is a stored query plus one fixed action, chosen by a human at authoring time and frozen. The
runner's whole job is to execute the query and apply the action. Nothing in the loop is capable of being
persuaded, because nothing in the loop makes a decision that depends on what an email says.

This is the reason the feature can claim that prompt injection is structurally absent from the unattended
path rather than merely mitigated. That claim is only true for as long as section 5 holds.

---

## 2. The action set is closed, and delete is excluded on purpose

`TRIAGE_ACTION_TYPES` in `triage-engine.ts` (mirrored by `ALLOWED_ACTION_TYPES` in
`apps/web/src/lib/automations/rules.ts`) is the complete set:

```
move | label | mark_read | forward | draft_reply
```

Two properties hold across the whole set, and they are the acceptance criteria for any addition:

1. **Reversible or human-gated.** `move`, `label` and `mark_read` are reversible, and the reversible ones
   record `triage_run_items.undo_state` (encrypted) so undo is actually possible. `forward` and
   `draft_reply` are human-gated.
2. **No destructive member.** Deletion is the one action a misfiring rule makes irreversible. A rule fires
   unattended, repeatedly, for months, against a filter nobody re-reads. The expected value of an
   unattended delete is bad and the tail is catastrophic, so it is not in the set.

Delete is excluded *actively*, not merely omitted. `TRIAGE_FORBIDDEN_ACTION_TYPES` in the engine and
`DELETE_SHAPED` / `assertNoDeleteShape` in `rules.ts` reject an action whose type merely *names* deletion
(`delete`, `trash`, `purge`, `remove`, `destroy`, `erase`, `expunge`) before the type is checked against
the allowed set at all. That is deliberate: the refusal must read as the product rule it is, and a future
action type cannot slip a destructive operation in under a new name and land on the generic "unknown
action type" branch.

If you are here because a customer asked for unattended delete: the answer is a `move` to their trash
folder, authored as an ordinary rule, which is reversible and shows up in the run log. Not a delete
action.

---

## 3. `forward` is gated, and the runner cannot ungate itself

`inboxes.send_approval_required` expresses "a human is watching this mailbox's sends". An unattended
runner is precisely the case where that assumption is false, so the runner does not consult the setting.
It forces `send_approval_required: true` on a local copy of the inbox row before calling
`queueSendApproval`, which is how the override is expressed without giving `queueSendApproval` a bypass
parameter that some later caller would reach for.

**The runner must never set `internalApprovalDispatch`.** See `triageApiKeyAsApiKeyRow` in `index.ts`:
that flag is what lets the approved-send dispatcher skip the approval gate after a human has already said
yes. An unattended runner holding it would be able to skip its own gate, which defeats the only human
check on this feature. It is left unset deliberately and the comment there says so. Do not "fix" it while
widening `ApiKeyRow`.

`draft_reply` goes through the ordinary reply-draft handler and never sends, on any provider, under any
configuration. Its recipients and threading are derived from the original message by that handler, not by
the runner.

---

## 4. Template substitution is a whitelist, not an evaluator

`renderTriageTemplate` substitutes exactly the members of `TRIAGE_TEMPLATE_PLACEHOLDERS`:

```
{{sender_name}}  {{sender_email}}  {{subject}}  {{date}}
```

Everything else in a template is literal text, including anything that looks like a placeholder but is not
on the list. Each substituted value is HTML-escaped (`escapeTriageHtml`). Message **bodies** are never
interpolated at all: a body is the most attacker-controlled field in the product, and an unattended runner
that copied one into a reply would be a prompt-injection amplifier with no human between the injection and
the artifact.

There is no expression syntax, no conditionals, no function calls, and no lookup of arbitrary fields by
name. Do not add any. The moment a template can compute, an email can be crafted to steer the
computation, and the guarantee in section 1 is gone.

---

## 5. What you must not add without re-opening the threat model

Each of the following would move this path back across the boundary. None of them is forbidden forever;
each of them requires a fresh threat model, a written decision, and a revision of the public claims on
`/docs` before it ships.

1. **Any LLM call that consumes message content and chooses or parameterizes an action.** This is the big
   one. "Let the model pick the folder", "let it decide whether this is urgent", "let it write the reply
   body", "just a small classifier on the subject line" are all the same change: they reintroduce exactly
   the injection path this design closes, on the one path in the product where no human is present to
   catch the result. If unattended classification is genuinely needed, the shape that preserves the
   boundary is a human reviewing the model's output before it is applied, which is the approval queue in
   `docs/mcp-apps/contract.md`, not a new autonomous branch.
2. **Any destructive action type**, including a "soft" one that trashes, expunges, or empties.
3. **Removing or conditionalizing the forced approval on `forward`**, or setting `internalApprovalDispatch`
   anywhere the runner can reach.
4. **Any evaluator in templates**, including a "safe subset" expression language.
5. **Interpolating body, snippet, preview, or header text** into a template, a forward note, or a run-log
   column.
6. **Accepting provider-native raw query strings** in `filter`. A stored rule re-executes for months
   without review; a raw string is a second dialect that nothing validates and that the preview cannot
   faithfully model.
7. **Storing message content** in `triage_*` tables. The privacy carve-outs are exactly two: the encrypted
   `triage_run_items.undo_state`, and the neutralized 120-character `subject_redacted` / `sender_redacted`
   pair. See the migration header before adding a column.
8. **Acting on a message before claiming it** in `triage_seen_messages`. The claim is what makes an
   overlapping or retried run unable to act twice; moving it after the action turns a timeout into
   duplicate mailbox mutations.
9. **Auto-retrying a run that failed mid-flight.** A stale lease is reclaimed and the run is marked
   failed, deliberately: its actions may have partially applied and it has no record of where it stopped.
10. **Letting a rule act with more authority than its key.** A rule runs as `triage_rules.api_key_id`,
    inside that key's scopes and inbox allowlist, metered and audit-logged like an interactive call, and
    the FK cascades so revoking the key takes its rules with it.

---

## 6. Standing invariants to preserve when refactoring

- `TriageDeps` injection exists so the runner has no independent provider seam. If the engine ever imports
  a provider client directly, it has become a second way to move and send mail, with its own bugs.
- A rule is created disabled. Enabling is always a separate explicit act.
- `preview` is read-only: it applies nothing, sends nothing, and must not claim anything in the seen
  ledger. The web preview route degrades to 503 when the edge function does not implement it.
- Auto-disable at `TRIAGE_MAX_CONSECUTIVE_FAILURES` (5) with `disabled_reason` set. A rule pointed at a
  dead mailbox stops.
- `max_messages_per_run` is the per-run blast radius, and `interval_minutes` is a fixed ladder rather than
  a free integer. Both are bounds on how wrong a single misconfigured rule can go before a human reads the
  run log.
- `error_detail` is operator-facing prose, never a provider payload that could carry message content.
