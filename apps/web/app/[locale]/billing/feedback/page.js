import { setRequestLocale } from 'next-intl/server';
import { Nav, Footer } from '../../../../components/marketing/Sections';
import CancelReasonForm from '../../../../components/billing/CancelReasonForm';
import { CANCEL_REASONS, isCancelReason } from '@/lib/billing/cancel-reasons';
import { verifyFeedbackToken } from '@/lib/billing/feedback-token';
import { feedbackCopy } from './content.mjs';
import '../../../../styles/help.css';
import '../../../../styles/contract-forms.css';

/**
 * /billing/feedback?t=<signed token>&r=<reason>: why a subscriber cancelled,
 * asked only after the cancellation is done.
 *
 * Opened from the reason links in the post-cancel email (cancel_ask in
 * src/lib/email/billing-lifecycle.ts). This GET is READ-ONLY: it checks the
 * token and shows the reasons with `r` preselected, and the answer is recorded
 * only when the reader presses Send (POST /api/billing/feedback). Mail link
 * scanners prefetch every URL in an email, so a GET that wrote would file a
 * reason nobody chose.
 *
 * noindex: a per-customer page with nothing for a search engine.
 */

export async function generateMetadata({ params }) {
  const { locale } = await params;
  const c = feedbackCopy(locale);
  return {
    title: c.meta.title,
    robots: { index: false, follow: false },
  };
}

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function BillingFeedbackPage({ params, searchParams }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = feedbackCopy(locale);
  const sp = await searchParams;
  const token = first(sp?.t);
  const reason = first(sp?.r);
  const valid = typeof token === 'string' && verifyFeedbackToken(token) !== null;

  return (
    <div>
      <Nav />

      <section className="pricing-page-hero" style={{ paddingBottom: 24 }}>
        <div className="help-wrap">
          <h1 className="pricing-page-h1" style={{ fontSize: 'clamp(28px, 4.5vw, 40px)' }}>{c.title}</h1>
          {valid ? <p className="pricing-page-lead">{c.lead}</p> : null}
        </div>
      </section>

      <section className="help-section" style={{ paddingBottom: 80 }}>
        <div className="help-wrap">
          {valid ? (
            <CancelReasonForm
              copy={c}
              token={token}
              reasons={[...CANCEL_REASONS]}
              initialReason={isCancelReason(reason) ? reason : null}
            />
          ) : (
            <p>
              {c.invalid} <a href="/dashboard">{c.dashboard}</a>
            </p>
          )}
        </div>
      </section>

      <Footer />
    </div>
  );
}
