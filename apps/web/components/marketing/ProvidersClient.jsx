'use client';

import { Fragment } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Nav, Footer } from './Sections';

// Rich-text tag handlers shared across this page (inline code + bold).
const RICH = {
  code: (chunks) => <code className="t-code-inline">{chunks}</code>,
  b: (chunks) => <strong>{chunks}</strong>,
};

// ---------------------------------------------------------------------------
// Capability data — mirrors PROVIDER_CAPABILITIES in
// supabase/functions/mcp-server/index.ts. Keep the two in sync whenever the
// matrix changes. (This comment used to name a third source,
// Documents/provider-support.md; no such file is in the repo.)
//
// That map is keyed by the stored `inboxes.provider` value rather than by
// brand, and a Google mailbox reaches it through two different keys:
//
//   'gmail' → the Gmail API connector, reached with OAuth. The inboxes that
//             connected before an app password became the default way in are
//             still stored this way and still run on it.
//   'imap'  → every app-password inbox, a Google one included. A Gmail address
//             connected today is stored as provider='imap', service='gmail'
//             (src/lib/email-providers/imap-presets.ts), and nothing in the
//             edge function branches on `service`, so it gets the same
//             capability set as iCloud or a generic host.
//
// The two answer differently on folders, labels, copy, permanent delete and
// search syntax, so Gmail gets a column per key below rather than one column
// that would have to be silently wrong for one of them.
// ---------------------------------------------------------------------------

const PROVIDERS = [
  // Gmail, both ways in. App password leads because it is the default one.
  { key: 'gmailImap', labelKey: 'gmailImap' },  // PROVIDER_CAPABILITIES.imap
  { key: 'gmail',     labelKey: 'gmailApi' },   // PROVIDER_CAPABILITIES.gmail
  // Microsoft Graph, reached with OAuth: its own capability set,
  // PROVIDER_CAPABILITIES.outlook.
  { key: 'outlook',   label: 'Outlook' },
  // Every column from here down, and the Gmail app-password one above, is
  // provider='imap' in the DB and shares the one capability set.
  { key: 'fastmail',  label: 'Fastmail' },
  { key: 'icloud',    label: 'iCloud' },
  { key: 'yahoo',     label: 'Yahoo' },
  { key: 'zoho',      label: 'Zoho' },
  { key: 'yandex',    label: 'Yandex' },
  { key: 'generic',   labelKey: 'generic' },
];

// ---------------------------------------------------------------------------
// Connection settings — how each provider is actually reached.
//
// This is the half of the matrix that the capability table below cannot carry:
// a capability is the same sentence for every IMAP provider, while the way in
// differs per provider and is where connections are actually lost. Every value
// here is traceable to the code that uses it, and the comment on each row names
// that file, because the whole point of this page is that it is checked rather
// than remembered:
//
//   hosts, ports, transport   src/lib/email-providers/imap-presets.ts
//                             src/lib/email-providers/host-presets.ts
//   Gmail OAuth scopes        app/auth/gmail/route.ts
//   Gmail app-password hosts  IMAP_PRESETS.gmail in imap-presets.ts
//   Microsoft scopes/consent  src/lib/email-providers/outlook-oauth.ts
//   generic transport pairs   src/lib/email/transport-autodetect.ts
//
// `imap`/`smtp` are null when the provider is not reached over IMAP at all.
//
// Gmail takes two rows because it genuinely has two ways in, and which one a
// mailbox used decides what the agent can do with it afterwards — see the two
// Gmail columns in the capability table below.
// ---------------------------------------------------------------------------

