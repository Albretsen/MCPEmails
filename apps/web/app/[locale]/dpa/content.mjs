// Copy for /dpa, the MCPEmails Data Processing Agreement.
//
// Kept next to the page rather than in messages/: a messages/ namespace is
// serialised into every marketing page, and this copy is only read here.
//
// ENGLISH IS THE BINDING TEXT. Every locale route renders the same English
// agreement (DPA_DOCUMENT). Only the page chrome (meta, eyebrow, the binding
// notice and the PDF label) is localized. Do not add machine translations of
// the agreement: a translation is a contract and needs native legal review.
//
// The PDF at public/legal/mcpemails-dpa-<version>.pdf is generated from this
// same text by scripts/build-dpa-pdf.mjs. A new version gets a new file name,
// so earlier versions stay reachable.
//
// Every retention and security promise below is contractual. Before changing
// code that stores, encrypts or purges customer data, check section 4 and the
// table in section 8, and change them together.
//
// Tokens, filled by the page and the PDF script: {entity} {orgNumber}
// {address}. Email addresses in the text are linked automatically.
//
// Block types: { p }, { table: { head, rows } }, { ol: [{ label, text }] },
// { h3 }.

export const DPA_VERSION = '2026-11-01';
export const DPA_EFFECTIVE = 'Effective 1 November 2026';
export const DPA_PDF_PATH = `/legal/mcpemails-dpa-${DPA_VERSION}.pdf`;

