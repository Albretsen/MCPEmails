# Releasing Help & support

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
2. There are no new env vars. The feature reads ones that are already set in
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
   - Team: unchanged.
   - The comparison table's "Community forum" row becomes "Help center".
   - The Personal-vs-Free FAQ answer is rewritten.
   - The self-hosting FAQ answer is updated, since "email support is on the
     paid plans" stops being true.
   - The in-product Personal/Pro feature lists and `llms.txt` are updated.

   `supportTier` ids (`community`, `email`, `priority`) stay as internal
   names. If the diff no longer applies, regenerate it with the same intent.
6. **Copy the diff does not cover.** Review these by hand:
   - `messages/*/pricing.json`: the "Personal vs Pro vs Team" FAQ.
   - `messages/*/dashboard.json`: `grandfatheredBody`.
   - `messages/*/forBusiness.json`: the Personal line.
   - Blog posts that state plan support levels:
     - `how-to-give-your-ai-agent-email-access.js`
     - `manage-multiple-email-accounts-with-ai.js`
     - `ai-email-for-agencies-and-client-work.js`
     - `hosted-vs-self-hosted-gmail-mcp-server.js`
   - Regenerate `scripts/built-output/snapshots`.
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
diff -ru a/apps/web/components/marketing/PricingClient.jsx b/apps/web/components/marketing/PricingClient.jsx
--- a/apps/web/components/marketing/PricingClient.jsx	2026-10-15 21:50:36
+++ b/apps/web/components/marketing/PricingClient.jsx	2026-10-15 21:50:37
@@ -148,8 +148,8 @@
     key: 'support',
     rows: [
       { key: 'community', free: true,  personal: true,  solo: true,  pro: true },
-      { key: 'email',     free: false, personal: true,  solo: true,  pro: true },
-      { key: 'priority',  free: false, personal: false, solo: false, pro: true },
+      { key: 'email',     free: true,  personal: true,  solo: true,  pro: true },
+      { key: 'priority',  free: false, personal: true,  solo: true,  pro: true },
     ],
   },
 ];
diff -ru a/apps/web/messages/en/dashboard.json b/apps/web/messages/en/dashboard.json
--- a/apps/web/messages/en/dashboard.json
+++ b/apps/web/messages/en/dashboard.json
@@ -515,11 +515,11 @@
       "personalFeature1": "3 connected inboxes",
       "personalFeature2": "120 requests / minute (2× burst)",
       "personalFeatureActions": "No monthly action cap",
-      "personalFeature4": "Email support",
+      "personalFeature4": "Priority email support",
       "soloFeature1": "Unlimited connected inboxes",
       "soloFeature2": "300 requests / minute (5× burst)",
       "soloFeature3": "Longer analytics history",
-      "soloFeature4": "Email support",
+      "soloFeature4": "Priority email support",
       "teamFeature1": "Everything in Pro",
       "teamFeature2": "Unlimited members with roles",
       "teamFeature3": "A separate workspace per client or business",
diff -ru a/apps/web/messages/en/dashboardChrome.json b/apps/web/messages/en/dashboardChrome.json
--- a/apps/web/messages/en/dashboardChrome.json
+++ b/apps/web/messages/en/dashboardChrome.json
@@ -233,7 +233,7 @@
     "featureInboxes": "Unlimited connected inboxes",
     "featureRateLimit": "5x higher burst rate limit",
     "featureTeam": "Cancel any time, keep the rest of the period",
-    "featureSupport": "Email support",
+    "featureSupport": "Priority email support",
     "personalUpgradeTitle": "Personal connects three mailboxes",
     "personalUpgradeBody": "You were about to connect another inbox. Personal takes you to three for $9 a month: work, personal, and one more.",
     "personalUpgradeCta": "Upgrade to Personal, $9/mo",
diff -ru a/apps/web/messages/en/home.json b/apps/web/messages/en/home.json
--- a/apps/web/messages/en/home.json
+++ b/apps/web/messages/en/home.json
@@ -162,7 +162,7 @@
           "Usage analytics",
           "Gmail, Outlook, iCloud, Fastmail & any IMAP",
           "Unlimited API keys",
-          "Community support"
+          "Help center and email support"
         ],
         "cta": "Start free"
       },
@@ -173,7 +173,7 @@
           "Everything in Free",
           "3 connected inboxes",
           "2x higher burst rate limit",
-          "Email support"
+          "Priority email support"
         ],
         "cta": "Get Personal",
         "ctaGrandfathered": "You already have unlimited inboxes"
