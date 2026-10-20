import { Link } from '@/i18n/navigation';
import { Nav, Footer } from './Sections';
import { MIcon } from '../MarketingPrimitives';
import { TABLE_ROWS, NOT_STATED, SOURCES } from '@/lib/compare/native-connectors.mjs';

/*
 * /native-connectors-vs-mcp. A server component: the copy arrives as `c` (one
 * locale of src/lib/compare/native-connectors/<locale>.json) so it renders into
 * the HTML of this page only, rather than riding along in the message payload
 * of every marketing page. `dates` are preformatted by the page for `locale`.
 *
 * The FAQ answers are always rendered. An accordion that only mounts an answer
 * after a click leaves crawlers and AI answer engines a list of questions with
 * nothing under them.
 */

const AXES = ['coverage', 'actions', 'portable'];
const COLUMNS = ['apps', 'provider', 'us'];

function Cell({ value, c }) {
  if (value === true) {
    return (
      <td className="tbl-check">
        <MIcon name="check" size={16} color="var(--mint-600)" />
      </td>
    );
  }
  if (value === false) {
    return <td className="tbl-dash"><span>–</span></td>;
  }
  const text = value === NOT_STATED ? c.table.notStated : c.table.values[value];
  return <td className="tbl-val">{text}</td>;
}

