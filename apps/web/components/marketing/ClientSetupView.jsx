import { Link } from '@/i18n/navigation';
import { Nav, Footer } from './Sections';
import { MIcon } from '../MarketingPrimitives';
import RichText from './RichText';
import { CLIENT_LOGOS } from '../dashboard/clientLogos';
import { MCP_URL, relatedClients } from '@/lib/clients/clients.mjs';
import { clientUi, fill } from '@/lib/clients/ui.mjs';

/**
 * A per-client setup page, rendered on the server.
 *
 * Server component on purpose. It has no state, no effects and no handlers,
 * and rendering it on the server is what lets the copy live in
 * src/lib/clients/content instead of a next-intl namespace that would ship to
 * every marketing page. Nav and Footer are the only things here that hydrate.
 *
 * Every class name used here already exists in styles/marketing.css, borrowed
 * from the provider landing pages and the docs page. This component adds no
 * CSS of its own.
 */

/** The client's official logo glyph, white on a rounded tile in its brand colour. */
function ClientLogo({ color, logo, size = 44 }) {
  const g = CLIENT_LOGOS[logo];
  if (!g) return null;
  const glyph = Math.round(size * 0.56);
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 11,
        background: color,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        margin: '0 auto 18px',
      }}
    >
      <svg width={glyph} height={glyph} viewBox={g.viewBox} fill="#fff" aria-hidden="true">
        <path d={g.d} />
      </svg>
    </div>
  );
}

/** A read-only code block in the docs page's style. No copy button: this is a server component. */
function CodeBlock({ label, code }) {
  return (
    <div className="docs-code-wrap">
      <div className="docs-code-bar">
        <span className="docs-code-lang">{label}</span>
      </div>
      <pre className="docs-pre"><code>{code}</code></pre>
    </div>
  );
}