diff -ru a/apps/web/messages/en/pricing.json b/apps/web/messages/en/pricing.json
--- a/apps/web/messages/en/pricing.json
+++ b/apps/web/messages/en/pricing.json
@@ -33,7 +33,7 @@
         "Usage analytics",
         "Gmail, Outlook, iCloud, Fastmail and any IMAP",
         "Unlimited API keys",
-        "Community support"
+        "Help center and email support"
       ]
     },
     "personal": {
@@ -46,7 +46,7 @@
         "3 connected inboxes",
         "No monthly action cap",
         "2x higher burst rate limit",
-        "Email support"
+        "Priority email support"
       ]
     },
     "solo": {
@@ -132,9 +132,9 @@
       "support": {
         "label": "Support",
         "rows": {
-          "community": "Community forum",
+          "community": "Help center",
           "email": "Email support",
-          "priority": "Priority support"
+          "priority": "Priority email support"
         }
       }
     },
@@ -165,7 +165,7 @@
       },
       {
         "q": "What does Personal add over Free?",
-        "a": "Two more connected inboxes, no monthly cap on email actions (fair use applies), double the burst ceiling (120 requests a minute instead of 60), and email support instead of the community forum. That is the whole list. Everything else is already on Free: every MCP tool including scheduled sends, the per-inbox send review and approval hold, and the usage analytics dashboard. We do not hold features back from Free to make the paid tiers look bigger."
+        "a": "Two more connected inboxes, no monthly cap on email actions (fair use applies), double the burst ceiling (120 requests a minute instead of 60), and priority email support, where Free has the help center and standard email support. That is the whole list. Everything else is already on Free: every MCP tool including scheduled sends, the per-inbox send review and approval hold, and the usage analytics dashboard. We do not hold features back from Free to make the paid tiers look bigger."
       },
       {
         "q": "What counts as an email action?",
@@ -209,7 +209,7 @@
       },
       {
         "q": "Can I self-host it instead of paying?",
-        "a": "Yes. MCP Emails is open source under AGPL-3.0 and free to self-host. A docker-compose stack runs the same MCP server, with your mailbox credentials encrypted under a key only you hold. Self-host covers IMAP and SMTP mailboxes. Gmail and Outlook sign-in (OAuth) and the dashboard stay on the hosted service, where they work on every plan, Free included; team features and email support are on the paid plans."
+        "a": "Yes. MCP Emails is open source under AGPL-3.0 and free to self-host. A docker-compose stack runs the same MCP server, with your mailbox credentials encrypted under a key only you hold. Self-host covers IMAP and SMTP mailboxes. Gmail and Outlook sign-in (OAuth) and the dashboard stay on the hosted service, where they work on every plan, Free included; team features and priority email support are on the paid plans."
       }
     ]
   },
diff -ru a/apps/web/messages/es/dashboard.json b/apps/web/messages/es/dashboard.json
--- a/apps/web/messages/es/dashboard.json
+++ b/apps/web/messages/es/dashboard.json
@@ -515,11 +515,11 @@
       "personalFeature1": "3 bandejas conectadas",
       "personalFeature2": "120 peticiones / minuto (ráfaga 2×)",
       "personalFeatureActions": "Sin límite mensual de acciones",
-      "personalFeature4": "Soporte por correo",
+      "personalFeature4": "Soporte prioritario por correo",
       "soloFeature1": "Bandejas conectadas ilimitadas",
       "soloFeature2": "300 peticiones / minuto (ráfaga 5×)",
       "soloFeature3": "Más historial de analíticas",
-      "soloFeature4": "Soporte por correo",
+      "soloFeature4": "Soporte prioritario por correo",
       "teamFeature1": "Todo lo de Pro",
       "teamFeature2": "Miembros ilimitados con roles",
       "teamFeature3": "Un espacio de trabajo separado por cliente o negocio",
diff -ru a/apps/web/messages/es/dashboardChrome.json b/apps/web/messages/es/dashboardChrome.json
--- a/apps/web/messages/es/dashboardChrome.json
+++ b/apps/web/messages/es/dashboardChrome.json
@@ -233,7 +233,7 @@
     "featureInboxes": "Bandejas conectadas ilimitadas",
     "featureRateLimit": "Límite de ráfaga 5x más alto",
     "featureTeam": "Cancela cuando quieras y conserva el resto del período",
-    "featureSupport": "Soporte por correo",
+    "featureSupport": "Soporte prioritario por correo",
     "personalUpgradeTitle": "Personal conecta tres buzones",
     "personalUpgradeBody": "Estabas a punto de conectar otra bandeja. Personal te lleva a tres por $9 al mes: el del trabajo, el personal y uno más.",
     "personalUpgradeCta": "Mejorar a Personal, $9/mes",
