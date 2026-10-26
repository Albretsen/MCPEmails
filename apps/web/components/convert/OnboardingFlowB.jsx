'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { isBusinessShapedWorkspace } from '@/lib/segment/consumer-domains.mjs';
import { SECOND_INBOX_DASHBOARD_HREF, nextInboxNeedsUpgrade } from '@/lib/onboarding/flow-b.mjs';
import { PlanSummaryCard } from './PlanSummaryCard';
import { flowBEvent, shownOnce } from './flow-b-actions';

/**
 * Flow B on /onboarding's It works step (WP-H, plan section 5): B1, the
 * second-inbox card, then B2, the plan summary. Its own module so ItWorksStep
 * loads it lazily: the cards, the consumer-domain list and the checkout copy
 * stay out of /onboarding's first load (scripts/bundle-budget.json).
 */
export default function OnboardingFlowB({ status, flowB = null, userEmail = '', finish, startSecondInbox }) {
  return (
    <>
      <SecondInboxCard status={status} flowB={flowB} finish={finish} startSecondInbox={startSecondInbox} />
      {flowB && !flowB.summaryDismissedAt && (
        <PlanSummaryCard
          flowB={flowB}
          surface="onboarding"
          businessShaped={isBusinessShapedWorkspace({ inboxes: status?.inboxes?.items ?? [], ownerEmail: userEmail })}
        />
      )}
    </>
  );
}

/**
 * B1. Below the success, a quiet card: "Most people connect a second inbox:
 * work and personal in one chat." Free covers one inbox, so at the cap the
 * card says the next one is on a paid plan before it is pressed, and the
 * press opens the dashboard's upgrade panel (with Continue on Free) rather
 * than a form that can only be refused.
 */
function SecondInboxCard({ status, flowB, finish, startSecondInbox }) {
  const t = useTranslations('onboarding.steps.it_works.secondInbox');
  const atCap = Boolean(flowB) && nextInboxNeedsUpgrade(status?.inboxes?.count ?? 0, flowB.inboxCaps?.free ?? 1);
  useEffect(() => {
    shownOnce('second_inbox_prompt', 'second_inbox_prompt_shown');
  }, []);
  const open = () => {
    flowBEvent('second_inbox_prompt_clicked');
    if (atCap) finish(SECOND_INBOX_DASHBOARD_HREF);
    else startSecondInbox?.();
  };
  return (
    <div className="onb-second-inbox" data-testid="onb-second-inbox" data-at-cap={atCap ? 'true' : 'false'}>
      <p className="onb-strong">{t('title')}</p>
      <p className="onb-muted">{t('lead')}</p>
      {atCap && <p className="onb-hint">{t('paidNote')}</p>}
      <div className="onb-actions">
        <button type="button" className="btn btn-secondary" onClick={open} data-testid="onb-second-inbox-open">
          {t('cta')}
        </button>
      </div>
    </div>
  );
}