export default function ClientSetupView({ locale, client, content }) {
  const ui = clientUi(locale).page;
  const related = relatedClients(client.slug, locale);
  const name = client.shortName ?? client.name;
  const isTerminal = client.configFile === 'terminal';
  const configLabel = isTerminal ? ui.config.terminal : (client.configFile ?? ui.config.json);
  const config = client.config ? client.config(MCP_URL) : null;

  return (
    <div>
      <Nav />

      <section className="pricing-page-hero">
        <div className="container">
          <ClientLogo color={client.color} logo={client.logo} />
          <div className="eye-label">{content.hero.eyebrow}</div>
          <h1 className="pricing-page-h1">
            {content.hero.titleLine1}<br />{content.hero.titleLine2}
          </h1>
          <p className="pricing-page-lead">{content.hero.lead}</p>
          {/*
            The direct answer to the query, quotable on its own. The provider
            pages ranked and returned no clicks until they carried one of
            these; there is no reason to relearn that here.
          */}
          {content.hero.answer && <p className="pricing-page-answer">{content.hero.answer}</p>}
          <div className="hero-cta" style={{ justifyContent: 'center', marginTop: 24 }}>
            <a className="btn btn-primary btn-lg" href="/signup">{ui.ctaPrimary}</a>
            <Link className="btn btn-secondary btn-lg" href="/docs">{ui.ctaSecondary}</Link>
          </div>
          <div className="hero-meta" style={{ justifyContent: 'center' }}>
            {['meta0', 'meta1', 'meta2'].map((k) => content.hero[k] && (
              <span className="item" key={k}>
                <MIcon name="check" size={14} color="var(--mint-600)" /> {content.hero[k]}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 56, paddingBottom: 0 }}>
        <div className="container">
          <div className="connect-callout">
            <MIcon name="lock" size={20} color="var(--cobalt-600)" />
            <div>
              <h2 style={{ margin: '0 0 6px', fontSize: 16 }}>{content.method.title}</h2>
              <p style={{ margin: 0, color: 'var(--fg-2)', fontSize: 14, lineHeight: 1.6 }}>
                <RichText>{content.method.body}</RichText>
              </p>
            </div>
          </div>
        </div>
      </section>

      {/*
        The endpoint, the transport and which of the two auth paths this client
        takes. Whether a client does OAuth or wants a bearer key is the single
        fact that decides whether someone's setup completes, and it is the fact
        a generic "paste the URL" page leaves out.
      */}
      <section className="section" style={{ paddingTop: 40, paddingBottom: 0 }}>
        <div className="container">
          <h2 className="providers-h2">{ui.endpoint.title}</h2>
          <p className="providers-sub">{fill(ui.endpoint.sub, { client: client.name })}</p>
          <div className="comparison-wrap">
            <table className="comparison-tbl providers-conn-tbl">
              <thead>
                <tr>
                  <th className="feat-col" style={{ minWidth: 170 }}>{ui.endpoint.colField}</th>
                  <th>{ui.endpoint.colValue}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="feat-name">{ui.endpoint.fieldUrl}</td>
                  <td className="tbl-val"><code className="connect-host">{MCP_URL}</code></td>
                </tr>
                <tr>
                  <td className="feat-name">{ui.endpoint.fieldTransport}</td>
                  <td className="tbl-val" style={{ fontSize: 13 }}>{ui.endpoint.transport}</td>
                </tr>
                <tr>
                  <td className="feat-name">{ui.endpoint.fieldAuth}</td>
                  <td className="tbl-val" style={{ fontSize: 13 }}>
                    {client.auth === 'oauth' ? ui.endpoint.authOauth : ui.endpoint.authKey}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="section how" id="how" style={{ background: 'var(--bg-page)' }}>
        <div className="container">
          <div className="section-head">
            <div className="eye-label">{ui.how.eyebrow}</div>
            <h2>{fill(ui.how.title, { client: client.name })}</h2>
            <p className="sub">{ui.how.sub}</p>
          </div>
          <div className="how-steps">
            {content.setup.map((s, i) => (
              <div className="step" key={i}>
                <span className="num">{String(i + 1).padStart(2, '0')}</span>
                <h3>{s.h}</h3>
                <p><RichText>{s.p}</RichText></p>
              </div>
            ))}
          </div>

          {config && (
            <div style={{ maxWidth: 820, margin: '28px auto 0' }}>
              <CodeBlock label={configLabel} code={config} />
            </div>
          )}

          {client.guide && (
            <p className="how-guide-link">
              {fill(ui.guideLink.intro, { client: client.name })}{' '}
              <a href={client.guide} target="_blank" rel="noopener noreferrer">{client.guide}</a>
            </p>
          )}
          <p className="how-guide-link">
            {ui.providers.intro} <Link href="/docs/providers">{ui.providers.label}</Link>
          </p>
        </div>
      </section>

      {/*
        The part only we can write: what goes wrong in this specific client.
        Every competing per-client page is the same page with the name swapped.
      */}
      {content.gotchas?.length > 0 && (
        <section className="section" id="gotchas">
          <div className="container">
            <div className="section-head">
              <div className="eye-label">{ui.gotchas.eyebrow}</div>
              <h2>{fill(ui.gotchas.title, { client: name })}</h2>
            </div>
            <div className="connect-gotchas">
              {content.gotchas.map((g, i) => (
                <div className="connect-gotcha" key={i}>
                  <MIcon name="alert-triangle" size={17} color="var(--amber-700)" />
                  <div>
                    <h3>{g.h}</h3>
                    <p><RichText>{g.p}</RichText></p>
                  </div>
                </div>
              ))}
            </div>
            {content.limits?.length > 0 && (
              <div className="connect-limits">
                <h3>{ui.limits.title}</h3>
                <ul>
                  {content.limits.map((l, i) => (
                    <li key={i}><RichText>{l}</RichText></li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}

      {content.faq?.length > 0 && (
        <section className="section" id="faq" style={{ background: 'var(--bg-page)' }}>
          <div className="container">
            <div className="section-head">
              <div className="eye-label">{ui.faq.eyebrow}</div>
              <h2>{fill(ui.faq.title, { client: client.name })}</h2>
            </div>
            <div className="connect-faq">
              {content.faq.map((f, i) => (
                <details className="connect-faq-item" key={i} open={i === 0}>
                  <summary><h3>{f.q}</h3></summary>
                  <p><RichText>{f.a}</RichText></p>
                </details>
              ))}
            </div>
          </div>
        </section>
      )}

      {related.length > 0 && (
        <section className="section" id="related">
          <div className="container">
            <div className="section-head">
              <h2>{ui.related.title}</h2>
              <p className="sub">{ui.related.sub}</p>
            </div>
            <ul className="connect-related">
              {related.map((c) => (
                <li key={c.slug}>
                  <Link href={`/docs/${c.slug}`}>{fill(ui.related.link, { client: c.name })}</Link>
                </li>
              ))}
            </ul>
            <p className="how-guide-link">
              <Link href="/docs/clients">{ui.related.all}</Link>
              {' · '}
              <Link href="/connect">{ui.connect.label}</Link>
            </p>
          </div>
        </section>
      )}

      <section className="section cta-band">
        <div className="container">
          <h2>{content.ctaBand.title}</h2>
          <p className="sub">{content.ctaBand.sub}</p>
          <div className="hero-cta" style={{ justifyContent: 'center' }}>
            <a className="btn btn-primary btn-lg" href="/signup">{ui.ctaPrimary}</a>
            <Link className="btn btn-secondary btn-lg" href="/docs">{ui.ctaSecondary}</Link>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
