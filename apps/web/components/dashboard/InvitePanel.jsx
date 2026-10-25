'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon, Btn } from '../Primitives';
import { useAppLocale } from '../i18n/AppLocaleProvider';
import { Link } from '@/i18n/navigation';
import { planDisplayName } from '@/lib/stripe/plans';

/*
 * The referral program in the dashboard (referral_v1): the Invite page, the
 * Overview tile that points at it, and the "Have a referral code?" field.
 *
 * Everything here reads GET /api/referrals and writes POST /api/referrals.
 * Rendered only while the workspace's `referral_enabled` rollout flag is on;
 * the API answers `enabled: false` otherwise and this file then shows nothing.
 *
 * NEVER A FRIEND'S IDENTITY. The summary rows carry no name, email or
 * workspace for the friend (my_referral_summary() does not return one), and
 * every row reads "A friend, joined <date>". Keep it that way: a referrer must
 * not learn who signed up, only that someone did.
 */

/** Days a paying workspace must have paid before the Overview tile shows. */
export const TILE_PAID_DAYS = 14;
/** Successful sends a paying workspace needs before the tile shows. */
export const TILE_MIN_SENDS = 10;
/** Days with any activity a Free workspace needs before the tile shows. */
export const TILE_FREE_ACTIVE_DAYS = 5;
/** localStorage key: the Overview tile was dismissed on this browser. */
export const TILE_DISMISSED_KEY = 'mcpe-referral-tile-dismissed';

/**
 * Whether the Overview tile is earned. A paying workspace: 10 or more
 * successful sends and paid for at least 14 days. Free: active on 5 or more
 * days of the window `dailyCounts` covers. `paidSince` is null when the first
 * paid checkout is unknown (a comp, or an account older than the funnel), and
 * then the paid branch never shows the tile.
 */
export function referralTileEligible({ plan, successfulSends = 0, paidSince = null, dailyCounts = [], now = Date.now() }) {
  if (plan && plan !== 'free') {
    if (successfulSends < TILE_MIN_SENDS || !paidSince) return false;
    const paidAt = Date.parse(paidSince);
    return Number.isFinite(paidAt) && now - paidAt >= TILE_PAID_DAYS * 86_400_000;
  }
  const activeDays = (dailyCounts ?? []).filter((d) => (d?.count ?? 0) > 0).length;
  return activeDays >= TILE_FREE_ACTIVE_DAYS;
}

