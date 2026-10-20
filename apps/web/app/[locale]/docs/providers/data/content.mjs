import { datasetStats, JSON_PATH, CSV_PATH, DATASET_PATH, LICENSE_URL } from '@/lib/connect/provider-dataset.mjs';

/**
 * Copy for /docs/providers/data. English only, like /best-email-mcp-servers:
 * the page makes dated, measured claims, and four machine translations would
 * be four more places for a number to drift from the probe.
 *
 * Every number in this file is computed from datasetStats(). Never type a
 * count into a sentence here: the provider release schedule changes the row
 * count without anyone editing this page.
 */

const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export function datasetCopy() {
  const s = datasetStats();
  return {
    stats: s,
    meta: {
      title: `IMAP and SMTP settings of ${s.providers} mail providers: open dataset`,
      description: `Hosts, ports, login mechanisms, SASL-IR support and SMTP size limits for ${s.providers} email providers, read from a live TLS probe. Free JSON and CSV under CC BY 4.0.`,
    },
    hero: {
      eyebrow: 'Open data',
      title: `IMAP and SMTP settings of ${s.providers} mail providers, probed live`,
      lead: 'We connect AI assistants to almost any mailbox, so we had to learn how each provider’s servers actually behave. Here is what they advertise before login, as a table and as free downloads.',
      json: 'Download JSON',
      csv: 'Download CSV',
      meta: [`Probed ${s.probedOn}`, 'CC BY 4.0', 'No login, no mail read'],
    },
    findings: {
      title: 'What the probe found',
      items: [
        {
          h: `${s.noSaslIr} of ${s.providers} IMAP servers do not advertise SASL-IR.`,
          p: 'A client that sends the credentials together with the AUTHENTICATE command saves a round trip on most servers and fails on these. They need the two-step form: send the command, wait for the server, then send the credentials.',
        },
        {
          h: `SMTP size limits run from ${fmt(s.sizeMin)} MB to ${fmt(s.sizeMax)} MB, median ${fmt(s.sizeMedian)} MB.`,
          p: `That is across the ${s.sizeCount} servers that advertise a SIZE limit. The limit applies to the whole encoded message, and base64 makes an attachment about a third larger, so a 20 MB file needs about 27 MB of headroom.`,
        },
        {
          h: `${s.oauth} of ${s.providers} advertise OAuth for IMAP (XOAUTH2 or OAUTHBEARER).`,
          p: 'Advertising a mechanism is not the same as opening it to every app. OAuth needs a client registered with that provider, which is why an app password is still the usual way in for third-party tools.',
        },
        {
          h: `${s.plain} accept AUTH PLAIN. ${s.loginOnly} offer LOGIN but not PLAIN.`,
          p: 'PLAIN is the safe default, but a client still needs LOGIN as a fallback. Microsoft Exchange servers that list only GSSAPI, NTLM and LOGIN answer PLAIN with 504 5.7.4.',
        },
        {
          h: `${s.implicitTlsSmtp} use implicit TLS for SMTP submission. ${s.starttlsSmtp} use STARTTLS.`,
          p: 'Port 465 with TLS from the first byte is now the norm. On a STARTTLS port, some servers only list their login mechanisms after the upgrade, so the table shows those as not visible.',
        },
      ],
    },
    table: {
      title: 'Every provider',
      sub: 'Sorted by name. Each provider links to its setup guide for Claude, ChatGPT and other MCP clients.',
      cols: {
        provider: 'Provider',
        imap: 'IMAP server',
        imapAuth: 'IMAP login',
        saslIr: 'SASL-IR',
        smtp: 'SMTP server',
        smtpAuth: 'SMTP login',
        size: 'Max size',
      },
      notVisible: 'after STARTTLS',
      yes: 'Yes',
      no: 'No',
    },
    method: {
      title: 'How it was measured',
      items: [
        'Hosts and ports come from the Thunderbird ISPDB where it lists the provider, and from the provider’s own documentation otherwise. The settingsSource field says which.',
        'Each host was reached over TLS and the certificate checked against that exact hostname, so every host listed here answered under the name we publish.',
        'We read the IMAP greeting and CAPABILITY, and the SMTP EHLO reply. We never logged in and never touched a mailbox.',
        'Extensions that servers list only after login, such as MOVE, IDLE and SPECIAL-USE, are left out. A pre-login probe would report them as missing on servers that support them.',
        'Only providers whose servers answered are included. Mailboxes we reach through an API rather than IMAP, such as Outlook.com through Microsoft Graph, are covered in the feature matrix instead.',
      ],
    },
    fields: {
      title: 'Fields',
      sub: 'The JSON and CSV carry the same fields in this order. In the CSV, lists are space-separated inside one cell.',
    },
    cite: {
      title: 'Use and cite',
      body: 'Free to use, copy and build on under CC BY 4.0, with credit. Settings drawn from the Thunderbird ISPDB are also available there under MPL 2.0. Found something wrong? Write to hello@mcpemails.com and we will re-check it.',
      citation: `MCPEmails, "IMAP and SMTP provider compatibility dataset", probed ${s.probedOn}. https://mcpemails.com${DATASET_PATH}`,
    },
    links: {
      matrix: 'Feature support per provider',
      connect: 'All setup guides',
    },
    cta: {
      title: 'Connect any of these mailboxes to your AI assistant',
      sub: 'Claude, ChatGPT, Cursor and other MCP clients. Free to start.',
      primary: 'Connect an inbox free',
      secondary: 'Read the docs',
    },
    paths: { json: JSON_PATH, csv: CSV_PATH, license: LICENSE_URL },
  };
}
