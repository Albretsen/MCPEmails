// Copy for /connect/custom-domain, the own-domain email hub.
//
// WHY THIS PAGE. Mailboxes on the customer's own domain (you@yourcompany.com)
// are about half of our paying customers, and the web-host pages under
// /connect convert well from few visits. Search and answer engines answer
// "connect my own-domain email to Claude" with a video, a forum thread and
// automation tools, not with a setup page. This is that page: one direct
// answer, the settings at the common hosts, and the failures we see most.
//
// HOW IT RELATES TO THE REST.
//   - The per-host pages (/connect/cpanel, /connect/hostinger, ...) own the
//     host queries and carry the full detail. This page summarises each in one
//     card and links there. The host pages link back (hubLinkFor below).
//   - /blog/connect-business-email-custom-domain-to-ai-agent covers business
//     mail providers (Google Workspace, Zoho, Fastmail, Migadu, Rackspace,
//     IONOS). This page covers web hosts and registrars, and links to it
//     rather than repeating it.
//
// RULES FOR THIS FILE.
//   - English only. The values are the same ones the host pages cite, read at
//     each host's own documentation on CHECKED_ON (SOURCES). Change a host
//     value here only together with src/lib/connect/content/en/<host>.json.
//   - Product claims match the code: the certificate-name retry is
//     src/lib/email/cert-host-alias.ts, called from app/api/inboxes/imap.
//   - Strings understand `code`, **bold** and [text](/path) and nothing else.
//     No em dashes, no angle brackets, no plan limits, no tool counts.

export const PATH = '/connect/custom-domain';
export const LOCALES = ['en'];
export const DATE_PUBLISHED = '2026-11-24';
export const DATE_MODIFIED = '2026-11-24';
export const CHECKED_ON = '2026-11-24';

export const MCP_URL = 'https://mcpemails.com/api/mcp';

/** Host documentation each card's values were read from on CHECKED_ON. */
export const SOURCES = [
  { name: 'cPanel: Set Up Mail Client', url: 'https://docs.cpanel.net/cpanel/email/set-up-mail-client/' },
  { name: 'Hostinger: email configuration details', url: 'https://www.hostinger.com/support/1575756-how-to-get-email-account-configuration-details-for-hostinger-email/' },
  { name: 'Hostinger: Titan Email configuration details', url: 'https://www.hostinger.com/support/5966022-how-to-get-email-account-configuration-details-for-titan-email-at-hostinger/' },
  { name: 'SiteGround: configure your mail client', url: 'https://www.siteground.com/kb/how_to_configure_my_mail_client' },
  { name: 'Namecheap: Private Email configuration for mail clients', url: 'https://www.namecheap.com/support/knowledgebase/article.aspx/1179/2175/general-private-email-configuration-for-mail-clients-and-mobile-devices/' },
  { name: 'GoDaddy: IMAP settings for Professional Email', url: 'https://www.godaddy.com/help/use-imap-settings-to-add-my-professional-email-to-a-client-32204' },
  { name: 'Plesk: access your mailbox', url: 'https://docs.plesk.com/en-US/obsidian/customer-guide/quick-start-with-plesk/set-up-mail-accounts/2-access-your-mailbox.65691/' },
  { name: 'Plesk: per-domain mail certificates (SNI)', url: 'https://support.plesk.com/hc/en-us/articles/12377516977175-How-to-assign-an-SSL-certificate-per-domain-to-secure-the-mail-server-in-Plesk-SNI-support' },
];

/**
 * The provider pages that link back here: every web host and cPanel host
 * page, and the generic IMAP page. English only, like this page, so the link
 * never sends a reader of a translated page to an English one unannounced.
 */
const HUB_LINKED_CATEGORIES = new Set(['hosting', 'cpanel']);
const HUB_LINKED_SLUGS = new Set(['imap']);

export const HUB_LINK = {
  intro: 'Mailbox on your own domain?',
  label: 'Own-domain email guide: settings at every common host',
  href: PATH,
};

export function hubLinkFor(locale, provider) {
  if (!LOCALES.includes(locale) || !provider) return null;
  if (!HUB_LINKED_CATEGORIES.has(provider.category) && !HUB_LINKED_SLUGS.has(provider.slug)) return null;
  return HUB_LINK;
}

