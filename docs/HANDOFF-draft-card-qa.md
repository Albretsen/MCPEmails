# Handoff: draft card QA fixes (written 2026-10-13)

Goal from Asgeir: orchestrate sub agents to fix everything in the QA report below, then release to production. The draft card is enabled only for internal workspaces, so risk is low. He authorized the production release in chat for this task.

## State at handoff

Nothing is merged to main, migrated or deployed. Two sub agents were started and then STOPPED MID-WORK so their work could be handed over. Their uncommitted work is pushed as one `wip:` commit per branch. It is unfinished and unreviewed: neither agent wrote a report, the tests were not confirmed green, and the code may not even compile. Read the diff against `origin/main` before building on it.

| Branch (on origin) | Scope | Known state when stopped |
|---|---|---|
| `fix/draft-card-qa-server` | Server: `supabase/functions/mcp-server/**`, migrations, `docs/mcp-apps/**` | New `draft-lineage.ts` with tests and a fake, edits to `mcp-app-drafts.ts`, `draft-recipients.ts`, `signature-compose.ts`, `imap-client.ts`, `index.ts`. The agent was in the middle of wiring lineage into the update, send and delete handlers in `index.ts`. NO migration for the lineage table exists yet, and `database.types.ts` is not updated. |
| `fix/draft-card-qa-card` | Card: `apps/mcp-app/src/**`, `apps/mcp-app/harness/**` | New `draft-failure.ts` and `unsaved.ts`, edits to `store.ts`, `App.tsx`, `DraftEditor.tsx`, `ui.tsx`, `styles.css` and two harness suites. Which of its six items are done is unknown. |

Both branches are cut from `origin/main` at `5c9d9d25`. This file lives on `fix/draft-card-qa-server` only; delete it before that branch merges to main (the repo is public).

The briefs below are what each agent was told. Use them to finish the work: check each item against the diff, complete what is missing, then continue with the remaining plan.

### Server agent brief (items)
1. Draft lineage table + stale-id resolution: new idempotent migration, written on create/reply/update/editor save, closed on send/delete. `draft` update/send/delete, `draft_read` and `draft_editor_save` accept any id in a lineage, act on the current one and return the current id. Fail soft. Conflict rule (`expected_revision`) out of scope.
2. Rich signature HTML flattened when body or signature is edited; envelope must not offer "Show formatting" when formatting is gone.
3. `draft_list` returns `cc: []` for a draft that has a Cc.
4. `draft_editor_save` must refuse invalid recipients instead of dropping them.
5. Server-authored card copy: Refresh must not claim "Saved ... by the assistant"; human error messages (keep `error_code`, do not change model-facing `content`, contract §8); replace "APPEND to Drafts".

Told to: add Deno tests, update `database.types.ts`, commit with explicit paths, not push, not touch prod, and report any card-side change it needs rather than editing `apps/mcp-app`.

### Card agent brief (items)
1. A failed action (failed receipt, isError, transport error) must never unmount the editor or lose typed text; in-editor notice with Retry/Refresh; after a transport failure re-read with `draft_read` and reconcile.
2. A remounted card gets the ORIGINAL tool result: re-read before presenting as current; Send disabled on unverified content.
3. Unsaved edits lost on reload: persist dirty edits and restore, and/or save on teardown; report host limits.
4. Cancelling Discard must return focus to Discard, never to "Save and send"; "No" must not sit where the send button appears.
5. Save keeps focus through its busy state.
6. Save and Save-and-send blocked while a recipient field holds invalid or uncommitted text.
Plus: Escape cancels a confirm; confirm focus starts on the safe choice; human wording for errors.

Told to: add harness regression tests on the real modules, keep `npm run verify` N/N, update the suite count comment in `.github/workflows/ci.yml` if a suite is added, not commit the generated `review-card.html.ts`, leave the worktree clean.

## Remaining plan

1. **UI polish agent**, on the card branch, after the card blockers are finished (same files, so sequential, not parallel). Everything under "Smaller issues" in the report that is card-side: recipients, focus, fullscreen, copy, date locale, HTML preview. The Hide confirm should say how to turn the card back on (dashboard settings).
2. **Integrate**: new worktree off current `origin/main`, merge both branches, apply any card-side change the server agent asked for (likely for the signature formatting flag), then `cd apps/mcp-app && npm run build` to regenerate `supabase/functions/mcp-server/ui/review-card.html.ts`.
3. **Test everything locally**: `npm run typecheck` and `npm run verify` in `apps/mcp-app`; Deno suite `HOST_GUARD_SKIP_NETWORK_TESTS=1 DENO_NO_PACKAGE_JSON=1 deno test --allow-env --allow-read --allow-run=git supabase/functions/mcp-server`; `npm test` and `npm run build` in `apps/web` (types changed).
4. **Fresh review agent**: give it the diff and the QA report, not conclusions. Past card work always had a real defect in the first fix that only a fresh reviewer found.
5. **Release**: PR to main, CI green ("CI passed" gates the Vercel prod deploy), merge. Apply the migration with `supabase db query --linked -f <file>` plus `migration repair` (never `db push`); do it before the function deploy unless the server agent says the function tolerates a missing table. Deploy from a clean tree at the merged sha: `npx supabase functions deploy mcp-server --project-ref swvaxorwumispmjaaszb --no-verify-jwt --use-api`. Check `git log <branch>..origin/main` is empty right before deploying.
6. **Verify live**: unauthenticated `initialize` returns a clean 401; a new card fingerprint is advertised in `tools/list`. The card only updates in conversations whose tool call happens after the deploy. Real send is Asgeir's to press (never send email).
7. Tell Asgeir about the two leftover test drafts (`Drafts:103` on asgeir@mcpemails.com, `[Gmail]/Drafts:8990` on the Gmail test inbox); do not delete them without asking.

