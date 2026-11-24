import { Fragment } from 'react';
import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { localePath, metaAlternatesFor, OG_LOCALE, OG_IMAGE, connectJsonLd } from '@/i18n/seo';
import { requireLocale } from '@/i18n/require-locale';
import { Nav, Footer } from '../../../../components/marketing/Sections';
import { PATH, LOCALES, DATE_PUBLISHED, DATE_MODIFIED, SOURCES, copy } from './content.mjs';

/**
 * /connect/custom-domain: the own-domain email hub. Copy, sources and the
 * rules for editing it are in content.mjs.
 *
 * A static segment beside /connect/[provider], so Next serves this page for
 * the slug before the dynamic route sees it. English only: the other locale
 * prefixes 404 and hreflang advertises only en (the same narrow
 * generateStaticParams the English-only comparison page uses).
 */

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }) {
  const { locale } = await params;
  requireLocale(locale);
  if (!LOCALES.includes(locale)) return {};
  const { title, description } = copy.meta;
  return {
    title,
    description,
    alternates: metaAlternatesFor(locale, PATH, LOCALES),
    openGraph: {
      type: 'article',
      url: localePath(locale, PATH),
      title: `${title} · MCPEmails`,
      description,
      locale: OG_LOCALE[locale],
      images: [OG_IMAGE],
      modifiedTime: DATE_MODIFIED,
    },
    twitter: {
      card: 'summary_large_image',
      title: `${title} · MCPEmails`,
      description,
      images: [OG_IMAGE.url],
    },
  };
}

const TOKEN = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/;

/** `code`, **bold** and [text](/path) in a copy string. */
function Inline({ text }) {
  return text.split(TOKEN).map((part, i) => {
    const link = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (link) {
      // /signup is outside the localized site; everything else is a marketing page.
      return link[2] === '/signup'
        ? <a key={i} href="/signup">{link[1]}</a>
        : <Link key={i} href={link[2]}>{link[1]}</Link>;
    }
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i} className="t-code-inline">{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

/** The same string without markup, for JSON-LD. */
function plain(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

const narrow = { maxWidth: 760 };
const sectionStyle = { paddingTop: 40, paddingBottom: 0 };

export default async function CustomDomainHubPage({ params }) {
  const { locale } = await params;
  requireLocale(locale);
  if (!LOCALES.includes(locale)) notFound();
  setRequestLocale(locale);

  const base = connectJsonLd(locale, {
    path: PATH,
    title: copy.meta.title,
    description: copy.meta.description,
    howToName: copy.howToName,
    steps: copy.steps.map((s) => ({ h: s.h, p: plain(s.p) })),
    faq: copy.faq,
    connectLabel: copy.breadcrumb,
  });
  const jsonLd = {
    ...base,
    '@graph': base['@graph'].map((node) =>
      node['@type'] === 'WebPage'
        ? {
            ...node,
            datePublished: DATE_PUBLISHED,
            dateModified: DATE_MODIFIED,
            citation: SOURCES.map((s) => ({ '@type': 'CreativeWork', name: s.name, url: s.url })),
          }
        : node,
    ),
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <div>
        <Nav />
        <main>
          <section className="pricing-page-hero">
            <div className="container">
              <div className="eye-label">{copy.eyebrow}</div>
              <h1 className="pricing-page-h1">{copy.title}</h1>
              <p className="pricing-page-lead">{copy.lead}</p>
              <div className="hero-cta" style={{ marginTop: 24 }}>
                <a className="btn btn-primary btn-lg" href="/signup?provider=imap">{copy.cta.button}</a>
              </div>
            </div>
          </section>

          <section className="section" style={sectionStyle}>
            <div className="container" style={narrow}>
              <p className="providers-sub"><Inline text={copy.answer} /></p>
            </div>
          </section>

          <section className="section" id="steps" style={sectionStyle}>
            <div className="container" style={narrow}>
              <h2 className="providers-h2">{copy.howToName}</h2>
              <ol className="read-only-list">
                {copy.steps.map((s) => (
                  <li key={s.h}>
                    <strong>{s.h}.</strong> <Inline text={s.p} />
                  </li>
                ))}
              </ol>
            </div>
          </section>

          <section className="section" id="hosts" style={sectionStyle}>
            <div className="container" style={narrow}>
              <h2 className="providers-h2">{copy.hostsTitle}</h2>
              <p><Inline text={copy.hostsLead} /></p>
              {copy.hosts.map((h) => (
                <div key={h.id} id={h.id} style={{ marginTop: 28 }}>
                  <h3 style={{ margin: '0 0 8px', fontSize: 18 }}>
                    <Link href={h.href}>{h.name}</Link>
                  </h3>
                  <ul className="read-only-list">
                    {h.rows.map(([label, value]) => (
                      <li key={label}>
                        <strong>{label}:</strong> <Inline text={value} />
                      </li>
                    ))}
                  </ul>
                  {h.note ? <p style={{ color: 'var(--fg-2)' }}><Inline text={h.note} /></p> : null}
                  <p className="how-guide-link" style={{ marginTop: 4 }}>
                    <Link href={h.href}>{copy.hostLinkLabel} {h.name}</Link>
                  </p>
                </div>
              ))}
              <p style={{ marginTop: 28 }}><Inline text={copy.hostsMore} /></p>
            </div>
          </section>

          <section className="section" id="troubleshooting" style={sectionStyle}>
            <div className="container" style={narrow}>
              <h2 className="providers-h2">{copy.troubleTitle}</h2>
              {copy.trouble.map((t) => (
                <div key={t.h} style={{ marginTop: 20 }}>
                  <h3 style={{ margin: '0 0 6px', fontSize: 17 }}>{t.h}</h3>
                  <p style={{ margin: 0 }}><Inline text={t.p} /></p>
                </div>
              ))}
            </div>
          </section>

          <section className="section" id="faq" style={sectionStyle}>
            <div className="container" style={narrow}>
              <h2 className="providers-h2">{copy.faqTitle}</h2>
              {copy.faq.map((f) => (
                <div key={f.q} style={{ marginTop: 20 }}>
                  <h3 style={{ margin: '0 0 6px', fontSize: 17 }}>{f.q}</h3>
                  <p style={{ margin: 0 }}>{f.a}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="section" id="sources" style={sectionStyle}>
            <div className="container" style={narrow}>
              <h2 className="providers-h2">{copy.sourcesTitle}</h2>
              <p style={{ color: 'var(--fg-2)' }}>{copy.sourcesLead}</p>
              <ul className="read-only-list">
                {SOURCES.map((s) => (
                  <li key={s.url}><a href={s.url} rel="noopener">{s.name}</a></li>
                ))}
              </ul>
            </div>
          </section>

          <section className="section cta-band" style={{ marginTop: 40 }}>
            <div className="container">
              <h2>{copy.cta.title}</h2>
              <p className="sub">{copy.cta.sub}</p>
              <div className="hero-cta">
                <a className="btn btn-primary btn-lg" href="/signup?provider=imap">{copy.cta.button}</a>
              </div>
            </div>
          </section>
        </main>
        <Footer />
      </div>
    </>
  );
}

