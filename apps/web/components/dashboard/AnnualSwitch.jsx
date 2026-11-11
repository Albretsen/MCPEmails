'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon, Btn } from '../Primitives';
import { planDisplayName } from '@/lib/stripe/plans';
import { annualOfferFromPrices } from '@/lib/stripe/annual-offer';

/**
 * The monthly-to-annual switch: a permanent card on the billing page and one
 * dismissible notice on the Overview. Owner only, decided on the server
 * (src/lib/billing/annual-switch.ts); `annualSwitch` is null for everyone
 * else and these render nothing.
 *
 * The saving is computed from the live catalogue the page already holds
 * (`stripePrices`, annualOfferFromPrices), never written down. No saving, no
 * card: the card exists to state it.
 *
 * Nothing is preselected and nothing is charged from here. The card's button
 * starts the billing page's normal two-step quote (handleUpgrade), which shows
 * the exact amount before the customer confirms; the notice only opens the
 * billing page.
 */

/**
 * Pure: what the card and notice show, or null.
 *
 * @param {{ planId?: string } | null | undefined} annualSwitch
 * @param {Record<string, any> | null | undefined} stripePrices
 */
export function annualSwitchView(annualSwitch, stripePrices) {
  const planId = annualSwitch?.planId;
  if (planId !== 'personal' && planId !== 'solo' && planId !== 'pro') return null;
  const offer = annualOfferFromPrices(stripePrices?.[planId]);
  if (!offer || offer.savingPercent == null) return null;
  return { planId, plan: planDisplayName(planId), percent: offer.savingPercent };
}

/** Fire-and-forget report to /api/billing/annual-switch. Never throws. */
export function reportAnnualSwitch(event, surface, workspaceId) {
  if (!workspaceId) return;
  try {
    fetch('/api/billing/annual-switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, surface, workspaceId }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // A lost beacon is a missing funnel row, never a broken page.
  }
}

function useShownOnce(view, surface, workspaceId) {
  const sent = useRef(false);
  useEffect(() => {
    if (!view || sent.current) return;
    sent.current = true;
    reportAnnualSwitch('shown', surface, workspaceId);
  }, [view, surface, workspaceId]);
}

const boxStyle = {
  padding: '14px 16px',
  background: 'var(--brand-soft)',
  border: '1px solid rgba(37,71,229,0.18)',
  borderRadius: 10,
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  flexWrap: 'wrap',
  fontFamily: 'var(--font-sans)',
};

/**
 * The billing page card. Permanent: no close button.
 *
 * @param {{ annualSwitch: any, stripePrices: any, workspaceId: string | null, onSwitch: (planId: string) => void, busy: boolean, disabled: boolean }} props
 */
export function AnnualSwitchCard({ annualSwitch, stripePrices, workspaceId, onSwitch, busy = false, disabled = false }) {
  const tr = useTranslations('dashboardChrome');
  const view = annualSwitchView(annualSwitch, stripePrices);
  useShownOnce(view, 'billing', workspaceId);
  if (!view) return null;
  return (
    <div data-annual-switch={view.planId} style={boxStyle}>
      <div style={{ flex: '1 1 260px', minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-1)', marginBottom: 4 }}>
          {tr('annualSwitch.title')}
        </div>
        <div style={{ fontSize: 13, color: 'var(--fg-1)', lineHeight: 1.5 }}>
          {tr('annualSwitch.body', { plan: view.plan, percent: view.percent })}
        </div>
        <div style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: 4, lineHeight: 1.5 }}>
          {tr('annualSwitch.current')}
        </div>
      </div>
      <Btn
        variant="primary"
        onClick={() => {
          reportAnnualSwitch('clicked', 'billing', workspaceId);
          onSwitch(view.planId);
        }}
        disabled={disabled}
      >
        {busy ? tr('annualSwitch.busy') : tr('annualSwitch.cta')}
      </Btn>
    </div>
  );
}

/**
 * The Overview notice. Dismissible; the server decides whether a dismissed
 * notice has come back (once, after 60 days).
 *
 * @param {{ annualSwitch: any, stripePrices: any, workspaceId: string | null, onOpenBilling: () => void }} props
 */
export function AnnualSwitchNotice({ annualSwitch, stripePrices, workspaceId, onOpenBilling }) {
  const tr = useTranslations('dashboardChrome');
  const [dismissed, setDismissed] = useState(false);
  const view = annualSwitch?.noticeVisible === true && !dismissed ? annualSwitchView(annualSwitch, stripePrices) : null;
  useShownOnce(view, 'overview', workspaceId);
  if (!view) return null;
  return (
    <div role="status" data-annual-switch-notice={view.planId} style={{ ...boxStyle, margin: '14px 24px 0', padding: '12px 14px', gap: 10 }}>
      <div style={{ flex: '1 1 260px', fontSize: 13, color: 'var(--fg-1)', lineHeight: 1.5 }}>
        {tr('annualSwitch.noticeBody', { plan: view.plan, percent: view.percent })}
      </div>
      <Btn
        variant="secondary"
        onClick={() => {
          reportAnnualSwitch('clicked', 'overview', workspaceId);
          onOpenBilling();
        }}
      >
        {tr('annualSwitch.noticeCta')}
      </Btn>
      <button
        type="button"
        className="toast-close"
        data-annual-switch-close="true"
        onClick={() => {
          setDismissed(true);
          reportAnnualSwitch('dismissed', 'overview', workspaceId);
        }}
        aria-label={tr('annualSwitch.close')}
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}
