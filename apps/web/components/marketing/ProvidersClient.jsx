'use client';

import { Nav, Footer } from './Sections';

// ---------------------------------------------------------------------------
// Capability data — mirrors PROVIDER_CAPABILITIES in
// supabase/functions/mcp-server/index.ts and Documents/provider-support.md.
// Keep these three sources in sync whenever the matrix changes.
// ---------------------------------------------------------------------------

const PROVIDERS = [
  { key: 'gmail',    label: 'Gmail' },
  { key: 'outlook',  label: 'Outlook' },
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
  contacts: {
    label: 'Contacts API',
    section: 'Contacts',
    gmail: true, outlook: true, fastmail: false,
    icloud: false, yahoo: false, zoho: false, yandex: false, generic: false,
  },
  // ── Scheduling ─────────────────────────────────────────────────────────
  scheduling: {
    label: 'Scheduled send',
    section: 'Scheduling',
    gmail: 'planned', outlook: 'planned', fastmail: 'planned',
    icloud: 'planned', yahoo: 'planned', zoho: 'planned', yandex: 'planned', generic: 'planned',
  },
  // ── Search syntax ──────────────────────────────────────────────────────
  search_syntax: {
    label: 'Search syntax',
    section: 'Search',
    gmail: 'Gmail', outlook: 'OData', fastmail: 'JMAP',
    icloud: 'IMAP', yahoo: 'IMAP', zoho: 'IMAP', yandex: 'IMAP', generic: 'IMAP',
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────

function Check() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label="Supported">
      <circle cx="8" cy="8" r="8" fill="var(--mint-100)" />
      <path d="M4.5 8l2.5 2.5 4.5-5" stroke="var(--mint-600)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Cross() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label="Not supported">
      <circle cx="8" cy="8" r="8" fill="var(--bg-sunken)" />
      <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="var(--fg-4)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function Planned() {
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, letterSpacing: '0.04em',
      padding: '2px 7px', borderRadius: 99,
      background: 'var(--amber-50)', color: 'var(--amber-700)',
      border: '1px solid rgba(217,119,6,0.2)',
      whiteSpace: 'nowrap',
    }}>
      planned
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
          <div className="eye-label">Provider support</div>
          <h1 className="pricing-page-h1">
            What works, per provider.
          </h1>
          <p className="pricing-page-lead">
            MCPEmails connects Gmail, Outlook, Fastmail, and any IMAP inbox (iCloud,
            Yahoo, Zoho, Yandex, generic). Not every provider exposes the same APIs —
            this table shows exactly what each one supports today.
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <a className="btn btn-primary btn-lg" href="/signup">Connect an inbox</a>
            <a className="btn btn-secondary btn-lg" href="/docs">Back to docs</a>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Check /> Supported</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Cross /> Not supported</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Planned /> Planned (not yet shipped)</div>
          </div>
          <p style={{
            fontSize: 13, fontFamily: 'var(--font-sans)', color: 'var(--fg-3)',
            lineHeight: 1.6, maxWidth: 760, marginBottom: 32,
          }}>
            <strong style={{ color: 'var(--fg-2)' }}>iCloud, Yahoo, Zoho, Yandex, and Generic IMAP</strong>{' '}
            all run through the same Deno IMAP/SMTP transport and share identical
            capabilities. The columns are shown separately for clarity but their
            feature set is identical.
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
                  <th className="feat-col" style={{ minWidth: 200 }}>Feature</th>
                  {PROVIDERS.map(p => (
                    <th key={p.key} style={{ minWidth: 90 }}>{p.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sections.map(({ section, rows }) => (
                  <>
                    <tr key={'section-' + section} className="tbl-section-head">
                      <td colSpan={PROVIDERS.length + 1}>{section}</td>
                    </tr>
                    {rows.map(row => (
                      <tr key={row.key}>
                        <td className="feat-name">{row.label}</td>
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
              <strong style={{ color: 'var(--fg-2)' }}>Gmail — folders vs labels:</strong>{' '}
              Gmail uses a flat label system rather than hierarchical folders.
              "Move" is implemented as label add/remove. Native copy is not available via the Gmail REST API.
            </p>
            <p style={{ margin: 0 }}>
              <strong style={{ color: 'var(--fg-2)' }}>Permanent delete:</strong>{' '}
              Gmail and Outlook move to Trash when you delete — permanent expunge is not exposed by their APIs.
              IMAP providers (Fastmail, iCloud, Yahoo, Zoho, Yandex, Generic) support both trash and hard expunge.
            </p>
            <p style={{ margin: 0 }}>
              <strong style={{ color: 'var(--fg-2)' }}>Contacts API:</strong>{' '}
              Gmail uses the Google People API; Outlook uses Microsoft Graph{' '}
              <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--bg-sunken)', padding: '1px 5px', borderRadius: 4 }}>/contacts</code>.
              Fastmail CardDAV and IMAP-based contacts are deferred to a later release.
            </p>
            <p style={{ margin: 0 }}>
              <strong style={{ color: 'var(--fg-2)' }}>Scheduling:</strong>{' '}
              Planned for all providers via a server-side queue (not provider-native scheduling). No provider exposes a native scheduled-send API that is accessible without storing credentials server-side.
            </p>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="pricing-cta-band">
        <div className="container">
          <h2 className="pricing-cta-h">Ready to connect your inbox?</h2>
          <p className="pricing-cta-sub">
            Free plan: unlimited connections, no card required.
          </p>
          <div className="pricing-cta-btns">
            <a className="btn btn-primary btn-lg" href="/signup">Get started free</a>
            <a className="btn btn-on-dark btn-lg" href="/docs">Read the docs</a>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
