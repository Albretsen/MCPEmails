'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { hasReusableInbox } from '@/lib/onboarding/flow';
import { StepPlaceholder } from './StepPlaceholder';

/**
 * A3-A5: which inbox, provider panel, connecting + proof. WP-E fills this in.
 * Props: the panel contract in ./index.js.
 *
 * Already built here (keep it): after Settings > Reset onboarding the
 * workspace may still have an inbox connected. The step then first offers
 * "Use <address>" (goNext with it) or "Connect another inbox" (hide the offer
 * and show the normal connect form).
 */
export function InboxStep({ step, status, clientLabel, goNext }) {
  const t = useTranslations('onboarding');
  const [connectAnother, setConnectAnother] = useState(false);
  const reusable = !connectAnother && hasReusableInbox(status) ? status.inboxes.items[0] : null;

  if (reusable) {
    return (
      <section className="onb-panel" data-step={step} data-testid="onb-reuse-inbox">
        <h1 className="onb-title">{t('steps.inbox.reuseTitle')}</h1>
        <div className="onb-actions">
          <button type="button" className="btn btn-primary" onClick={goNext}>
            {t('steps.inbox.reuse', { address: reusable.address })}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setConnectAnother(true)}>
            {t('steps.inbox.connectAnother')}
          </button>
        </div>
      </section>
    );
  }

  // WP-E: replace the placeholder with the A3-A5 connect flow, and call
  // goNext() once the inbox is connected and the proof card was shown.
  return <StepPlaceholder step={step} clientLabel={clientLabel} onContinue={goNext} />;
}
