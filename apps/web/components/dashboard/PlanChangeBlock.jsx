'use client';

/**
 * "Change or pause your plan" on the billing card, plus the banners for a
 * pause or switch that is already booked, and the optional cancel reason card.
 *
 * Everything comes from two read-only quotes (POST /api/billing/pause and
 * /api/billing/downgrade with action 'quote'). Either route answers 404 while
 * its flag is off for this account, and then its half renders nothing, so with
 * both flags off this component renders nothing at all (the reason card aside,
 * which hides itself too when its route is missing).
 *
 * Copy rules (plan section 0): neutral, no countdowns, no "are you sure", no
 * offer keyed to anything. The cancel itself stays in the Stripe portal and on
 * /cancel, untouched; "Switch to Free" here is a second, plainer route to the
 * same cancel at period end.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn, Icon } from '../Primitives';
import { useAppLocale } from '../i18n/AppLocaleProvider';
import { FREE_ACTION_ALLOWANCE, planDisplayName } from '@/lib/stripe/plans';

/** The reasons, fixed, one tap each (plan section 4). */
export const CANCEL_REASONS = [
  'too_expensive',
  'not_using_enough',
  'missing_feature',
  'reliability',
  'switched_tool',
  'temporary_need',
  'other',
];

const REASON_DETAIL_MAX = 500;

