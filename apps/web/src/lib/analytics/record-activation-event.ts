import type { ActivationEventStage, ActivationProvider } from '@/lib/analytics/activation-events';
import type { AuthFailureReason } from '@/lib/email/auth-failure';
import type { OnboardingClient } from '@/lib/onboarding/state';

/**
 * Browser helper for the four activation-rescue stages. Fire and forget: it
 * never throws and never rejects, so a component can call it inline.
 *
 *   recordActivationEvent('connect_fix_shown', { provider: 'gmail', authReason: 'account_password_used', phase: 'authentication' })
 *   recordActivationEvent('connect_fix_link_clicked', { provider: 'yahoo' })
 *   recordActivationEvent('first_call_prompt_copied', { client: 'claude' })
 *   recordActivationEvent('waiting_state_shown', { client: 'chatgpt' })
 *
 * The server takes the workspace from the session, validates every field
 * against closed lists, and dedupes (waiting_state_shown: once per workspace
 * per day). Type-only imports keep the server code out of the client bundle.
 */
export type ActivationEventFields = {
  /** Required for connect_fix_shown and connect_fix_link_clicked. */
  provider?: ActivationProvider;
  /** Required for first_call_prompt_copied and waiting_state_shown. */
  client?: OnboardingClient;
  /** connect_fix_* only: the failure the panel explains. */
  authReason?: AuthFailureReason | null;
  /** connect_fix_* only: coarse protocol phase, e.g. 'authentication'. */
  phase?: string | null;
  /** app_password_link_clicked only: which link (APP_PASSWORD_LINKS). */
  link?: string | null;
};

export function recordActivationEvent(stage: ActivationEventStage, fields: ActivationEventFields = {}): void {
  try {
    fetch('/api/analytics/activation-event', {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        stage,
        provider: fields.provider,
        client: fields.client,
        auth_reason: fields.authReason ?? undefined,
        phase: fields.phase ?? undefined,
        link: fields.link ?? undefined,
      }),
    }).catch(() => {
      // Analytics is never worth a console error in a user's browser.
    });
  } catch {
    // No fetch (an old browser, or a test DOM): nothing to record.
  }
}