export const DPA_DOCUMENT = {
  title: 'MCPEmails Data Processing Agreement',
  versionLine: `Version ${DPA_VERSION}. ${DPA_EFFECTIVE}.`,
  sections: [
    {
      id: 'parties',
      h: '1. Parties, scope and acceptance',
      blocks: [
        {
          p: 'This Data Processing Agreement ("DPA") sets the terms on which MCPEmails processes personal data for a customer. It meets Article 28 of the EU General Data Protection Regulation ("GDPR") as it applies in Norway through the EEA Agreement, and Annex A extends it to customers under other laws, including South Africa\'s Protection of Personal Information Act ("POPIA").',
        },
        {
          table: {
            head: ['Role', 'Party'],
            rows: [
              [
                'Processor',
                '{entity}, a Norwegian private limited company (aksjeselskap), org. no. {orgNumber}, {address}, trading as "MCPEmails" ("MCPEmails")',
              ],
              ['Controller', 'The customer that holds the MCPEmails account or workspace ("Customer")'],
            ],
          },
        },
        {
          ol: [
            {
              label: 'Part of the Terms.',
              text: 'This DPA forms part of the MCPEmails Terms of Service (the "Terms"). It applies automatically to every Customer that accepts the Terms; no signature is needed. If the Terms and this DPA conflict on personal data, this DPA prevails.',
            },
            {
              label: 'Countersigned copy.',
              text: 'A Customer that needs a signed copy can ask at privacy@mcpemails.com. MCPEmails will send this same text signed by {entity}. A signed copy does not change the terms.',
            },
            {
              label: 'Scope.',
              text: 'This DPA covers personal data in email content and mailbox metadata that MCPEmails processes on the Customer\'s behalf through the service at mcpemails.com, its MCP server, its API and its web client.',
            },
            {
              label: 'Outside scope.',
              text: 'For account, billing, support and website usage data, MCPEmails is an independent controller under its Privacy Policy. This DPA does not cover copies of the MCPEmails server code that a Customer or anyone else hosts on its own infrastructure.',
            },
            {
              label: 'Duration.',
              text: 'This DPA runs as long as MCPEmails processes personal data for the Customer. Section 8 survives it.',
            },
          ],
        },
      ],
    },
    {
      id: 'details',
      h: '2. Details of processing',
      blocks: [
        {
          p: 'MCPEmails reads and acts on the Customer\'s connected mailboxes when the Customer\'s AI client, API key or automation calls a tool. It does not keep a copy of the email content it reads.',
        },
        {
          table: {
            head: ['Item', 'Description'],
            rows: [
              [
                'Subject matter',
                'Connecting the Customer\'s mailboxes to AI clients the Customer chooses (for example Claude or ChatGPT) over the Model Context Protocol, and running the automations, reminders and scheduled sends the Customer sets up',
              ],
              ['Duration', 'For the life of the Customer\'s account, then deletion under section 8'],
              [
                'Nature',
                'Retrieving, searching, sending, drafting, organising and deleting email over IMAP, SMTP, the Gmail API or Microsoft Graph, each on a request from the Customer\'s client, key or automation',
              ],
              ['Purpose', 'Providing the service the Customer has asked for. No profiling, advertising, sale of data or AI training'],
              ['Data subjects', 'The Customer\'s users, and the people they correspond with'],
              [
                'Personal data',
                'Email headers, addresses, names, subjects, bodies and attachments; contact details found in mail; mailbox credentials (app passwords or OAuth tokens); connection data (IP address and client name of the calling AI client)',
              ],
              [
                'Special categories',
                'Mail may contain any category of personal data, including special categories such as health data. MCPEmails stores no email content it reads, so none of it is stored. The only content MCPEmails stores is what the Customer asks it to hold, listed in section 8',
              ],
            ],
          },
        },
      ],
    },
    {
      id: 'processor-duties',
      h: '3. Processor duties (GDPR Article 28(3))',
      blocks: [
        {
          ol: [
            {
              label: 'Instructions (a).',
              text: 'MCPEmails processes personal data only on the Customer\'s documented instructions, including for transfers outside the EEA. The instructions are the Terms, this DPA, the Customer\'s settings, and the tool calls made by the Customer\'s AI clients, API keys and automations. If law requires other processing, MCPEmails will tell the Customer first unless the law forbids it.',
            },
            {
              label: 'Unlawful instructions (h, last paragraph).',
              text: 'If MCPEmails believes an instruction breaks data protection law, it will tell the Customer and may refuse it.',
            },
            {
              label: 'Confidentiality (b).',
              text: 'MCPEmails is run by one person, Asgeir Albretsen, who is bound by confidentiality. No one else has production access. Anyone given access later will be bound by confidentiality first.',
            },
            {
              label: 'Security (c).',
              text: 'MCPEmails applies the measures in section 4 and keeps them at least as strong for the life of this DPA.',
            },
            {
              label: 'Subprocessors (d).',
              text: 'MCPEmails uses only the subprocessors in section 5, on the terms set out there.',
            },
            {
              label: 'Data subject requests (e).',
              text: 'Email stays in the Customer\'s mailbox, so most requests are answered there. MCPEmails will pass on any request it receives about the Customer\'s data without answering it itself, and will help the Customer answer the rest without undue delay.',
            },
            {
              label: 'Assistance (f).',
              text: 'MCPEmails will give reasonable help with the Customer\'s duties under GDPR Articles 32 to 36 (security, breach notices, impact assessments and prior consultation), using the information available to it.',
            },
            {
              label: 'Deletion at the end (g).',
              text: 'When the service ends, MCPEmails deletes personal data as set out in section 8. There is no stored email content to return; the mail stays with the Customer\'s mail provider.',
            },
            {
              label: 'Information and audits (h).',
              text: 'MCPEmails will make available the information needed to show it meets this DPA, and allows audits under section 9.',
            },
          ],
        },
      ],
    },
    {
      id: 'security',
      h: '4. Security measures (GDPR Article 32)',
      blocks: [
        { p: 'The main safeguard is that email content is fetched live and not stored.' },
        {
          table: {
            head: ['Area', 'Measure'],
            rows: [
              [
                'Email content',
                'Not written to the database, cache or logs. Only messages the Customer schedules for later or holds for approval are stored, encrypted (section 8)',
              ],
              [
                'Credentials at rest',
                'App passwords and OAuth tokens are encrypted with AES-256-GCM. The key is a server secret kept apart from the database',
              ],
              ['Data in transit', 'TLS 1.2 or higher. Mail servers that do not support TLS are refused'],
              ['Database location', 'One database for all customers, in the EU (Stockholm, Sweden)'],
              ['Backups', 'Daily encrypted database backups, kept 7 days by Supabase'],
              ['API keys', 'Only a SHA-256 hash is stored. The raw key is shown once'],
              ['Tenant isolation', 'Row-Level Security stops one workspace from reading another\'s data'],
              [
                'Least privilege',
                'Each key or AI client connection carries scopes. Sending, deleting and other changes need their own scopes and can be limited to chosen mailboxes',
              ],
              [
                'Read-only mode',
                'A read-only connection opens IMAP folders with EXAMINE, so the mail provider also refuses changes',
              ],
              [
                'Human checks',
                'The Customer can require approval before any send. Deleting mail needs an explicit confirmation flag',
              ],
              [
                'Abuse limits',
                'Every key is rate limited, and sending has automatic brakes against bulk or runaway sends',
              ],
              [
                'Admin access',
                'Production dashboards (Supabase, Vercel, GitHub) are protected by multi-factor authentication',
              ],
              ['Transparency', 'The server code is public on GitHub and can be self-hosted'],
            ],
          },
        },
      ],
    },
    {
      id: 'subprocessors',
      h: '5. Subprocessors (GDPR Article 28(2) and (4))',
      blocks: [
        { p: 'The Customer gives general authorisation for the subprocessors below.' },
        {
          table: {
            head: ['Subprocessor', 'Purpose', 'Location'],
            rows: [
              [
                'Supabase Pte. Ltd. (Singapore)',
                'Database, authentication, and the edge functions that connect to mailboxes',
                'Data stored in the EU (Stockholm, Sweden). Edge functions run in the US (East) and process email live without storing it',
              ],
              [
                'Vercel Inc. (USA)',
                'Website, dashboard, and the server functions that pass AI client requests to the edge functions',
                'US (East) and EU (Stockholm, Sweden); global network for requests in transit',
              ],
              [
                'Hetzner Online GmbH (Germany)',
                'Mail relay: a TLS tunnel used for providers that refuse connections from cloud addresses, and as a one-time retry route when a provider refuses a direct connection. TLS runs end to end, so the relay cannot read mail or passwords',
                'Germany',
              ],
            ],
          },
        },
        {
          ol: [
            {
              label: 'Not subprocessors.',
              text: 'The Customer\'s mail provider and AI client are chosen by the Customer and are not engaged by MCPEmails. Resend sends account emails (sign-in links, receipts, notices) and Stripe handles payments; both process only MCPEmails\' own account and billing data, never mail content, and are covered by the Privacy Policy.',
            },
            {
              label: 'Terms.',
              text: 'Each subprocessor is bound by a written data processing agreement with duties no weaker than this DPA. MCPEmails remains fully liable to the Customer for its subprocessors.',
            },
            {
              label: 'Changes.',
              text: 'MCPEmails will email the account owner at least 30 days before adding or replacing a subprocessor, and will update this list. The Customer may object on reasonable data protection grounds within that period. If the objection cannot be resolved, the Customer may end the service before the change and get a pro-rata refund of prepaid fees for the unused period.',
            },
          ],
        },
      ],
    },
    {
      id: 'transfers',
      h: '6. International transfers (GDPR Chapter V)',
      blocks: [
        {
          p: 'Stored data stays in the EU. Email is processed live in the United States, and Supabase\'s contracting entity is in Singapore.',
        },
        {
          ol: [
            {
              label: 'Mechanism.',
              text: 'Transfers to Supabase Pte. Ltd. and Vercel Inc. are covered by the Standard Contractual Clauses adopted by Commission Implementing Decision (EU) 2021/914 (Module Three, processor to processor), incorporated in each subprocessor\'s data processing agreement. Where a recipient is certified under the EU-US Data Privacy Framework, that also applies.',
            },
            {
              label: 'Supplementary measures.',
              text: 'Mail content is not stored in the US. Credentials are decrypted there only in memory for the length of a request, and the key is kept apart from the database.',
            },
            {
              label: 'Customer outside the EEA.',
              text: 'For a Customer outside the EEA, MCPEmails (in Norway) receives data from the Customer. Annex A sets out the terms for that.',
            },
          ],
        },
      ],
    },
    {
      id: 'breaches',
      h: '7. Personal data breaches (GDPR Article 33(2))',
      blocks: [
        {
          ol: [
            {
              text: 'MCPEmails will notify the Customer of a personal data breach without undue delay, and no later than 48 hours after becoming aware of it.',
            },
            {
              text: 'The notice goes to the account owner\'s email address and says what happened, the data and people likely affected, the likely consequences, and the steps taken or proposed. Details that are not yet known will follow as soon as they are.',
            },
            {
              text: 'MCPEmails will help the Customer notify authorities and data subjects. Notifying the Customer is not an admission of fault.',
            },
          ],
        },
      ],
    },
    {
      id: 'retention',
      h: '8. Retention and deletion',
      blocks: [
        {
          table: {
            head: ['Data', 'How it is stored', 'How long'],
            rows: [
              [
                'Email content read, searched or sent immediately',
                'Not stored. Passed to the Customer\'s client in the same response',
                'Not kept',
              ],
              [
                'Mailbox credentials',
                'Encrypted with AES-256-GCM',
                'Erased the moment the mailbox is disconnected or the account is deleted. They remain inside encrypted daily database backups until those expire, up to 8 days later',
              ],
              [
                'Mailbox settings (address, display name, server settings, signature)',
                'Database',
                'Erased 30 days after the mailbox is disconnected or the account is deleted',
              ],
              [
                'Messages scheduled to send later',
                'Full message encrypted with AES-256-GCM',
                'The message is erased 7 days after it is sent, fails or is cancelled. Only the time and status are kept as send history, and that is erased 30 days after account deletion',
              ],
              [
                'Sends held for approval',
                'Message, recipients and subject encrypted with AES-256-GCM',
                'Held for at most 24 hours waiting for a decision. The message is erased 7 days after the send is decided or expires, and the approval record is deleted after 90 days',
              ],
              [
                'Activity log',
                'Tool name, mailbox, time, status, duration and error code. No message bodies',
                'Deleted after 90 days on Free and Personal, and after 2 years on Pro and Business. The Free dashboard shows only the last 30 days',
              ],
              [
                'AI client connection log',
                'Sign-ins and token refreshes of AI clients, with IP address and user agent',
                'IP address and user agent erased after 30 days',
              ],
              [
                'Automation run records',
                'Subject and sender of each message an automation acted on, cut to 120 characters, and the outcome',
                'Deleted after 90 days',
              ],
              [
                'Reminders and follow-ups',
                'Encrypted reference to the message (subject, sender, recipients)',
                'Deleted 90 days after the reminder completes (180 days if it failed)',
              ],
              [
                'Unsubscribe tools',
                'Sender list from a scan, encrypted; requests the Customer sends, with the sender\'s name and address',
                'Scan results deleted after 1 day. Sent requests erased 30 days after account deletion',
              ],
              [
                'Send safety records',
                'One-way hashes of recipients and content, used to stop bulk sends',
                'Deleted after 2 days',
              ],
              [
                'Account deletion',
                'API keys revoked, mailboxes disconnected, credentials erased, workspace closed at once',
                'Everything above is erased within 30 days of account deletion, and leaves the encrypted backups up to 8 days after that',
              ],
            ],
          },
        },
        {
          ol: [
            {
              label: 'Return.',
              text: 'MCPEmails stores no email content the Customer could need back. The Customer\'s mail stays with its mail provider throughout.',
            },
            {
              label: 'Revocation.',
              text: 'The Customer can cut MCPEmails off at any time without asking, by revoking the app password or OAuth grant at its mail provider, or by disconnecting the mailbox in the dashboard.',
            },
            {
              label: 'Earlier deletion.',
              text: 'On written request, MCPEmails will erase a Customer\'s remaining records sooner than the table above, unless law requires it to keep them.',
            },
          ],
        },
      ],
    },
    {
      id: 'general',
      h: '9. Audits, liability and general terms',
      blocks: [
        {
          ol: [
            {
              label: 'Audits.',
              text: 'MCPEmails will answer reasonable written questions about its compliance within 30 days. If that is not enough, the Customer may audit once a year at its own cost, on 30 days\' notice, during business hours and under a confidentiality agreement. A supervisory authority may audit at any time.',
            },
            {
              label: 'Liability.',
              text: 'Liability under this DPA follows the limits in the Terms, except where data protection law does not allow them.',
            },
            {
              label: 'Governing law.',
              text: 'This DPA is governed by Norwegian law, and disputes go to the courts of Bergen, Norway, as in the Terms. The Standard Contractual Clauses follow their own governing law clause.',
            },
            {
              label: 'Changes.',
              text: 'MCPEmails may update this DPA to reflect changes in law or the service, by email to the account owner at least 30 days before the change takes effect. A change will not reduce the protection given to personal data.',
            },
            {
              label: 'Contact.',
              text: 'Data protection: privacy@mcpemails.com. Security reports: security@mcpemails.com.',
            },
          ],
        },
      ],
    },
    {
      id: 'annex-a',
      h: 'Annex A. Customers under other data protection laws, including POPIA',
      blocks: [
        {
          p: 'This annex applies when the Customer is subject to a data protection law outside the EEA. MCPEmails gives the same protection under that law as under the GDPR, and terms in this DPA are read with the nearest equivalent in that law.',
        },
        { h3: 'A.1 South Africa (POPIA)' },
        {
          p: 'For POPIA, the Customer is the "responsible party", MCPEmails is the "operator", and this DPA is the written contract required by section 21(1).',
        },
        {
          ol: [
            {
              label: 'Authorisation and confidentiality (section 20).',
              text: 'MCPEmails processes the Customer\'s personal information only with the Customer\'s knowledge or authorisation, as set out in section 3.1. It treats that information as confidential and does not disclose it, unless law requires it or it is needed to perform this DPA.',
            },
            {
              label: 'Security measures (sections 19 and 21(1)).',
              text: 'MCPEmails establishes and maintains the security measures in section 4. They are designed to secure the integrity and confidentiality of personal information and to prevent its loss, damage, or unlawful access or processing, as section 19 requires.',
            },
            {
              label: 'Notice of unauthorised access (section 21(2)).',
              text: 'MCPEmails will notify the Customer immediately when there are reasonable grounds to believe that the Customer\'s personal information has been accessed or acquired by an unauthorised person. The 48-hour limit in section 7 is an outer limit and does not delay this notice.',
            },
            {
              label: 'Data subject and Regulator matters.',
              text: 'MCPEmails will help the Customer meet its duties to data subjects and to the Information Regulator, including notices under section 22.',
            },
          ],
        },
        { h3: 'A.2 Transfers out of South Africa (POPIA section 72(1)(a))' },
        {
          p: 'Personal information flows from the Customer in South Africa to MCPEmails in Norway, and from there to the subprocessors in section 5. The parties agree that this DPA is a binding agreement giving the information a level of protection substantially similar to the conditions for lawful processing in POPIA, as follows:',
        },
        {
          ol: [
            {
              label: 'Conditions upheld.',
              text: 'MCPEmails processes the information only for the purpose in section 2, keeps it no longer than section 8 allows, secures it under section 4, and helps data subjects exercise their rights through the Customer.',
            },
            {
              label: 'Same law at the recipient.',
              text: 'MCPEmails is subject to the GDPR in Norway, which itself gives protection substantially similar to POPIA.',
            },
            {
              label: 'Onward transfers.',
              text: 'MCPEmails transfers the information onward only to the subprocessors in section 5, under written terms no weaker than this DPA, and to recipients outside the EEA only under the safeguards in section 6. It does not transfer the information to any other third party except where law requires it, and then only after telling the Customer if the law allows.',
            },
          ],
        },
        { h3: 'A.3 Other laws' },
        {
          ol: [
            {
              label: 'United Kingdom.',
              text: 'For a Customer subject to the UK GDPR, MCPEmails will, on request, sign the UK Information Commissioner\'s International Data Transfer Addendum (version B1.0) to the Standard Contractual Clauses.',
            },
            {
              label: 'Switzerland.',
              text: 'For a Customer subject to the Swiss Federal Act on Data Protection, references to the GDPR include that Act, and the Standard Contractual Clauses apply with the changes the Swiss Federal Data Protection and Information Commissioner requires.',
            },
            {
              label: 'Any other law.',
              text: 'Where another law needs a specific notice period, contract term or transfer document, the Customer can ask at privacy@mcpemails.com and MCPEmails will agree reasonable additions that do not change the service.',
            },
          ],
        },
      ],
    },
    {
      id: 'signatures',
      h: 'Signatures (optional, for a countersigned copy)',
      blocks: [
        {
          table: {
            head: ['', 'Processor', 'Controller'],
            rows: [
              ['Company', '{entity} (MCPEmails)', ''],
              ['Org. no.', '{orgNumber}', ''],
              ['Name', 'Asgeir Albretsen', ''],
              ['Title', 'Chair of the board', ''],
              ['Date', '', ''],
              ['Signature', '', ''],
            ],
          },
        },
      ],
    },
  ],
};

