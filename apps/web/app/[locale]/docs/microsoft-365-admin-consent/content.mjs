// Copy for /docs/microsoft-365-admin-consent. English is here; nb, es, fr and
// de are in content.<locale>.mjs with the same shape. zh falls back to
// English (zh is frozen, src/i18n/locale-policy.mjs).
//
// Kept next to the page rather than in messages/: a messages/ namespace is
// serialised into every marketing page, and this copy is only read here.
//
// Every claim is traced to code. If one of these changes, change the page:
//   why it happens          classifyMicrosoftAuthError and its comment in
//                           apps/web/src/lib/email-providers/outlook-oauth.ts
//   scopes the admin grants ADMIN_CONSENT_SCOPES in
//                           apps/web/app/auth/outlook/admin-consent/route.ts
//   scopes at user sign-in  OUTLOOK_SCOPES in outlook-oauth.ts
//   "organizations"         outlookAdminConsentEndpoint in outlook-oauth.ts;
//                           personal accounts refused there
//   link: 7 days, reusable, ADMIN_CONSENT_LINK_TTL_MS, ADMIN_CONSENT_STATE_TTL_SECONDS
//   10-minute round trip,   and the result statuses in
//   one browser             apps/web/src/lib/email-providers/outlook-admin-link.ts
//   no account needed       app/auth/outlook/admin-consent/route.ts (public, token)
//   dashboard labels        messages/<locale>/dashboardChrome.json: app.adminConsent*,
//                           connect.outlookAdminLink, adminConsentLink.*,
//                           adminConsentResult.*
//   no Exchange mailbox     dashboardChrome.json app.outlookNoMailbox
// Microsoft facts (roles that may grant tenant-wide consent for delegated
// permissions, the Enterprise apps path, assignment required) were read on
// 2026-10-29 at learn.microsoft.com/en-us/entra/identity/enterprise-apps/
// grant-admin-consent and configure-user-consent. Claude's Microsoft 365
// connector needing a Global Administrator: support.claude.com/en/articles/12542951,
// read the same day.
//
// Inline markup: `code`, **bold** and [text](url), rendered by the page.

import { MS_GRANT, MS_ASSIGN, CLAUDE_M365 } from './links.mjs';
import nb from './content.nb.mjs';
import es from './content.es.mjs';
import fr from './content.fr.mjs';
import de from './content.de.mjs';

const REPO = 'https://github.com/Albretsen/MCPEmails/blob/main';

export const EVIDENCE_LINKS = [
  { key: 'link', href: `${REPO}/apps/web/src/lib/email-providers/outlook-admin-link.ts`, file: 'outlook-admin-link.ts' },
  { key: 'route', href: `${REPO}/apps/web/app/auth/outlook/admin-consent/route.ts`, file: 'admin-consent/route.ts' },
  { key: 'oauth', href: `${REPO}/apps/web/src/lib/email-providers/outlook-oauth.ts`, file: 'outlook-oauth.ts' },
];

