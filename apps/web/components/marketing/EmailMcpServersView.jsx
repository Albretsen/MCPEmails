import { Link } from '@/i18n/navigation';
import { Nav, Footer } from './Sections';
import { MIcon } from '../MarketingPrimitives';
import RichText from './RichText';
import * as C from '@/lib/compare/email-mcp-servers.mjs';

/**
 * /email-mcp-servers-compared, rendered entirely on the server.
 *
 * Server-rendered on purpose, the same reason ConnectProviderView is: there is
 * no state, no effects and no handlers here, and `'use client'` would force the
 * copy into a next-intl namespace, which the root layout serialises into every
 * marketing page. Nav and Footer are the only things that hydrate.
 *
 * The copy and every sourced fact live in src/lib/compare/email-mcp-servers.mjs.
 * Read the editing rules at the top of that file before changing a claim.
 */

/*
 * marketing.css tints `tbody td:nth-child(4)` blue, because on /pricing the
 * fourth cell is the highlighted plan. This table's highlighted column is the
 * second one, so that rule would put the emphasis on a competitor. Every cell
 * therefore states its own background inline, which beats the stylesheet rule
 * in both directions: tint on ours, nothing on theirs.
 */
const FEATURED_TINT = 'rgba(37, 71, 229, 0.03)';

/** One table cell: booleans render as a tick or a dash, strings render as text. */
function Cell({ value, featured, muted }) {
  const shared = { backgroundColor: featured ? FEATURED_TINT : 'transparent' };

  if (value === true) {
    return (
      <td className="tbl-check" style={shared}>
        <MIcon name="check" size={16} color="var(--mint-600)" />
      </td>
    );
  }
  if (value === false) {
    return <td className="tbl-dash" style={shared}><span>–</span></td>;
  }
  const isNotStated = value === C.NOT_STATED;
  return (
    <td
      className="tbl-val"
      style={{
        ...shared,
        fontSize: 13.5,
        lineHeight: 1.55,
        textAlign: 'left',
        verticalAlign: 'top',
        color: isNotStated || muted ? 'var(--fg-3)' : undefined,
        fontStyle: isNotStated ? 'italic' : undefined,
      }}
    >
      {value}
    </td>
  );
}

