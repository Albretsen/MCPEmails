import { Fragment } from 'react';
import { setRequestLocale } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import { metaAlternates, localePath, OG_LOCALE, OG_IMAGE } from '@/i18n/seo';
import { LEGAL_ENTITY_NAME, LEGAL_ORG_NUMBER, LEGAL_POSTAL_ADDRESS } from '@/lib/email/legal';
import { Nav, Footer } from '../../../components/marketing/Sections';
import { DPA_DOCUMENT, DPA_PDF_PATH, dpaPageCopy, fillDpaText } from './content.mjs';
import { requireLocale } from '@/i18n/require-locale';
import '../../../styles/dpa.css';

/**
 * The MCPEmails Data Processing Agreement. It forms part of the terms and
 * applies to every customer, so it is public and needs no signature.
 *
 * English is the binding text: every locale renders the same English
 * agreement, with one localized line saying so. Server-rendered from
 * content.mjs rather than messages/, so none of this copy is serialised into
 * other pages.
 */
const PATH = '/dpa';
const ENTITY = { entity: LEGAL_ENTITY_NAME, orgNumber: LEGAL_ORG_NUMBER, address: LEGAL_POSTAL_ADDRESS };

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }) {
  const { locale } = await params;
  requireLocale(locale);
  const { meta } = dpaPageCopy(locale);
  return {
    title: meta.title,
    description: meta.description,
    alternates: metaAlternates(locale, PATH),
    openGraph: {
      type: 'website',
      url: localePath(locale, PATH),
      title: `${meta.title} · MCPEmails`,
      description: meta.description,
      locale: OG_LOCALE[locale],
      images: [OG_IMAGE],
    },
  };
}

/** Fill the entity tokens and link every email address in a string. */
function Text({ text }) {
  return fillDpaText(text, ENTITY)
    .split(/([\w.+-]+@mcpemails\.com)/)
    .map((part, i) =>
      i % 2 === 1 ? <a key={i} href={`mailto:${part}`}>{part}</a> : <Fragment key={i}>{part}</Fragment>,
    );
}

function Block({ block }) {
  if (block.p) return <p><Text text={block.p} /></p>;
  if (block.h3) return <h3>{block.h3}</h3>;
  if (block.ol) {
    return (
      <ol>
        {block.ol.map((item, i) => (
          <li key={i}>
            {item.label && <strong>{item.label} </strong>}
            <Text text={item.text} />
          </li>
        ))}
      </ol>
    );
  }
  if (block.table) {
    return (
      <div className="dpa-table-wrap">
        <table className="dpa-table">
          <thead>
            <tr>{block.table.head.map((h, i) => <th key={i}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {block.table.rows.map((row, i) => (
              <tr key={i}>{row.map((cell, j) => <td key={j}><Text text={cell} /></td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return null;
}

export default async function DpaPage({ params }) {
  const { locale } = await params;
  requireLocale(locale);
  setRequestLocale(locale);
  const c = dpaPageCopy(locale);

  return (
    <div>
      <Nav />

      <section className="pricing-page-hero" style={{ paddingBottom: 32 }}>
        <div className="container" style={{ maxWidth: 800 }}>
          <div className="eye-label">{c.eyebrow}</div>
          <h1 className="pricing-page-h1" lang="en" style={{ fontSize: 'clamp(32px, 5vw, 48px)' }}>
            {DPA_DOCUMENT.title}
          </h1>
          <p className="dpa-version" lang="en">{DPA_DOCUMENT.versionLine}</p>
          {c.notice && <p className="dpa-notice">{c.notice}</p>}
          <p className="dpa-download">
            <a href={DPA_PDF_PATH} download>{c.pdf}</a>
          </p>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 16, paddingBottom: 80 }}>
        <div className="container" style={{ maxWidth: 800 }}>
          <div className="dpa-body" lang="en">
            {DPA_DOCUMENT.sections.map((section) => (
              <div className="dpa-section" id={section.id} key={section.id}>
                <h2>{section.h}</h2>
                {section.blocks.map((block, i) => <Block key={i} block={block} />)}
              </div>
            ))}
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