/** A calendar date in the viewer's language, read in UTC like every reward boundary. */
function formatDay(iso, locale) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleDateString(locale || 'en', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/**
 * Cents as money in the viewer's language, in the credit's own currency
 * (`creditCurrency` from GET /api/referrals: the customer's billing currency,
 * USD or EUR). An unknown or missing code reads as USD.
 */
export function formatCredit(cents, currency, locale) {
  const value = Math.max(0, Number(cents) || 0) / 100;
  const code = typeof currency === 'string' && /^[a-z]{3}$/i.test(currency) ? currency.toUpperCase() : 'USD';
  try {
    return new Intl.NumberFormat(locale || 'en', { style: 'currency', currency: code }).format(value);
  } catch {
    return `${value.toFixed(2)} ${code}`;
  }
}

/**
 * The status line for one referral row. `held` never arrives (the summary
 * shows it as `charged`), and an unknown status reads as waiting rather than
 * as nothing.
 */
export function referralStatusText(row, t, locale) {
  switch (row?.status) {
    case 'qualified':
      return row.reward_kind === 'personal_month' && row.entitlement_until
        ? t('referral.statusQualifiedPersonal', { plan: planDisplayName('personal'), date: formatDay(row.entitlement_until, locale) })
        : t('referral.statusQualifiedCredit');
    case 'capped':
      return t('referral.statusCapped');
    case 'voided':
      return t('referral.statusVoided');
    default:
      return row?.qualifies_at
        ? t('referral.statusRewardOn', { date: formatDay(row.qualifies_at, locale) })
        : t('referral.statusWaiting');
  }
}

/**
 * Fire-and-forget beacon for referral_link_viewed / referral_link_copied.
 * Same shape as the second-mailbox prompt's: a keepalive POST whose body is one
 * word from a closed list; errors are swallowed.
 */
export function sendReferralBeacon(action) {
  try {
    fetch('/api/analytics/referral', {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    }).catch(() => {});
  } catch {
    // No fetch: nothing to record.
  }
}

/**
 * GET /api/referrals, once per mount while `active`. `status` is 'loading',
 * 'ready' or 'error'; `data` is the response body once ready.
 */
export function useReferralSummary(active = true) {
  const [state, setState] = useState({ status: active ? 'loading' : 'idle', data: null });
  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/referrals', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      setState({ status: 'ready', data: await res.json() });
    } catch {
      setState({ status: 'error', data: null });
    }
  }, []);
  useEffect(() => {
    if (!active) return;
    // A fetch on mount; the setState lands after it resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [active, load]);
  return { ...state, reload: load };
}

/* ---------------- Invite page ---------------- */

export function InvitePanel() {
  const t = useTranslations('dashboard');
  const { locale } = useAppLocale();
  const { status, data } = useReferralSummary(true);
  const [copied, setCopied] = useState(false);
  const viewed = useRef(false);

  const link = status === 'ready' && data?.enabled ? data.link : null;
  useEffect(() => {
    if (!link || viewed.current) return;
    viewed.current = true;
    sendReferralBeacon('viewed');
  }, [link]);

  const copy = () => {
    if (!link) return;
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      sendReferralBeacon('copied');
    };
    try {
      navigator.clipboard.writeText(link).then(done).catch(() => {});
    } catch {
      // No clipboard API: the link is still selectable on screen.
    }
  };

  const header = (
    <div className="page-header">
      <div className="grow">
        <div className="page-title">{t('referral.title')}</div>
        <div className="page-sub">{t('referral.sub')}</div>
      </div>
    </div>
  );

  if (status === 'loading') {
    return <div className="page">{header}<div className="page-sub" role="status">{t('referral.loading')}</div></div>;
  }
  if (status === 'error') {
    return <div className="page">{header}<div className="page-sub" role="alert">{t('referral.loadError')}</div></div>;
  }
  if (!data?.enabled) return <div className="page">{header}</div>;

  const referrals = Array.isArray(data.referrals) ? data.referrals : [];
  const cap = data.cap ?? 0;

  return (
    <div className="page" data-invite-panel="">
      {header}

      <div className="card">
        <div className="card-body" style={{ display: 'grid', gap: 12 }}>
          <div>
            <div style={{ fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 600, color: 'var(--fg-3)', marginBottom: 6 }}>
              {t('referral.linkLabel')}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <code
                data-referral-link=""
                style={{
                  flex: '1 1 260px', minWidth: 0, padding: '10px 12px', borderRadius: 8,
                  background: 'var(--bg-sunken, var(--bg-surface))', border: '1px solid var(--border-1)',
                  fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--fg-1)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', userSelect: 'all',
                }}
              >
                {link}
              </code>
              <Btn variant="primary" size="sm" icon={copied ? 'check' : 'copy'} onClick={copy}>
                {copied ? t('referral.copied') : t('referral.copy')}
              </Btn>
            </div>
          </div>
          {data.code ? (
            <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-2)' }} data-referral-code="">
              {t('referral.codeLine', { code: data.code })}
            </div>
          ) : null}
          <div style={{ fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--fg-3)', lineHeight: 1.5 }}>
            {t('referral.howPaid', { free: planDisplayName('free'), personal: planDisplayName('personal') })}
            {' '}
            {t('referral.rules', { cap })}
            {' '}
            <Link href="/terms#referral-program">{t('referral.termsLink')}</Link>
          </div>
        </div>
      </div>

      <div className="stat-grid" style={{ marginTop: 16 }}>
        <div className="stat">
          <div className="label">{t('referral.creditLabel')}</div>
          <div className="value" data-referral-credit="">{formatCredit(data.creditBalanceCents, data.creditCurrency, locale)}</div>
        </div>
        <div className="stat">
          <div className="label">{t('referral.rewardsLabel')}</div>
          <div className="value" data-referral-rewards="">{t('referral.rewardsValue', { count: data.rewardsLast365d ?? 0, cap })}</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-h">
          <div className="title">{t('referral.listTitle')}</div>
        </div>
        {referrals.length === 0 ? (
          <div className="empty" style={{ padding: '24px 20px' }} data-referral-empty="">
            <p style={{ fontSize: 12.5 }}>{t('referral.empty')}</p>
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {referrals.map((row) => (
              <li
                key={row.id}
                className="act-row"
                data-referral-status={row.status}
                style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between' }}
              >
                <span>{t('referral.friendJoined', { date: formatDay(row.attached_at, locale) })}</span>
                <span style={{ color: 'var(--fg-3)' }}>{referralStatusText(row, t, locale)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ---------------- Overview: tile and code entry ---------------- */

/**
 * The Overview's pointer to the Invite page. The caller decides eligibility
 * (referralTileEligible); this decides only whether it was dismissed, which is
 * remembered on this browser. Until storage has been read it renders nothing,
 * so a dismissed tile never flashes.
 */
export function ReferralTile({ onOpen }) {
  const t = useTranslations('dashboard');
  const [dismissed, setDismissed] = useState(null);
  useEffect(() => {
    let value = false;
    try { value = window.localStorage.getItem(TILE_DISMISSED_KEY) === '1'; } catch { /* storage blocked: show it */ }
    // Browser storage is only readable after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDismissed(value);
  }, []);
  if (dismissed !== false) return null;
  const dismiss = () => {
    setDismissed(true);
    try { window.localStorage.setItem(TILE_DISMISSED_KEY, '1'); } catch { /* not remembered: gone for this view */ }
  };
  return (
    <div
      data-referral-tile=""
      style={{
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10,
        padding: '8px 12px', marginBottom: 12,
        background: 'var(--bg-surface)', borderRadius: 10,
        border: '1px dashed var(--border-2, var(--border-1))',
      }}
    >
      <Icon name="gift" size={14} color="var(--fg-3)" />
      <div style={{ flex: '1 1 260px', minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600, color: 'var(--fg-1)' }}>{t('referral.tileTitle')}</div>
        <div style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)', marginTop: 2 }}>{t('referral.tileBody')}</div>
      </div>
      <Btn variant="secondary" size="sm" onClick={onOpen}>{t('referral.tileCta')}</Btn>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('referral.tileDismiss')}
        title={t('referral.tileDismiss')}
        data-referral-tile-dismiss=""
        style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 4, display: 'flex', color: 'var(--fg-3)' }}
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

/**
 * Settings > Billing: the referral credit still waiting on the Stripe
 * customer, with a link to the Invite page. Shows only while the API says the
 * program is on for this workspace and the credit is above zero; a failed
 * balance read (null) shows nothing. `onOpenInvite` switches the section in
 * place; without it the link is a plain navigation.
 */
export function BillingReferralCredit({ onOpenInvite }) {
  const t = useTranslations('dashboard');
  const { locale } = useAppLocale();
  const { status, data } = useReferralSummary(true);
  const cents = Number(data?.creditBalanceCents);
  if (status !== 'ready' || !data?.enabled || !(cents > 0)) return null;
  const open = (event) => {
    if (!onOpenInvite) return;
    event.preventDefault();
    onOpenInvite();
  };
  return (
    <div
      data-billing-referral-credit=""
      style={{
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
        padding: '0 2px', margin: '0 0 16px',
        fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-2)',
      }}
    >
      <Icon name="gift" size={14} color="var(--fg-3)" />
      <span>{t('referral.billingCredit', { amount: formatCredit(cents, data.creditCurrency, locale) })}</span>
      <a href="/dashboard/invite" onClick={open} data-billing-referral-link="">{t('referral.billingCreditLink')}</a>
    </div>
  );
}

/**
 * "Have a referral code?": one line, shown while the API says a code can
 * still be entered (before the first paid charge and within the entry
 * window). Any refusal reads as the same one line, so the field cannot be used
 * to probe which codes exist or why one was refused.
 */
export function ReferralCodeEntry({ onApplied }) {
  const t = useTranslations('dashboard');
  const [code, setCode] = useState('');
  const [state, setState] = useState('idle'); // idle | busy | applied | refused | failed

  const submit = async (e) => {
    e?.preventDefault?.();
    const value = code.trim();
    if (!value || state === 'busy') return;
    setState('busy');
    try {
      const res = await fetch('/api/referrals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: value }),
      });
      if (res.ok) {
        setState('applied');
        onApplied?.();
      } else {
        setState(res.status >= 500 ? 'failed' : 'refused');
      }
    } catch {
      setState('failed');
    }
  };

  if (state === 'applied') {
    return (
      <div role="status" data-referral-code-entry="applied" style={{ fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--fg-2)', marginBottom: 12 }}>
        {t('referral.codeEntryApplied')}
      </div>
    );
  }
  return (
    <form onSubmit={submit} data-referral-code-entry="" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
      <label htmlFor="referral-code" style={{ fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--fg-3)' }}>
        {t('referral.codeEntryLabel')}
      </label>
      <input
        id="referral-code"
        className="input"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder={t('referral.codeEntryPlaceholder')}
        autoComplete="off"
        spellCheck={false}
        maxLength={16}
        style={{ width: 140, textTransform: 'uppercase' }}
      />
      <Btn type="submit" variant="secondary" size="sm" busy={state === 'busy'} disabled={!code.trim()}>
        {t('referral.codeEntryApply')}
      </Btn>
      {state === 'refused' || state === 'failed' ? (
        <span role="alert" style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--red-500)' }}>
          {state === 'refused' ? t('referral.codeEntryError') : t('referral.codeEntryNetwork')}
        </span>
      ) : null}
    </form>
  );
}

/**
 * Everything the Overview shows for the program, in one place: the code field
 * while a code can be entered, otherwise the tile when it is earned.
 */
export function OverviewReferral({ eligible, onOpenInvite }) {
  const { status, data } = useReferralSummary(true);
  if (status !== 'ready' || !data?.enabled) return null;
  // No refetch after a code is applied: canEnterCode would turn false and
  // take the confirmation line away with the field.
  if (data.canEnterCode) return <ReferralCodeEntry />;
  return eligible ? <ReferralTile onOpen={onOpenInvite} /> : null;
}
