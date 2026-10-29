'use client';

import { useState } from 'react';
import { Btn } from '../Primitives';
import { emailDomain, prefillFromDomain } from '@/lib/email-providers/host-presets';

/**
 * Inboxes > inbox > Advanced > Connection type, for a generic IMAP/SMTP inbox:
 * send and receive, receive only, or send only. Saved through
 * PATCH /api/inboxes/[id]/connection on the same row, so the inbox keeps its
 * id and its AI connections.
 *
 *   - Dropping a half needs nothing typed: one line says what turns off, and
 *     Save confirms it.
 *   - Adding a half asks only for that half's server, port and security. The
 *     route checks it with the saved password before saving. If the new
 *     server refuses the saved login, or sits on another domain than the saved
 *     server (the route answers password_required and never sends the saved
 *     password there), the username and password fields appear and the next
 *     Save sends them.
 *
 * Reconnect no longer changes the type; it only re-enters the password.
 */

const HALVES = ['imap', 'smtp'];
const DEFAULTS = {
  imap: { port: 993, security: 'tls' },
  smtp: { port: 465, security: 'tls' },
};

const uses = (mode, half) => (half === 'imap' ? mode !== 'smtp' : mode !== 'imap');

/** Generic IMAP/SMTP inboxes only; branded and OAuth inboxes are fixed. */
export function connectionTypeAvailable(inbox) {
  return inbox.provider === 'imap'
    && !!inbox.hasImap
    && (inbox.connectionMode === 'both' || inbox.connectionMode === 'imap' || inbox.connectionMode === 'smtp')
    && inbox.status !== 'pending';
}

function initialServers(inbox) {
  const known = prefillFromDomain(emailDomain(String(inbox.address ?? '')) ?? '');
  const server = half => ({
    host: known?.[`${half}Host`] ?? '',
    port: String(known?.[`${half}Port`] ?? DEFAULTS[half].port),
    security: known?.[`${half}Security`] ?? DEFAULTS[half].security,
  });
  return { imap: server('imap'), smtp: server('smtp') };
}

