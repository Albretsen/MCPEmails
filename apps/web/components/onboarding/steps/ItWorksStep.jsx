'use client';

import { useTranslations } from 'next-intl';
import { StepPlaceholder } from './StepPlaceholder';

/**
 * A9, "It works": the success line, the next prompt, tomorrow's ritual, then
 * the dashboard. WP-F fills this in. Its last action must be `finish()`,
 * which stamps onboarding_completed_at (so the dashboard stops showing
 * "Finish setup") and goes to /dashboard.
 * Props: the panel contract in ./index.js.
 */
export function ItWorksStep({ step, clientLabel, finish }) {
  const t = useTranslations('onboarding');
  return <StepPlaceholder step={step} clientLabel={clientLabel} onContinue={finish} continueLabel={t('nav.done')} />;
}
