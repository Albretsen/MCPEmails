'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Btn } from '../Primitives';
import { Link } from '@/i18n/navigation';

/*
 * Webhooks for new mail, on the API keys page (routes: app/api/webhook-endpoints).
 *
 * Everyone in the workspace sees the list and the delivery log; only owners
 * and admins get the buttons that change something, the same line the routes
 * and the RLS draw. Free and Personal see an upgrade prompt, plus any
 * endpoints they kept from Pro or Business, marked paused.
 *
 * The signing secret is in the create response only, shown once in a dialog,
 * and dropped from state when the dialog closes.
 */

const ERROR_CODES = new Set([
  'url_invalid', 'url_not_https', 'url_credentials', 'port_not_allowed', 'host_not_allowed', 'host_not_found',
  'timeout', 'connect_failed', 'tls_failed', 'redirect', 'http_status',
]);

function formatTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

const muted = { fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--fg-3)', lineHeight: 1.6 };
const labelStyle = { display: 'block', fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 500, color: 'var(--fg-2)', marginBottom: 6 };

export function WebhooksPanel({ inboxes = [], planName = (id) => id ?? '' }) {
  const t = useTranslations('dashboard');
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [url, setUrl] = useState('');
  const [payloadMode, setPayloadMode] = useState('ids');
  const [chosen, setChosen] = useState(null); // null = all inboxes
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState('');
  const [secret, setSecret] = useState(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState({});
  const [notes, setNotes] = useState({});
  const [openLog, setOpenLog] = useState(null);
  const [logs, setLogs] = useState({});
  const [confirmDelete, setConfirmDelete] = useState(null);

  const errorText = (code) => t(`webhooks.errors.${ERROR_CODES.has(code) ? code : 'generic'}`);

  useEffect(() => {
    let live = true;
    fetch('/api/webhook-endpoints', { cache: 'no-store' })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!live) return;
        if (!res.ok || !Array.isArray(body?.endpoints)) setLoadError(true);
        else setData(body);
      })
      .catch(() => { if (live) setLoadError(true); });
    return () => { live = false; };
  }, []);

  const replace = (row) => setData((d) => ({ ...d, endpoints: d.endpoints.map((e) => (e.id === row.id ? row : e)) }));

  const create = async (event) => {
    event?.preventDefault?.();
    if (creating) return;
    setCreating(true);
    setFormError('');
    try {
      const res = await fetch('/api/webhook-endpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), payloadMode, inboxIds: chosen }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(ERROR_CODES.has(body?.error_code) ? errorText(body.error_code) : t('webhooks.saveFailed'));
        return;
      }
      const { secret: plain, ...row } = body;
      setData((d) => ({ ...d, endpoints: [...d.endpoints, row] }));
      setSecret(plain);
      setFormOpen(false);
      setUrl('');
      setPayloadMode('ids');
      setChosen(null);
      setAdvanced(false);
    } catch {
      setFormError(t('webhooks.saveFailed'));
    } finally {
      setCreating(false);
    }
  };

  const withBusy = async (id, work) => {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await work();
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  const setEnabled = (endpoint, enabled) => withBusy(endpoint.id, async () => {
    const res = await fetch(`/api/webhook-endpoints/${endpoint.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }).catch(() => null);
    const body = res ? await res.json().catch(() => ({})) : {};
    if (res?.ok) {
      replace(body);
      setNotes((n) => ({ ...n, [endpoint.id]: '' }));
    } else {
      setNotes((n) => ({ ...n, [endpoint.id]: t('webhooks.saveFailed') }));
    }
  });

  const sendTest = (endpoint) => withBusy(endpoint.id, async () => {
    const res = await fetch(`/api/webhook-endpoints/${endpoint.id}/test`, { method: 'POST' }).catch(() => null);
    const body = res ? await res.json().catch(() => ({})) : {};
    const text = res?.ok && body.ok
      ? t('webhooks.testOk', { status: body.status })
      : t('webhooks.testFailed', { reason: errorText(body?.errorCode) });
    setNotes((n) => ({ ...n, [endpoint.id]: text }));
    if (openLog === endpoint.id) loadLog(endpoint.id);
  });

  const loadLog = async (id) => {
    const res = await fetch(`/api/webhook-endpoints/${id}/deliveries`, { cache: 'no-store' }).catch(() => null);
    const body = res ? await res.json().catch(() => ({})) : {};
    setLogs((l) => ({ ...l, [id]: Array.isArray(body?.deliveries) ? body.deliveries : [] }));
  };

  const toggleLog = (id) => {
    if (openLog === id) {
      setOpenLog(null);
      return;
    }
    setOpenLog(id);
    loadLog(id);
  };

  const remove = (endpoint) => withBusy(endpoint.id, async () => {
    const res = await fetch(`/api/webhook-endpoints/${endpoint.id}`, { method: 'DELETE' }).catch(() => null);
    if (res?.ok) {
      setData((d) => ({ ...d, endpoints: d.endpoints.filter((e) => e.id !== endpoint.id) }));
      setConfirmDelete(null);
    } else {
      setNotes((n) => ({ ...n, [endpoint.id]: t('webhooks.saveFailed') }));
    }
  });

  const copySecret = () => {
    navigator.clipboard?.writeText(secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const endpoints = data?.endpoints ?? [];
  const enabledPlan = data?.webhooksEnabled === true;
  const canManage = data?.canManage === true;
  const atLimit = endpoints.length >= (data?.maxEndpoints ?? Infinity);

  const status = (e) => {
    if (!enabledPlan) return <Badge tone="neutral">{t('webhooks.statusPaused')}</Badge>;
    if (e.disabledReason === 'failing') return <Badge tone="red">{t('webhooks.statusFailing')}</Badge>;
    if (e.disabledAt) return <Badge tone="neutral">{t('webhooks.statusOff')}</Badge>;
    return <Badge tone="live">{t('webhooks.statusActive')}</Badge>;
  };

  const result = (d) => {
    const word = {
      delivered: t('webhooks.resultDelivered'),
      pending: t('webhooks.resultPending'),
      failed: t('webhooks.resultFailed'),
      abandoned: t('webhooks.resultAbandoned'),
    }[d.status] ?? d.status;
    return d.responseCode ? `${word} (HTTP ${d.responseCode})` : word;
  };

  return (
    <div className="card" style={{ marginTop: 14 }} data-testid="webhooks-panel">
      <div className="card-h">
        <div>
          <div className="title">{t('webhooks.title')}</div>
          <div className="sub">{t('webhooks.sub')}</div>
        </div>
        {enabledPlan && canManage && !formOpen && (
          <Btn variant="secondary" size="sm" icon="plus" onClick={() => setFormOpen(true)} disabled={atLimit}>
            {t('webhooks.add')}
          </Btn>
        )}
      </div>
      <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {loadError && <div style={muted} data-testid="webhooks-load-error">{t('webhooks.loadFailed')}</div>}

        {data && !enabledPlan && (
          <div data-testid="webhooks-upgrade" style={{ padding: '12px 14px', background: 'var(--bg-sunken)', borderRadius: 10 }}>
            <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13.5, fontWeight: 600, color: 'var(--fg-1)' }}>{t('webhooks.upgradeTitle')}</div>
            <div style={{ ...muted, marginTop: 4 }}>{t('webhooks.upgradeBody', { plan: planName(data.plan) })}</div>
            <div style={{ marginTop: 8 }}>
              <Link href="/pricing#compare" className="btn btn-primary btn-sm">{t('webhooks.upgradeCta')}</Link>
            </div>
            {endpoints.length > 0 && <div style={{ ...muted, marginTop: 8 }}>{t('webhooks.pausedNote')}</div>}
          </div>
        )}

        {data && enabledPlan && !canManage && <div style={muted}>{t('webhooks.readOnly')}</div>}
        {data && enabledPlan && canManage && atLimit && <div style={muted}>{t('webhooks.limitReached')}</div>}

        {formOpen && (
          <form onSubmit={create} data-testid="webhook-form" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label htmlFor="webhook-url" style={labelStyle}>{t('webhooks.urlLabel')}</label>
              <input
                id="webhook-url"
                className="input"
                type="url"
                inputMode="url"
                placeholder={t('webhooks.urlPlaceholder')}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={creating}
                maxLength={2048}
                autoFocus
                style={{ width: '100%', boxSizing: 'border-box' }}
              />
            </div>
            <button
              type="button"
              onClick={() => setAdvanced((a) => !a)}
              style={{ alignSelf: 'flex-start', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: 500, color: 'var(--brand)' }}
            >
              {t('webhooks.advanced')}
            </button>
            {advanced && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="webhook-advanced">
                <div>
                  <label htmlFor="webhook-payload" style={labelStyle}>{t('webhooks.payloadLabel')}</label>
                  <select id="webhook-payload" className="input" value={payloadMode} onChange={(e) => setPayloadMode(e.target.value)} disabled={creating}>
                    <option value="ids">{t('webhooks.payloadIds')}</option>
                    <option value="headers">{t('webhooks.payloadHeaders')}</option>
                  </select>
                </div>
                <div>
                  <div style={labelStyle}>{t('webhooks.inboxesLabel')}</div>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-2)' }}>
                    <input type="checkbox" checked={chosen === null} onChange={() => setChosen(chosen === null ? [] : null)} disabled={creating} />
                    {t('webhooks.inboxesAll')}
                  </label>
                  {chosen !== null && inboxes.map((inbox) => (
                    <label key={inbox.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-2)' }}>
                      <input
                        type="checkbox"
                        checked={chosen.includes(inbox.id)}
                        onChange={() => setChosen(chosen.includes(inbox.id) ? chosen.filter((id) => id !== inbox.id) : [...chosen, inbox.id])}
                        disabled={creating}
                      />
                      {inbox.address ?? inbox.id}
                    </label>
                  ))}
                </div>
              </div>
            )}
            {formError && <div style={{ fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--red-500)' }} data-testid="webhook-form-error">{formError}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn type="submit" variant="primary" size="sm" busy={creating} disabled={url.trim() === '' || (chosen !== null && chosen.length === 0)}>
                {creating ? t('webhooks.creating') : t('webhooks.create')}
              </Btn>
              <Btn variant="ghost" size="sm" onClick={() => { setFormOpen(false); setFormError(''); }} disabled={creating}>{t('webhooks.cancel')}</Btn>
            </div>
          </form>
        )}

        {data && endpoints.length === 0 && enabledPlan && !formOpen && <div style={muted}>{t('webhooks.empty')}</div>}

        {endpoints.length > 0 && (
          <div className="tbl-wrap">
            <table className="tbl" data-testid="webhooks-table">
              <thead>
                <tr>
                  <th>{t('webhooks.colUrl')}</th>
                  <th>{t('webhooks.colStatus')}</th>
                  <th>{t('webhooks.colLastDelivered')}</th>
                  <th className="right">{''}</th>
                </tr>
              </thead>
              <tbody>
                {endpoints.map((e) => (
                  <WebhookRow
                    key={e.id}
                    endpoint={e}
                    t={t}
                    status={status(e)}
                    busy={busy[e.id] === true}
                    note={notes[e.id]}
                    canManage={canManage}
                    enabledPlan={enabledPlan}
                    logOpen={openLog === e.id}
                    log={logs[e.id]}
                    result={result}
                    confirming={confirmDelete === e.id}
                    onTest={() => sendTest(e)}
                    onToggleLog={() => toggleLog(e.id)}
                    onEnable={() => setEnabled(e, true)}
                    onDisable={() => setEnabled(e, false)}
                    onDelete={() => (confirmDelete === e.id ? remove(e) : setConfirmDelete(e.id))}
                    onCancelDelete={() => setConfirmDelete(null)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {endpoints.length > 0 && <div style={muted}>{t('webhooks.signatureHint')}</div>}
      </div>

      {secret && (
        <div className="scrim">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="webhook-secret-title" style={{ width: 460 }} data-testid="webhook-secret-dialog">
            <div className="modal-h">
              <h2 id="webhook-secret-title" style={{ margin: 0 }}>{t('webhooks.secretTitle')}</h2>
              <div className="sub" style={{ marginTop: 4 }}>{t('webhooks.secretBody')}</div>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <code className="mono" data-testid="webhook-secret" style={{ flex: 1, background: 'var(--bg-sunken)', padding: '8px 10px', borderRadius: 8, wordBreak: 'break-all', fontSize: 12.5 }}>{secret}</code>
                <Btn variant="secondary" size="sm" icon={copied ? 'check' : 'copy'} onClick={copySecret}>{copied ? t('webhooks.copied') : t('webhooks.copy')}</Btn>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Btn variant="primary" onClick={() => setSecret(null)}>{t('webhooks.done')}</Btn>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function WebhookRow({ endpoint: e, t, status, busy, note, canManage, enabledPlan, logOpen, log, result, confirming, onTest, onToggleLog, onEnable, onDisable, onDelete, onCancelDelete }) {
  return (
    <>
      <tr data-testid={`webhook-row-${e.id}`}>
        <td style={{ maxWidth: 320 }}>
          <code className="mono" style={{ wordBreak: 'break-all', fontSize: 12.5 }}>{e.url}</code>
          {note ? <div style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)', marginTop: 4 }} data-testid="webhook-note">{note}</div> : null}
        </td>
        <td>{status}</td>
        <td style={{ whiteSpace: 'nowrap', color: 'var(--fg-2)', fontFamily: 'var(--font-sans)', fontSize: 13 }}>
          {e.lastSuccessAt ? formatTime(e.lastSuccessAt) : t('webhooks.never')}
        </td>
        <td className="right">
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <Btn variant="ghost" size="sm" onClick={onToggleLog}>{logOpen ? t('webhooks.hideDeliveries') : t('webhooks.deliveries')}</Btn>
            {canManage && enabledPlan && (
              <Btn variant="secondary" size="sm" onClick={onTest} busy={busy}>{busy ? t('webhooks.testing') : t('webhooks.test')}</Btn>
            )}
            {canManage && enabledPlan && e.disabledAt && (
              <Btn variant="secondary" size="sm" onClick={onEnable} disabled={busy}>{t('webhooks.turnOn')}</Btn>
            )}
            {canManage && !e.disabledAt && (
              <Btn variant="ghost" size="sm" onClick={onDisable} disabled={busy}>{t('webhooks.turnOff')}</Btn>
            )}
            {canManage && (
              <Btn variant="danger" size="sm" onClick={onDelete} disabled={busy}>{t('webhooks.delete')}</Btn>
            )}
          </div>
          {confirming && (
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center', marginTop: 6, fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--fg-2)' }} data-testid="webhook-delete-confirm">
              {t('webhooks.deleteConfirm')}
              <Btn variant="danger" size="sm" icon="trash" onClick={onDelete} disabled={busy}>{t('webhooks.delete')}</Btn>
              <Btn variant="ghost" size="sm" onClick={onCancelDelete} disabled={busy}>{t('webhooks.cancel')}</Btn>
            </div>
          )}
        </td>
      </tr>
      {logOpen && (
        <tr>
          <td colSpan={4} style={{ background: 'var(--bg-sunken)' }}>
            {!log ? null : log.length === 0 ? (
              <div style={muted}>{t('webhooks.noDeliveries')}</div>
            ) : (
              <table className="tbl" data-testid="webhook-log">
                <thead>
                  <tr>
                    <th>{t('webhooks.colTime')}</th>
                    <th>{t('webhooks.colEvent')}</th>
                    <th>{t('webhooks.colResult')}</th>
                    <th>{t('webhooks.colAttempt')}</th>
                  </tr>
                </thead>
                <tbody>
                  {log.map((d) => (
                    <tr key={d.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{formatTime(d.lastAttemptAt ?? d.createdAt)}</td>
                      <td><code className="mono" style={{ fontSize: 12 }}>{d.eventType}</code></td>
                      <td>{result(d)}</td>
                      <td>{d.attempt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export default WebhooksPanel;
