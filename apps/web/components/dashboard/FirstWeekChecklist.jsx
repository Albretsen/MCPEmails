'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon, Btn } from '../Primitives';
import { firstWeekChecklist, TARGET_ACTIVE_DAYS } from '@/lib/onboarding/first-week-checklist';

/**
 * FirstWeekChecklist: a dismissible card on the Overview for an owner in the
 * first 14 days after their first payment.
 *
 * Which items show, and which are ticked, is decided in
 * lib/onboarding/first-week-checklist.ts from real counts
 * (GET /api/onboarding/first-week). The inbox count and the plan's inbox limit
 * come from the live arrays the page already holds. Dismissing hides it at
 * once and is saved server-side (POST to the same route), so it stays hidden
 * on every device.
 *
 * Renders nothing while loading, on any error, for anyone but the owner, and
 * once every required item is done.
 *
 * Props:
 *   inboxes            live inbox array (for the count and the Reconnect target)
 *   maxInboxes         plan inbox allowance, null for unlimited
 *   userRole           only 'owner' sees the card
 *   onReconnect(inbox) App's reconnect flow for one inbox
 *   onGoToInboxes      fallback when the failing inbox is not known
 *   onGoToAutomations  opens the Automations panel
 *   onConnect(source)  opens the connect modal
 */

const PROMPT_KEYS = ['prompt1', 'prompt2', 'prompt3'];

function Tick({ done, num }) {
  return (
    <span
      aria-hidden="true"
      style={{
        flexShrink: 0, width: 22, height: 22, borderRadius: 999,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 11.5, fontWeight: 600,
        background: done ? 'var(--brand)' : 'var(--bg-surface)',
        color: done ? '#fff' : 'var(--fg-3)',
        border: done ? '1px solid var(--brand)' : '1px solid var(--border-1)',
      }}
    >
      {done ? <Icon name="check" size={13} /> : num}
    </span>
  );
}

function PromptRow({ text, t }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    try {
      navigator.clipboard?.writeText(text)?.catch?.(() => {});
    } catch {
      /* clipboard unavailable: the text is on screen to select by hand */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div
      data-first-week-prompt
      style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
        background: 'var(--bg-surface)', border: '1px solid var(--border-1)', borderRadius: 8,
      }}
    >
      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.45 }}>{text}</span>
      <Btn variant="ghost" size="sm" icon={copied ? 'check' : 'copy'} onClick={copy}>
        {copied ? t('firstWeek.copied') : t('firstWeek.copy')}
      </Btn>
    </div>
  );
}

