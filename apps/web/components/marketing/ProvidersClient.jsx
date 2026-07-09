'use client';

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
// supabase/functions/mcp-server/index.ts and Documents/provider-support.md.
// Keep these three sources in sync whenever the matrix changes.
// ---------------------------------------------------------------------------

const PROVIDERS = [
  { key: 'gmail',    label: 'Gmail' },
  { key: 'fastmail', label: 'Fastmail' },
  // iCloud, Yahoo, Zoho, Yandex, and Generic IMAP all use provider='imap'
  // in the DB and share the same capability set.
  { key: 'icloud',   label: 'iCloud' },
  { key: 'yahoo',    label: 'Yahoo' },
  { key: 'zoho',     label: 'Zoho' },
  { key: 'yandex',   label: 'Yandex' },
  { key: 'generic',  label: 'Generic IMAP' },
];

// true  = supported
// false = not supported
// 'planned' = on the roadmap, not yet shipped
// string    = informational value (e.g. search syntax name)

const MATRIX = {
  // ── Core read/write ────────────────────────────────────────────────────
  read: {
    label: 'Read email',
    section: 'Core',
    gmail: true, outlook: true, fastmail: true,
    icloud: true, yahoo: true, zoho: true, yandex: true, generic: true,
  },
  search: {
    label: 'Search',
    section: 'Core',
    gmail: true, outlook: true, fastmail: true,
    icloud: true, yahoo: true, zoho: true, yandex: true, generic: true,
  },
  send: {
    label: 'Send email',
    section: 'Core',
    gmail: true, outlook: true, fastmail: true,
    icloud: true, yahoo: true, zoho: true, yandex: true, generic: true,
  },
  reply: {
    label: 'Reply',
    section: 'Core',
    gmail: true, outlook: true, fastmail: true,
    icloud: true, yahoo: true, zoho: true, yandex: true, generic: true,
  },
  forward: {
    label: 'Forward',
    section: 'Core',
    gmail: true, outlook: true, fastmail: true,
    icloud: true, yahoo: true, zoho: true, yandex: true, generic: true,
  },
  // ── Flags & state ──────────────────────────────────────────────────────
  flags: {
    label: 'Read/unread + starred flags',
    section: 'Flags & state',
    gmail: true, outlook: true, fastmail: true,
    icloud: true, yahoo: true, zoho: true, yandex: true, generic: true,
  },
  // ── Folders & labels ───────────────────────────────────────────────────
  folders: {
    label: 'Folders',
    section: 'Folders & labels',
    // Gmail uses labels, not folders
    gmail: false, outlook: true, fastmail: true,
    icloud: true, yahoo: true, zoho: true, yandex: true, generic: true,
  },
  labels: {
    label: 'Labels / tags',
    section: 'Folders & labels',
    gmail: true, outlook: false, fastmail: false,
    icloud: false, yahoo: false, zoho: false, yandex: false, generic: false,
  },
  move: {
    label: 'Move',
    section: 'Folders & labels',
    gmail: true, outlook: true, fastmail: true,
    icloud: true, yahoo: true, zoho: true, yandex: true, generic: true,
  },
  copy: {
    label: 'Copy',
    section: 'Folders & labels',
    // Gmail API has no native copy
    gmail: false, outlook: true, fastmail: true,
    icloud: true, yahoo: true, zoho: true, yandex: true, generic: true,
  },
  // ── Delete ─────────────────────────────────────────────────────────────
  delete: {
    label: 'Delete / trash',
    section: 'Delete',
    gmail: true, outlook: true, fastmail: true,
    icloud: true, yahoo: true, zoho: true, yandex: true, generic: true,
  },
  permanent_delete: {
    label: 'Permanent delete (expunge)',
    section: 'Delete',
    // Gmail and Outlook support trash only (no direct expunge via API)
    gmail: false, outlook: false, fastmail: true,
    icloud: true, yahoo: true, zoho: true, yandex: true, generic: true,
  },
  // ── Drafts ─────────────────────────────────────────────────────────────
  drafts: {
    label: 'Drafts (create / edit / send)',
    section: 'Drafts',
    gmail: true, outlook: true, fastmail: true,
    icloud: true, yahoo: true, zoho: true, yandex: true, generic: true,
  },
  // ── Contacts ───────────────────────────────────────────────────────────
  contacts_db: {
    label: 'Contact search (live scan)',
    section: 'Contacts',
    // contact_search does a live, header-only scan of recent mail for every
    // provider — nothing is stored between calls.
    gmail: true, outlook: true, fastmail: true,
    icloud: true, yahoo: true, zoho: true, yandex: true, generic: true,
  },
  // ── Scheduling ─────────────────────────────────────────────────────────
  scheduling: {
    label: 'Scheduled send',
    section: 'Scheduling',
    // Shipped via server-side scheduled_sends queue (Task 17-18) for all providers
    gmail: true, outlook: true, fastmail: true,
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
    gmail: true, outlook: true, fastmail: true,
    icloud: true, yahoo: true, zoho: true, yandex: true, generic: true,
  },
  // ── Search syntax ──────────────────────────────────────────────────────
  search_syntax: {
    label: 'Search syntax',
    section: 'Search',
    gmail: 'Gmail', outlook: 'OData', fastmail: 'IMAP',
    icloud: 'IMAP', yahoo: 'IMAP', zoho: 'IMAP', yandex: 'IMAP', generic: 'IMAP',
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────

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
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <a className="btn btn-primary btn-lg" href="/signup">{t('providers.hero.ctaConnect')}</a>
            <Link className="btn btn-secondary btn-lg" href="/docs">{t('providers.hero.ctaBack')}</Link>
          </div>
        </div>
      </section>

      {/* Legend */}
      <section className="section" style={{ paddingTop: 48, paddingBottom: 0 }}>
        <div className="container">
          <div style={{
            display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'center',
            fontSize: 13, fontFamily: 'var(--font-sans)', color: 'var(--fg-3)',
            marginBottom: 24,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Check /> {t('providers.legend.supported')}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Cross /> {t('providers.legend.notSupported')}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Planned /> {t('providers.legend.planned')}</div>
          </div>
          <p style={{
            fontSize: 13, fontFamily: 'var(--font-sans)', color: 'var(--fg-3)',
            lineHeight: 1.6, maxWidth: 760, marginBottom: 32,
          }}>
            {t.rich('providers.legend.imapNote', RICH)}
          </p>
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
                    <th key={p.key} style={{ minWidth: 90 }}>{p.key === 'generic' ? t('providers.labels.generic') : p.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sections.map(({ section, rows }) => (
                  <>
                    <tr key={'section-' + section} className="tbl-section-head">
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
                  </>
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