export function ConnectionTypeEditor({ inbox, t, onChanged }) {
  const current = inbox.connectionMode;
  const [target, setTarget] = useState(current);
  const [servers, setServers] = useState(() => initialServers(inbox));
  const [needsLogin, setNeedsLogin] = useState(false);
  const [login, setLogin] = useState({ username: inbox.username ?? '', password: '' });
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);

  const k = key => `inboxes.detail.connection.${key}`;
  const added = HALVES.filter(half => uses(target, half) && !uses(current, half));
  const dropped = HALVES.filter(half => !uses(target, half) && uses(current, half));
  const changing = target !== current;

  const reset = () => {
    setTarget(current);
    setNeedsLogin(false);
    setLogin({ username: inbox.username ?? '', password: '' });
    setStatus(null);
  };

  const setServer = (half, field, value) =>
    setServers(prev => ({ ...prev, [half]: { ...prev[half], [field]: value } }));

  const save = async () => {
    if (saving) return;
    const empty = added.find(half => !servers[half].host.trim());
    if (empty) {
      setStatus({ kind: 'error', text: t(k('errors.hostRequired'), { server: empty.toUpperCase() }) });
      return;
    }
    if (needsLogin && !login.password.trim()) {
      setStatus({ kind: 'error', text: t(k('errors.passwordRequired')) });
      return;
    }
    const body = { mode: target };
    for (const half of added) {
      body[`${half}Host`] = servers[half].host.trim();
      body[`${half}Port`] = Number(servers[half].port);
      body[`${half}Security`] = servers[half].security;
    }
    if (needsLogin) {
      body.username = login.username.trim();
      body.appPassword = login.password;
    }
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/inboxes/${encodeURIComponent(inbox.id)}/connection`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const server = String(data.half ?? added[0] ?? 'imap').toUpperCase();
        if (data.error_code === 'password_required') {
          setNeedsLogin(true);
          setStatus({ kind: 'error', text: t(k('passwordForNewHost'), { server }) });
        } else if (data.needs_login && !needsLogin) {
          setNeedsLogin(true);
          setStatus({ kind: 'error', text: t(k('needsLogin'), { server }) });
        } else if (data.error_code === 'auth_failed') {
          setStatus({ kind: 'error', text: t(k('errors.loginRefused'), { server }) });
        } else if (data.error_code === 'login_already_connected') {
          setStatus({ kind: 'error', text: t(k('errors.loginInUse')) });
        } else if (data.error_code === 'host_required') {
          setStatus({ kind: 'error', text: t(k('errors.hostRequired'), { server }) });
        } else if (res.status === 422) {
          setStatus({ kind: 'error', text: t(k('errors.unreachable'), { server }) });
        } else {
          setStatus({ kind: 'error', text: t(k('errors.save')) });
        }
        return;
      }
      const mode = data.mode ?? target;
      onChanged?.(inbox.id, {
        connectionMode: mode,
        imapHost: data.imapHost ?? null,
        imapPort: data.imapPort ?? null,
        imapSecurity: data.imapSecurity ?? inbox.imapSecurity,
        smtpHost: data.smtpHost ?? null,
        smtpPort: data.smtpPort ?? null,
        smtpSecurity: data.smtpSecurity ?? inbox.smtpSecurity,
        username: data.username ?? null,
        ...(needsLogin ? { status: 'active', lastError: null } : {}),
      });
      setTarget(mode);
      setNeedsLogin(false);
      setLogin(prev => ({ ...prev, password: '' }));
      setStatus({ kind: 'ok', text: t(k(`saved.${mode}`)) });
    } catch {
      setStatus({ kind: 'error', text: t(k('errors.save')) });
    } finally {
      setSaving(false);
    }
  };

  const line = { margin: '8px 0 0', fontFamily: 'var(--font-sans)', fontSize: 12.5, lineHeight: 1.5 };
  const id = suffix => `connection-${inbox.id}-${suffix}`;

  return (
    <div data-connection-type>
      <h3 className="folder-overrides-title">{t(k('title'))}</h3>
      <p className="folder-overrides-help">{t(k('help'))}</p>
      <div className="folder-override-row">
        <label htmlFor={id('mode')}>{t(k('typeLabel'))}</label>
        <div className="folder-override-control">
          <select
            id={id('mode')}
            className="input"
            value={target}
            disabled={saving}
            onChange={e => { setTarget(e.target.value); setNeedsLogin(false); setStatus(null); }}
          >
            <option value="both">{t(k('modes.both'))}</option>
            <option value="imap">{t(k('modes.imap'))}</option>
            <option value="smtp">{t(k('modes.smtp'))}</option>
          </select>
        </div>
      </div>

      {changing && (
        <>
          {dropped.map(half => (
            <p key={half} style={{ ...line, color: 'var(--fg-2)' }} data-turns-off={half}>{t(k(`turnsOff.${half}`))}</p>
          ))}
          {added.map(half => (
            <div key={half} data-adds={half}>
              <p style={{ ...line, color: 'var(--fg-2)' }}>{t(k('addHint'), { server: half.toUpperCase() })}</p>
              <div className="folder-override-row">
                <label htmlFor={id(`${half}-host`)}>{t(k(`${half}Host`))}</label>
                <div className="folder-override-control">
                  <input id={id(`${half}-host`)} className="input" value={servers[half].host} disabled={saving} autoComplete="off" spellCheck={false} onChange={e => setServer(half, 'host', e.target.value)} />
                </div>
              </div>
              <div className="folder-override-row">
                <label htmlFor={id(`${half}-port`)}>{t(k('port'))}</label>
                <div className="folder-override-control">
                  <input id={id(`${half}-port`)} className="input" inputMode="numeric" value={servers[half].port} disabled={saving} onChange={e => setServer(half, 'port', e.target.value.replace(/\D/g, ''))} />
                </div>
              </div>
              <div className="folder-override-row">
                <label htmlFor={id(`${half}-security`)}>{t(k('security'))}</label>
                <div className="folder-override-control">
                  <select id={id(`${half}-security`)} className="input" value={servers[half].security} disabled={saving} onChange={e => setServer(half, 'security', e.target.value)}>
                    <option value="tls">{t(k('securityTls'))}</option>
                    <option value="starttls">{t(k('securityStarttls'))}</option>
                  </select>
                </div>
              </div>
            </div>
          ))}
          {needsLogin && (
            <div data-needs-login>
              <div className="folder-override-row">
                <label htmlFor={id('username')}>{t(k('username'))}</label>
                <div className="folder-override-control">
                  <input id={id('username')} className="input" value={login.username} placeholder={inbox.address} disabled={saving} autoComplete="off" spellCheck={false} onChange={e => setLogin(prev => ({ ...prev, username: e.target.value }))} />
                </div>
              </div>
              <div className="folder-override-row">
                <label htmlFor={id('password')}>{t(k('password'))}</label>
                <div className="folder-override-control">
                  <input id={id('password')} className="input" type="password" value={login.password} disabled={saving} autoComplete="new-password" onChange={e => setLogin(prev => ({ ...prev, password: e.target.value }))} />
                </div>
              </div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <Btn variant="primary" size="sm" onClick={save} disabled={saving}>
              {saving ? t(k(added.length ? 'checking' : 'saving')) : t(k('save'))}
            </Btn>
            <Btn variant="ghost" size="sm" onClick={reset} disabled={saving}>{t(k('cancel'))}</Btn>
          </div>
        </>
      )}

      {status && (
        <div role={status.kind === 'error' ? 'alert' : 'status'} style={{ ...line, color: status.kind === 'error' ? 'var(--red-500)' : 'var(--fg-2)' }}>
          {status.text}
        </div>
      )}
    </div>
  );
}
