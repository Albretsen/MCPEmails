/**
 * Rollout gates for pause and switch-to-Personal.
 *
 *   BILLING_PAUSE_ENABLED      offers Pause on the billing card and the API
 *   BILLING_DOWNGRADE_ENABLED  offers Switch to Personal / Switch to Free
 *
 * Off by default. While off, internal accounts (isInternalAccount: our
 * domains, GROWTH_INTERNAL_EMAILS) still see both, the same internal-first
 * rollout as Help & support (src/lib/support/release-gate.ts).
 *
 * READ AT CALL TIME, never captured at module scope: a warm lambda keeps
 * whatever it booted with (see src/lib/billing/lifecycle-mode.ts).
 *
 * The gates only decide what is OFFERED. The Stripe webhook projects any
 * pause or pending downgrade it sees, flag or no flag, because a customer who
 * already paused must never get the paid plan for free when a flag goes off.
 */
import { isInternalAccount } from '@/lib/analytics/internal-accounts';

function envOn(name: string): boolean {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

export function pauseEnabledFor(email: string | null | undefined): boolean {
  return envOn('BILLING_PAUSE_ENABLED') || isInternalAccount(email ?? null);
}

export function downgradeEnabledFor(email: string | null | undefined): boolean {
  return envOn('BILLING_DOWNGRADE_ENABLED') || isInternalAccount(email ?? null);
}
