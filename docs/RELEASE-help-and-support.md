# Releasing Help & support

> **Released 2026-10-31.** The release PR ("Help & support: release to
> everyone") ran the whole checklist below: the gate, the preview and
> visibility routes and their tests are deleted, `/help` is indexable and in
> the sitemap, the pricing-copy diff and the hand review are applied, and the
> changelog has its entry. The rest of this file is kept as history.

Help & support shipped internal-only in v1: `/help` (search, troubleshooting
articles, contact form), the ticket API, and the entry points in the dashboard
sidebar, the connect modal, the error pages and the marketing footer. Everything
is visible only to accounts `isInternalAccount()` accepts (our own domains plus
`GROWTH_INTERNAL_EMAILS`). Releasing it is a deletion, not a refactor.

The `support@mcpemails.com` mailbox is not gated. It is just an address.
`app/global-error.js` already mentions it, and that line stays.

## Before the v1 PR merges

1. Apply `supabase/migrations/20261016090000_support_tickets.sql` to
   production, one file at a time and never with the bulk push command:
   ```bash
   npx supabase db query --linked -f supabase/migrations/20261016090000_support_tickets.sql
   npx supabase migration repair --status applied 20261016090000 --linked
   ```
   Merge only after it is applied: until then the form answers
   `server_error` when it tries to insert a row.
2. Apply `supabase/migrations/20261029200000_help_article_feedback.sql` the
   same way:
   ```bash
   npx supabase db query --linked -f supabase/migrations/20261029200000_help_article_feedback.sql
   npx supabase migration repair --status applied 20261029200000 --linked
   ```
   Without it "Was this helpful?" still answers 204, but every vote is
   dropped (the upsert fails and is only logged).
3. Then apply `supabase/migrations/20261030210000_support_retention.sql`
   the same way. It needs step 2 first (it purges `help_article_feedback`)
   and the retention migration from #410 (it re-creates
   `purge_operational_history()` with one extra call):
   ```bash
   npx supabase db query --linked -f supabase/migrations/20261030210000_support_retention.sql
   npx supabase migration repair --status applied 20261030210000 --linked
   ```
   It deletes votes keyed by a hashed IP after 180 days and scrubs tickets
   from people without an account after 730 days, on the existing daily
   purge cron.
4. There are no new env vars. The feature reads ones that are already set in
   Production and Preview: `CSRF_SECRET` (HMACs for the preview cookie, the
   form token and the IP hash, each under its own label), `RESEND_API_KEY`,
   the Supabase keys, and `GROWTH_INTERNAL_EMAILS`.

## Testing the signed-out form while gated

Sign in with an internal account and open `/help`. Follow "Test the signed-out
form": it sets a signed `mcpe_support_preview` cookie (30 days) and returns
you to `/help`. Then sign out. The cookie keeps `/help` open in that browser
only, and only while the address embedded in it is still internal. "Stop
previewing" clears it. The cookie can only be minted from a real internal
session. Everyone else gets 404.

## Release checklist