diff -ru a/apps/web/messages/es/home.json b/apps/web/messages/es/home.json
--- a/apps/web/messages/es/home.json
+++ b/apps/web/messages/es/home.json
@@ -162,7 +162,7 @@
           "Analíticas de uso",
           "Gmail, Outlook, iCloud, Fastmail y cualquier IMAP",
           "Claves de API ilimitadas",
-          "Soporte de la comunidad"
+          "Centro de ayuda y soporte por correo"
         ],
         "cta": "Empieza gratis"
       },
@@ -173,7 +173,7 @@
           "Todo lo de Free",
           "3 bandejas conectadas",
           "Límite de ráfaga 2x más alto",
-          "Soporte por correo"
+          "Soporte prioritario por correo"
         ],
         "cta": "Obtener Personal",
         "ctaGrandfathered": "Ya tienes bandejas ilimitadas"
diff -ru a/apps/web/messages/es/pricing.json b/apps/web/messages/es/pricing.json
--- a/apps/web/messages/es/pricing.json
+++ b/apps/web/messages/es/pricing.json
@@ -33,7 +33,7 @@
         "Analíticas de uso",
         "Gmail, Outlook, iCloud, Fastmail y cualquier IMAP",
         "Claves de API ilimitadas",
-        "Soporte de la comunidad"
+        "Centro de ayuda y soporte por correo"
       ]
     },
     "personal": {
@@ -46,7 +46,7 @@
         "3 bandejas conectadas",
         "Sin tope mensual de acciones",
         "Límite de ráfaga 2x más alto",
-        "Soporte por correo"
+        "Soporte prioritario por correo"
       ]
     },
     "solo": {
@@ -132,9 +132,9 @@
       "support": {
         "label": "Soporte",
         "rows": {
-          "community": "Foro de la comunidad",
+          "community": "Centro de ayuda",
           "email": "Soporte por correo",
-          "priority": "Soporte prioritario"
+          "priority": "Soporte prioritario por correo"
         }
       }
     },
@@ -165,7 +165,7 @@
       },
       {
         "q": "¿Qué añade Personal sobre Free?",
-        "a": "Dos bandejas conectadas más, ningún tope mensual de acciones de correo (con uso justo), el doble de techo de ráfaga (120 peticiones por minuto en lugar de 60) y soporte por correo en lugar del foro de la comunidad. Esa es toda la lista. Todo lo demás ya está en Free: todas las herramientas MCP, incluidos los envíos programados, la aprobación antes de enviar configurable por bandeja y el panel de analíticas de uso. No retenemos funciones en Free para que los planes de pago parezcan más grandes."
+        "a": "Dos bandejas conectadas más, ningún tope mensual de acciones de correo (con uso justo), el doble de techo de ráfaga (120 peticiones por minuto en lugar de 60) y soporte prioritario por correo, mientras que Free tiene el centro de ayuda y el soporte por correo estándar. Esa es toda la lista. Todo lo demás ya está en Free: todas las herramientas MCP, incluidos los envíos programados, la aprobación antes de enviar configurable por bandeja y el panel de analíticas de uso. No retenemos funciones en Free para que los planes de pago parezcan más grandes."
       },
       {
         "q": "¿Qué cuenta como una acción de correo?",
@@ -209,7 +209,7 @@
       },
       {
         "q": "¿Puedo auto-alojarlo en lugar de pagar?",
-        "a": "Sí. MCP Emails es código abierto bajo AGPL-3.0 y gratis para auto-alojar. Un stack de docker-compose ejecuta el mismo servidor MCP, con las credenciales de tu buzón cifradas bajo una clave que solo tú posees. El auto-alojamiento cubre buzones IMAP y SMTP. El inicio de sesión con Gmail y Outlook (OAuth) y el panel se quedan en el servicio alojado, donde funcionan en todos los planes, incluido Gratis; las funciones de equipo y el soporte por correo están en los planes de pago."
+        "a": "Sí. MCP Emails es código abierto bajo AGPL-3.0 y gratis para auto-alojar. Un stack de docker-compose ejecuta el mismo servidor MCP, con las credenciales de tu buzón cifradas bajo una clave que solo tú posees. El auto-alojamiento cubre buzones IMAP y SMTP. El inicio de sesión con Gmail y Outlook (OAuth) y el panel se quedan en el servicio alojado, donde funcionan en todos los planes, incluido Gratis; las funciones de equipo y el soporte prioritario por correo están en los planes de pago."
       }
     ]
   },
