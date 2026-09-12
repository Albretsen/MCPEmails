import { Link } from '@/i18n/navigation';
import { Nav, Footer } from './Sections';
import { MIcon } from '../MarketingPrimitives';
import * as C from '@/lib/compare/email-mcp-servers.mjs';

/**
 * /best-email-mcp-servers, rendered entirely on the server.
 *
 * Server-rendered on purpose, the same reason ConnectProviderView is: there is
 * no state, no effects and no handlers here, and `'use client'` would force the
 * copy into a next-intl namespace, which the root layout serialises into every
 * marketing page. Nav and Footer are the only things that hydrate.
 *
 * The copy and every sourced fact live in src/lib/compare/email-mcp-servers.mjs.
 * Read the editing rules at the top of that file before changing a claim, and
 * rule 6 before adding a paragraph.
 *
 * ---------------------------------------------------------------------------
 * LAYOUT RULES, learned the hard way on 12 September 2026
 * ---------------------------------------------------------------------------
 * Everything on this page hangs off ONE left edge, the container's, and nothing
 * is centred except the shared CTA band at the foot. Two specific mistakes made
 * the first version of this page look like three pages stacked up, and both are
 * easy to reintroduce:
 *
 *  - `.hero-cta` and `.hero-meta` are flex rows that several other marketing
 *    pages override with `justifyContent: 'center'` while leaving the h1 and
 *    lead above them left-aligned. That override is copied from page to page
 *    and it is wrong every time: it puts the buttons on a different axis from
 *    the heading they belong to. Do not add it back here.
 *
 *  - `.connect-callout` carries `max-width: 720px; margin: 0 auto`, so it
 *    centres itself regardless of what it sits under. Dropping one inside a
 *    left-aligned column produces a narrower box floating under a wider box.
 *    This page therefore uses no callout: the ranking method is plain text with
 *    a rule down its left edge, at the same measure as everything else.
 *
 * `COL` is that measure. marketing.css puts prose at 720-760px
 * (.section-head, .faq-list, .providers-sub) and reserves the full 1136px
 * container for tables and card grids. The ranked cards are cards, but their
 * content is prose, so they sit at COL and the comparison table alone runs
 * full width.
 *
 * Heading structure is load-bearing for this page's job: one H1, an H2 per
 * section, and an H3 per ranked entry carrying the product name. The entry
 * order here, the order in `C.entries`, and the ItemList in page.js are the
 * same order, because a ranked list whose structured data disagrees with its
 * own prose is worse than no structured data.
 */

/** The single reading measure every block on this page shares. */
const COL = 820;

/*
 * marketing.css tints `tbody td:nth-child(4)` blue, because on /pricing the
 * fourth cell is the highlighted plan. This table's highlighted column is the
 * second one, so that rule would put the emphasis on a competitor. Every cell
 * therefore states its own background inline, which beats the stylesheet rule
 * in both directions: tint on ours, nothing on theirs.
 */
const FEATURED_TINT = 'rgba(37, 71, 229, 0.03)';

/*
 * Visually hidden, still announced. Inline rather than a `.sr-only` class
 * because this stylesheet has no such class and one page is not a reason to
 * add a global; if a second page needs it, promote this to marketing.css.
 */
const VISUALLY_HIDDEN = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

/**
 * One table cell: booleans render as a tick or a dash, strings render as text.
 *
 * `.tbl-check`, `.tbl-dash` and `.tbl-val` are all centred by marketing.css,
 * which suits /pricing where every cell is a glyph. Here most cells are
 * sentences, so a centred tick in a column of left-aligned prose sits on its
 * own axis. Every cell type is therefore forced left, and the headers with
 * them, so the table has exactly one alignment.
 */
function Cell({ value, featured, muted }) {
  const shared = {
    backgroundColor: featured ? FEATURED_TINT : 'transparent',
    textAlign: 'left',
    verticalAlign: 'top',
  };

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
        color: isNotStated || muted ? 'var(--fg-3)' : undefined,
        fontStyle: isNotStated ? 'italic' : undefined,
      }}
    >
      {value}
    </td>
  );
}

/** A pro or con line. The icon carries the polarity, so the text never repeats it. */
function Point({ kind, children }) {
  const good = kind === 'pro';
  return (
    <li style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <span style={{ flex: 'none', marginTop: 3 }}>
        <MIcon
          name={good ? 'check' : 'alert-triangle'}
          size={14}
          color={good ? 'var(--mint-600)' : 'var(--amber-600)'}
        />
      </span>
      <span>{children}</span>
    </li>
  );
}