1. **Delete the gate.** Remove `apps/web/src/lib/support/release-gate.ts`.
2. **Follow the markers.** Run `rg -n SUPPORT_RELEASE_GATE apps/web` and
   `cd apps/web && npx tsc --noEmit`. Simplify each call site to its ungated
   form:
   - `src/lib/support/viewer.ts`: drop the preview cookie and
     `supportVisibleTo`. Return `{ user }`.
   - `app/[locale]/help/page.js`:
     - drop `notFound()` and the noindex `robots` (see step 4);
     - drop the "Test the signed-out form" and "Stop previewing" links and
       the `preview` copy in `src/lib/support/help-content/*.json` (all five
       locales).
   - `app/api/support/tickets/route.ts`: drop the 404 branches. Non-POST
     methods answer 405.
   - `app/api/support/preview/route.ts` and its test: delete them.
   - `app/api/support/visibility/route.ts`: delete it, since nothing will
     call it any more.
   - `app/api/support/help-data/route.ts` (the dashboard help section's
     data): drop the 404 branches. GET answers 200, other methods 405.
   - `app/api/support/article-feedback/route.ts` ("Was this helpful?"):
     drop the 404 branches. POST answers 204, other methods 405.
   - `components/dashboard/CommandPalette.jsx`: drop the `supportVisible`
     prop and the `gated` flag on the Help entry. In `App.jsx`, prefetch the
     help data without the `supportVisible` check.
   - `components/dashboard/Pages.jsx` (the Inboxes page's "Reconnect not
     working?" banner link): drop the `supportVisible` prop of `InboxesPage`;
     `reconnectSupportHref` keeps only the help-center branch and the click
     handler drops its `!supportVisible` check. The `errorBannerSupportSubject`
     key in `messages/*/dashboard.json` is then unused: delete it in every
     locale. In `connect-support-link-ui.test.mjs`, drop the hidden-banner
     case and the mailto assert in the `reconnectSupportHref` test.
   - `app/dashboard/[[...section]]/page.js`, `components/dashboard/App.jsx`,
     `Sidebar.jsx`, `ConnectModal.jsx`: delete the `supportVisible` prop and
     render the sidebar item and the "Still stuck? Contact support" link
     unconditionally.
   - The dashboard help section (`/dashboard/help`):
     - `app/dashboard/[[...section]]/page.js`: drop the
       `initialRoute === 'help' && !supportVisible` 404;
     - `components/dashboard/App.jsx`: render `HelpSection` on
       `route === "help"` without `supportVisible &&`, and drop the
       help-to-overview fallback in the popstate listener;
     - `components/dashboard/routes.js` and `HelpSection.jsx`: delete the
       marker comments; `help` stays in `DASHBOARD_SECTIONS`.
   - `components/support/SupportHelpLink.jsx`: make it a plain link (keep
     `label`, `href` and `LinkComponent`). Delete the cookie check, the
     sessionStorage cache and the fetch. Its users are `app/error.js`,
     `app/not-found.js`, `app/global-error.js` and
     `components/marketing/Sections.jsx`.
   - Tests:
     - delete `release-gate.test.ts` and the hidden or 404 cases in
       `app/api/support/*/route.test.ts`, `sidebar-help-link.test.mjs`,
       `connect-support-link-ui.test.mjs`, `support-help-link-ui.test.mjs`,
       `app/api/support/help-data/route.test.ts` and
       `app/api/support/article-feedback/route.test.ts`; keep the visible
       cases;
     - remove deleted files from the `test:support*` scripts in
       `apps/web/package.json`.
3. **Sitemap.** In `apps/web/app/sitemap.ts`, add this to `MARKETING_PAGES`
   after the `/status` entry:
   ```ts
   { path: '/help', lastModified: '<release date>', changeFrequency: 'monthly', priority: 0.6 },
   ```
4. **Indexing.** Remove the `robots: { index: false, follow: false }` from
   `generateMetadata` in `app/[locale]/help/page.js`. Add `alternates`
   (canonical plus language alternates) the way the other marketing pages
   do.
5. **Plan copy.** From the repo root, apply the diff below with
   `git apply -p1`. It does this in all five locales:
   - Free: "Help center and email support".
   - Personal and Pro: "Priority email support". Pro inherits it through
     "Everything in Personal".
   - Business: unchanged.
   - The comparison table's "Community forum" row becomes "Help center",
     the "Email support" row is ticked for Free, and a "Priority email
     support" row is added for Personal, Pro and Business (a new `priority`
     key in each locale's `pricing.json`).
   - The Personal-vs-Free FAQ answer is rewritten.
   - The self-hosting FAQ answer is updated, since "email support is on the
     paid plans" stops being true.
   - The in-product Personal/Pro feature lists and `llms.txt` are updated.

   It covers en, es, fr, nb, zh and de (de was not in the first version of
   this diff; its pricing and home pages exist in German now).

   `supportTier` ids (`community`, `email`, `priority`) stay as internal
   names. If the diff no longer applies, regenerate it with the same intent.
6. **Copy the diff does not cover.** Review these by hand:
   - `messages/*/pricing.json`: the "difference between Personal, Pro and Business" FAQ answer (it says Personal has "email support").
   - `messages/*/dashboard.json`: `grandfatheredBody`.
   - `messages/*/forBusiness.json`: the Personal line.
   - Blog posts that state plan support levels:
     - `how-to-give-your-ai-agent-email-access.js`
     - `manage-multiple-email-accounts-with-ai.js`
     - `ai-email-for-agencies-and-client-work.js`
     - `hosted-vs-self-hosted-gmail-mcp-server.js`
   - Regenerate the built-output snapshots in
     `apps/web/scripts/built-output/snapshots` after the release merges
     (and after this diff): they still show `hello@` as the contact address
     and the old support lines.
   - Leave `selfHosting.json` alone: its "community-only" line is about
     self-hosting and stays true.
7. **Verify.**
   - `npm run build` passes.
   - `npm test` passes.
   - A signed-out browser sees the footer link.
   - `/help` answers 200 and is indexable.
   - `/sitemap.xml` lists `/help`.
   - A ticket filed from a non-internal account reaches `support@`.

## Pricing-copy diff (apply at release, not before)

```diff
diff --git a/apps/web/components/marketing/PricingClient.jsx b/apps/web/components/marketing/PricingClient.jsx
index 3037b581..050934aa 100644
--- a/apps/web/components/marketing/PricingClient.jsx
+++ b/apps/web/components/marketing/PricingClient.jsx
@@ -182,7 +182,8 @@ const TABLE_SECTIONS = [
     key: 'support',
     rows: [
       { key: 'community', free: true,  personal: true,  solo: true,  pro: true },
-      { key: 'email',     free: false, personal: true,  solo: true,  pro: true },
+      { key: 'email',     free: true,  personal: true,  solo: true,  pro: true },
+      { key: 'priority',  free: false, personal: true,  solo: true,  pro: true },
     ],
   },
 ];
diff --git a/apps/web/messages/de/dashboard.json b/apps/web/messages/de/dashboard.json
index 5e09458e..62a694e7 100644
--- a/apps/web/messages/de/dashboard.json
+++ b/apps/web/messages/de/dashboard.json
@@ -818,13 +818,13 @@
       "personalFeature1": "3 verbundene Postfächer",
       "personalFeature2": "120 Anfragen/Minute (2× Burst)",
       "personalFeatureActions": "Unbegrenzte E-Mail-Aktionen",
-      "personalFeature4": "E-Mail-Support",
+      "personalFeature4": "Bevorzugter E-Mail-Support",
       "soloFeature1": "10 verbundene Postfächer",
       "soloFeature2": "300 Anfragen/Minute (5× Burst)",
       "soloFeature3": "Längerer Analyseverlauf",
       "soloFeatureChatClosed": "Nachfassen, Zurückstellen und Morgen-Briefing bei geschlossenem Chat",
       "soloFeatureAllInboxes": "Alle Postfächer auf einmal durchsuchen, mit Anweisungen pro Postfach",
-      "soloFeature4": "E-Mail-Support",
+      "soloFeature4": "Bevorzugter E-Mail-Support",
       "businessFeature1": "Alles aus Pro",
       "businessFeature2": "10 Postfächer inklusive, $3 pro Monat für jedes weitere",
       "businessFeature3": "Unbegrenzt viele Mitglieder mit Rollen, ohne Aufpreis",
diff --git a/apps/web/messages/de/dashboardChrome.json b/apps/web/messages/de/dashboardChrome.json
index 4231489a..a424b898 100644
--- a/apps/web/messages/de/dashboardChrome.json
+++ b/apps/web/messages/de/dashboardChrome.json
@@ -243,7 +243,7 @@
     "featureInboxes": "10 verbundene Postfächer",
     "featureRateLimit": "5-fach höheres Burst-Ratenlimit",
     "featureTeam": "Jederzeit kündbar, der laufende Zeitraum bleibt Ihnen",
-    "featureSupport": "Support per E-Mail",
+    "featureSupport": "Bevorzugter Support per E-Mail",
     "personalUpgradeTitle": "Personal verbindet drei Postfächer",
     "personalUpgradeBody": "Sie wollten gerade ein weiteres Postfach verbinden. Mit Personal haben Sie drei für $9 pro Monat: Arbeit, Privates und eines mehr.",
     "personalUpgradeCta": "Auf Personal upgraden, $9/Monat",
diff --git a/apps/web/messages/de/home.json b/apps/web/messages/de/home.json
index c8bddb64..7db7e6da 100644
--- a/apps/web/messages/de/home.json
+++ b/apps/web/messages/de/home.json
@@ -192,7 +192,7 @@
           "Nutzungsanalyse",
           "Gmail, Outlook, iCloud, Fastmail und jedes IMAP-Postfach",
           "Unbegrenzt viele API-Schlüssel",
-          "Community-Support"
+          "Hilfecenter und E-Mail-Support"
         ],
         "cta": "Kostenlos starten"
       },
@@ -203,7 +203,7 @@
           "Alles aus Free",
           "3 verbundene Postfächer",
           "2x höheres Burst-Ratenlimit",
-          "E-Mail-Support"
+          "Bevorzugter E-Mail-Support"
         ],
         "cta": "Personal wählen",
         "ctaGrandfathered": "Sie haben bereits unbegrenzt viele Postfächer"
diff --git a/apps/web/messages/de/pricing.json b/apps/web/messages/de/pricing.json
index e5fdf98c..da070a69 100644
--- a/apps/web/messages/de/pricing.json
+++ b/apps/web/messages/de/pricing.json
@@ -34,7 +34,7 @@
         "Nutzungsanalyse",
         "Gmail, Outlook, iCloud, Fastmail und jedes IMAP-Postfach",
         "Unbegrenzt viele API-Schlüssel",
-        "Community-Support"
+        "Hilfecenter und E-Mail-Support"
       ]
     },
     "personal": {
@@ -47,7 +47,7 @@
         "3 verbundene Postfächer",
         "Unbegrenzte E-Mail-Aktionen",
         "2x höheres Burst-Ratenlimit",
-        "E-Mail-Support"
+        "Bevorzugter E-Mail-Support"
       ]
     },
     "solo": {
@@ -154,8 +154,9 @@
       "support": {
         "label": "Support",
         "rows": {
-          "community": "Community-Forum",
-          "email": "E-Mail-Support"
+          "community": "Hilfecenter",
+          "email": "E-Mail-Support",
+          "priority": "Bevorzugter E-Mail-Support"
         }
       }
     },
@@ -188,7 +189,7 @@
       },
       {
         "q": "Was bietet Personal zusätzlich zu Free?",
-        "a": "Zwei weitere verbundene Postfächer, unbegrenzte E-Mail-Aktionen (Fair Use gilt), die doppelte Burst-Grenze (120 Anfragen pro Minute statt 60), 90 statt 30 Tage Analyseverlauf und E-Mail-Support statt Community-Forum. Das ist die ganze Liste. Alles, was Sie täglich nutzen, ist auch in Free enthalten: lesen, suchen, organisieren, entwerfen, senden und Sendungen planen, die Versandprüfung und Freigabe pro Postfach und das Dashboard zur Nutzungsanalyse. Die Funktionen, die bei geschlossenem Chat weiterarbeiten, etwa Nachfass-Erinnerungen, Zurückstellen und das Morgen-Briefing, gehören zu Pro."
+        "a": "Zwei weitere verbundene Postfächer, unbegrenzte E-Mail-Aktionen (Fair Use gilt), die doppelte Burst-Grenze (120 Anfragen pro Minute statt 60), 90 statt 30 Tage Analyseverlauf und bevorzugten E-Mail-Support, während Free das Hilfecenter und den normalen E-Mail-Support hat. Das ist die ganze Liste. Alles, was Sie täglich nutzen, ist auch in Free enthalten: lesen, suchen, organisieren, entwerfen, senden und Sendungen planen, die Versandprüfung und Freigabe pro Postfach und das Dashboard zur Nutzungsanalyse. Die Funktionen, die bei geschlossenem Chat weiterarbeiten, etwa Nachfass-Erinnerungen, Zurückstellen und das Morgen-Briefing, gehören zu Pro."
       },
       {
         "q": "Was zählt als E-Mail-Aktion?",
@@ -232,7 +233,7 @@
       },
       {
         "q": "Kann ich es selbst hosten, statt zu bezahlen?",
-        "a": "Ja. MCPEmails ist Open Source unter AGPL-3.0 und kostenlos selbst zu hosten. Ein docker-compose-Stack betreibt denselben MCP-Server, und Ihre Postfach-Zugangsdaten werden mit einem Schlüssel verschlüsselt, den nur Sie besitzen. Self-Hosting deckt IMAP- und SMTP-Postfächer ab. Gmail- und Outlook-Anmeldung (OAuth) und das Dashboard bleiben im gehosteten Dienst, wo sie in jedem Tarif funktionieren, auch in Free; Mitglieder und Rollen gibt es in Business, E-Mail-Support in jedem bezahlten Tarif."
+        "a": "Ja. MCPEmails ist Open Source unter AGPL-3.0 und kostenlos selbst zu hosten. Ein docker-compose-Stack betreibt denselben MCP-Server, und Ihre Postfach-Zugangsdaten werden mit einem Schlüssel verschlüsselt, den nur Sie besitzen. Self-Hosting deckt IMAP- und SMTP-Postfächer ab. Gmail- und Outlook-Anmeldung (OAuth) und das Dashboard bleiben im gehosteten Dienst, wo sie in jedem Tarif funktionieren, auch in Free; Mitglieder und Rollen gibt es in Business, bevorzugten E-Mail-Support in jedem bezahlten Tarif."
       }
     ]
   },
diff --git a/apps/web/messages/en/dashboard.json b/apps/web/messages/en/dashboard.json
index 3a69b0d8..c98e116a 100644
--- a/apps/web/messages/en/dashboard.json
+++ b/apps/web/messages/en/dashboard.json
@@ -818,13 +818,13 @@
       "personalFeature1": "3 connected inboxes",
       "personalFeature2": "120 requests / minute (2× burst)",
       "personalFeatureActions": "Unlimited email actions",
-      "personalFeature4": "Email support",
+      "personalFeature4": "Priority email support",
       "soloFeature1": "10 connected inboxes",
       "soloFeature2": "300 requests / minute (5× burst)",
       "soloFeature3": "Longer analytics history",
       "soloFeatureChatClosed": "Follow-ups, snooze and a morning brief while the chat is closed",
       "soloFeatureAllInboxes": "Search all inboxes at once, with instructions per inbox",
-      "soloFeature4": "Email support",
+      "soloFeature4": "Priority email support",
       "businessFeature1": "Everything in Pro",
       "businessFeature2": "10 mailboxes included, $3 a month for each extra",
       "businessFeature3": "Unlimited members with roles, at no extra cost",
diff --git a/apps/web/messages/en/dashboardChrome.json b/apps/web/messages/en/dashboardChrome.json
index ed555674..92a15676 100644
--- a/apps/web/messages/en/dashboardChrome.json
+++ b/apps/web/messages/en/dashboardChrome.json
@@ -243,7 +243,7 @@
     "featureInboxes": "10 connected inboxes",
     "featureRateLimit": "5x higher burst rate limit",
     "featureTeam": "Cancel any time, keep the rest of the period",
-    "featureSupport": "Email support",
+    "featureSupport": "Priority email support",
     "personalUpgradeTitle": "Personal connects three mailboxes",
     "personalUpgradeBody": "You were about to connect another inbox. Personal takes you to three for $9 a month: work, personal, and one more.",
     "personalUpgradeCta": "Upgrade to Personal, $9/mo",
diff --git a/apps/web/messages/en/home.json b/apps/web/messages/en/home.json
index a349dcce..33202727 100644
--- a/apps/web/messages/en/home.json
+++ b/apps/web/messages/en/home.json
@@ -192,7 +192,7 @@
           "Usage analytics",
           "Gmail, Outlook, iCloud, Fastmail & any IMAP",
           "Unlimited API keys",
-          "Community support"
+          "Help center and email support"
         ],
         "cta": "Start free"
       },
@@ -203,7 +203,7 @@
           "Everything in Free",
           "3 connected inboxes",
           "2x higher burst rate limit",
-          "Email support"
+          "Priority email support"
         ],
         "cta": "Get Personal",
         "ctaGrandfathered": "You already have unlimited inboxes"
diff --git a/apps/web/messages/en/pricing.json b/apps/web/messages/en/pricing.json
index 1fe08fb5..8d0fe383 100644
--- a/apps/web/messages/en/pricing.json
+++ b/apps/web/messages/en/pricing.json
@@ -34,7 +34,7 @@
         "Usage analytics",
         "Gmail, Outlook, iCloud, Fastmail and any IMAP",
         "Unlimited API keys",
-        "Community support"
+        "Help center and email support"
       ]
     },
     "personal": {
@@ -47,7 +47,7 @@
         "3 connected inboxes",
         "Unlimited email actions",
         "2x higher burst rate limit",
-        "Email support"
+        "Priority email support"
       ]
     },
     "solo": {
@@ -154,8 +154,9 @@
       "support": {
         "label": "Support",
         "rows": {
-          "community": "Community forum",
-          "email": "Email support"
+          "community": "Help center",
+          "email": "Email support",
+          "priority": "Priority email support"
         }
       }
     },
@@ -188,7 +189,7 @@
       },
       {
         "q": "What does Personal add over Free?",
-        "a": "Two more connected inboxes, unlimited email actions (fair use applies), double the burst ceiling (120 requests a minute instead of 60), 90 days of analytics history instead of 30, and email support instead of the community forum. That is the whole list. Everything else you use day to day is on Free too: reading, searching, organising, drafting, sending and scheduled sends, the per-inbox send review and approval hold, and the usage analytics dashboard. The features that keep working when the chat is closed, such as follow-up reminders, snooze and the morning brief, are on Pro."
+        "a": "Two more connected inboxes, unlimited email actions (fair use applies), double the burst ceiling (120 requests a minute instead of 60), 90 days of analytics history instead of 30, and priority email support, where Free has the help center and standard email support. That is the whole list. Everything else you use day to day is on Free too: reading, searching, organising, drafting, sending and scheduled sends, the per-inbox send review and approval hold, and the usage analytics dashboard. The features that keep working when the chat is closed, such as follow-up reminders, snooze and the morning brief, are on Pro."
       },
       {
         "q": "What counts as an email action?",
@@ -232,7 +233,7 @@
       },
       {
         "q": "Can I self-host it instead of paying?",
-        "a": "Yes. MCPEmails is open source under AGPL-3.0 and free to self-host. A docker-compose stack runs the same MCP server, with your mailbox credentials encrypted under a key only you hold. Self-host covers IMAP and SMTP mailboxes. Gmail and Outlook sign-in (OAuth) and the dashboard stay on the hosted service, where they work on every plan, Free included; members and roles are on Business, and email support is on every paid plan."
+        "a": "Yes. MCPEmails is open source under AGPL-3.0 and free to self-host. A docker-compose stack runs the same MCP server, with your mailbox credentials encrypted under a key only you hold. Self-host covers IMAP and SMTP mailboxes. Gmail and Outlook sign-in (OAuth) and the dashboard stay on the hosted service, where they work on every plan, Free included; members and roles are on Business, and priority email support is on every paid plan."
       }
     ]
   },
diff --git a/apps/web/messages/es/dashboard.json b/apps/web/messages/es/dashboard.json
index 0dc9a6d7..6f69ca0f 100644
--- a/apps/web/messages/es/dashboard.json
+++ b/apps/web/messages/es/dashboard.json
@@ -818,13 +818,13 @@
       "personalFeature1": "3 bandejas conectadas",
       "personalFeature2": "120 peticiones / minuto (ráfaga 2×)",
       "personalFeatureActions": "Acciones de correo ilimitadas",
-      "personalFeature4": "Soporte por correo",
+      "personalFeature4": "Soporte prioritario por correo",
       "soloFeature1": "10 bandejas conectadas",
       "soloFeature2": "300 peticiones / minuto (ráfaga 5×)",
       "soloFeature3": "Más historial de analíticas",
       "soloFeatureChatClosed": "Seguimientos, posponer y resumen matinal con el chat cerrado",
       "soloFeatureAllInboxes": "Búsqueda en todas las bandejas a la vez, con instrucciones por bandeja",
-      "soloFeature4": "Soporte por correo",
+      "soloFeature4": "Soporte prioritario por correo",
       "businessFeature1": "Todo lo de Pro",
       "businessFeature2": "10 buzones incluidos, 3 $ al mes por cada uno adicional",
       "businessFeature3": "Miembros ilimitados con roles, sin coste extra",
diff --git a/apps/web/messages/es/dashboardChrome.json b/apps/web/messages/es/dashboardChrome.json
index 9dc1de05..64994fb6 100644
--- a/apps/web/messages/es/dashboardChrome.json
+++ b/apps/web/messages/es/dashboardChrome.json
@@ -243,7 +243,7 @@
     "featureInboxes": "10 bandejas conectadas",
     "featureRateLimit": "Límite de ráfaga 5x más alto",
     "featureTeam": "Cancela cuando quieras y conserva el resto del período",
-    "featureSupport": "Soporte por correo",
+    "featureSupport": "Soporte prioritario por correo",
     "personalUpgradeTitle": "Personal conecta tres buzones",
     "personalUpgradeBody": "Estabas a punto de conectar otra bandeja. Personal te lleva a tres por $9 al mes: el del trabajo, el personal y uno más.",
     "personalUpgradeCta": "Mejorar a Personal, $9/mes",
diff --git a/apps/web/messages/es/home.json b/apps/web/messages/es/home.json
index ca8c333c..cd5f9a7b 100644
--- a/apps/web/messages/es/home.json
+++ b/apps/web/messages/es/home.json
@@ -192,7 +192,7 @@
           "Analíticas de uso",
           "Gmail, Outlook, iCloud, Fastmail y cualquier IMAP",
           "Claves de API ilimitadas",
-          "Soporte de la comunidad"
+          "Centro de ayuda y soporte por correo"
         ],
         "cta": "Empieza gratis"
       },
@@ -203,7 +203,7 @@
           "Todo lo de Free",
           "3 bandejas conectadas",
           "Límite de ráfaga 2x más alto",
-          "Soporte por correo"
+          "Soporte prioritario por correo"
         ],
         "cta": "Obtener Personal",
         "ctaGrandfathered": "Ya tienes bandejas ilimitadas"
diff --git a/apps/web/messages/es/pricing.json b/apps/web/messages/es/pricing.json
index 4926cc65..e68113f8 100644
--- a/apps/web/messages/es/pricing.json
+++ b/apps/web/messages/es/pricing.json
@@ -34,7 +34,7 @@
         "Analíticas de uso",
         "Gmail, Outlook, iCloud, Fastmail y cualquier IMAP",
         "Claves de API ilimitadas",
-        "Soporte de la comunidad"
+        "Centro de ayuda y soporte por correo"
       ]
     },
     "personal": {
@@ -47,7 +47,7 @@
         "3 bandejas conectadas",
         "Acciones de correo ilimitadas",
         "Límite de ráfaga 2x más alto",
-        "Soporte por correo"
+        "Soporte prioritario por correo"
       ]
     },
     "solo": {
@@ -154,8 +154,9 @@
       "support": {
         "label": "Soporte",
         "rows": {
-          "community": "Foro de la comunidad",
-          "email": "Soporte por correo"
+          "community": "Centro de ayuda",
+          "email": "Soporte por correo",
+          "priority": "Soporte prioritario por correo"
         }
       }
     },
@@ -188,7 +189,7 @@
       },
       {
         "q": "¿Qué añade Personal sobre Free?",
-        "a": "Dos bandejas conectadas más, acciones de correo ilimitadas (con uso justo), el doble de techo de ráfaga (120 peticiones por minuto en lugar de 60), 90 días de historial de analíticas en lugar de 30 y soporte por correo en lugar del foro de la comunidad. Esa es toda la lista. Todo lo que usas a diario también está en Free: leer, buscar, organizar, redactar, enviar y programar envíos, la aprobación antes de enviar configurable por bandeja y el panel de analíticas de uso. Las funciones que siguen trabajando con el chat cerrado, como los recordatorios de seguimiento, posponer y el resumen matinal, están en Pro."
+        "a": "Dos bandejas conectadas más, acciones de correo ilimitadas (con uso justo), el doble de techo de ráfaga (120 peticiones por minuto en lugar de 60), 90 días de historial de analíticas en lugar de 30 y soporte prioritario por correo, mientras que Free tiene el centro de ayuda y el soporte por correo estándar. Esa es toda la lista. Todo lo que usas a diario también está en Free: leer, buscar, organizar, redactar, enviar y programar envíos, la aprobación antes de enviar configurable por bandeja y el panel de analíticas de uso. Las funciones que siguen trabajando con el chat cerrado, como los recordatorios de seguimiento, posponer y el resumen matinal, están en Pro."
       },
       {
         "q": "¿Qué cuenta como una acción de correo?",
@@ -232,7 +233,7 @@
       },
       {
         "q": "¿Puedo auto-alojarlo en lugar de pagar?",
-        "a": "Sí. MCPEmails es código abierto bajo AGPL-3.0 y gratis para auto-alojar. Un stack de docker-compose ejecuta el mismo servidor MCP, con las credenciales de tu buzón cifradas bajo una clave que solo tú posees. El auto-alojamiento cubre buzones IMAP y SMTP. El inicio de sesión con Gmail y Outlook (OAuth) y el panel se quedan en el servicio alojado, donde funcionan en todos los planes, incluido Gratis; los miembros y roles están en Business, y el soporte por correo en todos los planes de pago."
+        "a": "Sí. MCPEmails es código abierto bajo AGPL-3.0 y gratis para auto-alojar. Un stack de docker-compose ejecuta el mismo servidor MCP, con las credenciales de tu buzón cifradas bajo una clave que solo tú posees. El auto-alojamiento cubre buzones IMAP y SMTP. El inicio de sesión con Gmail y Outlook (OAuth) y el panel se quedan en el servicio alojado, donde funcionan en todos los planes, incluido Gratis; los miembros y roles están en Business, y el soporte prioritario por correo en todos los planes de pago."
       }
     ]
   },
diff --git a/apps/web/messages/fr/dashboard.json b/apps/web/messages/fr/dashboard.json
index e76b2a5e..c9d53b21 100644
--- a/apps/web/messages/fr/dashboard.json
+++ b/apps/web/messages/fr/dashboard.json
@@ -818,13 +818,13 @@
       "personalFeature1": "3 boîtes connectées",
       "personalFeature2": "120 requêtes / minute (2× en pointe)",
       "personalFeatureActions": "Actions e-mail illimitées",
-      "personalFeature4": "Support par e-mail",
+      "personalFeature4": "Support prioritaire par e-mail",
       "soloFeature1": "10 boîtes connectées",
       "soloFeature2": "300 requêtes / minute (5× en pointe)",
       "soloFeature3": "Historique d'analytique plus long",
       "soloFeatureChatClosed": "Relances, mise en attente et récapitulatif du matin, même conversation fermée",
       "soloFeatureAllInboxes": "Recherche dans toutes les boîtes à la fois, avec des instructions par boîte",
-      "soloFeature4": "Support par e-mail",
+      "soloFeature4": "Support prioritaire par e-mail",
       "businessFeature1": "Tout ce qu'inclut Pro",
       "businessFeature2": "10 boîtes incluses, 3 $ par mois pour chaque boîte en plus",
       "businessFeature3": "Membres illimités avec rôles, sans surcoût",
diff --git a/apps/web/messages/fr/dashboardChrome.json b/apps/web/messages/fr/dashboardChrome.json
index 87585a9d..bd9b1641 100644
--- a/apps/web/messages/fr/dashboardChrome.json
+++ b/apps/web/messages/fr/dashboardChrome.json
@@ -243,7 +243,7 @@
     "featureInboxes": "10 boîtes connectées",
     "featureRateLimit": "Limite de pointe 5x plus élevée",
     "featureTeam": "Annulez à tout moment, gardez le reste de la période",
-    "featureSupport": "Support par e-mail",
+    "featureSupport": "Support prioritaire par e-mail",
     "personalUpgradeTitle": "Personal connecte trois boîtes",
     "personalUpgradeBody": "Vous alliez connecter une autre boîte. Personal vous en donne trois pour 9 $ par mois : le travail, le personnel et une de plus.",
     "personalUpgradeCta": "Passer à Personal, 9 $/mois",
diff --git a/apps/web/messages/fr/home.json b/apps/web/messages/fr/home.json
index 4c0facc5..3b81f1ed 100644
--- a/apps/web/messages/fr/home.json
+++ b/apps/web/messages/fr/home.json
@@ -192,7 +192,7 @@
           "Analytique d'usage",
           "Gmail, Outlook, iCloud, Fastmail et toute boîte IMAP",
           "Clés API illimitées",
-          "Support communautaire"
+          "Centre d'aide et support par e-mail"
         ],
         "cta": "Commencer gratuitement"
       },
@@ -203,7 +203,7 @@
           "Tout ce que contient Free",
           "3 boîtes connectées",
           "Limite de pointe 2x plus élevée",
-          "Support par e-mail"
+          "Support prioritaire par e-mail"
         ],
         "cta": "Choisir Personal",
         "ctaGrandfathered": "Vous avez déjà des boîtes illimitées"
diff --git a/apps/web/messages/fr/pricing.json b/apps/web/messages/fr/pricing.json
index 04c14843..9634bb44 100644
--- a/apps/web/messages/fr/pricing.json
+++ b/apps/web/messages/fr/pricing.json
@@ -34,7 +34,7 @@
         "Analytique d'usage",
         "Gmail, Outlook, iCloud, Fastmail et toute boîte IMAP",
         "Clés API illimitées",
-        "Support communautaire"
+        "Centre d'aide et support par e-mail"
       ]
     },
     "personal": {
@@ -47,7 +47,7 @@
         "3 boîtes connectées",
         "Actions e-mail illimitées",
         "Limite de pointe 2x plus élevée",
-        "Support par e-mail"
+        "Support prioritaire par e-mail"
       ]
     },
     "solo": {
@@ -154,8 +154,9 @@
       "support": {
         "label": "Support",
         "rows": {
-          "community": "Forum communautaire",
-          "email": "Support par e-mail"
+          "community": "Centre d'aide",
+          "email": "Support par e-mail",
+          "priority": "Support prioritaire par e-mail"
         }
       }
     },
@@ -188,7 +189,7 @@
       },
       {
         "q": "Qu'apporte Personal par rapport à Free ?",
-        "a": "Deux boîtes connectées de plus, des actions e-mail illimitées (usage équitable), un plafond de pointe doublé (120 requêtes par minute au lieu de 60), 90 jours d'historique d'analytique au lieu de 30 et le support par e-mail à la place du forum communautaire. C'est toute la liste. Tout ce que vous utilisez au quotidien est aussi dans Free : lire, chercher, organiser, rédiger, envoyer et programmer des envois, la validation avant envoi réglable par boîte, et le tableau de bord d'analytique d'usage. Les fonctions qui continuent de travailler quand la conversation est fermée, comme les relances, la mise en attente et le récapitulatif du matin, sont dans Pro."
+        "a": "Deux boîtes connectées de plus, des actions e-mail illimitées (usage équitable), un plafond de pointe doublé (120 requêtes par minute au lieu de 60), 90 jours d'historique d'analytique au lieu de 30 et le support prioritaire par e-mail, là où Free a le centre d'aide et le support par e-mail standard. C'est toute la liste. Tout ce que vous utilisez au quotidien est aussi dans Free : lire, chercher, organiser, rédiger, envoyer et programmer des envois, la validation avant envoi réglable par boîte, et le tableau de bord d'analytique d'usage. Les fonctions qui continuent de travailler quand la conversation est fermée, comme les relances, la mise en attente et le récapitulatif du matin, sont dans Pro."
       },
       {
         "q": "Qu'est-ce qui compte comme une action e-mail ?",
@@ -232,7 +233,7 @@
       },
       {
         "q": "Puis-je l'héberger moi-même plutôt que de payer ?",
-        "a": "Oui. MCPEmails est open source sous AGPL-3.0 et gratuit à héberger soi-même. Une stack docker-compose exécute le même serveur MCP, avec les identifiants de votre boîte mail chiffrés sous une clé que vous seul détenez. L'auto-hébergement couvre les boîtes mail IMAP et SMTP. La connexion Gmail et Outlook (OAuth) et le tableau de bord restent sur le service hébergé, où ils fonctionnent avec tous les forfaits, Gratuit compris ; les membres et rôles sont sur Business, et le support par e-mail sur tous les forfaits payants."
+        "a": "Oui. MCPEmails est open source sous AGPL-3.0 et gratuit à héberger soi-même. Une stack docker-compose exécute le même serveur MCP, avec les identifiants de votre boîte mail chiffrés sous une clé que vous seul détenez. L'auto-hébergement couvre les boîtes mail IMAP et SMTP. La connexion Gmail et Outlook (OAuth) et le tableau de bord restent sur le service hébergé, où ils fonctionnent avec tous les forfaits, Gratuit compris ; les membres et rôles sont sur Business, et le support prioritaire par e-mail sur tous les forfaits payants."
       }
     ]
   },
diff --git a/apps/web/messages/nb/dashboard.json b/apps/web/messages/nb/dashboard.json
index 9a11454e..f7b47ac8 100644
--- a/apps/web/messages/nb/dashboard.json
+++ b/apps/web/messages/nb/dashboard.json
@@ -818,13 +818,13 @@
       "personalFeature1": "3 tilkoblede innbokser",
       "personalFeature2": "120 forespørsler / minutt (2× burst)",
       "personalFeatureActions": "Ubegrensede e-posthandlinger",
-      "personalFeature4": "E-poststøtte",
+      "personalFeature4": "Prioritert e-poststøtte",
       "soloFeature1": "10 tilkoblede innbokser",
       "soloFeature2": "300 forespørsler / minutt (5× burst)",
       "soloFeature3": "Lengre analysehistorikk",
       "soloFeatureChatClosed": "Oppfølging, utsettelse og morgenoppsummering mens chatten er lukket",
       "soloFeatureAllInboxes": "Søk i alle innbokser samtidig, med instruksjoner per innboks",
-      "soloFeature4": "E-poststøtte",
+      "soloFeature4": "Prioritert e-poststøtte",
       "businessFeature1": "Alt i Pro",
       "businessFeature2": "10 postkasser inkludert, 3 dollar i måneden for hver ekstra",
       "businessFeature3": "Ubegrenset antall medlemmer med roller, uten ekstra kostnad",
diff --git a/apps/web/messages/nb/dashboardChrome.json b/apps/web/messages/nb/dashboardChrome.json
index 87096067..6dcb7a4e 100644
--- a/apps/web/messages/nb/dashboardChrome.json
+++ b/apps/web/messages/nb/dashboardChrome.json
@@ -253,7 +253,7 @@
     "featureInboxes": "10 tilkoblede innbokser",
     "featureRateLimit": "5x høyere burst-grense",
     "featureTeam": "Si opp når som helst, behold resten av perioden",
-    "featureSupport": "E-poststøtte",
+    "featureSupport": "Prioritert e-poststøtte",
     "fastmailTabAppPassword": "App-passord",
     "howToGenerate": "Slik genererer du ett",
     "zohoRegionLabel": "Datasenterregion",
diff --git a/apps/web/messages/nb/home.json b/apps/web/messages/nb/home.json
index 50c2221c..0114305b 100644
--- a/apps/web/messages/nb/home.json
+++ b/apps/web/messages/nb/home.json
@@ -192,7 +192,7 @@
           "Bruksanalyse",
           "Gmail, Outlook, iCloud, Fastmail og alle IMAP",
           "Ubegrenset antall API-nøkler",
-          "Fellesskapsstøtte"
+          "Hjelpesenter og e-poststøtte"
         ],
         "cta": "Start gratis"
       },
@@ -203,7 +203,7 @@
           "Alt i Free",
           "3 tilkoblede innbokser",
           "2x høyere burst-grense",
-          "E-poststøtte"
+          "Prioritert e-poststøtte"
         ],
         "cta": "Velg Personal",
         "ctaGrandfathered": "Du har allerede ubegrenset antall innbokser"
diff --git a/apps/web/messages/nb/pricing.json b/apps/web/messages/nb/pricing.json
index c319cdb5..a5c689a5 100644
--- a/apps/web/messages/nb/pricing.json
+++ b/apps/web/messages/nb/pricing.json
@@ -34,7 +34,7 @@
         "Bruksanalyse",
         "Gmail, Outlook, iCloud, Fastmail og enhver IMAP",
         "Ubegrenset antall API-nøkler",
-        "Fellesskapsstøtte"
+        "Hjelpesenter og e-poststøtte"
       ]
     },
     "personal": {
@@ -47,7 +47,7 @@
         "3 tilkoblede innbokser",
         "Ubegrensede e-posthandlinger",
         "2x høyere burst-grense",
-        "E-poststøtte"
+        "Prioritert e-poststøtte"
       ]
     },
     "solo": {
@@ -154,8 +154,9 @@
       "support": {
         "label": "Kundestøtte",
         "rows": {
-          "community": "Fellesskapsforum",
-          "email": "E-poststøtte"
+          "community": "Hjelpesenter",
+          "email": "E-poststøtte",
+          "priority": "Prioritert e-poststøtte"
         }
       }
     },
@@ -188,7 +189,7 @@
       },
       {
         "q": "Hva gir Personal utover Free?",
-        "a": "To innbokser til, ubegrensede e-posthandlinger (rimelig bruk gjelder), dobbelt så høyt burst-tak (120 forespørsler per minutt i stedet for 60), 90 dager analysehistorikk i stedet for 30, og e-poststøtte i stedet for fellesskapsforumet. Det er hele listen. Alt du bruker til vanlig ligger også i Free: lese, søke, organisere, skrive, sende og planlagte sendinger, godkjenning før sending per innboks, og dashbordet for bruksanalyse. Funksjonene som jobber videre når chatten er lukket, som oppfølgingspåminnelser, utsettelse og morgenoppsummeringen, ligger i Pro."
+        "a": "To innbokser til, ubegrensede e-posthandlinger (rimelig bruk gjelder), dobbelt så høyt burst-tak (120 forespørsler per minutt i stedet for 60), 90 dager analysehistorikk i stedet for 30, og prioritert e-poststøtte, der Free har hjelpesenteret og vanlig e-poststøtte. Det er hele listen. Alt du bruker til vanlig ligger også i Free: lese, søke, organisere, skrive, sende og planlagte sendinger, godkjenning før sending per innboks, og dashbordet for bruksanalyse. Funksjonene som jobber videre når chatten er lukket, som oppfølgingspåminnelser, utsettelse og morgenoppsummeringen, ligger i Pro."
       },
       {
         "q": "Hva regnes som en e-posthandling?",
@@ -232,7 +233,7 @@
       },
       {
         "q": "Kan jeg selvhoste den i stedet for å betale?",
-        "a": "Ja. MCPEmails er åpen kildekode under AGPL-3.0 og gratis å selvhoste. En docker-compose-stack kjører den samme MCP-serveren, med legitimasjonen til postkassen din kryptert under en nøkkel bare du har. Selvhosting dekker IMAP- og SMTP-postkasser. Gmail- og Outlook-innlogging (OAuth) og dashboardet finnes på den hostede tjenesten, der de fungerer på alle planer, også Gratis; medlemmer og roller hører til Business, og e-poststøtte følger med alle betalte planer."
+        "a": "Ja. MCPEmails er åpen kildekode under AGPL-3.0 og gratis å selvhoste. En docker-compose-stack kjører den samme MCP-serveren, med legitimasjonen til postkassen din kryptert under en nøkkel bare du har. Selvhosting dekker IMAP- og SMTP-postkasser. Gmail- og Outlook-innlogging (OAuth) og dashboardet finnes på den hostede tjenesten, der de fungerer på alle planer, også Gratis; medlemmer og roller hører til Business, og prioritert e-poststøtte følger med alle betalte planer."
       }
     ]
   },
diff --git a/apps/web/messages/zh/dashboard.json b/apps/web/messages/zh/dashboard.json
index f48bfa9c..7c344adf 100644
--- a/apps/web/messages/zh/dashboard.json
+++ b/apps/web/messages/zh/dashboard.json
@@ -692,11 +692,11 @@
       "personalFeature1": "3 个已连接收件箱",
       "personalFeature2": "120 次请求／分钟（2× 突发）",
       "personalFeatureActions": "邮件操作不限量",
-      "personalFeature4": "电子邮件支持",
+      "personalFeature4": "优先邮件支持",
       "soloFeature1": "可连接 10 个收件箱",
       "soloFeature2": "300 次请求／分钟（5× 突发）",
       "soloFeature3": "更长的分析历史",
-      "soloFeature4": "电子邮件支持",
+      "soloFeature4": "优先邮件支持",
       "businessFeature1": "包含 Pro 的全部功能",
       "businessFeature2": "包含 10 个邮箱，每多一个每月 3 美元",
       "businessFeature3": "成员数量不限，可分配角色，不额外收费",
diff --git a/apps/web/messages/zh/dashboardChrome.json b/apps/web/messages/zh/dashboardChrome.json
index 42578f04..c101d625 100644
--- a/apps/web/messages/zh/dashboardChrome.json
+++ b/apps/web/messages/zh/dashboardChrome.json
@@ -243,7 +243,7 @@
     "featureInboxes": "可连接 10 个收件箱",
     "featureRateLimit": "突发速率上限提升 5 倍",
     "featureTeam": "随时取消，本周期剩余时间照旧有效",
-    "featureSupport": "邮件支持",
+    "featureSupport": "优先邮件支持",
     "personalUpgradeTitle": "Personal 可连接三个邮箱",
     "personalUpgradeBody": "你正准备再连接一个收件箱。Personal 每月 $9 让你连到三个：工作、私人，再加一个。",
     "personalUpgradeCta": "升级到 Personal，$9/月",
diff --git a/apps/web/messages/zh/home.json b/apps/web/messages/zh/home.json
index 6bb4e3bb..2e783aab 100644
--- a/apps/web/messages/zh/home.json
+++ b/apps/web/messages/zh/home.json
@@ -192,7 +192,7 @@
           "使用分析",
           "Gmail、Outlook、iCloud、Fastmail 及任何 IMAP",
           "无限量 API 密钥",
-          "社区支持"
+          "帮助中心和邮件支持"
         ],
         "cta": "免费开始"
       },
@@ -203,7 +203,7 @@
           "包含 Free 的全部功能",
           "3 个已连接收件箱",
           "突发速率上限提升 2 倍",
-          "邮件支持"
+          "优先邮件支持"
         ],
         "cta": "获取 Personal",
         "ctaGrandfathered": "你已拥有无限量收件箱"
diff --git a/apps/web/messages/zh/pricing.json b/apps/web/messages/zh/pricing.json
index 9253bc6a..1b559954 100644
--- a/apps/web/messages/zh/pricing.json
+++ b/apps/web/messages/zh/pricing.json
@@ -34,7 +34,7 @@
         "使用分析",
         "Gmail、Outlook、iCloud、Fastmail 及任何 IMAP",
         "无限量 API 密钥",
-        "社区支持"
+        "帮助中心和邮件支持"
       ]
     },
     "personal": {
@@ -47,7 +47,7 @@
         "3 个已连接收件箱",
         "邮件操作不限量",
         "突发速率上限提升 2 倍",
-        "邮件支持"
+        "优先邮件支持"
       ]
     },
     "solo": {
@@ -154,8 +154,9 @@
       "support": {
         "label": "支持",
         "rows": {
-          "community": "社区论坛",
-          "email": "邮件支持"
+          "community": "帮助中心",
+          "email": "邮件支持",
+          "priority": "优先邮件支持"
         }
       }
     },
@@ -188,7 +189,7 @@
       },
       {
         "q": "Personal 比 Free 多了什么？",
-        "a": "多两个已连接收件箱、邮件操作不限量（适用合理使用原则）、突发上限翻倍（每分钟 120 次请求而不是 60 次）、90 天而不是 30 天的分析历史，以及邮件支持而非社区论坛。这就是全部。日常使用的功能 Free 也都包含：读取、搜索、整理、起草、发送和定时发送、可按收件箱设置的发送前审批，以及使用分析仪表盘。在聊天关闭后仍继续工作的功能，例如跟进提醒、稍后处理和早间简报，属于 Pro。"
+        "a": "多两个已连接收件箱、邮件操作不限量（适用合理使用原则）、突发上限翻倍（每分钟 120 次请求而不是 60 次）、90 天而不是 30 天的分析历史，以及优先邮件支持（Free 提供帮助中心和标准邮件支持）。这就是全部。日常使用的功能 Free 也都包含：读取、搜索、整理、起草、发送和定时发送、可按收件箱设置的发送前审批，以及使用分析仪表盘。在聊天关闭后仍继续工作的功能，例如跟进提醒、稍后处理和早间简报，属于 Pro。"
       },
       {
         "q": "什么算作一次邮件操作？",
@@ -232,7 +233,7 @@
       },
       {
         "q": "我可以自托管来代替付费吗？",
-        "a": "可以。MCPEmails 采用 AGPL-3.0 开源，可免费自托管。一个 docker-compose 栈运行同一个 MCP 服务器，你的邮箱凭据用只有你持有的密钥加密。自托管支持 IMAP 和 SMTP 邮箱。Gmail 和 Outlook 登录（OAuth）以及控制台只在托管服务中提供，并且在所有套餐（包括免费套餐）上都可用；成员与角色属于 Business，邮件支持包含在所有付费套餐中。"
+        "a": "可以。MCPEmails 采用 AGPL-3.0 开源，可免费自托管。一个 docker-compose 栈运行同一个 MCP 服务器，你的邮箱凭据用只有你持有的密钥加密。自托管支持 IMAP 和 SMTP 邮箱。Gmail 和 Outlook 登录（OAuth）以及控制台只在托管服务中提供，并且在所有套餐（包括免费套餐）上都可用；成员与角色属于 Business，优先邮件支持包含在所有付费套餐中。"
       }
     ]
   },
diff --git a/apps/web/public/llms.txt b/apps/web/public/llms.txt
index 2f8a8a37..45407791 100644
--- a/apps/web/public/llms.txt
+++ b/apps/web/public/llms.txt
@@ -9,7 +9,7 @@ Key facts an assistant should know when recommending or describing MCPEmails:
 - Providers: Outlook / Microsoft 365 (Sign in with Microsoft, over Microsoft Graph), Gmail and Google Workspace (Google app password over IMAP), Fastmail, iCloud, Yahoo, Zoho, Yandex (app password), and any other mailbox via generic IMAP/SMTP. Personal Outlook.com, Hotmail, Live and MSN accounts connect directly; a work or school Microsoft 365 account may first need an IT admin to approve the app once for the organisation.
 - Tools (21, most take an `action` argument): inbox_list, email_read, email_organize, email_search_and_move, email_delete, email_compose, folder_list, folder, draft_list, draft, draft_read, draft_editor_hide, schedule_list, schedule, reminder_list, reminder, signature_get, signature_set, automation_read, automation, contact_search. A full-scope key also lists 8 app-only tools that drive in-chat cards (approval_*, bulk_*, draft_editor_save, card_automation); they are not called by hand.
 - Privacy: email content is never stored; fetched live per request. The exceptions are outgoing messages that have to wait (a scheduled send, or a send held for approval), which are stored encrypted. Credentials are encrypted at rest with AES-256-GCM and decrypted on our servers only for the request that needs them. Data is stored in one region, the EU (Stockholm); the servers that call your mail provider run in the US (East). Cookie-free, aggregated Vercel Web Analytics only; no email or account data is sent to analytics.
-- Pricing: Free (no card, 1 inbox, 150 email actions per calendar month, first 3 days uncounted, 60 requests/min), Personal $9/mo or $86.40/yr (3 inboxes, unlimited email actions, 120 requests/min, email support), Pro $15/mo or $144/yr (up to 10 inboxes, unlimited email actions, plus features that keep working when the chat is closed: follow-up reminders on sent mail, snooze, a daily morning brief put into your inbox, search across every connected inbox at once with inbox_id "all", and per-inbox instructions for the AI; Business includes them too), Business $39/mo or $374.40/yr (10 inboxes included, $3/mo or $28.80/yr for each extra, unlimited members with roles, admins approve held sends, several workspaces). Failed calls and inbox_list are never counted. When a Free workspace reaches 150, further email actions return an isError tool result naming the count and the reset date (the 1st of next month, UTC); retrying does not help.
+- Pricing: Free (no card, 1 inbox, 150 email actions per calendar month, first 3 days uncounted, 60 requests/min, help center and email support), Personal $9/mo or $86.40/yr (3 inboxes, unlimited email actions, 120 requests/min, priority email support), Pro $15/mo or $144/yr (up to 10 inboxes, unlimited email actions, priority email support, plus features that keep working when the chat is closed: follow-up reminders on sent mail, snooze, a daily morning brief put into your inbox, search across every connected inbox at once with inbox_id "all", and per-inbox instructions for the AI; Business includes them too), Business $39/mo or $374.40/yr (10 inboxes included, $3/mo or $28.80/yr for each extra, unlimited members with roles, admins approve held sends, several workspaces). Failed calls and inbox_list are never counted. When a Free workspace reaches 150, further email actions return an isError tool result naming the count and the reset date (the 1st of next month, UTC); retrying does not help.
 - Works with: Claude (web, desktop, code), Cursor, VS Code, ChatGPT, Cline, Windsurf, n8n, Make, Gemini CLI, Zed, JetBrains, Raycast, Warp, and any MCP client. Standard Streamable HTTP with OAuth 2.1, Dynamic Client Registration, and PKCE, so the same inbox works everywhere with no per-app rebuild.
 - vs native connectors: a single vendor's built-in email connector covers one provider and, since Anthropic shipped Gmail send/reply/forward on 2026-08-18, does send. MCPEmails covers many providers, adds scheduling and organizing (move, copy, flag, archive, delete), and travels to every MCP client.
 
diff --git a/apps/web/src/lib/stripe/plans.ts b/apps/web/src/lib/stripe/plans.ts
index 2f9f67b3..827e22be 100644
--- a/apps/web/src/lib/stripe/plans.ts
+++ b/apps/web/src/lib/stripe/plans.ts
@@ -356,7 +356,7 @@ export const PLANS: Record<PlanId, Plan> = {
       'Usage analytics',
       'Gmail, Outlook, iCloud, Fastmail and any IMAP',
       'Unlimited API keys',
-      'Community support',
+      'Help center and email support',
     ],
     highlighted: false,
   },
@@ -406,7 +406,8 @@ export const PLANS: Record<PlanId, Plan> = {
     // 1 -> 3, the monthly action cap (Free's public 150 -> none that a
     // customer can reach; the paid ceiling stays a silent abuse guard and is
     // never quoted as a number), maxRequestsPerMinute 60 -> 120, supportTier
-    // community -> email, billingPortalEnabled, and analyticsRetentionDays
+    // community -> email (shown as priority email support; Free shows the
+    // help center and email support), billingPortalEnabled, and analyticsRetentionDays
     // 30 -> 90. The history window is left out on purpose: this array ships in
     // the purchase confirmation email, which nothing re-checks when a window
     // moves; the pricing page's comparison table carries it. Pro and Business
@@ -416,7 +417,7 @@ export const PLANS: Record<PlanId, Plan> = {
       '3 connected inboxes',
       'No monthly action cap',
       '2x higher burst rate limit',
-      'Email support',
+      'Priority email support',
     ],
     highlighted: false,
   },
```