diff -ru a/apps/web/messages/fr/dashboard.json b/apps/web/messages/fr/dashboard.json
--- a/apps/web/messages/fr/dashboard.json
+++ b/apps/web/messages/fr/dashboard.json
@@ -515,11 +515,11 @@
       "personalFeature1": "3 boîtes connectées",
       "personalFeature2": "120 requêtes / minute (2× en pointe)",
       "personalFeatureActions": "Pas de plafond mensuel d'actions",
-      "personalFeature4": "Support par e-mail",
+      "personalFeature4": "Support prioritaire par e-mail",
       "soloFeature1": "Boîtes connectées illimitées",
       "soloFeature2": "300 requêtes / minute (5× en pointe)",
       "soloFeature3": "Historique d'analytique plus long",
-      "soloFeature4": "Support par e-mail",
+      "soloFeature4": "Support prioritaire par e-mail",
       "teamFeature1": "Tout ce que contient Pro",
       "teamFeature2": "Membres illimités avec rôles",
       "teamFeature3": "Un espace de travail distinct par client ou activité",
diff -ru a/apps/web/messages/fr/dashboardChrome.json b/apps/web/messages/fr/dashboardChrome.json
--- a/apps/web/messages/fr/dashboardChrome.json
+++ b/apps/web/messages/fr/dashboardChrome.json
@@ -233,7 +233,7 @@
     "featureInboxes": "Boîtes connectées illimitées",
     "featureRateLimit": "Limite de pointe 5x plus élevée",
     "featureTeam": "Annulez à tout moment, gardez le reste de la période",
-    "featureSupport": "Support par e-mail",
+    "featureSupport": "Support prioritaire par e-mail",
     "personalUpgradeTitle": "Personal connecte trois boîtes",
     "personalUpgradeBody": "Vous alliez connecter une autre boîte. Personal vous en donne trois pour 9 $ par mois : le travail, le personnel et une de plus.",
     "personalUpgradeCta": "Passer à Personal, 9 $/mois",
diff -ru a/apps/web/messages/fr/home.json b/apps/web/messages/fr/home.json
--- a/apps/web/messages/fr/home.json
+++ b/apps/web/messages/fr/home.json
@@ -162,7 +162,7 @@
           "Analytique d'usage",
           "Gmail, Outlook, iCloud, Fastmail et toute boîte IMAP",
           "Clés API illimitées",
-          "Support communautaire"
+          "Centre d'aide et support par e-mail"
         ],
         "cta": "Commencer gratuitement"
       },
@@ -173,7 +173,7 @@
           "Tout ce que contient Free",
           "3 boîtes connectées",
           "Limite de pointe 2x plus élevée",
-          "Support par e-mail"
+          "Support prioritaire par e-mail"
         ],
         "cta": "Choisir Personal",
         "ctaGrandfathered": "Vous avez déjà des boîtes illimitées"
diff -ru a/apps/web/messages/fr/pricing.json b/apps/web/messages/fr/pricing.json
--- a/apps/web/messages/fr/pricing.json
+++ b/apps/web/messages/fr/pricing.json
@@ -33,7 +33,7 @@
         "Analytique d'usage",
         "Gmail, Outlook, iCloud, Fastmail et toute boîte IMAP",
         "Clés API illimitées",
-        "Support communautaire"
+        "Centre d'aide et support par e-mail"
       ]
     },
     "personal": {
@@ -46,7 +46,7 @@
         "3 boîtes connectées",
         "Aucun plafond mensuel d'actions",
         "Limite de pointe 2x plus élevée",
-        "Support par e-mail"
+        "Support prioritaire par e-mail"
       ]
     },
     "solo": {
@@ -132,9 +132,9 @@
       "support": {
         "label": "Support",
         "rows": {
-          "community": "Forum communautaire",
+          "community": "Centre d'aide",
           "email": "Support par e-mail",
-          "priority": "Support prioritaire"
+          "priority": "Support prioritaire par e-mail"
         }
       }
     },