/**
 * One ranked entry.
 *
 * Flat on purpose: one border around the card and hairline rules inside it, no
 * nested filled panels. The price used to sit in a tinted box, which read as a
 * second card inside the first.
 */
function Entry({ e }) {
  const rule = { borderTop: '1px solid var(--border-1)', paddingTop: 14, marginTop: 14 };
  return (
    <article
      id={`rank-${e.rank}`}
      style={{
        border: e.us ? '1px solid var(--cobalt-300)' : '1px solid var(--border-1)',
        borderRadius: 14,
        padding: '26px 28px',
        background: e.us ? FEATURED_TINT : 'var(--bg-surface)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span
          aria-hidden="true"
          style={{
            flex: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: 999,
            background: e.us ? 'var(--cobalt-600)' : 'var(--bg-sunken)',
            color: e.us ? '#fff' : 'var(--fg-2)',
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          {e.rank}
        </span>
        <h3 style={{ margin: 0, fontSize: 21, lineHeight: 1.2, letterSpacing: '-0.01em' }}>
          {/* The number is in the badge for sighted readers; repeat it in the
              heading text for anyone listening to the headings alone. */}
          <span style={VISUALLY_HIDDEN}>{`Number ${e.rank}: `}</span>
          {e.name}
        </h3>
        {e.tag ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '4px 10px',
              borderRadius: 999,
              background: 'var(--cobalt-600)',
              color: '#fff',
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            <MIcon name="zap" size={12} color="#fff" /> {e.tag}
          </span>
        ) : null}
      </div>

      <p style={{ margin: '12px 0 0', color: 'var(--fg-1)', fontSize: 15.5, lineHeight: 1.6 }}>
        {e.verdict}
      </p>

      <p style={{ ...rule, margin: 0, color: 'var(--fg-2)', fontSize: 14, lineHeight: 1.6 }}>
        <strong style={{ color: 'var(--fg-1)' }}>Price. </strong>{e.price}
      </p>

      <ul
        style={{
          ...rule,
          padding: 0,
          listStyle: 'none',
          display: 'grid',
          gap: 9,
          color: 'var(--fg-2)',
          fontSize: 14,
          lineHeight: 1.6,
        }}
      >
        {e.pros.map((p) => <Point kind="pro" key={p}>{p}</Point>)}
        {e.cons.map((c) => <Point kind="con" key={c}>{c}</Point>)}
      </ul>

      <p style={{ ...rule, margin: 0, color: 'var(--fg-1)', fontSize: 14, lineHeight: 1.6 }}>
        <strong>Best for. </strong>{e.bestFor}
      </p>

      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'center', marginTop: 18 }}>
        {e.us ? (
          <a className="btn btn-primary" href={e.href}>Connect an inbox free</a>
        ) : (
          /*
           * rel="nofollow" on every competitor link. These are citations, not
           * endorsements, and a comparison page that passes link equity to the
           * five products it is competing with is a slightly unusual way to run
           * a business.
           */
          <a
            href={e.href}
            rel="nofollow noopener noreferrer"
            target="_blank"
            style={{ fontSize: 14, fontWeight: 500, color: 'var(--cobalt-600)' }}
          >
            {e.linkLabel || `Visit ${e.name}`}
          </a>
        )}
        {e.moreHref ? (
          <Link
            href={e.moreHref}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 14,
              fontWeight: 500,
              color: 'var(--cobalt-600)',
            }}
          >
            {e.moreLabel} <MIcon name="arrow" size={13} color="var(--cobalt-600)" />
          </Link>
        ) : null}
      </div>
    </article>
  );
}

