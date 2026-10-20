import { Fragment } from 'react';
import { setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { metaAlternates, localePath, OG_LOCALE, OG_IMAGE } from '@/i18n/seo';
import { LEGAL_ENTITY_NAME, LEGAL_POSTAL_ADDRESS } from '@/lib/email/legal';
import { Nav, Footer } from '../../../components/marketing/Sections';
import { withdrawalCopy } from './content.mjs';
import '../../../styles/contract-forms.css';

/**
 * The statutory withdrawal notice and the model withdrawal form, for
 * consumers in the EEA and the UK. Linked from the Stripe checkout page
 * (custom_text in src/lib/stripe/checkout-core.ts), the purchase confirmation
 * email, the cancellation email, the terms and the footer.
 *
 * Server-rendered from content.mjs rather than messages/, so none of this copy
 * is serialised into other pages.
 */
const PATH = '/withdrawal';
const CONTACT_EMAIL = 'legal@mcpemails.com';
const CANCEL_LABEL = 'mcpemails.com/cancel';

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }) {
  const { locale } = await params;
  const { meta } = withdrawalCopy(locale);
  return {
    title: meta.title,
    description: meta.description,
    alternates: metaAlternates(locale, PATH),
    openGraph: {
      type: 'website',
      url: localePath(locale, PATH),
      title: `${meta.title} · mcpemails`,
      description: meta.description,
      locale: OG_LOCALE[locale],
      images: [OG_IMAGE],
    },
  };
}

/** Replace {token}s in a copy string with React nodes. */
function Filled({ text, nodes }) {
  return text.split(/(\{\w+\})/).map((part, i) => {
    const key = part.startsWith('{') && part.endsWith('}') ? part.slice(1, -1) : null;
    return <Fragment key={i}>{key && key in nodes ? nodes[key] : part}</Fragment>;
  });
}

/** Plain-text fill, for the copyable form. */
function fillText(text, values) {
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m));
}

export default async function WithdrawalPage({ params }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = withdrawalCopy(locale);

  const nodes = {
    entity: LEGAL_ENTITY_NAME,
    address: LEGAL_POSTAL_ADDRESS,
    email: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>,
    cancelLink: <Link href="/cancel?type=withdraw">{CANCEL_LABEL}</Link>,
    terms: <Link href="/terms#plans-and-payment">{c.termsLabel}</Link>,
  };
  const formText = c.form.lines
    .map((line) => fillText(line, { entity: LEGAL_ENTITY_NAME, address: LEGAL_POSTAL_ADDRESS, email: CONTACT_EMAIL }))
    .join('\n\n');

  return (
    <div>
      <Nav />

      <section className="pricing-page-hero" style={{ paddingBottom: 48 }}>
        <div className="container" style={{ maxWidth: 800 }}>
          <div className="eye-label">{c.eyebrow}</div>
          <h1 className="pricing-page-h1" style={{ fontSize: 'clamp(32px, 5vw, 48px)' }}>{c.title}</h1>
          <p className="pricing-page-lead" style={{ maxWidth: 600 }}>{c.lead}</p>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 16, paddingBottom: 80 }}>
        <div className="container" style={{ maxWidth: 800 }}>
          <div className="legal-body">
            <div className="legal-section" id="notice">
              <h2>{c.notice.h}</h2>
              {c.notice.paras.map((p, i) => <p key={i}><Filled text={p} nodes={nodes} /></p>)}
              <p>
                <Link href="/cancel?type=withdraw" className="btn btn-primary">{c.cta}</Link>
              </p>
            </div>

            <div className="legal-section" id="effects">
              <h2>{c.effects.h}</h2>
              {c.effects.paras.map((p, i) => <p key={i}><Filled text={p} nodes={nodes} /></p>)}
            </div>

            <div className="legal-section" id="model-form">
              <h2>{c.form.h}</h2>
              <p>{c.form.intro}</p>
              <pre className="withdrawal-form">{formText}</pre>
            </div>

            <div className="legal-section" id="cancelling">
              <h2>{c.cancelling.h}</h2>
              <p><Filled text={c.cancelling.para} nodes={{ ...nodes, cancelLink: <Link href="/cancel">{CANCEL_LABEL}</Link> }} /></p>
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
