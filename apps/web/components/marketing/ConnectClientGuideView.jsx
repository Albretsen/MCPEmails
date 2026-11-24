import { withReadingLang } from '@/i18n/reading-lang.mjs';
import { Link } from '@/i18n/navigation';
import { Nav, Footer } from './Sections';
import RichText from './RichText';

/**
 * A per-assistant guide page (/connect/<provider>/claude or /chatgpt),
 * rendered on the server. One query, one page: the H1 is the query, the
 * answer comes first, then the numbered steps and a short FAQ. The page links
 * back to its provider page and across to the other assistant's guide.
 * Copy and data: src/lib/connect/client-guides.mjs.
 */
export default function ConnectClientGuideView({ locale, providerSlug, guide, locales }) {
  const signup = withReadingLang(`/signup?provider=${providerSlug}`, locale);
  return (
    <div>
      <Nav />

      <section className="pricing-page-hero">
        <div className="container">
          <div className="eye-label">{guide.eyebrow}</div>
          <h1 className="pricing-page-h1">{guide.h1}</h1>
          <p className="pricing-page-lead">{guide.answer}</p>
          <div className="hero-cta" style={{ marginTop: 24 }}>
            <a className="btn btn-primary btn-lg" href={signup}>{guide.ui.ctaPrimary}</a>
          </div>
          <p className="how-guide-link" style={{ marginTop: 12 }}>{guide.ui.ctaNote}</p>
        </div>
      </section>

      <section className="section how" id="how" style={{ background: 'var(--bg-page)' }}>
        <div className="container">
          <div className="section-head">
            <h2>{guide.stepsTitle}</h2>
          </div>
          <div className="how-steps">
            {guide.steps.map((s, i) => (
              <div className="step" key={i}>
                <span className="num">{String(i + 1).padStart(2, '0')}</span>
                <h3>{s.h}</h3>
                <p><RichText>{s.p}</RichText></p>
              </div>
            ))}
          </div>
          {guide.note && <p className="how-guide-link">{guide.note}</p>}
          <p className="how-guide-link">
            <Link href={guide.clientDocs.href}>{guide.clientDocs.label}</Link>
          </p>
        </div>
      </section>

      <section className="section" id="faq">
        <div className="container">
          <div className="section-head">
            <h2>{guide.ui.faqTitle}</h2>
          </div>
          <div className="connect-faq">
            {guide.faq.map((f, i) => (
              <details className="connect-faq-item" key={i} open={i === 0}>
                <summary><h3>{f.q}</h3></summary>
                <p><RichText>{f.a}</RichText></p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="section" id="related" style={{ background: 'var(--bg-page)' }}>
        <div className="container">
          <div className="section-head">
            <h2>{guide.ui.relatedTitle}</h2>
          </div>
          <ul className="connect-related">
            <li><Link href={guide.parent.href}>{guide.parent.label}</Link></li>
            <li><Link href={guide.sibling.href}>{guide.sibling.label}</Link></li>
          </ul>
        </div>
      </section>

      <Footer locales={locales} />
    </div>
  );
}