@@ -165,7 +165,7 @@
       },
       {
         "q": "Qu'apporte Personal par rapport à Free ?",
-        "a": "Deux boîtes connectées de plus, aucun plafond mensuel d'actions e-mail (usage équitable), un plafond de pointe doublé (120 requêtes par minute au lieu de 60) et le support par e-mail à la place du forum communautaire. C'est toute la liste. Le reste est déjà inclus dans Free : tous les outils MCP, y compris les envois programmés, la validation avant envoi réglable par boîte, et le tableau de bord d'analytique d'usage. Nous ne retenons pas de fonctionnalités sur Free pour faire paraître les formules payantes plus riches."
+        "a": "Deux boîtes connectées de plus, aucun plafond mensuel d'actions e-mail (usage équitable), un plafond de pointe doublé (120 requêtes par minute au lieu de 60) et le support prioritaire par e-mail, là où Free a le centre d'aide et le support par e-mail standard. C'est toute la liste. Le reste est déjà inclus dans Free : tous les outils MCP, y compris les envois programmés, la validation avant envoi réglable par boîte, et le tableau de bord d'analytique d'usage. Nous ne retenons pas de fonctionnalités sur Free pour faire paraître les formules payantes plus riches."
       },
       {
         "q": "Qu'est-ce qui compte comme une action e-mail ?",
@@ -209,7 +209,7 @@
       },
       {
         "q": "Puis-je l'héberger moi-même plutôt que de payer ?",
-        "a": "Oui. MCP Emails est open source sous AGPL-3.0 et gratuit à héberger soi-même. Une stack docker-compose exécute le même serveur MCP, avec les identifiants de votre boîte mail chiffrés sous une clé que vous seul détenez. L'auto-hébergement couvre les boîtes mail IMAP et SMTP. La connexion Gmail et Outlook (OAuth) et le tableau de bord restent sur le service hébergé, où ils fonctionnent avec tous les forfaits, Gratuit compris ; les fonctionnalités d'équipe et le support par e-mail sont sur les forfaits payants."
+        "a": "Oui. MCP Emails est open source sous AGPL-3.0 et gratuit à héberger soi-même. Une stack docker-compose exécute le même serveur MCP, avec les identifiants de votre boîte mail chiffrés sous une clé que vous seul détenez. L'auto-hébergement couvre les boîtes mail IMAP et SMTP. La connexion Gmail et Outlook (OAuth) et le tableau de bord restent sur le service hébergé, où ils fonctionnent avec tous les forfaits, Gratuit compris ; les fonctionnalités d'équipe et le support prioritaire par e-mail sont sur les forfaits payants."
       }
     ]
   },
diff -ru a/apps/web/messages/nb/dashboard.json b/apps/web/messages/nb/dashboard.json
--- a/apps/web/messages/nb/dashboard.json
+++ b/apps/web/messages/nb/dashboard.json
@@ -515,11 +515,11 @@
       "personalFeature1": "3 tilkoblede innbokser",
       "personalFeature2": "120 forespørsler / minutt (2× burst)",
       "personalFeatureActions": "Ingen månedlig grense for handlinger",
-      "personalFeature4": "E-poststøtte",
+      "personalFeature4": "Prioritert e-poststøtte",
       "soloFeature1": "Ubegrenset antall tilkoblede innbokser",
       "soloFeature2": "300 forespørsler / minutt (5× burst)",
       "soloFeature3": "Lengre analysehistorikk",
-      "soloFeature4": "E-poststøtte",
+      "soloFeature4": "Prioritert e-poststøtte",
       "teamFeature1": "Alt i Pro",
       "teamFeature2": "Ubegrenset antall medlemmer med roller",
       "teamFeature3": "Et eget arbeidsområde per kunde eller virksomhet",
diff -ru a/apps/web/messages/nb/dashboardChrome.json b/apps/web/messages/nb/dashboardChrome.json
--- a/apps/web/messages/nb/dashboardChrome.json
+++ b/apps/web/messages/nb/dashboardChrome.json
@@ -243,7 +243,7 @@
     "featureInboxes": "Ubegrenset antall tilkoblede innbokser",
     "featureRateLimit": "5x høyere burst-grense",
     "featureTeam": "Si opp når som helst, behold resten av perioden",
-    "featureSupport": "E-poststøtte",
+    "featureSupport": "Prioritert e-poststøtte",
     "fastmailTabAppPassword": "App-passord",
     "howToGenerate": "Slik genererer du ett",
     "zohoRegionLabel": "Datasenterregion",
diff -ru a/apps/web/messages/nb/home.json b/apps/web/messages/nb/home.json
--- a/apps/web/messages/nb/home.json
+++ b/apps/web/messages/nb/home.json
@@ -162,7 +162,7 @@
           "Bruksanalyse",
           "Gmail, Outlook, iCloud, Fastmail og alle IMAP",
           "Ubegrenset antall API-nøkler",
-          "Fellesskapsstøtte"
+          "Hjelpesenter og e-poststøtte"
         ],
         "cta": "Start gratis"
       },
@@ -173,7 +173,7 @@
           "Alt i Free",
           "3 tilkoblede innbokser",
           "2x høyere burst-grense",
