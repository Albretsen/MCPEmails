'use client';

import { Suspense, use, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { ONBOARDING_STEPS, initialStep, isOnboardingStep, nextStep } from '@/lib/onboarding/flow';
import { chipClientLabel, normalizeChipClient } from '@/lib/onboarding/clients.mjs';
import { ClientChip } from './ClientChip';
import { STEP_PANELS } from './steps';
import { useOnboardingStatus } from './useOnboardingStatus';
import { clientChanged, onboardingCompleted, stepViewed } from './onboarding-actions';

/**
 * The /onboarding client island (app/onboarding/page.tsx renders it).
 *
 * The header (title, step count, client chip, "Go to dashboard") paints at
 * once; the step body waits for the one streamed status read
 * (`statusPromise`, src/lib/onboarding/status.ts) inside a Suspense boundary.
 *
 * Props (all from the server page):
 *   variant         { flow, convert }  clientOnboardingVariant()
 *   initialClient   chip id, inferred server-side (clients.mjs)
 *   provider        ?provider= slug or null
 *   mcpUrl          MCP endpoint
 *   userEmail       signed-in address
 *   statusPromise   Promise<OnboardingStatus | null>
 *   requestedStep   ?step= when valid (QA: jump straight to a step), else null
 *   flowB           Flow B facts (flow-b-server.ts) or null (WP-H)
 *
 * @param {{
 *   variant: { flow: string, convert: string },
 *   initialClient: string,
 *   provider?: string | null,
 *   mcpUrl: string,
 *   userEmail?: string,
 *   statusPromise: Promise<unknown>,
 *   requestedStep?: string | null,
 *   flowB?: object | null,
 * }} props
 */
export function OnboardingApp({ variant, initialClient, provider = null, mcpUrl, userEmail = '', statusPromise, requestedStep = null, flowB = null }) {
  const t = useTranslations('onboarding');
  const [client, setClient] = useState(normalizeChipClient(initialClient) ?? 'claude');

  const changeClient = useCallback((id) => {
    const next = normalizeChipClient(id);
    if (!next) return;
    setClient(next);
    clientChanged(next);
    // Keep the choice on a reload or a shared link, like ?provider=.
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('client', next);
      window.history.replaceState(window.history.state, '', url.toString());
    } catch {
      // A URL we cannot rewrite only loses the reload convenience.
    }
  }, []);

  return (
    <div className="onb-root">
      <header className="onb-header">
        <a className="onb-brand" href="/dashboard">MCPEmails</a>
        <a className="onb-exit" href="/dashboard" data-testid="onb-exit">{t('shell.exit')}</a>
      </header>
      <main className="onb-main">
        <ClientChip client={client} onChange={changeClient} />
        <Suspense fallback={<p className="onb-muted onb-loading">{t('shell.loading')}</p>}>
          <OnboardingSteps
            statusPromise={statusPromise}
            requestedStep={requestedStep}
            client={client}
            provider={provider}
            variant={variant}
            mcpUrl={mcpUrl}
            userEmail={userEmail}
            flowB={flowB}
          />
        </Suspense>
      </main>
    </div>
  );
}

function OnboardingSteps({ statusPromise, requestedStep, client, provider, variant, mcpUrl, userEmail, flowB }) {
  const t = useTranslations('onboarding');
  const router = useRouter();
  const initialStatus = use(statusPromise);
  const { status, refreshStatus, setPolling } = useOnboardingStatus(initialStatus);
  const [step, setStep] = useState(() => (isOnboardingStep(requestedStep) ? requestedStep : initialStep(initialStatus)));

  // One onboarding_step_viewed per step per page load.
  const seen = useRef(new Set());
  useEffect(() => {
    if (seen.current.has(step)) return;
    seen.current.add(step);
    stepViewed(step);
  }, [step]);

  // Flow B, B1: the inbox step opened again from It works for a second inbox.
  const [secondInbox, setSecondInbox] = useState(false);
  const goNext = useCallback(() => {
    setSecondInbox(false);
    setStep((current) => nextStep(current) ?? current);
  }, []);
  const goTo = useCallback((id) => {
    if (!isOnboardingStep(id)) return;
    if (id !== 'inbox') setSecondInbox(false);
    setStep(id);
  }, []);
  const startSecondInbox = useCallback(() => {
    setSecondInbox(true);
    setStep('inbox');
  }, []);
  // `href` is a /dashboard path (B1 at the inbox cap opens the dashboard's
  // upgrade panel); anything else, such as a click event, is /dashboard.
  const finish = useCallback(async (href) => {
    setPolling(null);
    await onboardingCompleted();
    router.push(typeof href === 'string' && href.startsWith('/dashboard') ? href : '/dashboard');
  }, [setPolling, router]);

  const Panel = STEP_PANELS[step];
  const index = ONBOARDING_STEPS.indexOf(step);

  return (
    <>
      {initialStatus === null && <p className="onb-error" role="alert">{t('shell.statusError')}</p>}
      <p className="onb-progress">{t('shell.progress', { current: index + 1, total: ONBOARDING_STEPS.length })}</p>
      <Panel
        step={step}
        status={status}
        refreshStatus={refreshStatus}
        setPolling={setPolling}
        client={client}
        clientLabel={chipClientLabel(client)}
        provider={provider}
        variant={variant}
        mcpUrl={mcpUrl}
        userEmail={userEmail}
        goNext={goNext}
        goTo={goTo}
        finish={finish}
        flowB={flowB}
        secondInbox={secondInbox}
        startSecondInbox={startSecondInbox}
      />
    </>
  );
}