const CONNECTION = [
  {
    // The default way into a Google mailbox: an app password over Gmail's own
    // IMAP/SMTP hosts, stored as provider='imap', service='gmail'. Hosts and
    // ports are IMAP_PRESETS.gmail verbatim (imap-presets.ts).
    key: 'gmailImap', labelKey: 'gmailImap', href: '/connect/gmail',
    auth: 'appPassword',
    imap: { host: 'imap.gmail.com', port: '993', security: 'TLS' },
    smtp: { host: 'smtp.gmail.com', port: '465', security: 'TLS' },
  },
  {
    // Gmail API, not IMAP: gmail.readonly, gmail.send, gmail.modify and
    // gmail.settings.basic (app/auth/gmail/route.ts). Kept and demoted rather
    // than retired — it still carries the inboxes that connected this way, and
    // the connect modal still offers it one click down — because an unverified
    // Google app may only ever be granted consent by 100 accounts in its
    // lifetime and that counter cannot be reset.
    key: 'gmail', labelKey: 'gmailApi', href: '/connect/gmail',
    auth: 'googleOauth', imap: null, smtp: null,
  },
  {
    key: 'fastmail', label: 'Fastmail', href: '/connect/fastmail',
    auth: 'appPassword',
    imap: { host: 'imap.fastmail.com', port: '993', security: 'TLS' },
    smtp: { host: 'smtp.fastmail.com', port: '465', security: 'TLS' },
  },
  {
    key: 'icloud', label: 'iCloud Mail', href: '/connect/icloud',
    auth: 'appPassword',
    imap: { host: 'imap.mail.me.com', port: '993', security: 'TLS' },
    smtp: { host: 'smtp.mail.me.com', port: '587', security: 'STARTTLS' },
  },
  {
    key: 'yahoo', label: 'Yahoo Mail', href: '/connect/yahoo',
    auth: 'appPassword',
    imap: { host: 'imap.mail.yahoo.com', port: '993', security: 'TLS' },
    smtp: { host: 'smtp.mail.yahoo.com', port: '465', security: 'TLS' },
  },
  {
    // Global (.com) data centre, personal account. Five other regions and the
    // imappro/smtppro organization hosts are resolved by zohoHosts().
    key: 'zoho', label: 'Zoho Mail', href: '/connect/zoho',
    auth: 'appPassword',
    imap: { host: 'imap.zoho.com', port: '993', security: 'TLS' },
    smtp: { host: 'smtp.zoho.com', port: '465', security: 'TLS' },
  },
  {
    key: 'yandex', label: 'Yandex Mail', href: '/connect/yandex',
    auth: 'appPassword',
    imap: { host: 'imap.yandex.com', port: '993', security: 'TLS' },
    smtp: { host: 'smtp.yandex.com', port: '465', security: 'TLS' },
  },
  {
    // Microsoft Graph, not IMAP: Mail.ReadWrite, Mail.Send and offline_access
    // (OUTLOOK_SCOPES in outlook-oauth.ts), started from the connect modal's
    // Outlook card at /auth/outlook. Personal accounts consent for themselves;
    // a work or school tenant on Microsoft's default consent policy needs its
    // admin to approve once (/auth/outlook/admin-consent), which the notes say.
    key: 'outlook', label: 'Microsoft 365 / Outlook', href: '/connect/outlook',
    auth: 'microsoftOauth', imap: null, smtp: null,
  },
  {
    // Both standard pairs, in the order transport-autodetect tries them.
    key: 'generic', labelKey: 'generic', href: '/connect/imap',
    auth: 'mailboxPassword',
    imap: { host: null, port: '993 / 143', security: 'TLS / STARTTLS' },
    smtp: { host: null, port: '465 / 587', security: 'TLS / STARTTLS' },
  },
];

// true  = supported
// false = not supported
// 'planned' = on the roadmap, not yet shipped
// string    = informational value (e.g. search syntax name)