-          "E-poststøtte"
+          "Prioritert e-poststøtte"
         ],
         "cta": "Velg Personal",
         "ctaGrandfathered": "Du har allerede ubegrenset antall innbokser"
diff -ru a/apps/web/messages/nb/pricing.json b/apps/web/messages/nb/pricing.json
--- a/apps/web/messages/nb/pricing.json
+++ b/apps/web/messages/nb/pricing.json
@@ -33,7 +33,7 @@
         "Bruksanalyse",
         "Gmail, Outlook, iCloud, Fastmail og enhver IMAP",
         "Ubegrenset antall API-nøkler",
-        "Fellesskapsstøtte"
+        "Hjelpesenter og e-poststøtte"
       ]
     },
     "personal": {
@@ -46,7 +46,7 @@
         "3 tilkoblede innbokser",
         "Ingen månedlig handlingsgrense",
         "2x høyere burst-grense",
-        "E-poststøtte"
+        "Prioritert e-poststøtte"
       ]
     },
     "solo": {
@@ -132,9 +132,9 @@
       "support": {
         "label": "Kundestøtte",
         "rows": {
-          "community": "Fellesskapsforum",
+          "community": "Hjelpesenter",
           "email": "E-poststøtte",
-          "priority": "Prioritert støtte"
+          "priority": "Prioritert e-poststøtte"
         }
       }
     },
@@ -165,7 +165,7 @@
       },
       {
         "q": "Hva gir Personal utover Free?",
-        "a": "To innbokser til, ingen månedlig grense på e-posthandlinger (rimelig bruk gjelder), dobbelt så høyt burst-tak (120 forespørsler per minutt i stedet for 60), og e-poststøtte i stedet for fellesskapsforumet. Det er hele listen. Alt annet ligger allerede i Free: alle MCP-verktøyene, inkludert planlagte sendinger, godkjenning før sending per innboks, og dashbordet for bruksanalyse. Vi holder ikke funksjoner tilbake fra Free for å få de betalte planene til å se større ut."
+        "a": "To innbokser til, ingen månedlig grense på e-posthandlinger (rimelig bruk gjelder), dobbelt så høyt burst-tak (120 forespørsler per minutt i stedet for 60), og prioritert e-poststøtte, der Free har hjelpesenteret og vanlig e-poststøtte. Det er hele listen. Alt annet ligger allerede i Free: alle MCP-verktøyene, inkludert planlagte sendinger, godkjenning før sending per innboks, og dashbordet for bruksanalyse. Vi holder ikke funksjoner tilbake fra Free for å få de betalte planene til å se større ut."
       },
       {
         "q": "Hva regnes som en e-posthandling?",
@@ -209,7 +209,7 @@
       },
       {
         "q": "Kan jeg selvhoste den i stedet for å betale?",
-        "a": "Ja. MCP Emails er åpen kildekode under AGPL-3.0 og gratis å selvhoste. En docker-compose-stack kjører den samme MCP-serveren, med legitimasjonen til postkassen din kryptert under en nøkkel bare du har. Selvhosting dekker IMAP- og SMTP-postkasser. Gmail- og Outlook-innlogging (OAuth) og dashboardet finnes på den hostede tjenesten, der de fungerer på alle planer, også Gratis; teamfunksjoner og e-poststøtte hører til de betalte planene."
+        "a": "Ja. MCP Emails er åpen kildekode under AGPL-3.0 og gratis å selvhoste. En docker-compose-stack kjører den samme MCP-serveren, med legitimasjonen til postkassen din kryptert under en nøkkel bare du har. Selvhosting dekker IMAP- og SMTP-postkasser. Gmail- og Outlook-innlogging (OAuth) og dashboardet finnes på den hostede tjenesten, der de fungerer på alle planer, også Gratis; teamfunksjoner og prioritert e-poststøtte hører til de betalte planene."
       }
     ]
   },
diff -ru a/apps/web/messages/zh/dashboard.json b/apps/web/messages/zh/dashboard.json
--- a/apps/web/messages/zh/dashboard.json
+++ b/apps/web/messages/zh/dashboard.json
@@ -515,11 +515,11 @@
       "personalFeature1": "3 个已连接收件箱",
       "personalFeature2": "120 次请求／分钟（2× 突发）",
       "personalFeatureActions": "无月度操作上限",
-      "personalFeature4": "电子邮件支持",
+      "personalFeature4": "优先邮件支持",
       "soloFeature1": "无限量连接收件箱",
       "soloFeature2": "300 次请求／分钟（5× 突发）",
       "soloFeature3": "更长的分析历史",
