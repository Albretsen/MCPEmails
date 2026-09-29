# Paywall follow-up emails: rendered drafts

Rendered on 2026-09-29 from `apps/web/src/lib/email/paywall-followup-templates.ts`
for a workspace whose first paywall was the inbox cap. `UNSUBSCRIBE-TOKEN` stands
in for the reader's own `users.unsubscribe_token`. No real user data.

Every price, inbox count and the annual saving below are read from
`apps/web/src/lib/stripe/plans.ts` and `annual-offer.ts` at send time. These
drafts show whatever the catalogue said when they were rendered (Personal at
$5/month here); if the Personal reprice lands, the emails change with it and the
tests check they still match the catalogue. The annual sentence only appears
when a yearly Stripe price is configured (placeholders were used to render it).

For an action-cap paywall, the first line of steps 1 and 2 instead says the
workspace used the Free plan's monthly email actions.

Not sent. Not scheduled. See `app/api/internal/paywall-followup/dispatch/route.ts`.

## Step 1

From: Asgeir Albretsen <asgeir@mcpemails.com>
Subject: What a second inbox does in MCPEmails
List-Unsubscribe: <https://mcpemails.com/api/email/unsubscribe?token=UNSUBSCRIBE-TOKEN&c=lifecycle>
List-Unsubscribe-Post: List-Unsubscribe=One-Click

```text
Hi,

You recently reached the Free plan's limit of 1 connected inbox.

Here is what changes with more than one. Your agent reaches every inbox you connect through the same connection, so in one conversation you can ask it to check your work and personal inboxes for anything that still needs a reply, draft answers in each, and tidy both.

Personal is $5 a month for 3 connected inboxes. Pro is $15 a month for unlimited connected inboxes. Both have no monthly action cap.

If something else got in the way, reply and tell me. I read every reply.

Compare plans: https://mcpemails.com/pricing?plan=personal&interval=month

Asgeir
MCPEmails

You are getting this because you asked for product tips and offers when you signed up. Unsubscribe: https://mcpemails.com/api/email/unsubscribe?token=UNSUBSCRIBE-TOKEN&c=lifecycle
Billing and account notices are separate and are not affected.

MCPEmails is a service of Albretsen Consulting (enkeltpersonforetak), organisation number 926 646 753, Håsteins gate 9, 5160 Laksevåg, Norway.
```

## Step 2

From: Asgeir Albretsen <asgeir@mcpemails.com>
Subject: One way to use two inboxes with your agent
List-Unsubscribe: <https://mcpemails.com/api/email/unsubscribe?token=UNSUBSCRIBE-TOKEN&c=lifecycle>
List-Unsubscribe-Post: List-Unsubscribe=One-Click

```text
Hi,

A few days ago you reached the Free plan's limit of 1 connected inbox.

Here is one concrete way people use two inboxes. Say one is your business address and the other is your own. In a single conversation you can ask your agent to:

1. Summarise what came into the business inbox since Friday and flag anything that needs you.
2. Draft replies to the quote requests, sent from the business address.
3. Schedule them for Monday at 8:00. Scheduled send is on every plan, Free included.
4. Forward the invoices to your own inbox so they are in one place.

Free covers 1 inbox. Personal ($5 a month) covers 3 inboxes, and Pro ($15 a month) covers as many inboxes as you run.

See the plans: https://mcpemails.com/pricing?plan=personal&interval=month

Asgeir
MCPEmails

You are getting this because you asked for product tips and offers when you signed up. Unsubscribe: https://mcpemails.com/api/email/unsubscribe?token=UNSUBSCRIBE-TOKEN&c=lifecycle
Billing and account notices are separate and are not affected.

MCPEmails is a service of Albretsen Consulting (enkeltpersonforetak), organisation number 926 646 753, Håsteins gate 9, 5160 Laksevåg, Norway.
```

## Step 3

From: Asgeir Albretsen <asgeir@mcpemails.com>
Subject: MCPEmails plans, side by side
List-Unsubscribe: <https://mcpemails.com/api/email/unsubscribe?token=UNSUBSCRIBE-TOKEN&c=lifecycle>
List-Unsubscribe-Post: List-Unsubscribe=One-Click

```text
Hi,

This is the last email in this short series. Here is how the plans compare:

Free, $0: 1 connected inbox, 150 email actions a month.

Personal, $5 a month: 3 connected inboxes, no monthly action cap, email support.

Pro, $15 a month: unlimited connected inboxes, everything in Personal.

If you would rather pay once a year: Personal is $48 a year and Pro is $144 a year, which saves 20% against paying monthly.

Scheduled send and the approval hold are on every plan, Free included. Your Free account stays as it is whatever you decide.

Compare plans: https://mcpemails.com/pricing?plan=personal&interval=month

Asgeir
MCPEmails

You are getting this because you asked for product tips and offers when you signed up. Unsubscribe: https://mcpemails.com/api/email/unsubscribe?token=UNSUBSCRIBE-TOKEN&c=lifecycle
Billing and account notices are separate and are not affected.

MCPEmails is a service of Albretsen Consulting (enkeltpersonforetak), organisation number 926 646 753, Håsteins gate 9, 5160 Laksevåg, Norway.
```

