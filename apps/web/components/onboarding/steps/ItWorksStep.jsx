'use client';

import { Suspense, lazy, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { canDraftWith, promptKeys, successKey } from '@/lib/onboarding/connect-steps.mjs';
import { morningBriefOptIn } from './assist-actions';
import { PromptBlock } from './ConnectParts';

// Flow B, loaded on this last step only, so its cards stay out of
// /onboarding's first load (components/convert/OnboardingFlowB.jsx).
const OnboardingFlowB = lazy(() => import('../../convert/OnboardingFlowB'));

/**
 * A9, "It works": a specific success line (from the first call's tool), the
 * Draft my replies prompt, tomorrow's Morning brief prompt with an opt-in
 * "Email me this tomorrow at 8", then the dashboard through finish(), which
 * stamps onboarding_completed_at.
 *
 * Flow B (variant.convert = 'on', WP-H, plan section 5), before the finish
 * button and nothing restructured above it:
 *   B1  "Connect your other inbox". One tap reopens the inbox step for a
 *       second inbox; at the Free inbox cap it opens the dashboard's existing
 *       upgrade panel instead (ConnectModal, entry point second_inbox).
 *   B2  The plan summary card (components/convert/PlanSummaryCard.jsx).
 * Props: the panel contract in ./index.js.
 */
export function ItWorksStep({ step, status, client, clientLabel, finish, variant, flowB = null, userEmail = '', startSecondInbox }) {
  const t = useTranslations('onboarding');
  const locale = useLocale();
  const vars = { client: clientLabel };
  const prompts = promptKeys(client, { canDraft: canDraftWith(status?.credential?.scopes ?? null) });
  const [optIn, setOptIn] = useState({ phase: 'idle', email: null });

  const subscribe = async () => {
    setOptIn({ phase: 'saving', email: null });
    const res = await morningBriefOptIn(client, locale);
    setOptIn({ phase: res.ok ? 'done' : 'failed', email: res.email });
  };

  return (
    <section className="onb-panel" data-step={step} data-testid="onb-it-works">
      <h1 className="onb-title">{t('steps.it_works.title')}</h1>
      <p className="onb-success" data-testid="onb-success">{t(successKey(status?.firstCall?.tool ?? null), vars)}</p>

      {prompts.draftReplies && (
        <>
          <p className="onb-strong">{t('steps.it_works.next')}</p>
          <PromptBlock text={t(prompts.draftReplies)} kind="draft_replies" testId="onb-draft-prompt" />
        </>
      )}

      {prompts.morningBrief && (
        <>
          <p className="onb-strong">{t('steps.it_works.ritual')}</p>
          <PromptBlock text={t(prompts.morningBrief)} kind="morning_brief" testId="onb-morning-prompt" />
          <div className="onb-actions">
            {optIn.phase === 'done' ? (
              <p className="onb-muted" data-testid="onb-optin-done">{t('steps.it_works.optInDone', { email: optIn.email ?? '' })}</p>
            ) : (
              <button type="button" className="btn btn-secondary" onClick={subscribe} disabled={optIn.phase === 'saving'} data-testid="onb-optin">
                {t('steps.it_works.optIn')}
              </button>
            )}
          </div>
          {optIn.phase === 'failed' && <p className="onb-error" role="alert">{t('steps.it_works.optInFailed')}</p>}
        </>
      )}

      {variant?.convert === 'on' && (
        <Suspense fallback={null}>
          <OnboardingFlowB status={status} flowB={flowB} userEmail={userEmail} finish={finish} startSecondInbox={startSecondInbox} />
        </Suspense>
      )}

      <div className="onb-actions onb-finish">
        <button type="button" className="btn btn-primary" onClick={finish} data-testid="onb-finish">
          {t('steps.it_works.finish')}
        </button>
      </div>
    </section>
  );
}
