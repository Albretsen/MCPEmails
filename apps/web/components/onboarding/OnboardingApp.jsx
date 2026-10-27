'use client';

import { Suspense, use, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { initialStep, isOnboardingStep, nextStep, stepAfterInbox } from '@/lib/onboarding/flow';
import { chipClientLabel, normalizeChipClient } from '@/lib/onboarding/clients.mjs';
import { ClientChip } from './ClientChip';
import { ClientLogo, InboxLogo, MarkLogo } from './ClientLogo';
import { STEP_PANELS } from './steps';
import { useOnboardingStatus } from './useOnboardingStatus';
import { clientChanged, onboardingCompleted, stepViewed } from './onboarding-actions';
import { ChatReturnPanel } from './ChatReturnPanel';
import { rememberChatReturn, takeChatReturn } from '@/lib/onboarding/chat-return.mjs';

/**
 * The setup flow, as a dialog over the dashboard (SetupModal.jsx mounts it).
 *
 * The frame (close button, scrim) paints at once; the step body waits for the
 * one status read (`statusPromise`, src/lib/onboarding/status.ts) inside a
 * Suspense boundary.
 *
 * Three steps the user sees, five step ids underneath (flow.ts, unchanged so
 * the funnel categories keep their meaning):
 *   1 inbox · 2 add_to_ai · 3 first_prompt and wait · then it_works, the finish.
 *
 * Props:
 *   variant         { flow, convert }  clientOnboardingVariant()
 *   initialClient   chip id, inferred server-side (clients.mjs)
 *   provider        ?provider= slug or null
 *   mcpUrl          MCP endpoint
 *   userEmail       signed-in address
 *   statusPromise   Promise<OnboardingStatus | null>
 *   requestedStep   ?step= when valid (QA: jump straight to a step), else null
 *   flowB           Flow B facts (flow-b-server.ts) or null (WP-H)
 *   chatReturn      { client, provider } | null: a verified chat connect link
 *                   (from=chat). Only the inbox step, then ChatReturnPanel.
 *   onClose(href?)  close the dialog; `href` is a /dashboard path to open.
 */
export function OnboardingApp({ variant, initialClient, provider = null, mcpUrl, userEmail = '', statusPromise, requestedStep = null, flowB = null, chatReturn = null, onClose }) {
  const t = useTranslations('onboarding');
  const [client, setClient] = useState(normalizeChipClient(initialClient) ?? 'claude');
  const dialogRef = useRef(null);

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

  // Escape closes, unless something inside (the chip's menu) used it first.
  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true });
    const onKey = (event) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="onb-overlay">
      <div className="onb-scrim" aria-hidden="true" />
      <div className="onb-dialog" role="dialog" aria-modal="true" aria-label={t('shell.title')} tabIndex={-1} ref={dialogRef} data-testid="onb-dialog">
        <button type="button" className="onb-close" onClick={() => onClose?.()} aria-label={t('shell.exit')} data-testid="onb-exit">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
        <Suspense fallback={<div className="onb-loading" aria-busy="true" />}>
          <OnboardingSteps
            statusPromise={statusPromise}
            requestedStep={requestedStep}
            client={client}
            changeClient={changeClient}
            provider={provider}
            variant={variant}
            mcpUrl={mcpUrl}
            userEmail={userEmail}
            flowB={flowB}
            chatReturn={chatReturn}
            onClose={onClose}
          />
        </Suspense>
      </div>
    </div>
  );
}

/** Step id -> the 0-based place in the three steps the user sees; 3 is done. */
const STAGE = { inbox: 0, add_to_ai: 1, first_prompt: 2, wait: 2, it_works: 3 };
const STAGES = 3;