export default function CompareClient({ c, checkedOn, isEnglish }) {
  const fill = (s) => s.replace('{date}', checkedOn);

  return (
    <div>
      <Nav />

      {/* Hero */}
      <section className="pricing-page-hero">
        <div className="container">
          <div className="eye-label">{c.hero.eyebrow}</div>
          <h1 className="pricing-page-h1">
            {c.hero.titleLine1}<br />{c.hero.titleLine2}
          </h1>
          <p className="pricing-page-lead">{c.hero.lead}</p>
          <p className="pricing-footnote" style={{ textAlign: 'center', marginTop: 12 }}>
            {fill(c.hero.updated)}
          </p>
          <div className="hero-cta" style={{ justifyContent: 'center', marginTop: 24 }}>
            <a className="btn btn-primary btn-lg" href="/signup">{c.hero.ctaPrimary}</a>
            <Link className="btn btn-secondary btn-lg" href="/docs">{c.hero.ctaSecondary}</Link>
          </div>
        </div>
      </section>

      {/* The two kinds of "native", kept apart: see rule 3 in native-connectors.mjs. */}
      <section className="section" id="kinds" style={{ paddingBottom: 32 }}>
        <div className="container">
          <div className="section-head" style={{ marginBottom: 24 }}>
            <h2 style={{ fontSize: 36 }}>{c.kinds.title}</h2>
            <p className="sub">{c.kinds.sub}</p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
            {['apps', 'provider'].map((k) => (
              <div className="connect-callout" key={k} style={{ display: 'block' }}>
                <h3 style={{ margin: '0 0 6px', fontSize: 16 }}>{c.kinds[k].h}</h3>
                <p style={{ margin: 0, color: 'var(--fg-2)', fontSize: 14, lineHeight: 1.6 }}>{c.kinds[k].p}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Three differences that still hold */}
      <section className="section principles">
        <div className="container">
          <div className="section-head principles-head">
            <h2>{c.axes.title}</h2>
            <p className="sub">{c.axes.sub}</p>
          </div>
          <ol className="principle-list">
            {AXES.map((k, i) => (
              <li className="principle" key={k}>
                <div className="p-num">
                  <span className="n">{String(i + 1).padStart(2, '0')}</span>
                  <span className="t">{c.axes.items[k].tag}</span>
                </div>
                <div className="p-body">
                  <h3>{c.axes.items[k].h}</h3>
                  <p>{c.axes.items[k].p}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Comparison table */}
      <section className="section" id="compare" style={{ paddingTop: 64, paddingBottom: 80, background: 'var(--bg-page)' }}>
        <div className="container">
          <div className="section-head" style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 36 }}>{c.table.title}</h2>
          </div>
          <div className="comparison-wrap">
            {/* Fixed layout with even columns: the shared stylesheet sizes for a
                grid of ticks (a 40% label column, headers that never wrap), and
                here three of the columns hold sentences. The minimum width keeps
                cells readable on a phone, where .comparison-wrap scrolls. */}
            <table className="comparison-tbl" style={{ tableLayout: 'fixed', minWidth: 720 }}>
              <thead>
                <tr>
                  <th className="feat-col" style={{ width: '22%', whiteSpace: 'normal' }}>{c.table.featureCol}</th>
                  <th style={{ whiteSpace: 'normal' }}>{c.table.appsCol}</th>
                  <th style={{ whiteSpace: 'normal' }}>{c.table.providerCol}</th>
                  <th className="featured-col" style={{ whiteSpace: 'normal' }}>{c.table.usCol}</th>
                </tr>
              </thead>
              <tbody>
                {TABLE_ROWS.map((row) => (
                  <tr key={row.key}>
                    <td className="feat-name">{c.table.rows[row.key]}</td>
                    {COLUMNS.map((col) => <Cell key={col} value={row[col]} c={c} />)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="pricing-footnote" style={{ textAlign: 'center', marginTop: 20 }}>
            {fill(c.table.footnote)}
          </p>
        </div>
      </section>

      {/* FAQ, answers always in the HTML */}
      <section className="section" id="faq" style={{ background: 'var(--bg-page)' }}>
        <div className="container">
          <div className="section-head" style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 36 }}>{c.faq.title}</h2>
            <p className="sub">{c.faq.sub}</p>
          </div>
          <div className="faq-list">
            {c.faq.items.map((item) => (
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
      <section className="section" id="sources" style={{ paddingTop: 48, background: 'var(--bg-page)' }}>
        <div className="container">
          <div className="section-head" style={{ marginBottom: 20 }}>
            <h2 style={{ fontSize: 28 }}>{c.sources.title}</h2>
            <p className="sub">{fill(c.sources.sub)}</p>
          </div>
          <ul
            style={{
              margin: '0 auto',
              padding: 0,
              maxWidth: 760,
              listStyle: 'none',
              display: 'grid',
              gap: 10,
              fontSize: 13.5,
              lineHeight: 1.6,
              color: 'var(--fg-2)',
            }}
          >
            {SOURCES.map((s) => (
              <li key={s.id} style={{ overflowWrap: 'anywhere' }}>
                <span>{c.sources.items[s.id]}: </span>
                <a href={s.url} rel="nofollow noopener noreferrer" target="_blank">{s.url}</a>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/*
        Cross-link to the other comparison axis: this page answers "built-in
        connector or MCP", that one answers "which MCP email server". English
        only, because the target route 404s in every other locale.
      */}
      {isEnglish && (
        <section className="section" style={{ paddingTop: 0, background: 'var(--bg-page)' }}>
          <div className="container">
            <div className="connect-callout">
              <MIcon name="server" size={20} color="var(--cobalt-600)" />
              <div>
                <h2 style={{ margin: '0 0 6px', fontSize: 16 }}>{c.more.h}</h2>
                <p style={{ margin: '0 0 10px', color: 'var(--fg-2)', fontSize: 14, lineHeight: 1.6 }}>{c.more.p}</p>
                <Link
                  href="/best-email-mcp-servers"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 14,
                    fontWeight: 500,
                    color: 'var(--cobalt-600)',
                  }}
                >
                  {c.more.link}
                  <MIcon name="arrow" size={13} color="var(--cobalt-600)" />
                </Link>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* CTA band */}
      <section className="pricing-cta-band">
        <div className="container">
          <h2 className="pricing-cta-h">{c.ctaBand.title}</h2>
          <p className="pricing-cta-sub">{c.ctaBand.sub}</p>
          <div className="pricing-cta-btns">
            <a className="btn btn-primary btn-lg" href="/signup">{c.ctaBand.ctaPrimary}</a>
            <Link className="btn btn-on-dark btn-lg" href="/docs">{c.ctaBand.ctaSecondary}</Link>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