const MATRIX = {
  // ── Core read/write ────────────────────────────────────────────────────
  original_message: {
    label: 'Download original (.eml)',
    section: 'Core',
    gmail: true, gmailImap: true, outlook: true, fastmail: true,
    icloud: true, yahoo: true, zoho: true, yandex: true, generic: true,
  },
  read: {
    label: 'Read email',
    section: 'Core',
    gmail: true, gmailImap: true, outlook: true, fastmail: true,
    icloud: true, yahoo: true, zoho: true, yandex: true, generic: true,
  },
  search: {
    label: 'Search',
    section: 'Core',
    gmail: true, gmailImap: true, outlook: true, fastmail: true,
    icloud: true, yahoo: true, zoho: true, yandex: true, generic: true,
  },
  send: {
    label: 'Send email',
    section: 'Core',
    gmail: true, gmailImap: true, outlook: true, fastmail: true,
    icloud: true, yahoo: true, zoho: true, yandex: true, generic: true,
  },
  reply: {
    label: 'Reply',
    section: 'Core',
    gmail: true, gmailImap: true, outlook: true, fastmail: true,
    icloud: true, yahoo: true, zoho: true, yandex: true, generic: true,
  },
  forward: {
    label: 'Forward',
    section: 'Core',
    gmail: true, gmailImap: true, outlook: true, fastmail: true,
    icloud: true, yahoo: true, zoho: true, yandex: true, generic: true,
  },
  // ── Flags & state ──────────────────────────────────────────────────────
  flags: {
    label: 'Read/unread + starred flags',
    section: 'Flags & state',
    gmail: true, gmailImap: true, outlook: true, fastmail: true,
    icloud: true, yahoo: true, zoho: true, yandex: true, generic: true,
  },
  // ── Folders & labels ───────────────────────────────────────────────────
  folders: {
    label: 'Folders',
    section: 'Folders & labels',
    // The Gmail API has labels and no folders at all. Gmail's IMAP server
    // presents those same labels as folders, so the app-password column
    // answers like every other IMAP one.
    gmail: false, gmailImap: true, outlook: true, fastmail: true,
    icloud: true, yahoo: true, zoho: true, yandex: true, generic: true,
  },
  labels: {
    label: 'Labels / tags',
    section: 'Folders & labels',
    // The mirror image of the row above: label tools are offered on the Gmail
    // API connector only. Over IMAP the same labels are reached as folders.
    // Outlook has folders (labels: false in PROVIDER_CAPABILITIES.outlook).
    gmail: true, gmailImap: false, outlook: false, fastmail: false,
    icloud: false, yahoo: false, zoho: false, yandex: false, generic: false,
  },
  move: {
    label: 'Move',
    section: 'Folders & labels',
    gmail: true, gmailImap: true, outlook: true, fastmail: true,
    icloud: true, yahoo: true, zoho: true, yandex: true, generic: true,
  },
  copy: {
    label: 'Copy',
    section: 'Folders & labels',
    // The Gmail API has no native copy. IMAP UID COPY does, on Gmail's hosts
    // as anywhere else, so the same mailbox copies over an app password.
    // Outlook copies with Graph messages/{id}/copy.
    gmail: false, gmailImap: true, outlook: true, fastmail: true,
    icloud: true, yahoo: true, zoho: true, yandex: true, generic: true,
  },
  // ── Delete ─────────────────────────────────────────────────────────────
  delete: {
    label: 'Delete / trash',
    section: 'Delete',
    gmail: true, gmailImap: true, outlook: true, fastmail: true,
    icloud: true, yahoo: true, zoho: true, yandex: true, generic: true,
  },
  permanent_delete: {
    label: 'Permanent delete (expunge)',
    section: 'Delete',
    // The Gmail API exposes trash only, with no direct expunge. The IMAP
    // connector offers both, and a Gmail mailbox on an app password is the
    // IMAP connector (trash_vs_expunge: 'both'). Outlook uses Graph
    // permanentDelete (outlook trash_vs_expunge: 'both').
    gmail: false, gmailImap: true, outlook: true, fastmail: true,
    icloud: true, yahoo: true, zoho: true, yandex: true, generic: true,
  },
  // ── Drafts ─────────────────────────────────────────────────────────────
  drafts: {
    label: 'Drafts (create / edit / send)',
    section: 'Drafts',
    gmail: true, gmailImap: true, outlook: true, fastmail: true,
    icloud: true, yahoo: true, zoho: true, yandex: true, generic: true,
  },
  // ── Contacts ───────────────────────────────────────────────────────────
  contacts_db: {
    label: 'Contact search (live scan)',
    section: 'Contacts',
    // contact_search does a live, header-only scan of recent mail for every
    // provider — nothing is stored between calls.
    gmail: true, gmailImap: true, outlook: true, fastmail: true,
    icloud: true, yahoo: true, zoho: true, yandex: true, generic: true,
  },
  // ── Scheduling ─────────────────────────────────────────────────────────
  scheduling: {
    label: 'Scheduled send',
    section: 'Scheduling',
    // Shipped via server-side scheduled_sends queue (Task 17-18) for all providers
    gmail: true, gmailImap: true, outlook: true, fastmail: true,
    icloud: true, yahoo: true, zoho: true, yandex: true, generic: true,
  },
  // ── Signatures ─────────────────────────────────────────────────────────
  signatures: {
    label: 'Signatures (auto-applied on send)',
    section: 'Signatures',
    // The signature is appended server-side on every send/reply/forward/draft/
    // scheduled message — works the same on every provider. Supports rich HTML
    // formatting and a hosted logo/image (https URLs; some clients image-block
    // by default). See providers.notes.signatures for the rendered copy.
    gmail: true, gmailImap: true, outlook: true, fastmail: true,
    icloud: true, yahoo: true, zoho: true, yandex: true, generic: true,
  },
  // ── Search syntax ──────────────────────────────────────────────────────
  search_syntax: {
    label: 'Search syntax',
    section: 'Search',
    // email_search takes Gmail's query language on the API connector, Microsoft
    // Graph KQL on Outlook (search_syntax: 'odata', built by toGraphSearch in
    // search-translate.ts), and IMAP SEARCH criteria on everything else, the
    // same Gmail mailbox over IMAP included.
    gmail: 'Gmail', gmailImap: 'IMAP', outlook: 'KQL', fastmail: 'IMAP',
    icloud: 'IMAP', yahoo: 'IMAP', zoho: 'IMAP', yandex: 'IMAP', generic: 'IMAP',
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * The name shown for a provider, in either table.
 *
 * Most rows are a brand name that is the same word in every locale, so they
 * carry it inline. A row whose name says something *about* the connection —
 * "Generic IMAP", and the two Gmail rows, which have to name which way in they
 * are — carries a message key instead, because that part is translated.
 */
function providerLabel(t, entry) {
  return entry.labelKey ? t(`providers.labels.${entry.labelKey}`) : entry.label;
}

function Check() {
  const t = useTranslations('docs');
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label={t('providers.ariaSupported')}>
      <circle cx="8" cy="8" r="8" fill="var(--mint-100)" />
      <path d="M4.5 8l2.5 2.5 4.5-5" stroke="var(--mint-600)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Cross() {
  const t = useTranslations('docs');
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label={t('providers.ariaNotSupported')}>
      <circle cx="8" cy="8" r="8" fill="var(--bg-sunken)" />
      <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="var(--fg-4)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function Planned() {
  const t = useTranslations('docs');
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, letterSpacing: '0.04em',
      padding: '2px 7px', borderRadius: 99,
      background: 'var(--amber-50)', color: 'var(--amber-700)',
      border: '1px solid rgba(217,119,6,0.2)',
      whiteSpace: 'nowrap',
    }}>
      {t('providers.plannedBadge')}
    </span>
  );
}

