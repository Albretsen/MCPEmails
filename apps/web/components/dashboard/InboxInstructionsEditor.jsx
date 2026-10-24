'use client';

import { useEffect, useState } from 'react';
import { Btn } from '../Primitives';
import { Link } from '@/i18n/navigation';
import { pricingCompareHref } from '@/lib/billing/upgrade-intent.mjs';

/**
 * Inboxes > inbox > Advanced > Instructions for your AI (Pro feature
 * `inbox_instructions`): standing instructions every AI client sees for this
 * inbox, in inbox_list and on drafting and sending results.
 *
 * Mounted only when the feature is VISIBLE for the workspace (the caller
 * checks `proFeatures.visible`), and only while Advanced is open, so before
 * launch no customer fetches anything. When visible but not on Pro (or
 * Business), the field shows disabled with an upgrade link; the route refuses
 * the write anyway. One Save button, one result line.
 */

// Same cap as INBOX_INSTRUCTIONS_MAX_CHARS (supabase/functions/mcp-server/inbox-instructions.ts);
// the GET answer carries it too and wins.
const DEFAULT_MAX = 2000;

const KNOWN_ERRORS = new Set(['too_long', 'unavailable', 'pro_feature_required']);

export function InboxInstructionsEditor({ inbox, t, allowed = false }) {
  const [loaded, setLoaded] = useState(null);
  const [text, setText] = useState('');
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);
  const endpoint = `/api/inboxes/${encodeURIComponent(inbox.id)}/instructions`;

  useEffect(() => {
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoaded(null);
    setLoadError(null);
    setStatus(null);
    fetch(endpoint)
      .then(async res => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(KNOWN_ERRORS.has(body.error) ? body.error : 'load');
        return body;
      })
      .then(body => {
        if (!live) return;
        setLoaded(body);
        setText(body.instructions ?? '');
      })
      .catch(err => { if (live) setLoadError(KNOWN_ERRORS.has(err.message) ? err.message : 'load'); });
    return () => { live = false; };
  }, [endpoint]);

  const max = loaded?.max_chars ?? DEFAULT_MAX;
  const canEdit = allowed && loaded?.allowed === true && loaded?.can_manage !== false;
  const tooLong = text.trim().length > max;
  const unchanged = loaded !== null && text.trim() === (loaded.instructions ?? '');

  const save = async () => {
    if (saving || !canEdit || tooLong) return;
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instructions: text }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus({ kind: 'error', key: KNOWN_ERRORS.has(body.error) ? body.error : 'save' });
        return;
      }
      setLoaded(current => ({ ...current, instructions: body.instructions, updated_at: body.updated_at }));
      setText(body.instructions ?? '');
      setStatus({ kind: 'ok', text: body.instructions ? t('inboxes.detail.instructions.saved') : t('inboxes.detail.instructions.cleared') });
    } catch {
      setStatus({ kind: 'error', key: 'save' });
    } finally {
      setSaving(false);
    }
  };

  const line = { margin: '8px 0 0', fontFamily: 'var(--font-sans)', fontSize: 12.5, lineHeight: 1.5 };
  const id = `instructions-${inbox.id}`;

  return (
    <div data-inbox-instructions>
      <h3 className="folder-overrides-title"><label htmlFor={id}>{t('inboxes.detail.instructions.title')}</label></h3>
      <p className="folder-overrides-help">{t('inboxes.detail.instructions.help')}</p>

      {!allowed && (
        <p className="inbox-instructions-upsell" data-pro-upsell style={{ ...line, margin: '0 0 8px', color: 'var(--fg-2)' }}>
          {t('inboxes.detail.instructions.proOnly')}{' '}
          <Link href={pricingCompareHref('solo', false)}>{t('inboxes.detail.instructions.upgrade')}</Link>
        </p>
      )}

      {loadError ? (
        <div role="alert" style={{ ...line, color: 'var(--red-500)' }}>
          {t(`inboxes.detail.instructions.errors.${loadError}`, { max })}
        </div>
      ) : (
        <>
          <textarea
            id={id}
            className="input inbox-instructions-text"
            rows={5}
            value={loaded === null ? '' : text}
            placeholder={loaded === null ? t('inboxes.detail.instructions.loading') : t('inboxes.detail.instructions.placeholder')}
            disabled={loaded === null || !canEdit || saving}
            aria-invalid={tooLong || undefined}
            onChange={e => { setText(e.target.value); setStatus(null); }}
          />
          <div className="inbox-instructions-actions">
            <span className="inbox-instructions-count" style={{ color: tooLong ? 'var(--red-500)' : 'var(--fg-3)' }}>
              {t('inboxes.detail.instructions.count', { count: text.trim().length, max })}
            </span>
            <Btn variant="secondary" size="sm" disabled={!canEdit || tooLong || unchanged} busy={saving} onClick={save}>
              {t('inboxes.detail.instructions.save')}
            </Btn>
          </div>
          {status && (
            <div
              role={status.kind === 'error' ? 'alert' : 'status'}
              style={{ ...line, color: status.kind === 'error' ? 'var(--red-500)' : 'var(--fg-2)' }}
            >
              {status.kind === 'error' ? t(`inboxes.detail.instructions.errors.${status.key}`, { max }) : status.text}
            </div>
          )}
        </>
      )}
    </div>
  );
}