-      "soloFeature4": "电子邮件支持",
+      "soloFeature4": "优先邮件支持",
       "teamFeature1": "包含 Pro 的全部功能",
       "teamFeature2": "无限量成员与角色",
       "teamFeature3": "每个客户或业务一个独立工作区",
diff -ru a/apps/web/messages/zh/dashboardChrome.json b/apps/web/messages/zh/dashboardChrome.json
--- a/apps/web/messages/zh/dashboardChrome.json
+++ b/apps/web/messages/zh/dashboardChrome.json
@@ -233,7 +233,7 @@
     "featureInboxes": "无限量连接收件箱",
     "featureRateLimit": "突发速率上限提升 5 倍",
     "featureTeam": "随时取消，本周期剩余时间照旧有效",
-    "featureSupport": "邮件支持",
+    "featureSupport": "优先邮件支持",
     "personalUpgradeTitle": "Personal 可连接三个邮箱",
     "personalUpgradeBody": "你正准备再连接一个收件箱。Personal 每月 $9 让你连到三个：工作、私人，再加一个。",
     "personalUpgradeCta": "升级到 Personal，$9/月",
diff -ru a/apps/web/messages/zh/home.json b/apps/web/messages/zh/home.json
--- a/apps/web/messages/zh/home.json
+++ b/apps/web/messages/zh/home.json
@@ -162,7 +162,7 @@
           "使用分析",
           "Gmail、Outlook、iCloud、Fastmail 及任何 IMAP",
           "无限量 API 密钥",
-          "社区支持"
+          "帮助中心和邮件支持"
         ],
         "cta": "免费开始"
       },
@@ -173,7 +173,7 @@
           "包含 Free 的全部功能",
           "3 个已连接收件箱",
           "突发速率上限提升 2 倍",
-          "邮件支持"
+          "优先邮件支持"
         ],
         "cta": "获取 Personal",
         "ctaGrandfathered": "你已拥有无限量收件箱"
diff -ru a/apps/web/messages/zh/pricing.json b/apps/web/messages/zh/pricing.json
--- a/apps/web/messages/zh/pricing.json
+++ b/apps/web/messages/zh/pricing.json
@@ -33,7 +33,7 @@
         "使用分析",
         "Gmail、Outlook、iCloud、Fastmail 及任何 IMAP",
         "无限量 API 密钥",
-        "社区支持"
+        "帮助中心和邮件支持"
       ]
     },
     "personal": {
@@ -46,7 +46,7 @@
         "3 个已连接收件箱",
         "无每月操作上限",
         "突发速率上限提升 2 倍",
-        "邮件支持"
+        "优先邮件支持"
       ]
     },
     "solo": {
@@ -132,9 +132,9 @@
       "support": {
         "label": "支持",
         "rows": {
-          "community": "社区论坛",
+          "community": "帮助中心",
           "email": "邮件支持",
-          "priority": "优先支持"
+          "priority": "优先邮件支持"
         }
       }
     },
@@ -165,7 +165,7 @@
       },
       {
         "q": "Personal 比 Free 多了什么？",
-        "a": "多两个已连接收件箱、邮件操作无每月上限（适用合理使用原则）、突发上限翻倍（每分钟 120 次请求而不是 60 次），以及邮件支持而非社区论坛。这就是全部。其余功能 Free 已经包含：全部 MCP 工具（含定时发送）、可按收件箱设置的发送前审批，以及使用分析仪表盘。我们不会为了让付费套餐显得更丰富而在 Free 上保留功能。"
+        "a": "多两个已连接收件箱、邮件操作无每月上限（适用合理使用原则）、突发上限翻倍（每分钟 120 次请求而不是 60 次），以及优先邮件支持（Free 提供帮助中心和标准邮件支持）。这就是全部。其余功能 Free 已经包含：全部 MCP 工具（含定时发送）、可按收件箱设置的发送前审批，以及使用分析仪表盘。我们不会为了让付费套餐显得更丰富而在 Free 上保留功能。"
       },
       {
         "q": "什么算作一次邮件操作？",
@@ -209,7 +209,7 @@
       },
       {
         "q": "我可以自托管来代替付费吗？",
-        "a": "可以。MCP Emails 采用 AGPL-3.0 开源，可免费自托管。一个 docker-compose 栈运行同一个 MCP 服务器，你的邮箱凭据用只有你持有的密钥加密。自托管支持 IMAP 和 SMTP 邮箱。Gmail 和 Outlook 登录（OAuth）以及控制台只在托管服务中提供，并且在所有套餐（包括免费套餐）上都可用；团队功能和邮件支持属于付费套餐。"
+        "a": "可以。MCP Emails 采用 AGPL-3.0 开源，可免费自托管。一个 docker-compose 栈运行同一个 MCP 服务器，你的邮箱凭据用只有你持有的密钥加密。自托管支持 IMAP 和 SMTP 邮箱。Gmail 和 Outlook 登录（OAuth）以及控制台只在托管服务中提供，并且在所有套餐（包括免费套餐）上都可用；团队功能和优先邮件支持属于付费套餐。"
       }
     ]
   },
