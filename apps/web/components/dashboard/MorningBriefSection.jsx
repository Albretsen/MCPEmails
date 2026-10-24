'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Btn } from '../Primitives';
import { Link } from '@/i18n/navigation';
import { useAppLocale } from '../i18n/AppLocaleProvider';
import { pricingCompareHref } from '@/lib/billing/upgrade-intent.mjs';

/**
 * Settings > Workspace > Morning brief (Pro feature `morning_brief`): a daily
 * summary MCPEmails puts into one of the workspace's inboxes at the chosen
 * local hour. Not an email send.
 *
 * Renders nothing unless the feature is VISIBLE for the workspace
 * (`proFeatures.visible`), so before launch no customer sees it or fetches
 * anything. Visible below Pro: the form shows disabled with an upgrade link,
 * and the route refuses the write anyway. Only owners and admins can save.
 */

const BRIEF_LOCALES = ['en', 'nb', 'fr', 'es', 'de'];
const KNOWN_ERRORS = new Set([
  'unavailable',
  'pro_feature_required',
  'invalid_vip',
  'too_many_vips',
  'inbox_required',
  'invalid_inbox',
  'invalid_timezone',
]);

export function morningBriefAvailable(proFeatures) {
  return proFeatures?.visible === true;
}

/** The browser's IANA zone, or UTC. */
export function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function timeZoneOptions(current) {
  let zones = [];
  try {
    zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  } catch {
    zones = [];
  }
  const all = new Set(['UTC', ...zones]);
  if (current) all.add(current);
  return [...all].sort();
}

export function MorningBriefSection({ workspace, inboxes = [], proFeatures = null }) {
  if (!morningBriefAvailable(proFeatures) || !workspace?.id) return null;
  return <MorningBriefForm workspace={workspace} inboxes={inboxes} allowed={proFeatures?.allowed === true} />;
}

