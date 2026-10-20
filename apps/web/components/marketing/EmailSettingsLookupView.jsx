import { Nav, Footer } from './Sections';
import { Link } from '@/i18n/navigation';
import { withReadingLang } from '@/i18n/reading-lang.mjs';
import RichText from './RichText';
import EmailSettingsLookup from './EmailSettingsLookup';
import { LINKS, LOCALES, RELATED, SOURCES } from '@/lib/tools/email-settings-lookup.mjs';

/*
 * /tools/email-settings-lookup. A server component: the copy arrives as `c`
 * (one locale of src/lib/tools/email-settings-lookup/<locale>.json) and only
 * the `tool` block crosses into the client component. `href(key)` is the page's
 * locale-aware resolver for LINKS (see the page).
 *
 * The explainer and FAQ are plain server HTML below the tool, always rendered,
 * so crawlers and answer engines read them without running the lookup.
 */

/** Copy with `[label](key)` links and the RichText subset (<code>, <b>). */
function Prose({ text, href }) {
  const LINK = /\[([^\]]+)\]\(([a-zA-Z]+)\)/g;
  const out = [];
  let last = 0;
  let m;
  while ((m = LINK.exec(text)) !== null) {
    if (m.index > last) out.push(<RichText key={`t${last}`}>{text.slice(last, m.index)}</RichText>);
    out.push(LINKS[m[2]] ? <a key={`l${m.index}`} href={href(m[2])}>{m[1]}</a> : m[1]);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(<RichText key={`t${last}`}>{text.slice(last)}</RichText>);
  return <>{out}</>;
}

export default function EmailSettingsLookupView({ c, locale, registry, href, checkedOn }) {
  const fill = (s) => s.replace('{date}', checkedOn);

  return (
    <div>
      <Nav />

      <section className="pricing-page-hero">
        <div className="container">
          <div className="eye-label">{c.hero.eyebrow}</div>
          <h1 className="pricing-page-h1">{c.hero.title}</h1>
          <p className="pricing-page-lead">{c.hero.lead}</p>
          <EmailSettingsLookup t={c.tool} registry={registry} locale={locale} appPasswordHref={href('appPassword')} />
          <p className="pricing-footnote" style={{ textAlign: 'center', marginTop: 16 }}>{fill(c.hero.updated)}</p>
        </div>
      </section>

      <section className="section" id="explained">
        <div className="container">
          <div className="section-head" style={{ marginBottom: 24 }}>
            <h2 style={{ fontSize: 36 }}>{c.explain.title}</h2>
            <p className="sub">{c.explain.sub}</p>
          </div>
          <div className="tool-explain">
            {c.explain.items.map((item) => (
              <div key={item.h}>
                <h3>{item.h}</h3>
                <p><Prose text={item.p} href={href} /></p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section" id="ports" style={{ paddingTop: 0 }}>
        <div className="container">
          <div className="section-head" style={{ marginBottom: 24 }}>
            <h2 style={{ fontSize: 28 }}>{c.ports.title}</h2>
          </div>
          <div className="comparison-wrap">
            <table className="comparison-tbl" style={{ tableLayout: 'fixed', minWidth: 560 }}>
              <thead>
                <tr>
                  <th className="feat-col" style={{ width: '12%' }}>{c.ports.colPort}</th>
                  <th style={{ width: '14%' }}>{c.ports.colProtocol}</th>
                  <th style={{ width: '22%', whiteSpace: 'normal' }}>{c.ports.colSecurity}</th>
                  <th style={{ whiteSpace: 'normal' }}>{c.ports.colUse}</th>
                </tr>
              </thead>
              <tbody>
                {c.ports.rows.map((row) => (
                  <tr key={row.port}>
                    <td className="feat-name"><code className="t-code-inline">{row.port}</code></td>
                    <td className="tbl-val">{row.protocol}</td>
                    <td className="tbl-val">{row.security}</td>
                    <td className="tbl-val">{row.use}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="pricing-footnote" style={{ textAlign: 'center', marginTop: 16 }}>{c.ports.note}</p>
        </div>
      </section>

      <section className="section" id="faq" style={{ background: 'var(--bg-page)' }}>
        <div className="container">
          <div className="section-head" style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 36 }}>{c.faq.title}</h2>
          </div>
          <div className="faq-list">
            {c.faq.items.map((item) => (
              <div className="faq-item" key={item.q}>
                <h3 className="tool-faq-q">{item.q}</h3>
                <div className="faq-a"><Prose text={item.a} href={href} /></div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section" id="related" style={{ paddingTop: 48, background: 'var(--bg-page)' }}>
        <div className="container">
          <div className="section-head" style={{ marginBottom: 20 }}>
            <h2 style={{ fontSize: 28 }}>{c.related.title}</h2>
          </div>
          <ul className="tool-related">
            {RELATED.map((key) => (
              <li key={key}><a href={href(key)}>{c.related.items[key]}</a></li>
            ))}
          </ul>
        </div>
      </section>

      <section className="section" id="sources" style={{ paddingTop: 48, background: 'var(--bg-page)' }}>
        <div className="container">
          <div className="section-head" style={{ marginBottom: 20 }}>
            <h2 style={{ fontSize: 28 }}>{c.sources.title}</h2>
            <p className="sub">{fill(c.sources.sub)}</p>
          </div>
          <ul className="tool-sources">
            {SOURCES.map((s) => (
              <li key={s.id}>
                <span>{c.sources.items[s.id]}: </span>
                <a href={s.url} rel="nofollow noopener noreferrer" target="_blank">{s.url}</a>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="pricing-cta-band">
        <div className="container">
          <h2 className="pricing-cta-h">{c.ctaBand.title}</h2>
          <p className="pricing-cta-sub">{c.ctaBand.sub}</p>
          <div className="pricing-cta-btns">
            <a className="btn btn-primary btn-lg" href={withReadingLang('/signup', locale)}>{c.ctaBand.ctaPrimary}</a>
            <Link className="btn btn-on-dark btn-lg" href="/connect">{c.ctaBand.ctaSecondary}</Link>
          </div>
        </div>
      </section>

      <Footer locales={LOCALES} />
    </div>
  );
}