export default function EmailMcpServersView() {
  return (
    <div>
      <Nav />

      {/* Hero. Left-aligned throughout: see the layout rules above before
          adding a `justifyContent: 'center'` to either flex row here. */}
      <section className="pricing-page-hero">
        <div className="container">
          <div className="eye-label">{C.hero.eyebrow}</div>
          <h1 className="pricing-page-h1">
            {C.hero.titleLine1}<br />{C.hero.titleLine2}
          </h1>
          <p className="pricing-page-lead">{C.hero.lead}</p>
          <div className="hero-cta">
            <a className="btn btn-primary btn-lg" href="/signup">{C.ctaBand.ctaPrimary}</a>
            <a className="btn btn-secondary btn-lg" href="#ranked">See the ranking</a>
          </div>
          <div className="hero-meta" style={{ flexWrap: 'wrap', rowGap: 8 }}>
            {[C.hero.meta0, C.hero.meta1, C.hero.meta2].map((m) => (
              <span className="item" key={m}>
                <MIcon name="check" size={14} color="var(--mint-600)" /> {m}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* The TL;DR. First content after the hero, because it is the answer.
          One card, at the shared measure, on the shared left edge. */}
      <section className="section" style={{ paddingTop: 48, paddingBottom: 0 }}>
        <div className="container">
          <div
            style={{
              maxWidth: COL,
              border: '1px solid var(--border-1)',
              borderRadius: 14,
              background: 'var(--bg-surface)',
              padding: '24px 28px',
            }}
          >
            <h2 style={{ margin: '0 0 4px', fontSize: 18, letterSpacing: '-0.01em' }}>
              {C.quickPicks.title}
            </h2>
            {/*
              A description list, not a flex row per line: `dt` in its own grid
              column is what makes every product name start on the same vertical
              rule. The previous flex version gave the label a min-width, so a
              longer label pushed its own name out of line with the others.

              .picks-dl rather than inline styles because the columns have to
              collapse under 640px, and a media query cannot be written inline.
            */}
            <dl className="picks-dl">
              {C.quickPicks.items.map((q) => (
                <div key={q.label} style={{ display: 'contents' }}>
                  <dt>{q.label}</dt>
                  <dd><strong>{q.name}</strong>{`, ${q.why}`}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>

      {/* The ranking, with its method as a quiet note above the list rather
          than a second box floating between two sections. */}
      <section className="section" id="ranked" style={{ paddingTop: 56, paddingBottom: 64 }}>
        <div className="container">
          <h2 className="providers-h2">{`The ${C.entries.length} best email MCP servers, ranked`}</h2>
          <p className="providers-sub" style={{ marginBottom: 20 }}>
            Every entry lists what it is bad at, including the first one.
          </p>

          <div
            style={{
              maxWidth: COL,
              paddingLeft: 16,
              borderLeft: '2px solid var(--border-1)',
              marginBottom: 36,
            }}
          >
            <h3 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 600, color: 'var(--fg-1)' }}>
              {C.method.title}
            </h3>
            <p style={{ margin: 0, color: 'var(--fg-3)', fontSize: 14, lineHeight: 1.65 }}>
              {C.method.body}
            </p>
          </div>

          <div style={{ display: 'grid', gap: 20, maxWidth: COL }}>
            {C.entries.map((e) => <Entry e={e} key={e.name} />)}
          </div>
        </div>
      </section>

      {/* The summary table. The one block that gets the full container: five
          columns do not fit in the reading measure, and it scrolls on its own. */}
      <section
        className="section"
        id="compare"
        style={{ paddingTop: 56, paddingBottom: 72, background: 'var(--bg-page)' }}
      >
        <div className="container">
          <h2 className="providers-h2">Side by side</h2>
          <p className="providers-sub">
            Two hosted services, an agent tool platform, and running it yourself.
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
                      style={{ minWidth: 180, textAlign: 'left' }}
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
          <p className="pricing-footnote" style={{ marginTop: 20, maxWidth: COL }}>
            {C.tableFootnote}
          </p>
        </div>
      </section>

      {/* FAQ. Static markup, not the accordion: this page is server-rendered,
          and every answer here is something we want indexed and quotable. */}
      <section className="section" id="faq">
        <div className="container">
          <h2 className="providers-h2">{C.faq.title}</h2>
          <p className="providers-sub">{C.faq.sub}</p>
          {/* .faq-list caps itself at the stylesheet's 760px. Widened to COL so
              its right edge lines up with the cards and the table footnote
              rather than stopping 60px short of them. */}
          <div className="faq-list" style={{ maxWidth: COL }}>
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
                {/* .faq-a caps itself at 680px while its divider rule spans the
                    list, so the rule overshoots the text it belongs to. Text and
                    rule share an edge here instead. */}
                <div className="faq-a" style={{ maxWidth: '100%' }}>{item.a}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Sources. Printed, not merely tracked. */}
      <section className="section" id="sources" style={{ paddingTop: 48, background: 'var(--bg-page)' }}>
        <div className="container">
          <h2 className="providers-h2">{C.SOURCES.title}</h2>
          <p className="providers-sub">{C.SOURCES.sub}</p>
          <ul
            style={{
              margin: 0,
              padding: 0,
              maxWidth: COL,
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

      {/* CTA band. The one centred block on the page, and it is centred by the
          shared stylesheet rather than by an override here. */}
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