diff -ru a/apps/web/public/llms.txt b/apps/web/public/llms.txt
--- a/apps/web/public/llms.txt	2026-10-15 21:50:36
+++ b/apps/web/public/llms.txt	2026-10-15 21:50:37
@@ -9,7 +9,7 @@
 - Providers: Outlook / Microsoft 365 (Sign in with Microsoft, over Microsoft Graph), Gmail (Google app password over IMAP by default, or Sign in with Google), Fastmail, iCloud, Yahoo, Zoho, Yandex (app password), and any other mailbox via generic IMAP/SMTP. Personal Outlook.com, Hotmail, Live and MSN accounts connect directly; a work or school Microsoft 365 account may first need an IT admin to approve the app once for the organisation.
 - Tools (action-based): inbox_list, email_read, email_organize, email_delete, email_compose, folder, draft, schedule, contact_search.
 - Privacy: email content is never stored; fetched live per request. Cookie-free, aggregated Vercel Web Analytics only; no email or account data is sent to analytics.
-- Pricing: Free (no card, 1 inbox, 150 email actions per calendar month, first 7 days uncounted, 60 requests/min), Personal $9/mo or $86.40/yr (3 inboxes, no monthly action cap, 120 requests/min, email support), Pro $15/mo or $144/yr (unlimited inboxes, no monthly action cap), Team $79/mo (members, roles, SSO). Failed calls and inbox_list are never counted. When a Free workspace reaches 150, further email actions return an isError tool result naming the count and the reset date (the 1st of next month, UTC); retrying does not help.
+- Pricing: Free (no card, 1 inbox, 150 email actions per calendar month, first 7 days uncounted, 60 requests/min, help center and email support), Personal $9/mo or $86.40/yr (3 inboxes, no monthly action cap, 120 requests/min, priority email support), Pro $15/mo or $144/yr (unlimited inboxes, no monthly action cap, priority email support), Team $79/mo (members, roles, SSO). Failed calls and inbox_list are never counted. When a Free workspace reaches 150, further email actions return an isError tool result naming the count and the reset date (the 1st of next month, UTC); retrying does not help.
 - Works with: Claude (web, desktop, code), Cursor, VS Code, ChatGPT, Cline, Windsurf, n8n, Make, Gemini CLI, Zed, JetBrains, Raycast, Warp, and any MCP client. Standard Streamable HTTP with OAuth 2.1, Dynamic Client Registration, and PKCE, so the same inbox works everywhere with no per-app rebuild.
 - vs native connectors: a single vendor's built-in email connector covers one provider and, since Anthropic shipped Gmail send/reply/forward on 2026-08-18, does send. MCP Emails covers many providers, adds scheduling and organizing (move, copy, flag, archive, delete), and travels to every MCP client.
 
diff -ru a/apps/web/src/lib/stripe/plans.ts b/apps/web/src/lib/stripe/plans.ts
--- a/apps/web/src/lib/stripe/plans.ts	2026-10-15 21:50:36
+++ b/apps/web/src/lib/stripe/plans.ts	2026-10-15 21:50:37
@@ -262,7 +262,7 @@
       'Usage analytics',
       'Gmail, Outlook, iCloud, Fastmail and any IMAP',
       'Unlimited API keys',
-      'Community support',
+      'Help center and email support',
     ],
     highlighted: false,
   },
@@ -309,7 +309,7 @@
     // 1 -> 3, the monthly action cap (Free's public 150 -> none that a
     // customer can reach; the paid ceiling stays a silent abuse guard and is
     // never quoted as a number), maxRequestsPerMinute 60 -> 120, supportTier
-    // community -> email, and billingPortalEnabled. Nothing else differs, so
+    // community -> email (shown as email support -> priority email support), and billingPortalEnabled. Nothing else differs, so
     // nothing else may be listed. Pro and Team inherit "no cap" through
     // "Everything in Personal" and must not restate it.
     features: [
@@ -317,7 +317,7 @@
       '3 connected inboxes',
       'No monthly action cap',
       '2x higher burst rate limit',
-      'Email support',
+      'Priority email support',
     ],
     highlighted: false,
   },

```
