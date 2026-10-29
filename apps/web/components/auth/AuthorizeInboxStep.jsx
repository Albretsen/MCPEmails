'use client';

import { useCallback, useState } from 'react';
import { InboxStep } from '../onboarding/steps/InboxStep';
import { chipClientLabel } from '@/lib/onboarding/clients.mjs';
import '../../styles/onboarding.css';
import '../../styles/onboarding-inbox.css';

const noop = () => {};
const VARIANT = Object.freeze({ flow: 'new', convert: 'off' });

/**
 * The onboarding inbox step (components/onboarding/steps/InboxStep.jsx, WP-E)
 * inside the OAuth consent card, for a workspace in the new onboarding flow
 * with no mailbox yet. Loaded on demand by AuthorizeApp, so the step's code
 * and CSS reach only the consent screens that show it. Its `onboarding`
 * strings come from the /authorize layout (AuthorizeLocaleProvider).
 *
 * It renders the step through the same panel contract /onboarding uses
 * (components/onboarding/steps/index.js), plus `returnTo`: the /authorize URL
 * a Microsoft sign-in comes back to. `onConnected` is the step's goNext();
 * `onProof` runs when the connected inbox's proof card shows.
 */
export default function AuthorizeInboxStep({ client = null, userEmail = '', returnTo, onConnected, onProof = null }) {
  const [status, setStatus] = useState(null);
  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/onboarding/status', { cache: 'no-store', headers: { Accept: 'application/json' } });
      const next = res.ok ? await res.json() : null;
      setStatus(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  return (
    <div className="az-onb" data-testid="az-inbox-step">
      <InboxStep
        step="inbox"
        status={status}
        refreshStatus={refreshStatus}
        setPolling={noop}
        client={client ?? 'claude'}
        clientLabel={chipClientLabel(client)}
        provider={null}
        variant={VARIANT}
        mcpUrl=""
        userEmail={userEmail}
        goNext={onConnected}
        goTo={noop}
        finish={onConnected}
        returnTo={returnTo}
        onProof={onProof}
      />
    </div>
  );
}
