import { setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { metaAlternates, localePath, OG_LOCALE, OG_IMAGE } from '@/i18n/seo';
import { issueSupportFormToken } from '@/lib/support/form-token';
import { Nav, Footer } from '../../../components/marketing/Sections';
import CancelForm from '../../../components/legal/CancelForm';
import { cancelCopy } from './content.mjs';
import '../../../styles/help.css';
import '../../../styles/contract-forms.css';

/**
 * "Cancel contracts here": the public cancellation and withdrawal form.
 *
 * No login, on purpose. §312k BGB requires that a consumer can cancel a
 * subscription bought online through a button that leads straight to a form,
 * and Directive (EU) 2023/2673 requires the same for withdrawal. The form
 * posts to /api/legal/contract-request, which records the request as a
 * support ticket, emails the customer a receipt and notifies us.
 *
 * `?type=withdraw` preselects the withdrawal; /withdrawal links here with it.
 * Linked from the footer on every page.
 */
const PATH = '/cancel';
const SUPPORT_EMAIL = 'support@mcpemails.com';

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }) {
  const { locale } = await params;
  const { meta } = cancelCopy(locale);
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

export default async function CancelPage({ params, searchParams }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = cancelCopy(locale);
  const sp = await searchParams;
  const type = Array.isArray(sp?.type) ? sp.type[0] : sp?.type;
  const initialKind = type === 'withdraw' ? 'withdraw' : 'cancel';

  return (
    <div>
      <Nav />

      <section className="pricing-page-hero" style={{ paddingBottom: 24 }}>
        <div className="help-wrap">
          <div className="eye-label">{c.eyebrow}</div>
          <h1 className="pricing-page-h1" style={{ fontSize: 'clamp(32px, 5vw, 48px)' }}>{c.title}</h1>
          <p className="pricing-page-lead">{c.lead}</p>
          <p className="help-muted"><Link href="/withdrawal">{c.withdrawalLink}</Link></p>
        </div>
      </section>

      <section className="help-section" style={{ paddingBottom: 80 }}>
        <div className="help-wrap">
          <CancelForm
            copy={c}
            locale={locale}
            initialKind={initialKind}
            formToken={issueSupportFormToken()}
            supportEmail={SUPPORT_EMAIL}
          />
        </div>
      </section>

      <Footer />
    </div>
  );
}