Gotchas (from notes on Asgeir's machine that you cannot read):
- `deno test` never imports `index.ts`, so a syntax error there passes the suite; run `deno check --node-modules-dir=none supabase/functions/mcp-server/index.ts` as CI does.
- The card bundle is `supabase/functions/mcp-server/ui/review-card.html.ts`, generated by `npm run build` in `apps/mcp-app`; its URI is fingerprinted, and Deno drift tests compare it with `apps/mcp-app/src`.
- Card rule: nothing renders empty and nothing reports height 0 (contract §1).
- `content` of tool results is pinned byte for byte (contract §8); card data goes in `structuredContent` only.
- A merge to main is a Vercel production deploy of the web app. The edge function and the migration are deployed by hand with Supabase credentials; if you do not have them, stop at a green, merged PR and tell Asgeir the two commands in step 5.
- Never send email; stop at a saved draft.

## The QA report (verbatim)

The draft card is not ready to release: I found four problems that lose user work or risk a wrong send, plus a list of smaller ones. Testing was live in claude.ai on two drafts (asgeir@mcpemails.com and the Gmail test inbox), driven by keyboard only because Chrome-extension clicks do not reach the card's iframe.

### Blockers

1. Any failed action replaces the editor with a dead-end error card. A save came back as `-32603: Failed to fetch` although the server had stored it (new id `Drafts:103`). Retrying then hit `draft_not_found`, and the whole editor was swapped for "That draft could not be found", with no Refresh and the typed text gone from view.
   * Cause: failures come back as a `receipt` card, and `mergeEnvelope` in apps/mcp-app/src/store.ts replaces the editor with any renderable envelope. The in-editor error notice with a Refresh link in `DraftEditor.tsx` is never reached.
   * Stale ids are not resolved: I found no draft-lineage code in `supabase/functions/mcp-server` or the migrations, although the concept doc lists it as phase 1.
2. After a page reload the card shows the original draft as if it were current. Both cards came back with the first tool result (old subject, old recipients, "Saved 13:59 by the assistant", Send enabled). Pressing Refresh on the reloaded Gmail card gave the same dead-end error, while the real draft sat in the mailbox under a newer id.
3. Unsaved edits are lost on reload. I had removed recipients and added body text without saving; after reload the server draft was unchanged and the edits were gone, with no warning.
4. Editing the body or signature flattens the rich signature. Adding two characters to the signature and saving turned the logo, link and table into plain lines, and a literal `-- ` now appears in the HTML. There is no warning, and "Show formatting" is still offered. A recipients-and-subject-only save kept the HTML intact.

### Risk of a wrong send

* Cancelling Discard puts keyboard focus on "Save and send". Reproduced twice: Discard, then "No" with Enter, and the focus ring is on "Save and send", so a second Enter would send. "No" also sits where "Save and send" appears, so a mouse double-click may do the same; I could not test that.
* After a failed save, the next Tab lands on "Save and send", because Save loses focus while it is disabled.
* A typed but invalid address is silently dropped on save. With `a@b` still in the To field, Save went through, the text and its warning vanished. Send uses the same code path, so a mistyped recipient would be left off the mail.

### Smaller issues

* Recipients:
   * Duplicate check is case-sensitive (`an upper-case copy of an address` was added next to `the Gmail test inbox`).
   * Backspace in an empty field does not remove the last chip.
   * A comma inside a display name (`Doe, Jane <…>`) raises a false "Doe does not look like an email address" warning.
   * The warning stays while you type a correction and sits far below the field.
   * The "Cc Bcc" link wraps onto two lines when To has three chips.
* Focus:
   * Tabbing through the message box opens fullscreen unasked.
   * Focus is dropped after "Cc Bcc", signature "Edit", chip removal, Save, and opening either confirm.
   * Escape does not cancel a confirm.
   * The first Tab stop in the Discard confirm is "Yes, discard".
* Fullscreen:
   * The card stays a narrow column.
   * A long body gives two nested scrollbars and pushes Save/Send off-screen.
   * Claude's own prompt box covers the bottom of the card.
* Copy:
   * Refresh rewrites the header to "Saved 14:02 by the assistant" when nothing was saved and the last save was mine.
   * Error text is written for the model ("Reload the draft list", "Error: draft_not_found", raw `-32603`).
   * The fullscreen footer says "APPEND to Drafts".
   * Dates are Norwegian in an English card.
   * The Hide confirm does not say how to turn the card back on.
* HTML preview: it looks identical to the editable box, shows the signature table with borders and `[image: MCP Emails logo]`, and has no gap before the signature.
* Outside the card: `draft_list` returned `cc: []` for a draft whose Cc was `hello@mcpemails.com`.

### What worked

First render with no sliver; dirty state and the "Save and send" label; Unicode and literal `<b>` in the body; long subject; chip add and remove; expand and collapse keeping unsaved edits; Refresh keeping unsaved edits when the server copy is unchanged; signature split and edit; both inline confirms.

### Not tested

* Real send: the final keypress was blocked by the permission classifier.
* Confirming Discard and Hide.
* Everything mouse-only: tooltips, click targets, double-click.
* Other variants: narrow or mobile width, light theme, reply drafts, attachments, Outlook, approval-held sends.

Two test drafts remain: `Drafts:103` on asgeir@mcpemails.com and `[Gmail]/Drafts:8990` on the Gmail test inbox (still addressed to demo@ and a duplicate upper-case address, Cc hello@). The claude.ai conversation "MCP Emails draft creation" is still open in Chrome.