function Cell({ value }) {
  if (value === true)      return <td className="tbl-check"><Check /></td>;
  if (value === false)     return <td className="tbl-dash"><Cross /></td>;
  if (value === 'planned') return <td className="tbl-check"><Planned /></td>;
  // string value (e.g. search syntax)
  return (
    <td className="tbl-val" style={{ fontSize: 13 }}>
      <code style={{
        fontFamily: 'var(--font-mono)', fontSize: 12,
        background: 'var(--bg-sunken)', padding: '2px 6px', borderRadius: 4,
        color: 'var(--fg-2)',
      }}>
        {value}
      </code>
    </td>
  );
}

/**
 * One IMAP/SMTP cell: host on its own line, then port and transport security.
 *
 * A null endpoint means the row is not reached over IMAP at all:
 * the Gmail API row talks to gmail.googleapis.com and the Outlook row to
 * graph.microsoft.com. (The other Gmail row is ordinary IMAP and has hosts
 * like any other.) `unavailable` is kept for a row that is listed before it
 * can be connected; no row sets it today. A null host means the value is the
 * user's own.
 */
function Transport({ endpoint, unavailable }) {
  const t = useTranslations('docs');
  if (!endpoint) {
    return (
      <td className="tbl-val" style={{ fontSize: 13, color: 'var(--fg-3)' }}>
        {t(unavailable ? 'providers.connection.unavailable' : 'providers.connection.api')}
      </td>
    );
  }
  return (
    <td className="tbl-val" style={{ fontSize: 13 }}>
      <code style={{
        fontFamily: 'var(--font-mono)', fontSize: 12,
        color: 'var(--fg-1)', whiteSpace: 'nowrap',
      }}>
        {endpoint.host ?? t('providers.connection.varies')}
      </code>
      <div style={{ color: 'var(--fg-3)', fontSize: 12, marginTop: 3, whiteSpace: 'nowrap' }}>
        {endpoint.port} · {endpoint.security}
      </div>
    </td>
  );
}