export const copy = {
  meta: {
    title: 'Connect Your Own-Domain Email to Claude and ChatGPT',
    description:
      'Connect you@yourcompany.com to Claude and ChatGPT over IMAP: server names, ports and passwords at cPanel, Hostinger, SiteGround, GoDaddy and Plesk.',
  },
  breadcrumb: 'Connect',
  eyebrow: 'Own-domain email + AI',
  title: 'Connect your own-domain email to Claude and ChatGPT',
  lead:
    'A mailbox on your own domain, such as you@yourcompany.com, connects to Claude and ChatGPT the same way a desktop mail client does: IMAP and SMTP with the mailbox password. The only hard part is knowing which server name and password your host wants. This page has them for the common hosts.',
  answer:
    'Short answer: Claude and ChatGPT have no built-in connector for a mailbox at your web host. Connect the mailbox to MCPEmails over IMAP with the server name your host prints in its control panel (often not `mail.yourdomain.com`), port 993 for IMAP and 465 for SMTP, your full email address as the username and the mailbox password, not your hosting login. Then add `https://mcpemails.com/api/mcp` to Claude as a custom connector, or install Any Mailbox in ChatGPT. One mailbox is free.',
  howToName: 'How to connect an own-domain mailbox to Claude and ChatGPT',
  steps: [
    {
      h: 'Find out who runs your mailbox',
      p: 'Your domain does not say who serves its mail. Look up the MX record, or type your address into the [email settings lookup](/tools/email-settings-lookup). An MX at your hosting company means a mailbox on its server (cPanel, Plesk, Hostinger, SiteGround). An MX ending in `privateemail.com` means Namecheap Private Email, one ending in `secureserver.net` means GoDaddy, and a Microsoft-hosted MX means Microsoft 365, which connects with **Outlook** instead of IMAP. For Google Workspace, Zoho, Fastmail and other business mail providers, follow the [business email guide](/blog/connect-business-email-custom-domain-to-ai-agent).',
    },
    {
      h: 'Read the server name and set the mailbox password',
      p: 'Open your host\'s control panel and copy the secure (SSL/TLS) IMAP and SMTP server names from its mail client settings screen. The cards below say where that screen is at each host. Set or reset the password on the mailbox itself: your hosting or registrar login is a different credential and is always refused.',
    },
    {
      h: 'Connect the mailbox in MCPEmails',
      p: '[Create a free account](/signup), open **Inboxes**, click **Connect inbox** and choose **IMAP / SMTP**. Enter your address and password; MCPEmails fills in the servers when it can detect them, and otherwise you paste the values from your panel.',
    },
    {
      h: 'Add MCPEmails to Claude or ChatGPT',
      p: 'In Claude, open **Customize**, then **Connectors**, click **+ Add**, then **Add custom connector**, paste `https://mcpemails.com/api/mcp` and sign in. In ChatGPT, install **Any Mailbox** from the plugin directory and sign in. The same mailbox then works in Cursor and any other MCP client too.',
    },
  ],
  hostsTitle: 'IMAP and SMTP settings at the common hosts',
  hostsLead:
    'Ports are the same almost everywhere: IMAP 993 with SSL/TLS and SMTP 465 with SSL/TLS, with 587 and STARTTLS as the usual SMTP alternative. What differs is the server name, the password and where the panel hides them. Each card links to the full page for that host.',
  hosts: [
    {
      id: 'cpanel',
      name: 'cPanel hosts',
      href: '/connect/cpanel',
      rows: [
        ['Server', 'Your hosting server: `mail.yourdomain.com`, the bare domain, or the server\'s own hostname. Use whichever the panel prints in the secure table.'],
        ['Ports', 'IMAP 993, SMTP 465 (SSL/TLS)'],
        ['Password', 'The password set on the email account, never your cPanel login'],
        ['In the panel', '**Email Accounts**, **Connect Devices** on the address, then **Mail Client Manual Settings**, Secure SSL/TLS table'],
      ],
      note: 'cPanel\'s own documentation says the system shows the server\'s hostname when the domain has no valid certificate. That is why the panel sometimes prints a name you have never seen: use it.',
    },
    {
      id: 'hostinger',
      name: 'Hostinger',
      href: '/connect/hostinger',
      rows: [
        ['Server', '`imap.hostinger.com` and `smtp.hostinger.com`. Business and Enterprise Email plans run on Titan: `imap.titan.email` and `smtp.titan.email`'],
        ['Ports', 'IMAP 993, SMTP 465 (SSL), or 587 with STARTTLS'],
        ['Password', 'The mailbox password, or an app password if the mailbox has two-factor authentication on'],
        ['In the panel', 'hPanel, **Emails**, **Manage** next to the domain, then **Connect Apps & Devices**'],
      ],
    },
    {
      id: 'siteground',
      name: 'SiteGround',
      href: '/connect/siteground',
      rows: [
        ['Server', 'The secure server name for your account, in the form `secureNNN.sgcpanel.com`. `mail.yourdomain.com` fails the certificate check'],
        ['Ports', 'IMAP 993, SMTP 465 (SSL)'],
        ['Password', 'The mailbox password, not your Client Area login'],
        ['In the panel', '**Site Tools**, **Email**, **Accounts**, the menu on the address, **Mail Configuration**, then the **Manual Settings** tab'],
      ],
      note: 'SiteGround has no cPanel any more. Guides that start in cPanel describe a panel your account does not have.',
    },
    {
      id: 'namecheap',
      name: 'Namecheap Private Email',
      href: '/connect/namecheap',
      rows: [
        ['Server', '`mail.privateemail.com` for incoming and outgoing, whatever your domain is. Namecheap says not to change it'],
        ['Ports', 'IMAP 993, SMTP 465 (SSL), or 143 and 587 with STARTTLS'],
        ['Password', 'The mailbox password, or an application password if two-factor authentication is on'],
        ['In the panel', 'Private Email webmail, **Settings**, **Security**, **Application Passwords** for the 2FA case'],
      ],
      note: 'A mailbox created in Namecheap shared hosting (cPanel) is a different mailbox on a different server: follow the cPanel card for that one.',
    },
    {
      id: 'godaddy',
      name: 'GoDaddy Professional Email',
      href: '/connect/godaddy',
      rows: [
        ['Server', '`imap.secureserver.net` (IMAP) and `smtpout.secureserver.net` (SMTP)'],
        ['Ports', 'IMAP 993, SMTP 465 (SSL)'],
        ['Password', 'That mailbox\'s own email password, not your GoDaddy account login'],
        ['In the panel', '**My Products**, **Email & Office**: the tile names the product, and **Manage** next to the address resets its password'],
      ],
      note: 'Microsoft 365 bought from GoDaddy is a Microsoft mailbox, not a GoDaddy one. Connect it with **Outlook** (Sign in with Microsoft) on the [Microsoft 365 page](/connect/office365), not over IMAP.',
    },
    {
      id: 'plesk',
      name: 'Plesk servers',
      href: '/connect/plesk',
      rows: [
        ['Server', 'Plesk says to use your domain name itself, for example `example.com`, for incoming and outgoing'],
        ['Ports', 'IMAP 993 with SSL, SMTP 465, or 587 where the submission port is on'],
        ['Password', 'The password set on the mail account in Plesk, not the panel login'],
        ['In the panel', '**Websites & Domains**, the domain, **Mail Accounts**, then **Mail Client Setup** on the address'],
      ],
    },
  ],
  hostLinkLabel: 'Full setup guide for',
  hostsMore:
    'Another host? The [provider list](/connect#web-hosting) has pages for more web hosts and for cPanel hosts such as Bluehost, HostGator and A2 Hosting, and the [generic IMAP page](/connect/imap) covers any server.',
  troubleTitle: 'Troubleshooting own-domain mailboxes',
  trouble: [
    {
      h: 'Certificate name mismatch on mail.yourdomain.com',
      p: 'On shared hosting, `mail.yourdomain.com` is usually a DNS alias (a CNAME) for the host\'s own mail server, and the certificate that server presents names the host\'s server, not your domain. A client that checks certificates properly refuses the connection, on every port. The fix is the host\'s server name: the one your panel prints, or the target of the CNAME (`dig +short CNAME mail.yourdomain.com`). MCPEmails tries this itself: when the certificate names another server, it follows the alias, checks the certificate is valid for that name and that it is the same machine, and connects with it. When it cannot prove a name, the error tells you which name the certificate carries, so you can enter that.',
    },
    {
      h: 'TLS error when the server is an IP address',
      p: 'Mail certificates are issued to names, not to IP addresses, so typing the server\'s IP as the host fails the certificate check even when the IP is right. Enter the server\'s hostname instead: your panel\'s mail settings, or the reverse DNS name of that IP, usually give it. Never turn certificate checks off to get past this; a name problem has a name fix.',
    },
    {
      h: 'The password is rejected',
      p: 'Almost always one of three things. You used the hosting, registrar or panel login instead of the password on the mailbox itself. Two-factor authentication is on for the mailbox and the host wants an app password for mail clients (Hostinger, Namecheap Private Email, Titan). Or the server name points at a different machine that holds a different mailbox, which happens when `mail.yourdomain.com` points at old hosting.',
    },
    {
      h: 'It times out instead of failing',
      p: 'A timeout is the server name, the port or a firewall, not the password. Check the name against your panel, and the port against its security mode: 993 is implicit TLS and 143 is STARTTLS for IMAP, 465 is implicit TLS and 587 is STARTTLS for SMTP. MCPEmails retries the other standard ports when a connection never got a usable session, but it never retries a refused password.',
    },
    {
      h: 'Mail reads fine but sending fails or vanishes',
      p: 'The SMTP half is its own server, port and security mode, so check it separately. On cPanel, a mailbox can have outgoing mail set to **Hold** under **Restrictions**: the send is accepted and never delivered. Some hosts also cap sends per hour on shared plans.',
    },
  ],
  faqTitle: 'Questions about own-domain email and AI',
  faq: [
    {
      q: 'Can Claude read email on my own domain?',
      a: 'Yes, through an MCP server. Claude has no built-in connector for a mailbox at your web host. Connect the mailbox to MCPEmails over IMAP, add https://mcpemails.com/api/mcp to Claude as a custom connector, and Claude can read, search, send, reply and organize that mail.',
    },
    {
      q: 'Can ChatGPT read email on my own domain?',
      a: 'Yes. Connect the mailbox to MCPEmails over IMAP, then install Any Mailbox, the MCPEmails plugin, from the ChatGPT plugin directory and sign in. ChatGPT gets only the access you approve, and mail is fetched live, never stored.',
    },
    {
      q: 'What IMAP server do I use for my domain email?',
      a: 'The one your host prints in its control panel, in the secure (SSL/TLS) settings. It is often not mail.yourdomain.com: Namecheap Private Email uses mail.privateemail.com, GoDaddy Professional Email uses imap.secureserver.net, Hostinger uses imap.hostinger.com, SiteGround uses a secureNNN.sgcpanel.com name, and cPanel and Plesk hosts use your server name or domain.',
    },
    {
      q: 'Why does mail.mydomain.com give a certificate error?',
      a: 'Because it is usually an alias for your host\'s shared mail server, and that server\'s certificate carries the host\'s server name, not your domain. Use the host\'s server name from your control panel, or the target of the mail.yourdomain.com CNAME record. MCPEmails tries to find and prove that name automatically when you connect.',
    },
    {
      q: 'Do I need an app password for my domain email?',
      a: 'Usually not. Web host mailboxes use the password set on the mailbox. The exception is a mailbox with two-factor authentication on: Hostinger, Namecheap Private Email and Titan then want an app password for mail clients, and refuse the normal one as if it were wrong.',
    },
    {
      q: 'Can I connect several addresses on my domain, like info@ and sales@?',
      a: 'Yes. Each address connects as its own mailbox in one MCPEmails workspace, and your AI client reaches all of them through the same connector. The free plan connects one mailbox; the pricing page lists what each plan connects.',
    },
    {
      q: 'Is my email stored by MCPEmails?',
      a: 'No. Messages are fetched live from your host over IMAP for each request and passed to your AI client. The mailbox credential is encrypted at rest and message bodies are not retained.',
    },
  ],
  sourcesTitle: 'Sources',
  sourcesLead: 'Host settings on this page were read at each host\'s own documentation on 24 November 2026.',
  cta: {
    title: 'Connect your domain mailbox',
    sub: 'One mailbox is free, no card required. Paste the server name from your panel and your agent has the inbox in a couple of minutes.',
    button: 'Connect your mailbox free',
  },
};
