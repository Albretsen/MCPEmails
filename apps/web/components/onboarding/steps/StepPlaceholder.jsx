'use client';

import { useTranslations } from 'next-intl';

/**
 * The stand-in body for a step that is not built yet: its title, one line,
 * and a Continue button so the flow can be walked end to end. A panel stops
 * using this once its work package fills it in.
 */
export function StepPlaceholder({ step, clientLabel, onContinue, continueLabel, children }) {
  const t = useTranslations('onboarding');
  return (
    <section className="onb-panel" data-step={step}>
      <h1 className="onb-title">{t(`steps.${step}.title`, { client: clientLabel })}</h1>
      <p className="onb-muted">{t('placeholder')}</p>
      {children}
      <div className="onb-actions">
        <button type="button" className="btn btn-primary" onClick={onContinue}>
          {continueLabel ?? t('nav.continue')}
        </button>
      </div>
    </section>
  );
}