// The "planned" legend entry only earns its place while some cell is still
// planned. Every cell shipped with the Outlook launch, and a legend for a mark
// the table never shows reads as a hint that something is missing.
const HAS_PLANNED = Object.values(MATRIX).some((row) =>
  PROVIDERS.some((p) => row[p.key] === 'planned'),
);

// ── Page ───────────────────────────────────────────────────────────────────

export default function ProvidersClient() {
  const t = useTranslations('docs');
  // Group rows by section for the section-head rows
  const sections = [];
  const seen = {};
  for (const [key, row] of Object.entries(MATRIX)) {
    if (!seen[row.section]) {
      seen[row.section] = true;
      sections.push({ section: row.section, rows: [] });
    }
    sections[sections.length - 1].rows.push({ key, ...row });
  }

  return (
    <div>
      <Nav />

      {/* Hero */}
      <section className="pricing-page-hero">
        <div className="container">
          <div className="eye-label">{t('providers.hero.eyebrow')}</div>
          <h1 className="pricing-page-h1">
            {t('providers.hero.heading')}
          </h1>
          <p className="pricing-page-lead">
            {t('providers.hero.lead')}
          </p>
          {/*
            The maintenance is the moat, so the date is on the page rather than
            in a comment. It lives in the message bundle
            (docs.providers.verified.date) so bumping it is one edit per locale.
          */}
          <p className="providers-verified" title={t('providers.verified.note')}>
            <span className="providers-verified-dot" aria-hidden="true" />
            {t('providers.verified.label')}: <b>{t('providers.verified.date')}</b>
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <a className="btn btn-primary btn-lg" href="/signup">{t('providers.hero.ctaConnect')}</a>
            <Link className="btn btn-secondary btn-lg" href="/docs">{t('providers.hero.ctaBack')}</Link>
          </div>
        </div>
      </section>

      {/* Connection settings */}
      <section className="section" style={{ paddingTop: 48, paddingBottom: 0 }}>
        <div className="container">
          <h2 className="providers-h2">{t('providers.connection.title')}</h2>
          <p className="providers-sub">{t('providers.connection.lead')}</p>

          <div className="comparison-wrap">
            <table className="comparison-tbl providers-conn-tbl">
              <thead>
                <tr>
                  <th className="feat-col" style={{ minWidth: 150 }}>{t('providers.connection.columns.provider')}</th>
                  <th style={{ minWidth: 130 }}>{t('providers.connection.columns.auth')}</th>
                  <th style={{ minWidth: 150 }}>{t('providers.connection.columns.imap')}</th>
                  <th style={{ minWidth: 150 }}>{t('providers.connection.columns.smtp')}</th>
                  <th style={{ minWidth: 300 }}>{t('providers.connection.columns.breaks')}</th>
                </tr>
              </thead>
              <tbody>
                {CONNECTION.map((row) => (
                  <tr key={row.key}>
                    <td className="feat-name">
                      {/*
                        Each row links to its own setup page, and every one of
                        those links back here. The pair is what makes this the
                        hub rather than another leaf.
                      */}
                      {row.href
                        ? <Link href={row.href}>{providerLabel(t, row)}</Link>
                        : providerLabel(t, row)}
                    </td>
                    <td className="tbl-val" style={{ fontSize: 13 }}>
                      {t(`providers.connection.auth.${row.auth}`)}
                    </td>
                    <Transport endpoint={row.imap} unavailable={row.unavailable} />
                    <Transport endpoint={row.smtp} unavailable={row.unavailable} />
                    <td className="tbl-val providers-breaks">
                      {t(`providers.connection.breaks.${row.key}`)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{
            marginTop: 24,
            display: 'flex', flexDirection: 'column', gap: 10,
            fontSize: 13, fontFamily: 'var(--font-sans)', color: 'var(--fg-3)', lineHeight: 1.6,
          }}>
            {/*
              The Gmail pair needs a sentence of its own: two rows for one
              brand reads like a mistake until you know that the product really
              does connect a Google mailbox two ways, and that the choice is
              what decides the capability columns further down.
            */}
            <p style={{ margin: 0 }}>{t.rich('providers.connection.notes.gmailTwoWays', RICH)}</p>
            <p style={{ margin: 0 }}>{t.rich('providers.connection.notes.autodetect', RICH)}</p>
            <p style={{ margin: 0 }}>{t.rich('providers.connection.notes.authMechanism', RICH)}</p>
            <p style={{ margin: 0 }}>{t.rich('providers.connection.notes.otherHosts', RICH)}</p>
          </div>
        </div>
      </section>

      {/* Legend */}
      <section className="section" style={{ paddingTop: 48, paddingBottom: 0 }}>
        <div className="container">
          <h2 className="providers-h2">{t('providers.capabilities.title')}</h2>
          <p className="providers-sub">{t('providers.capabilities.lead')}</p>
          <div style={{
            display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'center',
            fontSize: 13, fontFamily: 'var(--font-sans)', color: 'var(--fg-3)',
            marginBottom: 24,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Check /> {t('providers.legend.supported')}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Cross /> {t('providers.legend.notSupported')}</div>
            {HAS_PLANNED && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Planned /> {t('providers.legend.planned')}</div>
            )}
          </div>
          <p style={{
            fontSize: 13, fontFamily: 'var(--font-sans)', color: 'var(--fg-3)',
            lineHeight: 1.6, maxWidth: 760, marginBottom: 32,
          }}>
            {t.rich('providers.legend.imapNote', RICH)}
          </p>
          <div style={{
            maxWidth: 760, padding: '14px 16px', borderRadius: 10,
            border: '1px solid var(--border-1)', background: 'var(--bg-sunken)',
            fontSize: 13, fontFamily: 'var(--font-sans)', color: 'var(--fg-2)', lineHeight: 1.6,
          }}>
            <strong style={{ color: 'var(--fg-1)' }}>{t('providers.profiles.title')}</strong><br />
            {t.rich('providers.profiles.body', RICH)}
          </div>
        </div>
      </section>

      {/* Table */}
      <section className="section" style={{ paddingTop: 8, paddingBottom: 80 }}>
        <div className="container">
          <div className="comparison-wrap">
            <table className="comparison-tbl">
              <thead>
                <tr>
                  <th className="feat-col" style={{ minWidth: 200 }}>{t('providers.table.feature')}</th>
                  {PROVIDERS.map(p => (
                    <th key={p.key} style={{ minWidth: 90 }}>{providerLabel(t, p)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sections.map(({ section, rows }) => (
                  <Fragment key={section}>
                    <tr className="tbl-section-head">
                      <td colSpan={PROVIDERS.length + 1}>{t(`providers.sections.${section}`)}</td>
                    </tr>
                    {rows.map(row => (
                      <tr key={row.key}>
                        <td className="feat-name">{t(`providers.features.${row.key}`)}</td>
                        {PROVIDERS.map(p => (
                          <Cell key={p.key} value={row[p.key]} />
                        ))}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          {/* Notes */}
          <div style={{
            marginTop: 24,
            display: 'flex', flexDirection: 'column', gap: 10,
            fontSize: 13, fontFamily: 'var(--font-sans)', color: 'var(--fg-3)', lineHeight: 1.6,
          }}>
            <p style={{ margin: 0 }}>
              {t.rich('providers.notes.gmail', RICH)}
            </p>
            <p style={{ margin: 0 }}>
              {t.rich('providers.notes.outlook', RICH)}
            </p>
            <p style={{ margin: 0 }}>
              {t.rich('providers.notes.permanentDelete', RICH)}
            </p>
            <p style={{ margin: 0 }}>
              {t.rich('providers.notes.contacts_db', RICH)}
            </p>
            <p style={{ margin: 0 }}>
              {t.rich('providers.notes.scheduling', RICH)}
            </p>
            <p style={{ margin: 0 }}>
              {t.rich('providers.notes.signatures', RICH)}
            </p>
            <p style={{ margin: 0 }}>
              {t.rich('providers.notes.forward', RICH)}
            </p>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="pricing-cta-band">
        <div className="container">
          <h2 className="pricing-cta-h">{t('providers.cta.heading')}</h2>
          <p className="pricing-cta-sub">
            {t('providers.cta.sub')}
          </p>
          <div className="pricing-cta-btns">
            <a className="btn btn-primary btn-lg" href="/signup">{t('providers.cta.primary')}</a>
            <Link className="btn btn-on-dark btn-lg" href="/docs">{t('providers.cta.secondary')}</Link>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
