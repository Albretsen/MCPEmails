import { Link } from '@/i18n/navigation';
import { Nav, Footer } from './Sections';
import { MIcon } from '../MarketingPrimitives';
import { datasetRows, FIELD_DOCS } from '@/lib/connect/provider-dataset.mjs';
import { datasetCopy } from '../../app/[locale]/docs/providers/data/content.mjs';

/**
 * /docs/providers/data, rendered entirely on the server (no state, no effects;
 * see EmailMcpServersView for why that matters for bundle size). Layout follows
 * the same single-left-edge rules as that page: prose at COL, the table alone
 * at full container width.
 */
const COL = 820;

const mono = { fontFamily: 'var(--font-mono)', fontSize: 12.5 };
const cell = { verticalAlign: 'top', backgroundColor: 'transparent', textAlign: 'left' };

function list(v, fallback) {
  if (v == null) return <span style={{ color: 'var(--fg-3)' }}>{fallback}</span>;
  return <span style={mono}>{v.join(' ')}</span>;
}

function endpoint(host, port, security) {
  if (!host) return <span style={{ color: 'var(--fg-3)' }}>–</span>;
  return (
    <span style={mono}>
      {host}:{port}
      <span style={{ color: 'var(--fg-3)' }}> {security}</span>
    </span>
  );
}

export default function ProviderDatasetView() {
  const C = datasetCopy();
  const rows = datasetRows();
  const T = C.table;

  return (
    <div>
      <Nav />

      <section className="pricing-page-hero">
        <div className="container">
          <div className="eye-label">{C.hero.eyebrow}</div>
          <h1 className="pricing-page-h1" style={{ maxWidth: COL }}>{C.hero.title}</h1>
          <p className="pricing-page-lead">{C.hero.lead}</p>
          <div className="hero-cta">
            <a className="btn btn-primary btn-lg" href={C.paths.json} download>{C.hero.json}</a>
            <a className="btn btn-secondary btn-lg" href={C.paths.csv} download>{C.hero.csv}</a>
          </div>
          <div className="hero-meta" style={{ flexWrap: 'wrap', rowGap: 8 }}>
            {C.hero.meta.map((m) => (
              <span className="item" key={m}>
                <MIcon name="check" size={14} color="var(--mint-600)" /> {m}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section className="section" id="findings" style={{ paddingTop: 48, paddingBottom: 24 }}>
        <div className="container">
          <h2 className="providers-h2">{C.findings.title}</h2>
          <div className="faq-list" style={{ maxWidth: COL }}>
            {C.findings.items.map((f) => (
              <div className="faq-item" key={f.h}>
                <h3
                  style={{
                    margin: 0,
                    padding: '20px 0 8px',
                    fontFamily: 'var(--font-sans)',
                    fontSize: 16,
                    fontWeight: 500,
                    color: 'var(--fg-1)',
                  }}
                >
                  {f.h}
                </h3>
                <div className="faq-a" style={{ maxWidth: '100%' }}>{f.p}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section
        className="section"
        id="table"
        style={{ paddingTop: 48, paddingBottom: 64, background: 'var(--bg-page)' }}
      >
        <div className="container">
          <h2 className="providers-h2">{T.title}</h2>
          <p className="providers-sub">{T.sub}</p>
          <div className="comparison-wrap">
            <table className="comparison-tbl">
              <thead>
                <tr>
                  <th className="feat-col" style={{ minWidth: 160 }}>{T.cols.provider}</th>
                  <th style={{ minWidth: 220, textAlign: 'left' }}>{T.cols.imap}</th>
                  <th style={{ minWidth: 150, textAlign: 'left' }}>{T.cols.imapAuth}</th>
                  <th style={{ minWidth: 70, textAlign: 'left' }}>{T.cols.saslIr}</th>
                  <th style={{ minWidth: 220, textAlign: 'left' }}>{T.cols.smtp}</th>
                  <th style={{ minWidth: 130, textAlign: 'left' }}>{T.cols.smtpAuth}</th>
                  <th style={{ minWidth: 80, textAlign: 'left' }}>{T.cols.size}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.slug} id={r.slug}>
                    <td className="feat-name" style={cell}>
                      <Link href={r.page}>{r.name}</Link>
                    </td>
                    <td style={cell}>{endpoint(r.imapHost, r.imapPort, r.imapSecurity)}</td>
                    <td style={cell}>{list(r.imapAuth, '–')}</td>
                    <td style={cell}>{r.saslIr ? T.yes : T.no}</td>
                    <td style={cell}>{endpoint(r.smtpHost, r.smtpPort, r.smtpSecurity)}</td>
                    <td style={cell}>{r.smtpHost ? list(r.smtpAuth, T.notVisible) : '–'}</td>
                    <td style={cell}>{r.smtpMaxSizeMb == null ? '–' : `${r.smtpMaxSizeMb} MB`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="section" id="method" style={{ paddingTop: 56, paddingBottom: 24 }}>
        <div className="container">
          <h2 className="providers-h2">{C.method.title}</h2>
          <ul style={{ maxWidth: COL, paddingLeft: 20, lineHeight: 1.7, color: 'var(--fg-2)' }}>
            {C.method.items.map((m) => <li key={m} style={{ marginBottom: 8 }}>{m}</li>)}
          </ul>
          <p style={{ maxWidth: COL, color: 'var(--fg-2)' }}>
            <Link href="/docs/providers">{C.links.matrix}</Link>
            {' · '}
            <Link href="/connect">{C.links.connect}</Link>
          </p>
        </div>
      </section>

      <section className="section" id="fields" style={{ paddingTop: 32, paddingBottom: 24 }}>
        <div className="container">
          <h2 className="providers-h2">{C.fields.title}</h2>
          <p className="providers-sub">{C.fields.sub}</p>
          <dl style={{ maxWidth: COL, display: 'grid', gridTemplateColumns: 'minmax(120px, max-content) 1fr', gap: '6px 20px', color: 'var(--fg-2)' }}>
            {FIELD_DOCS.map((f) => (
              <div key={f.key} style={{ display: 'contents' }}>
                <dt style={mono}>{f.key}</dt>
                <dd style={{ margin: 0 }}>{f.doc}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="section" id="cite" style={{ paddingTop: 32, paddingBottom: 64 }}>
        <div className="container">
          <h2 className="providers-h2">{C.cite.title}</h2>
          <p style={{ maxWidth: COL, color: 'var(--fg-2)' }}>
            {C.cite.body}{' '}
            <a href={C.paths.license} rel="license">CC BY 4.0</a>
          </p>
          <pre style={{ ...mono, maxWidth: COL, whiteSpace: 'pre-wrap', padding: 16, borderRadius: 8, background: 'var(--bg-page)', color: 'var(--fg-1)' }}>
            {C.cite.citation}
          </pre>
        </div>
      </section>

      <section className="pricing-cta-band">
        <div className="container">
          <h2 className="pricing-cta-h">{C.cta.title}</h2>
          <p className="pricing-cta-sub">{C.cta.sub}</p>
          <div className="pricing-cta-btns">
            <a className="btn btn-primary btn-lg" href="/signup">{C.cta.primary}</a>
            <Link className="btn btn-on-dark btn-lg" href="/docs">{C.cta.secondary}</Link>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