export function FirstWeekChecklist({ inboxes = [], maxInboxes = null, userRole, onReconnect, onGoToInboxes, onGoToAutomations, onConnect }) {
  const t = useTranslations('dashboard');
  const isOwner = userRole === 'owner';
  const [counts, setCounts] = useState(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!isOwner) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/onboarding/first-week', { cache: 'no-store' });
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled && body?.eligible === true && body.counts) setCounts(body.counts);
      } catch {
        /* the card is optional: no data, no card */
      }
    })();
    return () => { cancelled = true; };
  }, [isOwner]);

  const state = firstWeekChecklist({
    counts: dismissed ? null : counts,
    now: new Date(),
    isOwner,
    inboxCount: inboxes?.length ?? 0,
    maxInboxes,
  });
  if (!state.visible) return null;

  const dismiss = () => {
    setDismissed(true);
    fetch('/api/onboarding/first-week', { method: 'POST' }).catch(() => {});
  };

  const reconnect = (inboxId) => {
    const target = (inboxes ?? []).find((ib) => ib.id === inboxId);
    if (target && onReconnect) onReconnect(target);
    else onGoToInboxes?.();
  };

  const rowStyle = (done) => ({
    display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 14px',
    background: 'var(--bg-sunken)', borderRadius: 10, border: '1px solid var(--border-1)',
    opacity: done ? 0.65 : 1,
  });
  const titleStyle = (done) => ({ fontSize: 13.5, fontWeight: 600, color: done ? 'var(--fg-3)' : 'var(--fg-1)' });
  const descStyle = { fontSize: 12.5, color: 'var(--fg-3)', marginTop: 2, lineHeight: 1.5 };

  return (
    <div className="card" style={{ marginTop: 16 }} data-first-week-checklist>
      <div className="card-h">
        <div>
          <div className="title">{t('firstWeek.title')}</div>
          <div className="sub">{t('firstWeek.sub')}</div>
        </div>
        <div className="grow"></div>
        <Btn variant="ghost" size="sm" onClick={dismiss}>{t('firstWeek.dismiss')}</Btn>
      </div>
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {state.items.map((item, index) => {
          const num = index + 1;
          if (item.id === 'first_call') {
            return (
              <div key={item.id} data-item={item.id} data-done={String(item.done)} style={rowStyle(item.done)}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <Tick done={item.done} num={num} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={titleStyle(item.done)}>{t('firstWeek.firstCallTitle')}</div>
                    {!item.done && <div style={descStyle}>{t('firstWeek.firstCallDesc')}</div>}
                  </div>
                </div>
              </div>
            );
          }
          if (item.id === 'inbox_attention') {
            return (
              <div key={item.id} data-item={item.id} data-done="false" style={rowStyle(false)}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <span aria-hidden="true" style={{ flexShrink: 0, width: 22, height: 22, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--amber-600, #d97706)' }}>
                    <Icon name="bell" size={16} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={titleStyle(false)}>{t('firstWeek.attentionTitle')}</div>
                    <div style={descStyle}>{t('firstWeek.attentionDesc')}</div>
                  </div>
                  <div style={{ flexShrink: 0 }}>
                    <Btn variant="primary" size="sm" icon="refresh" onClick={() => reconnect(item.inboxId)}>{t('firstWeek.reconnect')}</Btn>
                  </div>
                </div>
              </div>
            );
          }
          if (item.id === 'active_days') {
            return (
              <div key={item.id} data-item={item.id} data-done={String(item.done)} style={rowStyle(item.done)}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <Tick done={item.done} num={num} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={titleStyle(item.done)}>{t('firstWeek.daysTitle')}</div>
                    <div style={descStyle} data-progress>{t('firstWeek.daysProgress', { count: item.progress ?? 0, target: TARGET_ACTIVE_DAYS })}</div>
                  </div>
                </div>
                {!item.done && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 34 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg-3)' }}>{t('firstWeek.promptsLead')}</div>
                    {PROMPT_KEYS.map((k) => <PromptRow key={k} text={t(`firstWeek.${k}`)} t={t} />)}
                  </div>
                )}
              </div>
            );
          }
          if (item.id === 'automation') {
            return (
              <div key={item.id} data-item={item.id} data-done={String(item.done)} style={rowStyle(item.done)}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <Tick done={item.done} num={num} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={titleStyle(item.done)}>{t('firstWeek.automationTitle')}</div>
                    {!item.done && <div style={descStyle}>{t('firstWeek.automationDesc')}</div>}
                  </div>
                  {!item.done && (
                    <div style={{ flexShrink: 0 }}>
                      <Btn variant="secondary" size="sm" onClick={() => onGoToAutomations?.()}>{t('firstWeek.openAutomations')}</Btn>
                    </div>
                  )}
                </div>
              </div>
            );
          }
          // another_inbox: optional, last, no price.
          return (
            <div key={item.id} data-item={item.id} data-done="false" style={rowStyle(false)}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <Tick done={false} num={num} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={titleStyle(false)}>{t('firstWeek.inboxTitle', { count: item.inboxLimit })}</div>
                  <div style={descStyle}>{t('firstWeek.inboxDesc')}</div>
                </div>
                <div style={{ flexShrink: 0 }}>
                  <Btn variant="secondary" size="sm" icon="plus" onClick={() => onConnect?.('other')}>{t('firstWeek.connectInbox')}</Btn>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
