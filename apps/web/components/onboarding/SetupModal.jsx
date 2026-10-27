'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import OnboardingLocaleProvider from '../i18n/OnboardingLocaleProvider';
import { OnboardingApp } from './OnboardingApp';
import { fetchOnboardingStatus } from './useOnboardingStatus';
import '../../styles/onboarding.css';
import '../../styles/onboarding-inbox.css';

/**
 * The setup flow as a dialog on top of the dashboard. The dashboard
 * (components/dashboard/App.jsx) loads this file lazily, only when the page
 * came with `?setup=1` for a workspace in the new onboarding flow, so none of
 * it is in the dashboard's first load.
 *
 * Rendered into <body>; everything else on the page is made inert while it is
 * open, so Tab and screen readers stay inside the dialog.
 *
 * Props: `setup` from app/dashboard/[[...section]]/page.js
 * ({ variant, initialClient, provider, requestedStep, chatReturn, userEmail }),
 * plus mcpUrl, flowB, onClose(href?) and onMounted() (called once the dialog is
 * on screen, so the dashboard can drop its placeholder scrim).
 */
export default function SetupModal({ setup, mcpUrl, flowB = null, onClose, onMounted }) {
  // One status read, started when the dialog mounts; never rejects.
  const [statusPromise] = useState(() => fetchOnboardingStatus().catch((error) => {
    console.error('[onboarding] initial status failed', error instanceof Error ? error.message : String(error));
    return null;
  }));
  const [host, setHost] = useState(null);

  useEffect(() => {
    const el = document.createElement('div');
    el.className = 'onb-host';
    document.body.appendChild(el);
    const others = Array.from(document.body.children).filter((node) => node !== el && !node.inert);
    for (const node of others) node.inert = true;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // The portal target exists only after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHost(el);
    onMounted?.();
    return () => {
      for (const node of others) node.inert = false;
      document.body.style.overflow = overflow;
      el.remove();
    };
  }, [onMounted]);

  if (!host) return null;
  return createPortal(
    <OnboardingLocaleProvider>
      <OnboardingApp
        variant={setup.variant}
        initialClient={setup.initialClient}
        provider={setup.provider}
        mcpUrl={mcpUrl}
        userEmail={setup.userEmail}
        statusPromise={statusPromise}
        requestedStep={setup.requestedStep}
        flowB={flowB}
        chatReturn={setup.chatReturn}
        onClose={onClose}
      />
    </OnboardingLocaleProvider>,
    host,
  );
}