export default function EmailMcpServersView() {
  return (
    <div>
      <Nav />

      {/* Hero */}
      <section className="pricing-page-hero">
        <div className="container">
          <div className="eye-label">{C.hero.eyebrow}</div>
          <h1 className="pricing-page-h1">
            {C.hero.titleLine1}<br />{C.hero.titleLine2}
          </h1>
          <p className="pricing-page-lead">{C.hero.lead}</p>
          {/* The quotable paragraph. Search and assistant answers pull from
              here, so it has to answer the question outright rather than tease. */}
          <p className="pricing-page-answer">{C.hero.answer}</p>
          <div className="hero-cta" style={{ justifyContent: 'center', marginTop: 24 }}>
            <a className="btn btn-primary btn-lg" href="/signup">{C.ctaBand.ctaPrimary}</a>
            <Link className="btn btn-secondary btn-lg" href="/pricing">See our pricing</Link>
          </div>
          <div className="hero-meta" style={{ justifyContent: 'center' }}>
            {[C.hero.meta0, C.hero.meta1, C.hero.meta2].map((m) => (
              <span className="item" key={m}>
                <MIcon name="check" size={14} color="var(--mint-600)" /> {m}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* Method: stated before the table, because the method is the point. */}
      <section className="section" style={{ paddingTop: 56, paddingBottom: 0 }}>
        <div className="container">
          <div className="connect-callout">
            <MIcon name="shield" size={20} color="var(--cobalt-600)" />
            <div>
              <h2 style={{ margin: '0 0 6px', fontSize: 16 }}>{C.method.title}</h2>
              <p style={{ margin: 0, color: 'var(--fg-2)', fontSize: 14, lineHeight: 1.6 }}>
                <RichText>{C.method.body}</RichText>
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* The table */}
      <section
        className="section"
        id="compare"
        style={{ paddingTop: 48, paddingBottom: 72, background: 'var(--bg-page)' }}
      >
        <div className="container">
          <h2 className="providers-h2">Side by side</h2>
          <p className="providers-sub">
            Hosted services, an agent tool platform, and running it yourself.
          </p>
          <div className="comparison-wrap">
            <table className="comparison-tbl">
              <thead>
                <tr>
                  <th className="feat-col" style={{ minWidth: 190 }}>Capability</th>
                  {C.columns.map((col) => (
                    <th
                      key={col.key}
                      className={col.featured ? 'featured-col' : undefined}
                      style={{ minWidth: 190 }}
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {C.rows.map((row) => (
                  <tr key={row.label}>
                    <td
                      className="feat-name"
                      style={{ verticalAlign: 'top', backgroundColor: 'transparent' }}
                    >
                      {row.label}
                    </td>
                    {C.columns.map((col) => (
                      <Cell
                        key={col.key}
                        value={row[col.key]}
                        featured={col.featured}
                        muted={col.key === 'selfhosted'}
                      />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="pricing-footnote" style={{ marginTop: 20 }}>{C.tableFootnote}</p>
        </div>
      </section>

      {/* Where the alternatives win. Deliberately before our own pitch. */}
      <section className="section principles">
        <div className="container">
          <div className="section-head principles-head">
            <div className="eye-label">{C.theyWin.eyebrow}</div>
            <h2>{C.theyWin.title}</h2>
            <p className="sub">{C.theyWin.sub}</p>
          </div>
          <ol className="principle-list">
            {C.theyWin.items.map((item, i) => (
              <li className="principle" key={item.h}>
                <div className="p-num">
                  <span className="n">{String(i + 1).padStart(2, '0')}</span>
                  <span className="t">{item.tag}</span>
                </div>
                <div className="p-body">
                  <h3>{item.h}</h3>
                  <p><RichText>{item.p}</RichText></p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* What we are actually for. */}
      <section className="section principles" style={{ background: 'var(--bg-page)' }}>
        <div className="container">
          <div className="section-head principles-head">
            <div className="eye-label">{C.weWin.eyebrow}</div>
            <h2>{C.weWin.title}</h2>
            <p className="sub">{C.weWin.sub}</p>
          </div>
          <ol className="principle-list">
            {C.weWin.items.map((item, i) => (
              <li className="principle" key={item.h}>
                <div className="p-num">
                  <span className="n">{String(i + 1).padStart(2, '0')}</span>
                  <span className="t">{item.tag}</span>
                </div>
                <div className="p-body">
                  <h3>{item.h}</h3>
                  <p><RichText>{item.p}</RichText></p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Per-product profiles */}
      <section className="section">
        <div className="container">
          <div className="section-head" style={{ marginBottom: 32 }}>
            <div className="eye-label">{C.profiles.eyebrow}</div>
            <h2 style={{ fontSize: 36 }}>{C.profiles.title}</h2>
          </div>
          {/* Inline grid rather than a new marketing.css class: auto-fit with a
              minmax track is responsive without a media query, and this page is
              the only thing that would use the class. */}
          <div
            style={{
              display: 'grid',
              gap: 20,
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))',
            }}
          >
            {C.profiles.items.map((p) => (
              <article
                key={p.name}
                style={{
                  border: '1px solid var(--border-1)',
                  borderRadius: 12,
                  padding: 24,
                  background: 'var(--bg-surface)',
                }}
              >
                <h3 style={{ margin: '0 0 8px', fontSize: 18 }}>
                  {/*
                    rel="nofollow" on every competitor link. These are citations,
                    not endorsements, and a comparison page that passes link
                    equity to the four products it is competing with is a
                    slightly unusual way to run a business.
                  */}
                  <a href={p.url} rel="nofollow noopener noreferrer" target="_blank">{p.name}</a>
                </h3>
                <p style={{ margin: '0 0 10px', color: 'var(--fg-2)', fontSize: 14, lineHeight: 1.65 }}>
                  {p.blurb}
                </p>
                <p style={{ margin: 0, color: 'var(--fg-1)', fontSize: 14, lineHeight: 1.65 }}>
                  <strong>{p.bestIf}</strong>
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* Native connectors: corrected, then handed off to the sibling page. */}
      <section className="section" style={{ paddingTop: 0 }}>
        <div className="container">
          <div className="connect-callout">
            <MIcon name="mail" size={20} color="var(--cobalt-600)" />
            <div>
              <h2 style={{ margin: '0 0 6px', fontSize: 16 }}>{C.nativeNote.title}</h2>
              <p style={{ margin: '0 0 10px', color: 'var(--fg-2)', fontSize: 14, lineHeight: 1.6 }}>
                {C.nativeNote.body}
              </p>
              <Link
                href="/native-connectors-vs-mcp"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 14,
                  fontWeight: 500,
                  color: 'var(--cobalt-600)',
                }}
              >
                {C.nativeNote.linkLabel} <MIcon name="arrow" size={13} color="var(--cobalt-600)" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ. Static markup, not the accordion: this page is server-rendered,
          and every answer here is something we want indexed and quotable. */}
      <section className="section" id="faq" style={{ background: 'var(--bg-page)' }}>
        <div className="container">
          <div className="section-head" style={{ marginBottom: 32 }}>
            <div className="eye-label">{C.faq.eyebrow}</div>
            <h2 style={{ fontSize: 36 }}>{C.faq.title}</h2>
            <p className="sub">{C.faq.sub}</p>
          </div>
          <div className="faq-list">
            {C.faq.items.map((item) => (
              <div className="faq-item" key={item.q}>
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
                  {item.q}
                </h3>
                <div className="faq-a">{item.a}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Sources. Printed, not merely tracked. */}
      <section className="section" id="sources" style={{ paddingTop: 56 }}>
        <div className="container">
          <h2 className="providers-h2">{C.SOURCES.title}</h2>
          <p className="providers-sub">{C.SOURCES.sub}</p>
          <ul
            style={{
              margin: 0,
              padding: 0,
              listStyle: 'none',
              display: 'grid',
              gap: 10,
              fontSize: 13.5,
              lineHeight: 1.6,
              color: 'var(--fg-2)',
            }}
          >
            {C.SOURCES.items.map((s) => (
              <li key={s.url} style={{ overflowWrap: 'anywhere' }}>
                <span>{s.label}: </span>
                <a href={s.url} rel="nofollow noopener noreferrer" target="_blank">{s.url}</a>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* CTA band */}
      <section className="pricing-cta-band">
        <div className="container">
          <h2 className="pricing-cta-h">{C.ctaBand.title}</h2>
          <p className="pricing-cta-sub">{C.ctaBand.sub}</p>
          <div className="pricing-cta-btns">
            <a className="btn btn-primary btn-lg" href="/signup">{C.ctaBand.ctaPrimary}</a>
            <Link className="btn btn-on-dark btn-lg" href="/docs">{C.ctaBand.ctaSecondary}</Link>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