// Page chrome per locale. `notice` is the one localized line above the
// English text; English needs none.
const en = {
  meta: {
    title: 'Data Processing Agreement',
    description:
      'The MCPEmails Data Processing Agreement (GDPR Article 28, with a POPIA annex): what we process, subprocessors, transfers, breach notice and retention.',
  },
  eyebrow: 'Legal',
  notice: null,
  pdf: 'Download PDF',
};

const nb = {
  meta: {
    title: 'Databehandleravtale',
    description:
      'Databehandleravtalen for MCPEmails (GDPR artikkel 28, med vedlegg for POPIA): hva vi behandler, underleverandører, overføringer, varsling av brudd og lagringstid.',
  },
  eyebrow: 'Juridisk',
  notice:
    'Databehandleravtalen finnes foreløpig bare på engelsk. Den engelske versjonen er bindende, og oversettelser kan komme senere.',
  pdf: 'Last ned PDF',
};

const es = {
  meta: {
    title: 'Acuerdo de tratamiento de datos',
    description:
      'El acuerdo de tratamiento de datos de MCPEmails (artículo 28 del RGPD, con un anexo sobre POPIA): qué tratamos, subencargados, transferencias, aviso de brechas y conservación.',
  },
  eyebrow: 'Legal',
  notice:
    'Por ahora este acuerdo solo está disponible en inglés. La versión en inglés es la vinculante, y es posible que se publiquen traducciones más adelante.',
  pdf: 'Descargar PDF',
};