function MorningBriefForm({ workspace, inboxes, allowed }) {
  const t = useTranslations('dashboard');
  const { locale } = useAppLocale();
  const endpoint = `/api/workspaces/${encodeURIComponent(workspace.id)}/morning-brief`;
  const [loaded, setLoaded] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);

  const targets = inboxes.filter(i => i.status !== 'pending');

  useEffect(() => {
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoaded(null);
    setLoadError(null);
    fetch(endpoint)
      .then(async res => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(KNOWN_ERRORS.has(body.error) ? body.error : 'load');
        return body;
      })
      .then(body => {
        if (!live) return;
        const s = body.settings ?? { ...body.defaults, timezone: browserTimeZone() };
        setLoaded(body);
        setForm({
          enabled: s.enabled === true,
          hour: Number.isInteger(s.hour) ? s.hour : 7,
          timezone: s.timezone || browserTimeZone(),
          inbox_id: s.inbox_id ?? '',
          vipText: (s.vip_senders ?? []).join('\n'),
        });
      })
      .catch(err => { if (live) setLoadError(KNOWN_ERRORS.has(err.message) ? err.message : 'load'); });
    return () => { live = false; };
  }, [endpoint]);

  const canEdit = allowed && loaded?.allowed === true && loaded?.can_manage === true;
  const update = patch => { setForm(f => ({ ...f, ...patch })); setStatus(null); };

  const save = async () => {
    if (saving || !canEdit || !form) return;
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: form.enabled,
          hour: form.hour,
          timezone: form.timezone,
          locale: BRIEF_LOCALES.includes(locale) ? locale : 'en',
          inbox_id: form.inbox_id || null,
          vip_senders: form.vipText.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus({ kind: 'error', key: KNOWN_ERRORS.has(body.error) ? body.error : 'save', detail: body.detail ?? '', max: body.max_vips ?? 50 });
        return;
      }
      setForm(f => ({ ...f, vipText: (body.settings?.vip_senders ?? []).join('\n') }));
      setLoaded(l => ({ ...l, status: l?.status ? { ...l.status, paused: false } : l?.status }));
      setStatus({ kind: 'ok' });
    } catch {
      setStatus({ kind: 'error', key: 'save' });
    } finally {
      setSaving(false);
    }
  };

  const line = { margin: 0, fontFamily: 'var(--font-sans)', fontSize: 12.5, lineHeight: 1.55, color: 'var(--fg-2)' };
  const label = { display: 'flex', flexDirection: 'column', gap: 4, fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-1)' };
  const lastSent = loaded?.status?.last_sent_at
    ? new Date(loaded.status.last_sent_at).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
    : null;

  return (
    <div className="card" style={{ maxWidth: 640, marginTop: 14 }} data-morning-brief>
      <div className="card-h">
        <div>
          <div className="title">{t('settings.morningBrief.title')}</div>
          <div className="sub">{t('settings.morningBrief.sub')}</div>
        </div>
      </div>
      <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {!allowed && (
          <p style={line} data-pro-upsell>
            {t('settings.morningBrief.proOnly')}{' '}
            <Link href={pricingCompareHref('solo', false)}>{t('settings.morningBrief.upgrade')}</Link>
          </p>
        )}
        {allowed && loaded && loaded.can_manage === false && (
          <p style={line} role="note">{t('settings.morningBrief.roleNote')}</p>
        )}

        {loadError ? (
          <div role="alert" style={{ ...line, color: 'var(--red-500)' }}>{t(`settings.morningBrief.errors.${loadError}`)}</div>
        ) : !form ? (
          <p style={line}>{t('settings.morningBrief.loading')}</p>
        ) : (
          <>
            <label htmlFor="morning-brief-enabled" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-sans)', fontSize: 13, color: canEdit ? 'var(--fg-1)' : 'var(--fg-3)' }}>
              <input
                id="morning-brief-enabled"
                type="checkbox"
                checked={form.enabled}
                disabled={!canEdit || saving}
                onChange={e => update({ enabled: e.target.checked })}
                style={{ accentColor: 'var(--brand)' }}
              />
              {t('settings.morningBrief.enable')}
            </label>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <label style={label}>
                {t('settings.morningBrief.hour')}
                <select className="input" value={form.hour} disabled={!canEdit || saving} onChange={e => update({ hour: Number(e.target.value) })} data-field="hour">
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>{`${String(h).padStart(2, '0')}:00`}</option>
                  ))}
                </select>
              </label>
              <label style={label}>
                {t('settings.morningBrief.timezone')}
                <select className="input" value={form.timezone} disabled={!canEdit || saving} onChange={e => update({ timezone: e.target.value })} data-field="timezone">
                  {timeZoneOptions(form.timezone).map(z => <option key={z} value={z}>{z}</option>)}
                </select>
              </label>
            </div>

            <label style={label}>
              {t('settings.morningBrief.inbox')}
              <select className="input" value={form.inbox_id} disabled={!canEdit || saving} onChange={e => update({ inbox_id: e.target.value })} data-field="inbox">
                <option value="">{t('settings.morningBrief.inboxPlaceholder')}</option>
                {targets.map(i => <option key={i.id} value={i.id}>{i.address || i.label}</option>)}
              </select>
            </label>

            <label style={label}>
              {t('settings.morningBrief.vip')}
              <textarea
                className="input"
                rows={3}
                value={form.vipText}
                placeholder={t('settings.morningBrief.vipPlaceholder')}
                disabled={!canEdit || saving}
                onChange={e => update({ vipText: e.target.value })}
                data-field="vip"
              />
            </label>
            <p style={line}>{t('settings.morningBrief.help')}</p>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Btn variant="secondary" size="sm" disabled={!canEdit} busy={saving} onClick={save}>
                {t('settings.morningBrief.save')}
              </Btn>
              {loaded?.status?.paused ? (
                <span style={{ ...line, color: 'var(--red-500)' }} data-brief-state>{t('settings.morningBrief.paused')}</span>
              ) : lastSent ? (
                <span style={line} data-brief-state>{t('settings.morningBrief.lastSent', { when: lastSent })}</span>
              ) : null}
            </div>

            {status && (
              <div role={status.kind === 'error' ? 'alert' : 'status'} style={{ ...line, color: status.kind === 'error' ? 'var(--red-500)' : 'var(--fg-2)' }}>
                {status.kind === 'error'
                  ? t(`settings.morningBrief.errors.${status.key}`, { detail: status.detail ?? '', max: status.max ?? 50 })
                  : t('settings.morningBrief.saved')}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