function OnboardingSteps({ statusPromise, requestedStep, client, changeClient, provider, variant, mcpUrl, userEmail, flowB, chatReturn = null, onClose }) {
  const t = useTranslations('onboarding');
  const initialStatus = use(statusPromise);
  const { status, refreshStatus, setPolling } = useOnboardingStatus(initialStatus);
  // goNext reads the latest status without being rebuilt on every poll.
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  const [step, setStep] = useState(() => (chatReturn ? 'inbox' : isOnboardingStep(requestedStep) ? requestedStep : initialStep(initialStatus)));
  // From a chat link: the inbox step is the whole flow, then back to the chat.
  // `chatDone` holds the client to send them back to.
  const [chatDone, setChatDone] = useState(null);
  // Kept across the Microsoft sign-in, which returns with ?connected=outlook
  // but without the link's parameters (src/lib/onboarding/chat-return.mjs).
  useEffect(() => {
    if (chatReturn) {
      rememberChatReturn(chatReturn);
      return;
    }
    try {
      if (new URL(window.location.href).searchParams.get('connected') !== 'outlook') return;
    } catch {
      return;
    }
    const back = takeChatReturn();
    // Read once, after a full-page return from Microsoft.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (back) setChatDone({ client: back.client });
  }, [chatReturn]);

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
    if (chatReturn) {
      setPolling(null);
      takeChatReturn();
      setChatDone({ client: chatReturn.client });
      return;
    }
    setStep((current) => (current === 'inbox' ? stepAfterInbox(statusRef.current) : nextStep(current) ?? current));
  }, [chatReturn, setPolling]);
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
  // upgrade panel); anything else, such as a click event, closes onto the
  // dashboard behind.
  const finish = useCallback(async (href) => {
    setPolling(null);
    await onboardingCompleted();
    onClose?.(typeof href === 'string' && href.startsWith('/dashboard') ? href : undefined);
  }, [setPolling, onClose]);

  if (chatDone) {
    return <ChatReturnPanel client={chatDone.client ?? client} onClose={onClose} />;
  }

  const Panel = STEP_PANELS[step];
  const stage = STAGE[step];
  const clientLabel = chipClientLabel(client);

  return (
    <>
      <div className="onb-top">
        {!chatReturn && (
          <div
            className="onb-bars"
            role="progressbar"
            aria-valuemin={1}
            aria-valuemax={STAGES}
            aria-valuenow={Math.min(stage + 1, STAGES)}
            aria-label={t('shell.progress', { current: Math.min(stage + 1, STAGES), total: STAGES })}
            data-testid="onb-progress-bars"
          >
            {Array.from({ length: STAGES }, (_, i) => (
              <span key={i} className={i < stage ? 'is-done' : i === stage ? 'is-current' : ''} />
            ))}
          </div>
        )}
      </div>
      <Chain stage={chatReturn ? 0 : stage} client={client} />
      {initialStatus === null && <p className="onb-error" role="alert">{t('shell.statusError')}</p>}
      <div className="onb-stage" key={secondInbox ? 'inbox-2' : step}>
        <Panel
          step={step}
          status={status}
          refreshStatus={refreshStatus}
          setPolling={setPolling}
          client={client}
          clientLabel={clientLabel}
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
      </div>
      {step !== 'it_works' && (
        <div className="onb-foot">
          <ClientChip client={client} onChange={changeClient} />
          <button type="button" className="onb-skip" onClick={() => onClose?.()} data-testid="onb-skip">{t('shell.skip')}</button>
        </div>
      )}
    </>
  );
}

/**
 * Inbox, MCPEmails, the AI app: what this flow wires together. Each link
 * fills in as its step is done; the one being made animates.
 */
function Chain({ stage, client }) {
  const link = (i) => (stage > i ? 'is-done' : stage === i ? 'is-current' : '');
  return (
    <div className="onb-chain" aria-hidden="true" data-stage={stage}>
      <span className={`onb-node${stage > 0 ? ' is-done' : ''}`}><InboxLogo size={44} /></span>
      <span className={`onb-link ${link(0)}`} />
      <span className={`onb-node${stage > 1 ? ' is-done' : ''}`}><MarkLogo size={44} /></span>
      <span className={`onb-link ${link(1)}`} />
      <span className={`onb-node${stage > 2 ? ' is-done' : ''}`}><ClientLogo client={client} size={44} /></span>
    </div>
  );
}