const fr = {
  meta: {
    title: 'Accord de traitement des données',
    description:
      "L'accord de traitement des données de MCPEmails (article 28 du RGPD, avec une annexe POPIA) : données traitées, sous-traitants ultérieurs, transferts, notification des violations et conservation.",
  },
  eyebrow: 'Mentions légales',
  notice:
    "Cet accord n'existe pour l'instant qu'en anglais. La version anglaise fait foi, et des traductions pourront suivre.",
  pdf: 'Télécharger le PDF',
};

const de = {
  meta: {
    title: 'Auftragsverarbeitungsvertrag',
    description:
      'Der Auftragsverarbeitungsvertrag von MCPEmails (Art. 28 DSGVO, mit einem Anhang zu POPIA): was wir verarbeiten, Unterauftragsverarbeiter, Übermittlungen, Meldung von Datenpannen und Speicherdauer.',
  },
  eyebrow: 'Rechtliches',
  notice:
    'Dieser Vertrag liegt derzeit nur auf Englisch vor. Die englische Fassung ist verbindlich, Übersetzungen können folgen.',
  pdf: 'PDF herunterladen',
};

const zh = {
  meta: {
    title: '数据处理协议',
    description:
      'MCPEmails 数据处理协议（GDPR 第 28 条，附 POPIA 附件）：我们处理哪些数据、子处理方、跨境传输、数据泄露通知和保留期限。',
  },
  eyebrow: '法律',
  notice: '本协议目前仅提供英文版。英文版本具有约束力，日后可能提供译本。',
  pdf: '下载 PDF',
};

export const DPA_PAGE_COPY = { en, nb, es, fr, de, zh };

export function dpaPageCopy(locale) {
  return DPA_PAGE_COPY[locale] ?? en;
}

/** Fill {entity} {orgNumber} {address} as plain text. */
export function fillDpaText(text, values) {
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m));
}
