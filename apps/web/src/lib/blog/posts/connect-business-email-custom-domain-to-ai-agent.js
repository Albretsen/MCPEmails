const post = {
  slug: 'connect-business-email-custom-domain-to-ai-agent',
  title: 'Connect a Custom-Domain Business Email to Your AI Agent (IMAP Setup)',
  description:
    'Setup guide for you@yourcompany.com: find out who really runs your mail, connect Google Workspace, Zoho, Fastmail, Migadu, Titan, Rackspace, IONOS or cPanel, and fix the From name before your agent replies.',
  cover: '/blog/cover-connect-gmail-to-claude.svg',
  coverAlt:
    'Connect a business email on your own domain to an AI agent with MCP Emails',
  authorId: 'asgeir',
  publishedAt: '2026-09-15T09:00:00.000Z',
  updatedAt: '2026-09-25T09:00:00.000Z',
  tags: ['Business email', 'IMAP', 'Google Workspace', 'Tutorial'],
  featured: false,
  content: `> **On Microsoft 365?** If your company mailbox turns out to be a Microsoft tenant, this guide will help you confirm that. Connect it with **Outlook** and Sign in with Microsoft instead of IMAP; your IT admin may need to approve the app once for the whole organisation first. The [Outlook and Microsoft 365 guide](/blog/connect-outlook-microsoft-365-ai-agent-mcp) has the steps.

Most guides for connecting email to an AI agent assume your address ends in gmail.com. Business mail is different: the domain does not tell you who serves the mailbox, somebody else may control whether mail clients can log in at all, and what your agent sends goes to customers under your name. This is the guide for you@yourcompany.com.

**Jump to your provider:** [Google Workspace](#google-workspace) · [Zoho Mail](#zoho-mail) · [Fastmail and Migadu](#fastmail-and-migadu) · [Titan Email](#titan-email) · [Rackspace Email](#rackspace-email) · [IONOS](#ionos) · [cPanel and shared web hosts](#cpanel-and-shared-web-hosts)

## Why a business mailbox is harder than a consumer one

- **Someone else may control app access.** A Google Workspace admin can switch app passwords off for a whole domain. Zoho ships mailboxes with IMAP off, Titan with third-party access off. All three refuse the login exactly like a wrong password.
- **Your address does not name your mail host.** Our own hello@mcpemails.com is served by Migadu, and nothing in the domain says so. Guessing \`mail.yourcompany.com\` usually reaches nothing.
- **SMTP is not always a mirror of IMAP.** Rackspace serves both from one unbranded host; OVH Hosted Exchange does not listen on 465 at all and needs 587 with STARTTLS.
- **The From name is customer-facing.** A reply that goes out with no name is a support ticket.

## Step 1: Find out who actually runs your mail

MCP Emails tries to answer this for you. Type your address into the IMAP connect form, pause for half a second, and it checks four sources in order: a table of providers that caused real connection failures, your domain's RFC 6186 service records, your MX record matched back against that table, and Mozilla's autoconfiguration database. Nothing is filled in unless both halves resolved.

To check yourself first:

\`\`\`
dig +short MX yourcompany.com
dig +short SRV _imaps._tcp.yourcompany.com
\`\`\`

Service records state host and port directly, but most domains publish none, so the MX answer is usually what you get:

- Ending in \`.l.google.com\`, or \`smtp.google.com\`: Google Workspace.
- \`mx.zoho.com\` or a regional equivalent: Zoho Mail.
- \`aspmx1.migadu.com\`: Migadu. \`mx1.titan.email\`: Titan, under whatever brand you bought it.
- A Microsoft-hosted MX name: a Microsoft 365 tenant. Connect it with **Outlook**, not IMAP.
- Your hosting company's own server name: a cPanel or Plesk mailbox.

## Step 2: Follow your provider's path

In the dashboard, open **Inboxes → Connect Inbox** and pick the route that matches.

### Google Workspace

Workspace connects with a **Google app password** over IMAP by default (\`imap.gmail.com\` on 993, \`smtp.gmail.com\` on 465); OAuth is also available. App passwords only exist once 2-Step Verification is on, and an administrator can disable them domain-wide, in which case the Google page is simply unavailable to you. Admins can also restrict third-party OAuth apps under Security → API controls, which blocks that path at Google's consent screen. If both are shut, ask your admin.

### Zoho Mail

**Enable IMAP access** first, under Settings → Mail Accounts → the address → IMAP Access. It is off by default and set per mailbox, so enabling it for yourself does nothing for a colleague. Generate an **application-specific password** too if two-factor authentication is on.

Your host depends on two things Zoho never shows together: which of its six regional data centres the account lives in (\`.com\`, \`.eu\`, \`.in\`, \`.com.au\`, \`.jp\`, \`zohocloud.ca\`), and whether it is a paid custom-domain organization account, which uses \`imappro\` and \`smtppro\` for that region. MCP Emails asks for both and builds the hostname.

### Fastmail and Migadu

Fastmail uses an **app password** with Mail (IMAP/SMTP) access, from Settings → Privacy & Security: \`imap.fastmail.com\` on 993 and \`smtp.fastmail.com\` on 465. A guide telling you to sign in with Fastmail over OAuth is stale.

Migadu uses the **mailbox password**, not your Migadu account password, which manages domains and billing and authenticates no mail. An alias has no password at all, so if the address you want is an alias, add an **identity** on the mailbox and give it one. Hosts are \`imap.migadu.com\` and \`smtp.migadu.com\`. The [iCloud and IMAP walkthrough](/blog/connect-icloud-fastmail-imap-to-claude) has the app-password steps.

### Titan Email

Titan refuses every mail client until you flip one switch: **Settings → Enable Titan on Other Apps**. Until then the login fails like a wrong password. Titan is also white-labelled, so where you bought it decides your hostnames: GoDaddy sells it as Professional Email on \`imap.secureserver.net\` and \`smtpout.secureserver.net\`, Hostinger as Titan on \`imap.titan.email\`. Titan's troubleshooting tells you to turn two-factor off; you do not have to, because it supports application passwords.

### Rackspace Email

Both hosts are \`secure.emailsrvr.com\`, incoming and outgoing, whatever your domain is. The name carries no Rackspace branding, so people "correct" it to something more plausible and nothing works. Use the mailbox password from the Cloud Office control panel. With multi-factor authentication on it stops working over IMAP and SMTP while still working in webmail, so you need an app password. Rackspace also sells Hosted Exchange, which is not connectable here, and resells Microsoft 365, which connects with **Outlook** rather than IMAP.

### IONOS

IONOS gives **every address its own email password**, set in the control panel under Email. Your IONOS account login, very often an email address itself, authenticates the control panel and nothing else, and that one confusion is most of the IONOS failures in our logs. IONOS answers on both 993 with TLS and 143 with STARTTLS, so cycling between them is wasted effort: one workspace made twelve consecutive attempts alternating the two, and the password was the problem all along.

### cPanel and shared web hosts

There is no cPanel mail service, only your hosting company's server, so the panel is the only authority on its name. Open **Email Accounts**, click **Connect Devices**, and copy the values from **Mail Client Manual Settings**, using the secure SSL/TLS column. The username is the full email address, never your cPanel login, and the credential is the mailbox password. No app password, no OAuth. Plesk works the same way.

## When nothing is detected and you supply the settings yourself

Give MCP Emails four things per protocol: host, port, security mode, and your full address as the username. The conventions are fixed, and the form keeps port and security in step so they cannot drift apart:

- IMAP **993** is implicit TLS; IMAP **143** is STARTTLS.
- SMTP **465** is implicit TLS; SMTP **587** is STARTTLS, and **25** is STARTTLS on small hosts that offer nothing else.

Mixing those up was the largest cause of failed generic connections: STARTTLS on 993 stalls waiting for a greeting a TLS-only listener never sends, and implicit TLS on 143 fails the handshake. You no longer have to get it right first time. A connection that never established a usable session is retried on the other standard transports, up to three attempts per protocol, starting with the one you asked for. A password the server refused is never retried: re-sending it would only triple the failed-login count your provider uses for lockout.

Sending negotiates one more thing you will never see. Exchange-style hosts advertise **LOGIN** without PLAIN, so MCP Emails reads what the server offers, tries PLAIN first when both are there, and falls back to LOGIN. A refused mechanism is never reported as a bad password.

## Set the sender display name before your agent replies

Everything your agent sends builds its From header from one field: the inbox's display name, in front of your address. Leave it empty and mail goes out as the bare address.

Set it per inbox on the inbox detail page, where a preview shows the header as recipients see it. An agent can set it too, with \`signature_set\` and the \`sender_name\` argument. Names are capped at 100 characters, with control characters and angle brackets stripped so a name cannot smuggle a second address into the header. Set a signature while you are there: [email signatures for Claude](/blog/email-signatures-for-claude).

## Troubleshooting business mail

- **The login is refused and the password is definitely right.** Check the switch first: IMAP access on Zoho, third-party access on Titan, app passwords on Workspace, multi-factor on Rackspace.
- **You are using the wrong password entirely.** Migadu, IONOS, Rackspace and cPanel all separate the control-panel login from the mailbox password, and both are usually email addresses.
- **It times out instead of failing.** That is the host or the port, not the credential. Re-read the hostname from the provider's own panel.
- **Mail reads but will not send.** The outgoing half is its own host, port and security mode, and some hosts do not listen on 465 at all. Confirm you granted \`send:email\`.
- **It is a Microsoft 365 mailbox.** Bought direct or resold by GoDaddy, IONOS or Rackspace, it is still a Microsoft tenant. Connect it with **Outlook** and Sign in with Microsoft, not IMAP. If Microsoft says admin approval is required, send the link the dashboard shows to your IT admin.

The [provider matrix](/docs/providers) and the [provider pages](/connect) carry the per-provider detail.

## FAQ

**How do I find out who hosts my company email?**
Look up your domain's MX record, or type your address into the connect form and let autodiscovery check the MX and service records for you.

**Can I connect a Google Workspace address?**
Yes, with a Google app password over IMAP, or with OAuth. Your administrator can block either: app passwords can be disabled domain-wide, and third-party OAuth apps restricted under API controls.

**What if my host publishes no IMAP settings?**
Supply them yourself: host, port, security mode, and your full address as the username. If the first transport does not answer, the standard alternatives are tried automatically.

**Does MCP Emails store my company's email?**
No. Message content is fetched live from your provider on each request and discarded. Only the encrypted provider credential is retained.

**Is one inbox enough on the free plan?**
Free connects 1 inbox. Personal is $5/month for 3 inboxes with no monthly action cap, Pro $15/month for unlimited inboxes. See [pricing](/pricing).

## Next step

[Create a free account](/signup), connect your business mailbox, set the sender name, and add \`https://mcpemails.com/api/mcp\` to your client. Then have it call \`inbox_list\` and summarize yesterday's unread mail before you grant it anything that sends.`,
};

export default post;
