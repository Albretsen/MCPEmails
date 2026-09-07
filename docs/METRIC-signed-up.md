# "Signed up" is one number

**A person has signed up when there is a row in `public.users` whose address is not one of ours.**

That is the number to celebrate, to put on a slide, and to print anywhere the
words "users", "signups" or "signed up" appear. On 2026-09-07 it was **413**.

Read it with `signup_scoreboard()`, never by counting a table:

```sql
select * from public.signup_scoreboard();
-- total | last_24h | last_7d | internal_excluded
--   413 |       27 |     117 |                10
```

## Why it had to be written down

Four surfaces answered "how many signed up" and three of them disagreed:

| Surface | Said | Was counting |
| --- | --- | --- |
| Signup notification email | 422 | every row in `users`, ours included |
| albretsen.no | 422 | same |
| /admin/growth and the kiosk | 412 | people who are not us |
| Kiosk "Road to a paying customer" | 404 | live workspaces, ours included |

None of them was broken. They counted three different things, and three right
answers under one word is worse than one wrong answer: nobody can tell which is
which from across a room, and a milestone you cannot state is a milestone you
cannot celebrate.

## Why this definition and not another

- **People, not workspaces.** Someone who deletes a workspace still signed up.
  Someone with two has not signed up twice. Workspace counts move for reasons
  that have nothing to do with how many humans found the product, which is
  exactly what a milestone number must not do.
- **Not `auth.users`,** though it agrees today. `public.users` is the row the
  product treats as a person.
- **Ours excluded.** Ten accounts are the founder's own, the synthetic monitor,
  the reviewer demo mailbox and test signups. Counting them is flattering and
  false, and the flattery grows every time we add a test account.
- **Nothing about deletion.** There is no user-deletion path that removes the
  row, so the number only goes up. That is what makes it safe to celebrate: a
  milestone that can be un-passed is not a milestone.

## Where the list of "ours" lives

`public.internal_accounts`, one row per address. It is a table rather than an
environment variable because the signup email is a Supabase edge function and
albretsen.no is a different site: neither can read the Next.js app's
environment, so both counted everybody, and would have gone on counting
everybody however carefully the growth board was written.

A human still edits one place, `GROWTH_INTERNAL_EMAILS`. Push it to the table:

```bash
node scripts/sync-internal-accounts.mjs          # show the diff
node scripts/sync-internal-accounts.mjs --apply  # write it
```

Plus-tagged variants match automatically, so list `you@gmail.com` and never
`you+test@gmail.com`. The domains `@mcpemails.com` and `@mcpemails.dev` are
matched in code and need no rows.

## The one number that is deliberately different

The kiosk's "Road to a paying customer" ladder starts lower, at **394**. It
counts *workspaces that still exist*, which is the right unit for a funnel
about connecting a mailbox, and its tile says `workspaces, not people`. It now
excludes our accounts too, so the unit is the only thing left between the two
figures. Use the ladder to decide what to fix. Use `signup_scoreboard()` to
decide what to celebrate.

## Next milestones

The achievement track on /admin/growth already runs off this definition:
**500**, then 1,000, 2,500, 5,000 signups.
