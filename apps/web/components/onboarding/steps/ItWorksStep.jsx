'use client';

import { Suspense, lazy } from 'react';
import { useTranslations } from 'next-intl';
import { successKey } from '@/lib/onboarding/connect-steps.mjs';
import { chipClientLabel, normalizeChipClient } from '@/lib/onboarding/clients.mjs';
import { SuccessMark } from './inbox/ConnectOutcome';

// Flow B, loaded on this last step only, so its cards stay out of the
// dialog's first load (components/convert/OnboardingFlowB.jsx).
const OnboardingFlowB = lazy(() => import('../../convert/OnboardingFlowB'));

/**
 * The finish, "It works": a check that draws itself, a specific success line
 * (from the first call's tool), then Done through finish(), which stamps
 * onboarding_completed_at and closes the dialog onto the dashboard. Nothing
 * else to paste: the user has seen it work and wants to move on.
 *
 * Flow B (variant.convert = 'on', WP-H, plan section 5), before Done:
 *   B1  "Connect your other inbox". One tap reopens the inbox step for a
 *       second inbox; at the Free inbox cap it opens the dashboard's existing
 *       upgrade panel instead (ConnectModal, entry point second_inbox).
 *   B2  The plan summary card (components/convert/PlanSummaryCard.jsx).
 * Props: the panel contract in ./index.js.
 */
export function ItWorksStep({ step, status, clientLabel, finish, variant, flowB = null, userEmail = '', startSecondInbox }) {
  const t = useTranslations('onboarding');
  // The success line names the app that made the call, which can differ
  // from the chip (a ChatGPT call while the chip says Claude).
  const caller = normalizeChipClient(status?.firstCall?.client ?? null);
  const vars = { client: caller ? chipClientLabel(caller) : clientLabel };

  return (
    <section className="onb-panel onb-done" data-step={step} data-testid="onb-it-works">
      <SuccessMark size={48} />
      <h1 className="onb-title">{t('steps.it_works.title')}</h1>
      <p className="onb-sub" data-testid="onb-success">{t(successKey(status?.firstCall?.tool ?? null), vars)}</p>

      {variant?.convert === 'on' && (
        <Suspense fallback={null}>
          <OnboardingFlowB status={status} flowB={flowB} userEmail={userEmail} finish={finish} startSecondInbox={startSecondInbox} />
        </Suspense>
      )}

      <div className="onb-actions onb-actions-wide">
        <button type="button" className="btn btn-primary" onClick={finish} data-testid="onb-finish">
          {t('steps.it_works.finish')}
        </button>
      </div>
    </section>
  );
}
