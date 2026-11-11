'use client';

import { useTranslations } from 'next-intl';
import { inboxHealth } from '@/lib/inboxes/health';

/**
 * The broken-inbox alert's dashboard banner (src/lib/retention/inbox-alert.ts).
 *
 * The Inboxes page already shows an amber line for inboxes that need
 * reconnecting. For workspaces in the `alert` arm of the inbox_broken_alert
 * experiment this puts a red one above EVERY other page too, naming the inbox
 * when there is one, with the Reconnect action right there. The holdout arm
 * sees what everyone saw before.
 *
 * Shown while the condition holds, read from the live inbox array on the page
 * (the same rule as the Inboxes page: status 'error' or the refused-password
 * marker, parked inboxes excluded). Not dismissible. Viewers cannot reconnect,
 * so they do not get it.
 *
 * Pure decision, exported for the test: null, { kind: 'one', inbox } or
 * { kind: 'many', count }.
 */
export function brokenInboxBannerState({ enabled, route, userRole, inboxes }) {
  if (enabled !== true) return null;
  if (route === 'inboxes') return null;
  if (userRole === 'viewer') return null;
  const broken = (inboxes ?? []).filter(
    (ib) => !ib.parked && inboxHealth({ provider: ib.provider, status: ib.status, last_error: ib.lastError }) === 'reconnect_required',
  );
  if (broken.length === 0) return null;
  return broken.length === 1 ? { kind: 'one', inbox: broken[0] } : { kind: 'many', count: broken.length };
}

export function BrokenInboxBanner({ enabled, route, userRole, inboxes, onReconnect, onOpenInboxes }) {
  const tr = useTranslations('dashboardChrome');
  const state = brokenInboxBannerState({ enabled, route, userRole, inboxes });
  if (!state) return null;

  const text = state.kind === 'one'
    ? tr('app.inboxAlertOne', { address: state.inbox.address ?? '' })
    : tr('app.inboxAlertMany', { count: String(state.count) });

  return (
    <div style={{ padding: '16px 32px 0' }}>
      <div
        role="alert"
        data-inbox-alert={state.kind}
        style={{
          background: 'var(--red-50)',
          border: '1px solid var(--red-500)',
          borderRadius: 10,
          padding: '10px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: 1, minWidth: 200, fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--red-700)' }}>
          {text}
        </div>
        {state.kind === 'one' ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onReconnect?.(state.inbox)}>
            {tr('app.inboxAlertReconnect')}
          </button>
        ) : (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onOpenInboxes?.()}>
            {tr('app.inboxAlertOpenInboxes')}
          </button>
        )}
      </div>
    </div>
  );
}