const en = {
  meta: {
    title: 'Need admin approval for Outlook or Microsoft 365? Approve MCPEmails',
    description:
      'Why Microsoft shows "Need admin approval" when you connect a work Outlook or Microsoft 365 mailbox to Claude or ChatGPT, the link to send your IT admin, and exactly which permissions the admin approves.',
  },
  breadcrumb: 'Microsoft 365 admin approval',
  eyebrow: 'Docs',
  title: 'Microsoft 365: "Need admin approval"',
  lead:
    'Microsoft shows "Need admin approval" when your organization does not let employees approve mail access for an app themselves. An IT admin approves MCPEmails once, and then everyone in the organization can connect their own mailbox. This page is for both of you: what the person connecting does, and what the admin is approving.',
  sections: [
    {
      id: 'why',
      h: 'Why Microsoft asks for an admin',
      items: [
        'Since late 2025, Microsoft\'s default consent policy for work and school tenants stops employees from approving mail permissions such as `Mail.Read` and `Mail.ReadWrite` for an app. Microsoft shows **Need admin approval** instead of the usual consent screen.',
        'Your organization sets this, not your account and not MCPEmails. Being a verified publisher does not get an app past it, and some organizations have switched user consent off for every app.',
        'Personal Microsoft accounts (Outlook.com, Hotmail, Live) have no organization and no admin, so they never see this screen.',
        `Claude's own Microsoft 365 connector has the same requirement: [Anthropic's help article](${CLAUDE_M365}) says a Microsoft Entra Global Administrator must consent before anyone in the organization can use it. The steps below are for MCPEmails, which connects the mailbox to Claude, ChatGPT and other MCP clients.`,
      ],
    },
    {
      id: 'connecting',
      h: 'If you are connecting your mailbox',
      ordered: true,
      items: [
        'In the MCPEmails dashboard, open **Inboxes**, then **Connect inbox**, choose Outlook and click **Connect with Microsoft**.',
        'If Microsoft answers with **Need admin approval**, come back to the dashboard. It says your organization has to approve mailbox access and offers **Get a link for your IT admin**. The Outlook option in the connect window has the same link under **Get the approval link for your admin**.',
        'Copy the link and send it to your IT admin by email or chat. It works for 7 days and can be opened more than once. Your admin does not need an MCPEmails account.',
        'When your admin has approved, click **Connect with Microsoft** again. You sign in with your own account and the inbox connects.',
      ],
    },
    {
      id: 'self-admin',
      h: 'If you are your own admin',
      items: [
        'In the same dialog, click **I\'m the admin, approve now**. It opens Microsoft\'s approval page in your tab, and after you approve you return to the dashboard to connect the mailbox.',
        'Sign in on that page with an account that holds one of the roles listed in the next section. A user account without a role cannot approve, even in a small tenant.',
      ],
    },
    {
      id: 'admin',
      h: 'If you are the IT admin',
      items: [
        'The link opens Microsoft\'s own admin consent page (`login.microsoftonline.com/organizations/v2.0/adminconsent`) for MCPEmails. You sign in with your Microsoft work account on Microsoft\'s page. MCPEmails never sees your password.',
        `Approving needs a role that can grant tenant-wide consent for delegated permissions. [Microsoft lists](${MS_GRANT}) Privileged Role Administrator, Cloud Application Administrator, Application Administrator and AI Administrator, and a Global Administrator can do it too.`,
        'Review the permissions and accept. The approval covers the whole organization once. Each person still signs in with their own account when they connect, and gets access only to their own mailbox.',
        'You then land on an MCPEmails page that says whether Microsoft confirmed the approval. Nothing else is needed from you.',
        'The link grants nothing by itself. It only starts Microsoft\'s flow, and nothing changes in your tenant until you accept there.',
        `Prefer the admin center? If MCPEmails already appears under **Entra ID**, **Enterprise apps**, **All applications**, open it, choose **Permissions** and click **Grant admin consent**. [Microsoft's guide](${MS_GRANT}) describes that route.`,
      ],
    },
    {
      id: 'permissions',
      h: 'What the admin approves',
      items: [
        '`Mail.ReadWrite` (delegated): read and change mail in the signed-in person\'s mailbox, so the AI can search, read, write drafts, move, flag, manage folders and delete.',
        '`Mail.Send` (delegated): send mail as the signed-in person. `Mail.ReadWrite` does not cover sending, so it is a separate permission.',
        '`offline_access`: keep the connection working without signing in again, until the person disconnects or access is removed.',
        'When each person signs in, MCPEmails also asks for `openid`, `profile` and `email` to read their name and address. Consent policies do not restrict these sign-in basics, so the admin approval leaves them out.',
        'Every permission is delegated. MCPEmails asks for no application permissions, so it acts only for the person who signed in and cannot open other mailboxes in your tenant.',
        'Messages are fetched live from Microsoft for each request and are not stored. The token from each sign-in is encrypted at rest, and data is stored in Stockholm. See [security](/security).',
      ],
    },
    {
      id: 'control',
      h: 'Limit or remove access later',
      items: [
        `To let only some people connect, turn on **Assignment required** for MCPEmails under **Enterprise apps** and assign the users or groups who may sign in. [Microsoft's guide](${MS_ASSIGN}) has the steps.`,
        'To remove it for the whole organization, delete or disable MCPEmails under **Enterprise apps**.',
        'Each person can disconnect their own mailbox at any time by deleting the inbox in the MCPEmails dashboard.',
      ],
    },
    {
      id: 'problems',
      h: 'If it still does not work',
      items: [
        '**"The approval did not go through".** Microsoft did not confirm the approval, so Outlook stays blocked. The admin opens the link again, signed in with an account that holds one of the roles above.',
        '**"Not approved".** The approval was cancelled on Microsoft\'s screen and nothing changed. Open the link again when ready.',
        '**"This link has expired" or "This link is not valid".** Links last 7 days and must be copied whole. Get a fresh one from the dashboard.',
        '**"Please start again".** The approval took more than 10 minutes or finished in a different browser. Open the link again and finish in that browser.',
        '**No Outlook mailbox.** An account without an Exchange Online mailbox, such as an admin account without an Exchange licence, has nothing to connect, so MCPEmails refuses it. If your mail is hosted elsewhere, connect it with IMAP instead.',
        '**A request form instead of the approval page.** If your organization has turned on Microsoft\'s admin consent workflow, a user who tries to connect may see a form to request approval. The admin can approve that request, or simply open the MCPEmails link.',
      ],
    },
  ],
  evidence: {
    h: 'Check it yourself',
    intro: 'MCPEmails is open source. These files build the link, start the approval and list the permissions this page describes:',
    labels: {
      link: 'The signed, seven-day approval link and the result statuses',
      route: 'The public route the link opens, and the permissions it asks the admin for',
      oauth: 'The permissions each person grants at sign-in, and how a "Need admin approval" answer is recognised',
    },
  },
  cta: {
    title: 'Connect your Microsoft 365 mailbox',
    sub: 'One inbox is free, forever.',
    button: 'Get started',
    providers: 'Microsoft 365 setup',
  },
};

export const ADMIN_CONSENT = { en, nb, es, fr, de };

export function adminConsentCopy(locale) {
  return ADMIN_CONSENT[locale] ?? en;
}
