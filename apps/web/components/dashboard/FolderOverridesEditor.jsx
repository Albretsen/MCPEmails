'use client';

import { useEffect, useState } from 'react';

/**
 * Inboxes > inbox > Advanced > Folders: which IMAP folder MCPEmails uses for
 * Sent, Drafts, Trash, Spam and Archive.
 *
 * Each role is one select. Its first option is "Automatic", labelled with the
 * folder automatic detection picks right now (or "not found"); the others are
 * the inbox's own folders, loaded live from the mail server. A change saves
 * at once and says so on one line. The rules (never INBOX, never one folder
 * for two roles, only folders the server listed) are enforced by the route;
 * the UI also disables a folder another role already uses, so the common
 * mistake cannot be made in the first place.
 *
 * Mounted only while the Advanced section is open, so opening an inbox does
 * not dial its mail server. While the folder list loads, the five rows already
 * show with disabled selects, so the panel keeps its height when it arrives.
 */

// Same order as FOLDER_OVERRIDE_ROLES (supabase/functions/mcp-server/folder-overrides.ts).
const ROLES = ['sent', 'drafts', 'trash', 'spam', 'archive'];

const KNOWN_ERRORS = new Set([
  'inbox_not_allowed', 'not_listed', 'used_by_other_role', 'folders_unreachable', 'unavailable', 'unsupported_inbox',
]);

export function FolderOverridesEditor({ inbox, t }) {
  const [settings, setSettings] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(null);
  const [status, setStatus] = useState(null);
  const endpoint = `/api/inboxes/${encodeURIComponent(inbox.id)}/folders`;

  useEffect(() => {
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSettings(null);
    setLoadError(null);
    setStatus(null);
    fetch(endpoint)
      .then(async res => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(KNOWN_ERRORS.has(body.error) ? body.error : 'load');
        return body;
      })
      .then(body => { if (live) setSettings(body); })
      .catch(err => { if (live) setLoadError(KNOWN_ERRORS.has(err.message) ? err.message : 'load'); });
    return () => { live = false; };
  }, [endpoint]);

  const save = async (role, folder) => {
    if (saving) return;
    setSaving(role);
    setStatus(null);
    try {
      const res = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, folder }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus({ kind: 'error', key: KNOWN_ERRORS.has(body.error) ? body.error : 'save' });
        return;
      }
      setSettings(current => ({
        ...current,
        roles: current.roles.map(r => (r.role === role ? { ...r, override: folder } : r)),
      }));
      const roleName = t(`inboxes.detail.folders.roles.${role}`);
      setStatus(folder === null
        ? { kind: 'ok', text: t('inboxes.detail.folders.resetDone', { role: roleName }) }
        : { kind: 'ok', text: t('inboxes.detail.folders.saved', { role: roleName, folder }) });
    } catch {
      setStatus({ kind: 'error', key: 'save' });
    } finally {
      setSaving(null);
    }
  };

  const line = { margin: '8px 0 0', fontFamily: 'var(--font-sans)', fontSize: 12.5, lineHeight: 1.5 };

  return (
    <div data-folder-overrides>
      <h3 className="folder-overrides-title">{t('inboxes.detail.folders.title')}</h3>
      <p className="folder-overrides-help">{t('inboxes.detail.folders.help')}</p>

      {loadError ? (
        <div role="alert" style={{ ...line, color: 'var(--red-500)' }}>{t(`inboxes.detail.folders.errors.${loadError}`)}</div>
      ) : settings === null ? (
        <div aria-busy="true">
          {ROLES.map(role => {
            const id = `folder-${inbox.id}-${role}`;
            return (
              <div key={role} className="folder-override-row" data-role={role}>
                <label htmlFor={id}>{t(`inboxes.detail.folders.roles.${role}`)}</label>
                <div className="folder-override-control">
                  <select id={id} className="input folder-override-automatic" value="" disabled onChange={() => {}}>
                    <option value="">{t('inboxes.detail.folders.loading')}</option>
                  </select>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <>
          {settings.roles.map(({ role, automatic, override }) => {
            const id = `folder-${inbox.id}-${role}`;
            const taken = new Set(settings.roles.filter(r => r.role !== role && r.override).map(r => r.override));
            return (
              <div key={role} className="folder-override-row" data-role={role}>
                <label htmlFor={id}>{t(`inboxes.detail.folders.roles.${role}`)}</label>
                <div className="folder-override-control">
                  <select
                    id={id}
                    className={`input${override ? '' : ' folder-override-automatic'}`}
                    value={override ?? ''}
                    disabled={!!saving}
                    onChange={e => save(role, e.target.value === '' ? null : e.target.value)}
                  >
                    <option value="">
                      {automatic
                        ? t('inboxes.detail.folders.automatic', { folder: automatic })
                        : t('inboxes.detail.folders.automaticNone')}
                    </option>
                    {settings.folders.map(folder => (
                      <option key={folder} value={folder} disabled={taken.has(folder)}>{folder}</option>
                    ))}
                  </select>
                  {override && (
                    <button type="button" className="folder-override-reset" disabled={!!saving} onClick={() => save(role, null)}>
                      {t('inboxes.detail.folders.reset')}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {status && (
            <div
              role={status.kind === 'error' ? 'alert' : 'status'}
              style={{ ...line, color: status.kind === 'error' ? 'var(--red-500)' : 'var(--fg-2)' }}
            >
              {status.kind === 'error' ? t(`inboxes.detail.folders.errors.${status.key}`) : status.text}
            </div>
          )}
        </>
      )}
    </div>
  );
}
