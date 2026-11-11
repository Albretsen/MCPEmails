'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Btn } from '../Primitives';

/**
 * Settings > Advanced: the Business recipient rule
 * (workspaces.allowed_recipient_domains, PUT /api/workspaces/[id]/recipient-rule).
 *
 * Owners and admins on Business only. Collapsed by default; the current list
 * is read when it is opened. Empty saves "any recipient". A send to anyone
 * outside the list is held for an owner or admin to approve.
 */
export function recipientRuleVisible({ userRole, plan }) {
  return (userRole === 'owner' || userRole === 'admin') && plan === 'pro';
}

export function RecipientRuleSection({ workspace, userRole }) {
  const t = useTranslations('dashboard');
  const [loaded, setLoaded] = useState(false);
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState('');
  const [status, setStatus] = useState(null); // null | 'loading' | 'saving' | 'saved' | { error }

  if (!workspace?.id || !recipientRuleVisible({ userRole, plan: workspace?.plan })) return null;

  async function load() {
    if (loaded) return;
    setLoaded(true);
    setStatus('loading');
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}/recipient-rule`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus({ error: typeof data.error === 'string' ? data.error : t('settings.recipientRule.loadFailed') });
        return;
      }
      const text = Array.isArray(data.domains) ? data.domains.join(', ') : '';
      setValue(text);
      setSaved(text);
      setStatus(null);
    } catch {
      setStatus({ error: t('settings.recipientRule.loadFailed') });
    }
  }

  async function save() {
    setStatus('saving');
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}/recipient-rule`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domains: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus({ error: typeof data.error === 'string' ? data.error : t('settings.recipientRule.saveFailed') });
        return;
      }
      const text = Array.isArray(data.domains) ? data.domains.join(', ') : '';
      setValue(text);
      setSaved(text);
      setStatus('saved');
    } catch {
      setStatus({ error: t('settings.recipientRule.saveFailed') });
    }
  }

  const busy = status === 'loading' || status === 'saving';
  return (
    <div className="card" style={{ maxWidth: 640, marginTop: 14 }}>
      <div className="card-body">
        <details className="inbox-sending-details" onToggle={(e) => { if (e.currentTarget.open) load(); }}>
          <summary><span>{t('settings.recipientRule.advanced')}</span></summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 12 }}>
            <label htmlFor="settings-recipient-rule" style={{ font: '600 13px var(--font-sans)', color: 'var(--fg-1)' }}>
              {t('settings.recipientRule.title')}
            </label>
            <div style={{ font: '12.5px/1.55 var(--font-sans)', color: 'var(--fg-2)' }}>
              {t('settings.recipientRule.help')}
            </div>
            <input
              id="settings-recipient-rule"
              className="input"
              type="text"
              value={value}
              placeholder={t('settings.recipientRule.placeholder')}
              onChange={(e) => { setValue(e.target.value); if (status === 'saved' || (status && status.error)) setStatus(null); }}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Btn variant="primary" size="sm" onClick={save} disabled={busy || value.trim() === saved.trim()}>
                {status === 'saving' ? t('settings.recipientRule.saving') : t('settings.recipientRule.save')}
              </Btn>
              {status === 'loading' && <span style={{ font: '12.5px var(--font-sans)', color: 'var(--fg-3)' }}>{t('settings.recipientRule.loading')}</span>}
              {status === 'saved' && <span style={{ font: '12.5px var(--font-sans)', color: 'var(--fg-2)' }}>{t('settings.recipientRule.saved')}</span>}
              {status && status.error && <span role="alert" style={{ font: '12.5px var(--font-sans)', color: 'var(--red-700)' }}>{status.error}</span>}
            </div>
          </div>
        </details>
      </div>
    </div>
  );
}
