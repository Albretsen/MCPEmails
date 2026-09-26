'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon, Btn } from '../Primitives';

/**
 * AdminConsentLinkDialog: the shareable Microsoft 365 approval link.
 *
 * A work or school account on Microsoft's default consent policy cannot
 * approve mail access itself; an IT administrator has to approve MCP Emails
 * once for the organisation. That admin usually has no MCP Emails account, so
 * "send to your IT admin" has to mean an actual link the user can paste into
 * an email or a chat. The link is minted by /auth/outlook/admin-consent/link
 * (a signed, seven-day token, see lib/email-providers/outlook-admin-link.ts)
 * and opens Microsoft's admin-consent screen for whoever follows it.
 *
 * The secondary action is for the user who IS their own admin: it follows the
 * same link in this tab, and the callback brings them back to the dashboard.
 *
 * @param {{ onClose: () => void }} props
 */
export function AdminConsentLinkDialog({ onClose }) {
  const tr = useTranslations('dashboardChrome');
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef(null);
  const closeRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/auth/outlook/admin-consent/link', { cache: 'no-store' })
      .then(response => (response.ok ? response.json() : null))
      .then(data => {
        if (cancelled) return;
        if (data && typeof data.url === 'string') setUrl(data.url);
        else setFailed(true);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = event => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard refused (permissions, insecure context): select the text so
      // the user can copy it by hand, which always works.
      inputRef.current?.select();
    }
  };

  const approveNow = () => {
    if (!url) return;
    // A whole-document navigation: the link is a server route that redirects
    // to Microsoft, not a page this app renders.
    window.location.href = url;
  };

  return (
    <div className="scrim" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-consent-link-title"
        onClick={event => event.stopPropagation()}
        style={{ width: 500 }}
      >
        <div className="modal-h">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <h2 id="admin-consent-link-title" style={{ margin: 0 }}>{tr('adminConsentLink.title')}</h2>
            <button
              ref={closeRef}
              onClick={onClose}
              aria-label={tr('adminConsentLink.close')}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)', padding: 4, flexShrink: 0, lineHeight: 1 }}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>

        <div className="modal-body">
          <p style={{ margin: '0 0 14px', fontFamily: 'var(--font-sans)', fontSize: 13.5, lineHeight: 1.55, color: 'var(--fg-2)' }}>
            {tr('adminConsentLink.body')}
          </p>

          <div className="field">
            <label htmlFor="admin-consent-link-url">{tr('adminConsentLink.label')}</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                id="admin-consent-link-url"
                ref={inputRef}
                className="input"
                readOnly
                value={url ?? ''}
                placeholder={failed ? '' : tr('adminConsentLink.loading')}
                onFocus={event => event.target.select()}
                aria-describedby="admin-consent-link-expiry"
                style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)', fontSize: 12 }}
              />
              <Btn variant="primary" icon={copied ? 'check' : 'copy'} onClick={copy} disabled={!url}>
                {copied ? tr('adminConsentLink.copied') : tr('adminConsentLink.copy')}
              </Btn>
            </div>
            <span id="admin-consent-link-expiry" style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
              {tr('adminConsentLink.expiry')}
            </span>
          </div>

          {failed && (
            <div
              role="alert"
              style={{
                marginTop: 12,
                padding: '10px 12px',
                background: 'var(--red-100)',
                border: '1px solid rgba(229,72,77,0.25)',
                borderRadius: 8,
                fontFamily: 'var(--font-sans)',
                fontSize: 13,
                color: 'var(--red-700)',
                lineHeight: 1.5,
              }}
            >
              {tr('adminConsentLink.error')}
            </div>
          )}

          <span aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
            {copied ? tr('adminConsentLink.copied') : ''}
          </span>
        </div>

        <div className="modal-foot">
          <Btn variant="ghost" onClick={approveNow} disabled={!url}>{tr('adminConsentLink.approveNow')}</Btn>
          <Btn variant="secondary" onClick={onClose}>{tr('adminConsentLink.done')}</Btn>
        </div>
      </div>
    </div>
  );
}
