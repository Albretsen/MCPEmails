'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

/**
 * The dashboard's two doors into the /onboarding flow. Both read
 * `workspace.onboarding` from the dashboard page (app/dashboard/[[...section]]/page.js):
 *   { flow, convert, finishSetup, canReset }
 *
 * FinishSetupLink: a small link that reopens the setup dialog while a workspace
 * in the new flow has not finished it (closing the dialog leaves the flow; this
 * is how they get back).
 *
 * ResetOnboardingCard: Settings, internal owners only. POST /api/onboarding
 * {reset} clears the onboarding and first-call markers
 * (src/lib/onboarding/reset.ts), then opens /onboarding.
 */
export function FinishSetupLink({ onboarding }) {
  const t = useTranslations('dashboardChrome');
  if (!onboarding?.finishSetup) return null;
  return (
    <div style={{ padding: '12px 32px 0' }}>
      <a href="/dashboard?setup=1" data-testid="finish-setup-link" style={{ fontSize: 13.5, color: 'var(--brand)' }}>
        {t('onboardingEntry.finishSetup')}
      </a>
    </div>
  );
}

export function ResetOnboardingCard({ onboarding, fetchImpl = globalThis.fetch, navigate = (href) => window.location.assign(href) }) {
  const t = useTranslations('dashboardChrome');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!onboarding?.canReset) return null;

  async function reset() {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetchImpl('/api/onboarding', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'reset' }),
      });
      if (!res.ok) throw new Error(String(res.status));
      navigate('/onboarding');
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }

  return (
    <div className="card" data-testid="reset-onboarding-card" style={{ marginTop: 16, padding: 16 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('onboardingEntry.resetTitle')}</div>
      <p style={{ margin: '0 0 12px', color: 'var(--fg-3)', fontSize: 13.5 }}>{t('onboardingEntry.resetBody')}</p>
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={reset}>
        {t('onboardingEntry.resetButton')}
      </button>
      {failed && <p role="alert" style={{ margin: '8px 0 0', color: 'var(--red-700)', fontSize: 13 }}>{t('onboardingEntry.resetFailed')}</p>}
    </div>
  );
}