function formatMoney(cents, currency, locale) {
  const code = (currency || 'usd').toUpperCase();
  try {
    return new Intl.NumberFormat(locale || 'en', { style: 'currency', currency: code }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${code}`;
  }
}

function formatDate(iso, locale) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(locale || 'en', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data };
}

function readStored(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode or blocked storage: the card simply shows again next time.
  }
}

/**
 * Inbox picker: which inboxes stay active at the target plan's cap, per
 * workspace. Preselected by the server's ranking (most used in 30 days).
 * Never a blocker: the confirm button works with the preselection.
 */
function InboxKeepPicker({ inboxes, cap, selected, onChange, label }) {
  const t = useTranslations('dashboard');
  const byWorkspace = useMemo(() => {
    const map = new Map();
    for (const inbox of inboxes) {
      if (!map.has(inbox.workspaceId)) map.set(inbox.workspaceId, []);
      map.get(inbox.workspaceId).push(inbox);
    }
    return map;
  }, [inboxes]);

  const toggle = (inbox) => {
    const next = new Set(selected);
    if (next.has(inbox.id)) {
      next.delete(inbox.id);
    } else {
      const inWorkspace = byWorkspace.get(inbox.workspaceId) ?? [];
      const chosen = inWorkspace.filter((i) => next.has(i.id));
      // At the cap, the newest pick replaces the oldest one.
      if (cap != null && chosen.length >= cap) next.delete(chosen[0].id);
      next.add(inbox.id);
    }
    onChange(next);
  };

  return (
    <div data-inbox-picker style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.5 }}>{label}</div>
      {inboxes.map((inbox) => (
        <label
          key={inbox.id}
          style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-1)' }}
        >
          <input
            type="checkbox"
            data-inbox-id={inbox.id}
            checked={selected.has(inbox.id)}
            onChange={() => toggle(inbox)}
          />
          <span>{inbox.email || t('billing.planChange.inboxUnnamed')}</span>
        </label>
      ))}
    </div>
  );
}

function Dialog({ title, children, confirmLabel, onConfirm, onCancel, busy }) {
  const t = useTranslations('dashboard');
  return (
    <div className="scrim" onClick={busy ? undefined : onCancel}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 460 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="plan-change-dialog-title"
      >
        <div className="modal-h">
          <h2 id="plan-change-dialog-title">{title}</h2>
        </div>
        <div className="modal-body">{children}</div>
        <div className="modal-foot">
          <Btn variant="secondary" onClick={onCancel} disabled={busy}>
            {t('billing.planChange.close')}
          </Btn>
          <Btn variant="primary" onClick={onConfirm} busy={busy}>
            {confirmLabel}
          </Btn>
        </div>
      </div>
    </div>
  );
}

function Text({ children }) {
  return <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>{children}</div>;
}

/** The optional reason card, shown once after a cancel is scheduled. */
function CancelReasonCard({ storageKey }) {
  const t = useTranslations('dashboard');
  const [hidden, setHidden] = useState(true);
  const [state, setState] = useState('idle'); // idle | other | sending | done
  const [detail, setDetail] = useState('');

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHidden(readStored(storageKey) === '1');
  }, [storageKey]);

  if (hidden) return null;

  const dismiss = () => {
    writeStored(storageKey, '1');
    setHidden(true);
  };

  const send = async (reason, text) => {
    setState('sending');
    try {
      const res = await postJson('/api/billing/feedback', {
        reason,
        ...(text ? { detail: text.slice(0, REASON_DETAIL_MAX) } : {}),
        source: 'billing_card',
      });
      if (!res.ok) {
        // No feedback route on this deploy (404), or it refused: hide quietly.
        dismiss();
        return;
      }
      writeStored(storageKey, '1');
      setState('done');
    } catch {
      dismiss();
    }
  };

  return (
    <div
      data-cancel-reason
      style={{
        padding: '14px 16px',
        background: 'var(--bg-sunken)',
        border: '1px solid var(--border-1)',
        borderRadius: 10,
        fontFamily: 'var(--font-sans)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {state === 'done' ? (
        <div data-reason-thanks style={{ fontSize: 13.5, color: 'var(--fg-1)' }}>{t('billing.cancelReason.thanks')}</div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <div style={{ fontSize: 13.5, color: 'var(--fg-1)', lineHeight: 1.5, flex: 1 }}>{t('billing.cancelReason.prompt')}</div>
            <button
              type="button"
              data-reason-dismiss
              onClick={dismiss}
              aria-label={t('billing.cancelReason.dismiss')}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)', padding: 2, lineHeight: 1 }}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {CANCEL_REASONS.map((reason) => (
              <Btn
                key={reason}
                size="sm"
                variant="secondary"
                disabled={state === 'sending'}
                onClick={() => (reason === 'other' ? setState('other') : send(reason))}
              >
                <span data-reason={reason}>{t(`billing.cancelReason.reasons.${reason}`)}</span>
              </Btn>
            ))}
          </div>
          {state === 'other' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <textarea
                data-reason-detail
                maxLength={REASON_DETAIL_MAX}
                value={detail}
                onChange={(e) => setDetail(e.target.value)}
                placeholder={t('billing.cancelReason.otherPlaceholder')}
                rows={3}
                style={{ fontFamily: 'var(--font-sans)', fontSize: 13, padding: 8, borderRadius: 8, border: '1px solid var(--border-1)' }}
              />
              <div>
                <Btn size="sm" variant="primary" onClick={() => send('other', detail.trim())}>
                  {t('billing.cancelReason.send')}
                </Btn>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function PlanChangeBlock({ toast }) {
  const t = useTranslations('dashboard');
  const { locale } = useAppLocale();
  const [pause, setPause] = useState(null);
  const [downgrade, setDowngrade] = useState(null);
  const [dialog, setDialog] = useState(null); // pause | extend | resume | downgrade | keep | free
  const [months, setMonths] = useState(1);
  const [keep, setKeep] = useState(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    postJson('/api/billing/pause', { action: 'quote' })
      .then((res) => live && setPause(res.ok ? res.data : null))
      .catch(() => live && setPause(null));
    postJson('/api/billing/downgrade', { action: 'quote' })
      .then((res) => live && setDowngrade(res.ok ? res.data : null))
      .catch(() => live && setDowngrade(null));
    return () => {
      live = false;
    };
  }, []);

  const money = (cents, currency) => (typeof cents === 'number' ? formatMoney(cents, currency, locale) : '');
  const date = (iso) => formatDate(iso, locale);

  const openDialog = (kind) => {
    if (kind === 'pause') {
      setMonths(pause?.pauseOptions?.[0]?.months ?? 1);
      setKeep(new Set((pause?.inboxes?.inboxes ?? []).filter((i) => i.keep).map((i) => i.id)));
    }
    if (kind === 'extend') setMonths(pause?.extendOptions?.[0]?.months ?? 1);
    if (kind === 'downgrade') {
      setKeep(new Set((downgrade?.inboxes?.inboxes ?? []).filter((i) => i.keep).map((i) => i.id)));
    }
    setDialog(kind);
  };

  const run = async (url, body, successKey, values) => {
    setBusy(true);
    try {
      const res = await postJson(url, { ...body, confirm: true });
      if (!res.ok || !res.data?.changed) {
        toast?.({ message: t('billing.planChange.failed'), variant: 'error' });
        setBusy(false);
        return;
      }
      toast?.({ message: t(successKey, values), variant: 'success' });
      setDialog(null);
      // The webhook projects the change; give it a moment, then reload.
      window.setTimeout(() => window.location.reload(), 2000);
    } catch {
      toast?.({ message: t('billing.networkError'), variant: 'error' });
      setBusy(false);
    }
  };

  const keepIds = () => [...keep];

  const paused = pause && (pause.state === 'paused' || pause.state === 'scheduled');
  const pending = downgrade?.pending ?? null;
  const offerPause = Boolean(pause?.canPause);
  const offerDowngrade = Boolean(downgrade?.canDowngrade);
  const offerFree = Boolean(downgrade?.canSwitchFree) && !paused && !pending;
  const cancelScheduled = Boolean(downgrade?.cancelScheduled ?? pause?.cancelScheduled);
  const reasonKey = `mcpe_cancel_reason_${downgrade?.periodEnd ?? pause?.periodEnd ?? 'x'}`;

  if (!pause && !downgrade) return null;

  const pauseOption = pause?.pauseOptions?.find((o) => o.months === months) ?? null;
  const extendOption = pause?.extendOptions?.find((o) => o.months === months) ?? null;
  const pauseInboxes = pause?.inboxes;
  const downgradeInboxes = downgrade?.inboxes;
  const toPlanName = planDisplayName(downgrade?.downgrade?.toPlan ?? pending?.toPlan ?? 'personal');
  const fromPlanName = planDisplayName(pending?.fromPlan ?? downgrade?.downgrade?.fromPlan ?? 'solo');

  const blockStyle = {
    padding: '14px 16px',
    background: 'var(--bg-sunken)',
    borderRadius: 10,
    border: '1px solid var(--border-1)',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    fontFamily: 'var(--font-sans)',
  };

  return (
    <>
      {paused && (
        <div data-pause-banner style={blockStyle}>
          <div style={{ fontSize: 13.5, color: 'var(--fg-1)', lineHeight: 1.5 }}>
            {pause.state === 'paused'
              ? t('billing.planChange.pausedUntil', { date: date(pause.billsAt) })
              : t('billing.planChange.pauseScheduled', { start: date(pause.pausedFrom), date: date(pause.billsAt) })}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Btn size="sm" variant="secondary" onClick={() => openDialog('resume')}>
              {t('billing.planChange.resumeEarly')}
            </Btn>
            {pause.canExtend && (
              <Btn size="sm" variant="ghost" onClick={() => openDialog('extend')}>
                {t('billing.planChange.extend')}
              </Btn>
            )}
          </div>
        </div>
      )}

      {pending && (
        <div data-downgrade-banner style={blockStyle}>
          <div style={{ fontSize: 13.5, color: 'var(--fg-1)', lineHeight: 1.5 }}>
            {t('billing.planChange.switchesOn', { plan: planDisplayName(pending.toPlan), date: date(pending.effectiveAt) })}
          </div>
          <div>
            <Btn size="sm" variant="secondary" onClick={() => openDialog('keep')}>
              {t('billing.planChange.keepPlan', { plan: fromPlanName })}
            </Btn>
          </div>
        </div>
      )}

      {!paused && !pending && (offerPause || offerDowngrade || offerFree) && (
        <div data-plan-change style={blockStyle}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--fg-1)' }}>{t('billing.planChange.title')}</div>
          <div style={{ fontSize: 12.5, color: 'var(--fg-3)', lineHeight: 1.5 }}>{t('billing.planChange.sub')}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {offerPause && (
              <Btn size="sm" variant="secondary" onClick={() => openDialog('pause')}>
                <span data-action="pause">{t('billing.planChange.pause')}</span>
              </Btn>
            )}
            {offerDowngrade && (
              <Btn size="sm" variant="secondary" onClick={() => openDialog('downgrade')}>
                <span data-action="downgrade">{t('billing.planChange.switchTo', { plan: toPlanName })}</span>
              </Btn>
            )}
            {offerFree && (
              <Btn size="sm" variant="ghost" onClick={() => openDialog('free')}>
                <span data-action="free">{t('billing.planChange.switchToFree')}</span>
              </Btn>
            )}
          </div>
        </div>
      )}

      {cancelScheduled && !paused && <CancelReasonCard storageKey={reasonKey} />}

      {dialog === 'pause' && pause && (
        <Dialog
          title={t('billing.planChange.pauseTitle')}
          confirmLabel={t('billing.planChange.pauseConfirm')}
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={() => run('/api/billing/pause', { action: 'pause', months, keepInboxIds: keepIds() }, 'billing.planChange.pausedToast', { date: date(pauseOption?.billsAt) })}
        >
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} role="radiogroup">
            {pause.pauseOptions.map((option) => (
              <Btn
                key={option.months}
                size="sm"
                variant={option.months === months ? 'primary' : 'secondary'}
                onClick={() => setMonths(option.months)}
              >
                <span data-months={option.months}>{t('billing.planChange.months', { count: option.months })}</span>
              </Btn>
            ))}
          </div>
          <Text>
            {t('billing.planChange.pauseStarts', { date: date(pause.periodEnd) })}{' '}
            {t('billing.planChange.resumesAt', {
              date: date(pauseOption?.billsAt),
              amount: money(pause.amountCents, pause.currency),
            })}
          </Text>
          <Text>{t('billing.planChange.pauseWhile', { actions: FREE_ACTION_ALLOWANCE })}</Text>
          {pause.cancelScheduled && <Text>{t('billing.planChange.replacesCancel')}</Text>}
          {pauseInboxes?.overCap && (
            <InboxKeepPicker
              inboxes={pauseInboxes.inboxes}
              cap={pauseInboxes.cap}
              selected={keep}
              onChange={setKeep}
              label={t('billing.planChange.pickFree')}
            />
          )}
        </Dialog>
      )}

      {dialog === 'extend' && pause && (
        <Dialog
          title={t('billing.planChange.extendTitle')}
          confirmLabel={t('billing.planChange.extendConfirm')}
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={() => run('/api/billing/pause', { action: 'extend', months }, 'billing.planChange.extendedToast', { date: date(extendOption?.billsAt) })}
        >
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} role="radiogroup">
            {pause.extendOptions.map((option) => (
              <Btn
                key={option.months}
                size="sm"
                variant={option.months === months ? 'primary' : 'secondary'}
                onClick={() => setMonths(option.months)}
              >
                {t('billing.planChange.moreMonths', { count: option.months })}
              </Btn>
            ))}
          </div>
          <Text>
            {t('billing.planChange.resumesAt', {
              date: date(extendOption?.billsAt),
              amount: money(pause.amountCents, pause.currency),
            })}
          </Text>
        </Dialog>
      )}

      {dialog === 'resume' && pause && (
        <Dialog
          title={t('billing.planChange.resumeTitle')}
          confirmLabel={t('billing.planChange.resumeConfirm')}
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={() => run('/api/billing/pause', { action: 'resume_early' }, 'billing.planChange.resumedToast', {})}
        >
          <Text>
            {pause.state === 'scheduled'
              ? t('billing.planChange.resumeScheduledBody', { date: date(pause.periodEnd) })
              : t('billing.planChange.resumePausedBody', {
                  date: date(pause.periodEnd),
                  amount: money(pause.amountCents, pause.currency),
                })}
          </Text>
        </Dialog>
      )}

      {dialog === 'downgrade' && downgrade?.downgrade && (
        <Dialog
          title={t('billing.planChange.switchTitle', { plan: toPlanName })}
          confirmLabel={t('billing.planChange.switchConfirm', { plan: toPlanName })}
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={() => run('/api/billing/downgrade', { action: 'confirm', keepInboxIds: keepIds() }, 'billing.planChange.switchedToast', { plan: toPlanName, date: date(downgrade.downgrade.effectiveAt) })}
        >
          <Text>
            {t(downgrade.downgrade.interval === 'year' ? 'billing.planChange.switchBodyYear' : 'billing.planChange.switchBodyMonth', {
              plan: toPlanName,
              current: fromPlanName,
              date: date(downgrade.downgrade.effectiveAt),
              amount: money(downgrade.downgrade.amountCents, downgrade.downgrade.currency),
            })}
          </Text>
          {downgradeInboxes?.overCap && (
            <InboxKeepPicker
              inboxes={downgradeInboxes.inboxes}
              cap={downgradeInboxes.cap}
              selected={keep}
              onChange={setKeep}
              label={t('billing.planChange.pickDowngrade', {
                plan: toPlanName,
                count: downgradeInboxes.cap ?? downgrade.downgrade.inboxCap,
                date: date(downgrade.downgrade.effectiveAt),
              })}
            />
          )}
        </Dialog>
      )}

      {dialog === 'keep' && pending && (
        <Dialog
          title={t('billing.planChange.keepPlan', { plan: fromPlanName })}
          confirmLabel={t('billing.planChange.keepPlan', { plan: fromPlanName })}
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={() => run('/api/billing/downgrade', { action: 'undo' }, 'billing.planChange.keptToast', { plan: fromPlanName })}
        >
          <Text>{t('billing.planChange.keepBody', { plan: fromPlanName })}</Text>
        </Dialog>
      )}

      {dialog === 'free' && downgrade && (
        <Dialog
          title={t('billing.planChange.freeTitle')}
          confirmLabel={t('billing.planChange.freeConfirm')}
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={() => run('/api/billing/downgrade', { action: 'switch_free' }, 'billing.planChange.freeToast', { date: date(downgrade.periodEnd) })}
        >
          <Text>{t('billing.planChange.freeBody', { date: date(downgrade.periodEnd) })}</Text>
        </Dialog>
      )}
    </>
  );
}
