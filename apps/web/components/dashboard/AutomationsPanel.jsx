'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Btn, Icon } from '../Primitives';
import { useToast } from './Toast';

/* AutomationsPanel.jsx: scheduled, unattended triage rules.

   This is the only surface in the product where the server touches a mailbox
   with nobody watching, so the panel is built around three things a user needs
   before they will trust it:

     1. A standing, always-visible statement of what an automation can and
        cannot do (it never deletes mail; forwarding is approval-gated). It sits
        above the list rather than inside the create modal, because it has to be
        true of every rule already running, not just the one being written.
     2. A Preview button in the form that runs the filter against the real
        mailbox and shows the matches BEFORE anything is enabled. Rules are
        always created switched off, so preview is the step between writing a
        filter and letting it act.
     3. A run log per rule, down to what happened to each individual message.

   Run history is a modal, not a route: the dashboard's catch-all 404s on paths
   deeper than one segment, so /dashboard/automations/<id>/runs cannot exist. */

const CADENCE_OPTIONS = [
  { minutes: 15, key: 'm15' },
  { minutes: 30, key: 'm30' },
  { minutes: 60, key: 'h1' },
  { minutes: 180, key: 'h3' },
  { minutes: 360, key: 'h6' },
  { minutes: 720, key: 'h12' },
  { minutes: 1440, key: 'd1' },
];

const ACTION_TYPES = ['move', 'label', 'mark_read', 'forward', 'draft_reply'];

const ACTION_LABEL_KEY = {
  move: 'automations.actionType.move',
  label: 'automations.actionType.label',
  mark_read: 'automations.actionType.markRead',
  forward: 'automations.actionType.forward',
  draft_reply: 'automations.actionType.draftReply',
};

// Status to badge tone. Only the five tones that have CSS exist:
// live | brand | neutral | amber | red.
const RUN_STATUS_TONE = {
  running: 'brand',
  completed: 'live',
  completed_with_errors: 'amber',
  failed: 'red',
  skipped: 'neutral',
};

const RUN_STATUS_KEY = {
  running: 'automations.status.running',
  completed: 'automations.status.completed',
  completed_with_errors: 'automations.status.completedWithErrors',
  failed: 'automations.status.failed',
  skipped: 'automations.status.skipped',
};

const OUTCOME_TONE = {
  applied: 'live',
  queued_for_approval: 'amber',
  failed: 'red',
  skipped_duplicate: 'neutral',
};

const OUTCOME_KEY = {
  applied: 'automations.runs.outcomeApplied',
  queued_for_approval: 'automations.runs.outcomeQueued',
  failed: 'automations.runs.outcomeFailed',
  skipped_duplicate: 'automations.runs.outcomeSkipped',
};

/** Text filter fields the form exposes, in the order they read best. */
const TEXT_FILTERS = [
  { field: 'from', labelKey: 'automations.modal.filterFrom' },
  { field: 'to', labelKey: 'automations.modal.filterTo' },
  { field: 'subject', labelKey: 'automations.modal.filterSubject' },
  { field: 'body', labelKey: 'automations.modal.filterBody' },
];

const BOOLEAN_FILTERS = [
  { field: 'unread', labelKey: 'automations.modal.filterUnread' },
  { field: 'has_attachment', labelKey: 'automations.modal.filterHasAttachment' },
  { field: 'flagged', labelKey: 'automations.modal.filterFlagged' },
];

function formatTimestamp(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toLocaleString();
}

function inboxLabel(row) {
  return row?.inboxes?.display_name || row?.inboxes?.email_address || null;
}

/* ── Panel ─────────────────────────────────────────────────────────────── */

/**
 * @param userRole  workspace role of the signed-in user
 * @param inboxes   [{ id, label, address }] from the dashboard's server fetch
 * @param keys      [{ id, name, scopes, inboxIds }] from the dashboard's server fetch
 */
export function AutomationsPanel({ userRole, inboxes = [], keys = [] }) {
  const t = useTranslations('dashboard');
  const { toast } = useToast();

  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [formRule, setFormRule] = useState(null); // { mode: 'create' | 'edit', rule }
  const [runsRule, setRunsRule] = useState(null);
  const [deleteRule, setDeleteRule] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const canManage = userRole === 'owner' || userRole === 'admin';

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/automations', { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || t('automations.errorLoad'));
      setRules(Array.isArray(payload.automations) ? payload.automations : []);
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error && loadError.message ? loadError.message : t('automations.errorLoad'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  // A rule holding a lease is mid-run. Poll while any is, so the last-run column
  // resolves on its own instead of leaving the user to guess when to refresh.
  const anyRunning = rules.some((rule) => Boolean(rule.running_since));
  useEffect(() => {
    if (!anyRunning) return undefined;
    const id = window.setInterval(() => { void load(); }, 5000);
    return () => window.clearInterval(id);
  }, [anyRunning, load]);

  const toggleEnabled = async (rule) => {
    if (!canManage || busyId) return;
    setBusyId(rule.id);
    try {
      const response = await fetch(`/api/automations/${rule.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || t('automations.errorGeneric'));
      toast({ message: rule.enabled ? t('automations.toastDisabled') : t('automations.toastEnabled'), variant: 'success' });
      await load();
    } catch (toggleError) {
      toast({ message: toggleError instanceof Error && toggleError.message ? toggleError.message : t('automations.errorGeneric'), variant: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  const removeRule = async () => {
    if (!deleteRule || busyId) return;
    setBusyId(deleteRule.id);
    try {
      const response = await fetch(`/api/automations/${deleteRule.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || t('automations.errorGeneric'));
      toast({ message: t('automations.toastDeleted'), variant: 'success' });
      setDeleteRule(null);
      await load();
    } catch (removeError) {
      toast({ message: removeError instanceof Error && removeError.message ? removeError.message : t('automations.errorGeneric'), variant: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="page automations">
      <div className="page-header">
        <div className="grow">
          <div className="page-title">{t('automations.title')}</div>
          <div className="page-sub">{t('automations.subtitle')}</div>
        </div>
        {canManage ? (
          <Btn variant="primary" icon="plus" onClick={() => setFormRule({ mode: 'create', rule: null })}>
            {t('automations.newButton')}
          </Btn>
        ) : null}
      </div>

      {/* Standing safety statement. Not decoration: it is the contract the
          feature is sold on, so it stays on screen next to the running rules. */}
      <div className="alert" role="note" style={{ marginBottom: 16, alignItems: 'flex-start' }}>
        <Icon name="shield" size={16} />
        <span>
          <strong>{t('automations.trust.headline')}</strong>{' '}
          {t('automations.trust.neverDeletes')} {t('automations.trust.forwardApproval')}
        </span>
      </div>

      {!canManage && !loading && !error ? (
        <div className="alert" role="status" style={{ marginBottom: 16 }}>
          {t('automations.viewerNotice')}
        </div>
      ) : null}

      {error ? (
        <div className="alert alert-error" role="alert" style={{ marginBottom: 16 }}>
          <span>{error}</span>
          <Btn size="sm" variant="secondary" icon="refresh" onClick={() => { setLoading(true); void load(); }} disabled={loading}>
            {t('automations.retry')}
          </Btn>
        </div>
      ) : null}

      <div className="card">
        <div className="tbl-wrap">
          {loading ? (
            <RuleTableSkeleton label={t('automations.loadingLabel')} />
          ) : rules.length === 0 ? (
            <div className="empty">
              <div className="ico"><Icon name="zap" size={20} /></div>
              <h3>{t('automations.empty.title')}</h3>
              <p>{t('automations.empty.body')}</p>
              {canManage ? (
                <Btn variant="primary" icon="plus" onClick={() => setFormRule({ mode: 'create', rule: null })}>
                  {t('automations.empty.cta')}
                </Btn>
              ) : null}
            </div>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('automations.table.name')}</th>
                  <th>{t('automations.table.inbox')}</th>
                  <th>{t('automations.table.cadence')}</th>
                  <th>{t('automations.table.action')}</th>
                  <th>{t('automations.table.enabled')}</th>
                  <th>{t('automations.table.lastRun')}</th>
                  <th className="right">{t('automations.table.actionsCol')}</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <RuleRow
                    key={rule.id}
                    rule={rule}
                    t={t}
                    canManage={canManage}
                    busy={busyId === rule.id}
                    onToggle={() => toggleEnabled(rule)}
                    onEdit={() => setFormRule({ mode: 'edit', rule })}
                    onRuns={() => setRunsRule(rule)}
                    onDelete={() => setDeleteRule(rule)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {formRule ? (
        <RuleFormModal
          mode={formRule.mode}
          rule={formRule.rule}
          inboxes={inboxes}
          keys={keys}
          onClose={() => setFormRule(null)}
          onSaved={async (message) => {
            setFormRule(null);
            toast({ message, variant: 'success' });
            await load();
          }}
        />
      ) : null}

      {runsRule ? <RunHistoryModal rule={runsRule} onClose={() => setRunsRule(null)} /> : null}

      {deleteRule ? (
        <DeleteDialog
          rule={deleteRule}
          submitting={busyId === deleteRule.id}
          onCancel={() => { if (!busyId) setDeleteRule(null); }}
          onConfirm={removeRule}
        />
      ) : null}
    </div>
  );
}

/* ── Row ───────────────────────────────────────────────────────────────── */

function RuleRow({ rule, t, canManage, busy, onToggle, onEdit, onRuns, onDelete }) {
  const cadence = CADENCE_OPTIONS.find((option) => option.minutes === rule.interval_minutes);
  const lastRun = rule.last_run;
  const lastRunAt = formatTimestamp(lastRun?.started_at);
  const running = Boolean(rule.running_since);

  return (
    <tr>
      <td>
        <div style={{ fontWeight: 500 }}>{rule.name}</div>
        {rule.disabled_reason ? (
          <div className="sub" style={{ fontSize: 12, color: 'var(--red-700)', marginTop: 2 }}>
            {t('automations.autoDisabled')}
          </div>
        ) : null}
      </td>
      <td>{inboxLabel(rule) ?? <span className="sub">{t('automations.unknownInbox')}</span>}</td>
      <td>{cadence ? t(`automations.cadence.${cadence.key}`) : `${rule.interval_minutes}`}</td>
      <td>{describeAction(rule.action, t)}</td>
      <td>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: canManage && !busy ? 'pointer' : 'default' }}>
          <input
            type="checkbox"
            checked={Boolean(rule.enabled)}
            onChange={onToggle}
            disabled={!canManage || busy}
            style={{ accentColor: 'var(--brand)' }}
            aria-label={rule.enabled ? t('automations.enabledOn') : t('automations.enabledOff')}
          />
          <span className="sub" style={{ fontSize: 12.5 }}>
            {rule.enabled ? t('automations.enabledOn') : t('automations.enabledOff')}
          </span>
        </label>
      </td>
      <td>
        {running ? (
          <Badge tone="brand">{t('automations.status.running')}</Badge>
        ) : lastRun ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
            <Badge tone={RUN_STATUS_TONE[lastRun.status] ?? 'neutral'}>
              {RUN_STATUS_KEY[lastRun.status] ? t(RUN_STATUS_KEY[lastRun.status]) : lastRun.status}
            </Badge>
            {lastRunAt ? <span className="sub" style={{ fontSize: 12 }}>{lastRunAt}</span> : null}
          </div>
        ) : (
          <span className="sub">{t('automations.status.never')}</span>
        )}
      </td>
      <td className="right">
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <Btn size="sm" variant="secondary" icon="activity" onClick={onRuns}>{t('automations.rowRuns')}</Btn>
          {canManage ? <Btn size="sm" variant="secondary" onClick={onEdit} disabled={busy}>{t('automations.rowEdit')}</Btn> : null}
          {canManage ? <Btn size="sm" variant="danger" icon="trash" onClick={onDelete} disabled={busy} aria-label={t('automations.rowDelete')}>{t('automations.rowDelete')}</Btn> : null}
        </div>
      </td>
    </tr>
  );
}

function describeAction(action, t) {
  if (!action || typeof action !== 'object') return <span className="sub">{t('automations.actionType.unknown')}</span>;
  if (action.type === 'move') return t('automations.actionSummary.move', { folder: action.folder ?? '' });
  if (action.type === 'label') return t('automations.actionSummary.label', { label: action.label ?? '' });
  if (action.type === 'mark_read') return t('automations.actionSummary.markRead');
  if (action.type === 'forward') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {t('automations.actionSummary.forward', { count: Array.isArray(action.to) ? action.to.length : 0 })}
        <Badge tone="amber">{t('automations.approvalBadge')}</Badge>
      </span>
    );
  }
  if (action.type === 'draft_reply') return t('automations.actionSummary.draftReply');
  return <span className="sub">{t('automations.actionType.unknown')}</span>;
}

/* ── Skeleton ──────────────────────────────────────────────────────────── */

function RuleTableSkeleton({ label }) {
  return (
    <div role="status" aria-label={label} style={{ padding: '14px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      {[0, 1, 2].map((row) => (
        <div key={row} aria-hidden="true" style={{ display: 'grid', gridTemplateColumns: '1.4fr 1.2fr 0.8fr 1.2fr 0.7fr 1fr', gap: 16, alignItems: 'center' }}>
          <span className="sk" style={{ width: row === 1 ? '78%' : '62%', height: 14 }} />
          <span className="sk" style={{ width: '70%', height: 14 }} />
          <span className="sk" style={{ width: '54%', height: 14 }} />
          <span className="sk" style={{ width: row === 2 ? '84%' : '66%', height: 14 }} />
          <span className="sk sk-pill" style={{ width: 58, height: 20 }} />
          <span className="sk sk-pill" style={{ width: 92, height: 20 }} />
        </div>
      ))}
    </div>
  );
}

/* ── Create / edit modal ───────────────────────────────────────────────── */

function initialFormState(rule) {
  const filter = (rule?.filter && typeof rule.filter === 'object') ? rule.filter : {};
  const action = (rule?.action && typeof rule.action === 'object') ? rule.action : { type: 'move' };
  return {
    name: rule?.name ?? '',
    inboxId: rule?.inbox_id ?? '',
    apiKeyId: rule?.api_key_id ?? '',
    intervalMinutes: rule?.interval_minutes ?? 60,
    maxMessages: rule?.max_messages_per_run ?? 25,
    from: filter.from ?? '',
    to: filter.to ?? '',
    subject: filter.subject ?? '',
    body: filter.body ?? '',
    unread: filter.unread === true,
    has_attachment: filter.has_attachment === true,
    flagged: filter.flagged === true,
    actionType: ACTION_TYPES.includes(action.type) ? action.type : 'move',
    folder: action.folder ?? '',
    label: action.label ?? '',
    forwardTo: Array.isArray(action.to) ? action.to.join(', ') : '',
    forwardNote: action.note ?? '',
    template: action.template ?? '',
  };
}

function buildFilter(form) {
  const filter = {};
  for (const { field } of TEXT_FILTERS) {
    const value = (form[field] ?? '').trim();
    if (value) filter[field] = value;
  }
  for (const { field } of BOOLEAN_FILTERS) {
    if (form[field]) filter[field] = true;
  }
  return filter;
}

function buildAction(form) {
  if (form.actionType === 'move') return { type: 'move', folder: form.folder.trim() };
  if (form.actionType === 'label') return { type: 'label', label: form.label.trim() };
  if (form.actionType === 'mark_read') return { type: 'mark_read' };
  if (form.actionType === 'forward') {
    const recipients = form.forwardTo.split(/[,;\s]+/).map((entry) => entry.trim()).filter(Boolean);
    const note = form.forwardNote.trim();
    return note ? { type: 'forward', to: recipients, note } : { type: 'forward', to: recipients };
  }
  return { type: 'draft_reply', template: form.template.trim() };
}

function RuleFormModal({ mode, rule, inboxes, keys, onClose, onSaved }) {
  const t = useTranslations('dashboard');
  const [form, setForm] = useState(() => initialFormState(rule));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState('');

  const set = (field, value) => setForm((current) => ({ ...current, [field]: value }));

  // Only keys that may actually be used with the chosen inbox. A key with an
  // explicit inbox allowlist is rejected server-side for any inbox outside it,
  // so offering it here would only produce a confusing save failure.
  const usableKeys = useMemo(() => keys.filter((key) => {
    if (!form.inboxId) return true;
    const bound = key.inboxIds;
    return !Array.isArray(bound) || bound.includes(form.inboxId);
  }), [keys, form.inboxId]);

  const filter = buildFilter(form);
  const hasFilter = Object.keys(filter).length > 0;
  const canPreview = Boolean(form.inboxId && form.apiKeyId && hasFilter) && !previewing && !submitting;

  const runPreview = async () => {
    if (!canPreview) return;
    setPreviewing(true);
    setPreviewError('');
    try {
      const response = await fetch('/api/automations/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inbox_id: form.inboxId, api_key_id: form.apiKeyId, filter }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || t('automations.modal.previewFailed'));
      setPreview(payload);
    } catch (error_) {
      setPreview(null);
      setPreviewError(error_ instanceof Error && error_.message ? error_.message : t('automations.modal.previewFailed'));
    } finally {
      setPreviewing(false);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const payloadBody = {
        name: form.name,
        inbox_id: form.inboxId,
        api_key_id: form.apiKeyId,
        interval_minutes: Number(form.intervalMinutes),
        max_messages_per_run: Number(form.maxMessages),
        filter,
        action: buildAction(form),
      };
      const response = await fetch(mode === 'create' ? '/api/automations' : `/api/automations/${rule.id}`, {
        method: mode === 'create' ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadBody),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || t('automations.errorGeneric'));
      await onSaved(mode === 'create' ? t('automations.toastCreated') : t('automations.toastUpdated'));
    } catch (submitError) {
      setError(submitError instanceof Error && submitError.message ? submitError.message : t('automations.errorGeneric'));
      setSubmitting(false);
    }
  };

  return (
    <div className="scrim" onClick={() => !submitting && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="automation-form-title" onClick={(event) => event.stopPropagation()} style={{ width: 620 }}>
        <div className="modal-h">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <h2 id="automation-form-title" style={{ margin: 0 }}>
                {mode === 'create' ? t('automations.modal.createTitle') : t('automations.modal.editTitle')}
              </h2>
              <div className="sub" style={{ marginTop: 4 }}>
                {mode === 'create' ? t('automations.modal.createSub') : t('automations.modal.editSub')}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              aria-label={t('automations.modal.close')}
              style={{ background: 'transparent', border: 0, color: 'var(--fg-3)', cursor: submitting ? 'not-allowed' : 'pointer', padding: 4, flexShrink: 0, lineHeight: 1 }}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>

        <form onSubmit={submit}>
          <div className="modal-body">
            <div className="field">
              <label htmlFor="automation-name">{t('automations.modal.nameLabel')}</label>
              <input
                id="automation-name"
                className="input"
                type="text"
                maxLength={80}
                value={form.name}
                placeholder={t('automations.modal.namePlaceholder')}
                onChange={(event) => set('name', event.target.value)}
                disabled={submitting}
                autoFocus
              />
            </div>

            <div className="field">
              <label htmlFor="automation-inbox">{t('automations.modal.inboxLabel')}</label>
              <select
                id="automation-inbox"
                className="input"
                value={form.inboxId}
                onChange={(event) => set('inboxId', event.target.value)}
                disabled={submitting}
              >
                <option value="">{t('automations.modal.inboxPlaceholder')}</option>
                {inboxes.map((inbox) => (
                  <option key={inbox.id} value={inbox.id}>{inbox.address || inbox.label}</option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="automation-key">{t('automations.modal.keyLabel')}</label>
              <select
                id="automation-key"
                className="input"
                value={form.apiKeyId}
                onChange={(event) => set('apiKeyId', event.target.value)}
                disabled={submitting}
              >
                <option value="">{t('automations.modal.keyPlaceholder')}</option>
                {usableKeys.map((key) => (
                  <option key={key.id} value={key.id}>{key.name}</option>
                ))}
              </select>
              <div className="sub" style={{ fontSize: 12 }}>{t('automations.modal.keyHelp')}</div>
            </div>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div className="field" style={{ flex: '1 1 200px', minWidth: 0 }}>
                <label htmlFor="automation-cadence">{t('automations.modal.cadenceLabel')}</label>
                <select
                  id="automation-cadence"
                  className="input"
                  value={form.intervalMinutes}
                  onChange={(event) => set('intervalMinutes', Number(event.target.value))}
                  disabled={submitting}
                >
                  {CADENCE_OPTIONS.map((option) => (
                    <option key={option.minutes} value={option.minutes}>{t(`automations.cadence.${option.key}`)}</option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ flex: '1 1 160px', minWidth: 0 }}>
                <label htmlFor="automation-max">{t('automations.modal.maxLabel')}</label>
                <input
                  id="automation-max"
                  className="input"
                  type="number"
                  min={1}
                  max={200}
                  value={form.maxMessages}
                  onChange={(event) => set('maxMessages', event.target.value)}
                  disabled={submitting}
                />
                <div className="sub" style={{ fontSize: 12 }}>{t('automations.modal.maxHelp')}</div>
              </div>
            </div>

            <fieldset style={{ border: '1px solid var(--border-1)', borderRadius: 10, padding: '12px 14px', margin: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <legend style={{ fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 500, padding: '0 6px' }}>
                {t('automations.modal.filterLegend')}
              </legend>
              <div className="sub" style={{ fontSize: 12 }}>{t('automations.modal.filterHelp')}</div>
              {TEXT_FILTERS.map(({ field, labelKey }) => (
                <div className="field" key={field}>
                  <label htmlFor={`automation-filter-${field}`}>{t(labelKey)}</label>
                  <input
                    id={`automation-filter-${field}`}
                    className="input"
                    type="text"
                    maxLength={500}
                    value={form[field]}
                    onChange={(event) => set(field, event.target.value)}
                    disabled={submitting}
                  />
                </div>
              ))}
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                {BOOLEAN_FILTERS.map(({ field, labelKey }) => (
                  <label key={field} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-sans)', fontSize: 13 }}>
                    <input
                      type="checkbox"
                      checked={form[field]}
                      onChange={(event) => set(field, event.target.checked)}
                      disabled={submitting}
                      style={{ accentColor: 'var(--brand)' }}
                    />
                    {t(labelKey)}
                  </label>
                ))}
              </div>
            </fieldset>

            {/* Preview. Placed between the filter and the action on purpose: it
                answers "what does this match" while the filter is still the
                thing on screen, before the user decides what to do to it. */}
            <div style={{ border: '1px solid var(--border-1)', borderRadius: 10, padding: '12px 14px', background: 'var(--ink-25)', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 500 }}>{t('automations.modal.previewTitle')}</div>
                  <div className="sub" style={{ fontSize: 12 }}>{t('automations.modal.previewHelp')}</div>
                </div>
                <Btn variant="primary" icon="eye" onClick={runPreview} disabled={!canPreview}>
                  {previewing ? t('automations.modal.previewing') : t('automations.modal.preview')}
                </Btn>
              </div>

              {previewError ? (
                <div className="alert alert-error" role="alert"><span>{previewError}</span></div>
              ) : null}

              {preview ? (
                preview.messages.length === 0 ? (
                  <div className="sub" style={{ fontSize: 13 }}>{t('automations.modal.previewEmpty')}</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13 }}>
                      {t('automations.modal.previewCount', { count: preview.matched })}
                    </div>
                    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {preview.messages.map((message, index) => (
                        <li key={message.id ?? index} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-1)', borderRadius: 8, padding: '8px 10px' }}>
                          <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-1)', overflowWrap: 'anywhere' }}>
                            {message.subject || t('automations.modal.previewNoSubject')}
                          </div>
                          <div className="sub" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>
                            {message.from || t('automations.modal.previewUnknownSender')}
                            {formatTimestamp(message.date) ? ` · ${formatTimestamp(message.date)}` : ''}
                          </div>
                        </li>
                      ))}
                    </ul>
                    {preview.truncated ? (
                      <div className="sub" style={{ fontSize: 12 }}>{t('automations.modal.previewMore', { count: preview.limit })}</div>
                    ) : null}
                  </div>
                )
              ) : null}
            </div>

            <fieldset style={{ border: '1px solid var(--border-1)', borderRadius: 10, padding: '12px 14px', margin: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <legend style={{ fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 500, padding: '0 6px' }}>
                {t('automations.modal.actionLegend')}
              </legend>
              <div className="field">
                <label htmlFor="automation-action">{t('automations.modal.actionLabel')}</label>
                <select
                  id="automation-action"
                  className="input"
                  value={form.actionType}
                  onChange={(event) => set('actionType', event.target.value)}
                  disabled={submitting}
                >
                  {ACTION_TYPES.map((type) => (
                    <option key={type} value={type}>{t(ACTION_LABEL_KEY[type])}</option>
                  ))}
                </select>
              </div>

              {form.actionType === 'move' ? (
                <div className="field">
                  <label htmlFor="automation-folder">{t('automations.modal.folderLabel')}</label>
                  <input id="automation-folder" className="input" type="text" maxLength={200} value={form.folder} placeholder={t('automations.modal.folderPlaceholder')} onChange={(event) => set('folder', event.target.value)} disabled={submitting} />
                </div>
              ) : null}

              {form.actionType === 'label' ? (
                <div className="field">
                  <label htmlFor="automation-label">{t('automations.modal.labelLabel')}</label>
                  <input id="automation-label" className="input" type="text" maxLength={200} value={form.label} placeholder={t('automations.modal.labelPlaceholder')} onChange={(event) => set('label', event.target.value)} disabled={submitting} />
                  <div className="sub" style={{ fontSize: 12 }}>{t('automations.modal.labelHelp')}</div>
                </div>
              ) : null}

              {form.actionType === 'mark_read' ? (
                <div className="sub" style={{ fontSize: 12.5 }}>{t('automations.modal.markReadNote')}</div>
              ) : null}

              {form.actionType === 'forward' ? (
                <>
                  <div className="field">
                    <label htmlFor="automation-forward-to">{t('automations.modal.forwardToLabel')}</label>
                    <input id="automation-forward-to" className="input" type="text" value={form.forwardTo} placeholder={t('automations.modal.forwardToPlaceholder')} onChange={(event) => set('forwardTo', event.target.value)} disabled={submitting} />
                    <div className="sub" style={{ fontSize: 12 }}>{t('automations.modal.forwardToHelp')}</div>
                  </div>
                  <div className="field">
                    <label htmlFor="automation-forward-note">{t('automations.modal.forwardNoteLabel')}</label>
                    <input id="automation-forward-note" className="input" type="text" maxLength={500} value={form.forwardNote} placeholder={t('automations.modal.forwardNotePlaceholder')} onChange={(event) => set('forwardNote', event.target.value)} disabled={submitting} />
                  </div>
                  <div className="alert" role="note"><span>{t('automations.modal.forwardApprovalNote')}</span></div>
                </>
              ) : null}

              {form.actionType === 'draft_reply' ? (
                <div className="field">
                  <label htmlFor="automation-template">{t('automations.modal.templateLabel')}</label>
                  <textarea
                    id="automation-template"
                    className="input"
                    rows={5}
                    maxLength={5000}
                    value={form.template}
                    placeholder={t('automations.modal.templatePlaceholder')}
                    onChange={(event) => set('template', event.target.value)}
                    disabled={submitting}
                    style={{ height: 'auto', padding: '10px 12px', lineHeight: 1.5, resize: 'vertical' }}
                  />
                  <div className="sub" style={{ fontSize: 12 }}>{t('automations.modal.templateHelp')}</div>
                </div>
              ) : null}
            </fieldset>

            {mode === 'create' ? (
              <div className="sub" style={{ fontSize: 12.5 }}>{t('automations.modal.createdNote')}</div>
            ) : null}

            {error ? <div className="alert alert-error" role="alert"><span>{error}</span></div> : null}
          </div>

          <div className="modal-foot">
            <Btn variant="ghost" onClick={onClose} disabled={submitting}>{t('automations.modal.cancel')}</Btn>
            <Btn variant="primary" type="submit" disabled={submitting}>
              {submitting
                ? (mode === 'create' ? t('automations.modal.creating') : t('automations.modal.saving'))
                : (mode === 'create' ? t('automations.modal.create') : t('automations.modal.save'))}
            </Btn>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ── Run history modal ─────────────────────────────────────────────────── */

function RunHistoryModal({ rule, onClose }) {
  const t = useTranslations('dashboard');
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [nextBefore, setNextBefore] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [openRun, setOpenRun] = useState(null);

  const loadRuns = useCallback(async (before) => {
    try {
      const url = before
        ? `/api/automations/${rule.id}/runs?before=${encodeURIComponent(before)}`
        : `/api/automations/${rule.id}/runs`;
      const response = await fetch(url, { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || t('automations.runs.errorLoad'));
      setRuns((current) => (before ? [...current, ...(payload.runs ?? [])] : (payload.runs ?? [])));
      setNextBefore(payload.has_more ? payload.next_before : null);
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error && loadError.message ? loadError.message : t('automations.runs.errorLoad'));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [rule.id, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadRuns(null); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadRuns]);

  // Poll while a run is in flight, so a manual or scheduled run resolves in
  // front of the person watching it. Only the first page is refreshed: a run
  // that has already scrolled out of view is finished by definition.
  const anyRunning = runs.some((run) => run.status === 'running');
  useEffect(() => {
    if (!anyRunning) return undefined;
    const id = window.setInterval(() => { void loadRuns(null); }, 5000);
    return () => window.clearInterval(id);
  }, [anyRunning, loadRuns]);

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="automation-runs-title" onClick={(event) => event.stopPropagation()} style={{ width: 760 }}>
        <div className="modal-h">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <h2 id="automation-runs-title" style={{ margin: 0 }}>{t('automations.runs.title')}</h2>
              <div className="sub" style={{ marginTop: 4 }}>{t('automations.runs.subtitle', { name: rule.name })}</div>
            </div>
            <button type="button" onClick={onClose} aria-label={t('automations.runs.close')} style={{ background: 'transparent', border: 0, color: 'var(--fg-3)', cursor: 'pointer', padding: 4, flexShrink: 0, lineHeight: 1 }}>
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>

        <div className="modal-body">
          {error ? (
            <div className="alert alert-error" role="alert">
              <span>{error}</span>
              <Btn size="sm" variant="secondary" icon="refresh" onClick={() => { setLoading(true); void loadRuns(null); }}>{t('automations.retry')}</Btn>
            </div>
          ) : null}

          {loading ? (
            <RuleTableSkeleton label={t('automations.runs.loadingLabel')} />
          ) : openRun ? (
            <RunItems rule={rule} run={openRun} onBack={() => setOpenRun(null)} />
          ) : runs.length === 0 ? (
            <div className="empty">
              <div className="ico"><Icon name="activity" size={20} /></div>
              <h3>{t('automations.runs.empty')}</h3>
              <p>{t('automations.runs.emptyBody')}</p>
            </div>
          ) : (
            <>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>{t('automations.runs.colStarted')}</th>
                      <th>{t('automations.runs.colStatus')}</th>
                      <th>{t('automations.runs.colTrigger')}</th>
                      <th>{t('automations.runs.colResult')}</th>
                      <th className="right" />
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((run) => (
                      <tr key={run.id}>
                        <td>{formatTimestamp(run.started_at) ?? t('automations.unknownTime')}</td>
                        <td>
                          <Badge tone={RUN_STATUS_TONE[run.status] ?? 'neutral'}>
                            {RUN_STATUS_KEY[run.status] ? t(RUN_STATUS_KEY[run.status]) : run.status}
                          </Badge>
                        </td>
                        <td>{run.trigger === 'manual' ? t('automations.runs.triggerManual') : t('automations.runs.triggerSchedule')}</td>
                        <td>
                          <div>{t('automations.runs.resultSummary', { matched: run.matched ?? 0, succeeded: run.succeeded ?? 0, failed: run.failed ?? 0, skipped: run.skipped ?? 0 })}</div>
                          {run.error_detail ? <div className="sub" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{run.error_detail}</div> : null}
                        </td>
                        <td className="right">
                          <Btn size="sm" variant="secondary" onClick={() => setOpenRun(run)}>{t('automations.runs.viewItems')}</Btn>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {nextBefore ? (
                <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
                  <Btn variant="secondary" disabled={loadingMore} onClick={() => { setLoadingMore(true); void loadRuns(nextBefore); }}>
                    {loadingMore ? t('automations.runs.loading') : t('automations.runs.loadMore')}
                  </Btn>
                </div>
              ) : null}
            </>
          )}
        </div>

        <div className="modal-foot">
          <Btn variant="secondary" onClick={onClose}>{t('automations.runs.close')}</Btn>
        </div>
      </div>
    </div>
  );
}

/** Per-message detail for one run: what actually happened to each email. */
function RunItems({ rule, run, onBack }) {
  const t = useTranslations('dashboard');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/automations/${rule.id}/runs?run_id=${encodeURIComponent(run.id)}`, { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || t('automations.runs.errorLoad'));
      setItems(Array.isArray(payload.items) ? payload.items : []);
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error && loadError.message ? loadError.message : t('automations.runs.errorLoad'));
    } finally {
      setLoading(false);
    }
  }, [rule.id, run.id, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  // A run still in flight keeps producing items. Poll until it stops.
  useEffect(() => {
    if (run.status !== 'running') return undefined;
    const id = window.setInterval(() => { void load(); }, 5000);
    return () => window.clearInterval(id);
  }, [run.status, load]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Btn size="sm" variant="secondary" onClick={onBack}>{t('automations.runs.itemsBack')}</Btn>
        <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-2)' }}>
          {t('automations.runs.itemsTitle', { started: formatTimestamp(run.started_at) ?? '' })}
        </div>
      </div>

      {error ? (
        <div className="alert alert-error" role="alert">
          <span>{error}</span>
          <Btn size="sm" variant="secondary" icon="refresh" onClick={() => { setLoading(true); void load(); }}>{t('automations.retry')}</Btn>
        </div>
      ) : null}

      {loading ? (
        <RuleTableSkeleton label={t('automations.runs.loadingLabel')} />
      ) : items.length === 0 ? (
        <div className="empty">
          <div className="ico"><Icon name="mail" size={20} /></div>
          <h3>{t('automations.runs.itemsEmpty')}</h3>
          <p>{t('automations.runs.itemsEmptyBody')}</p>
        </div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('automations.runs.colSubject')}</th>
                <th>{t('automations.runs.colSender')}</th>
                <th>{t('automations.runs.colOutcome')}</th>
                <th>{t('automations.runs.colDetail')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td style={{ overflowWrap: 'anywhere' }}>{item.subject_redacted || <span className="sub">{t('automations.runs.noSubject')}</span>}</td>
                  <td style={{ overflowWrap: 'anywhere' }}>{item.sender_redacted || <span className="sub">{t('automations.runs.unknownSender')}</span>}</td>
                  <td>
                    <Badge tone={OUTCOME_TONE[item.outcome] ?? 'neutral'}>
                      {OUTCOME_KEY[item.outcome] ? t(OUTCOME_KEY[item.outcome]) : item.outcome}
                    </Badge>
                  </td>
                  <td className="sub" style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>{describeItemDetail(item, t)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function describeItemDetail(item, t) {
  const detail = item.detail && typeof item.detail === 'object' ? item.detail : {};
  if (item.outcome === 'failed') {
    // Named before the generic code branch: an IMAP server that will not keep
    // custom keywords is a cause the user can act on, not an opaque code.
    if (detail.error_code === 'imap_keywords_unsupported') return t('automations.runs.detailKeywordsUnsupported');
    if (detail.error_code) return t('automations.runs.detailFailed', { code: String(detail.error_code) });
  }
  if (item.outcome === 'queued_for_approval') return t('automations.runs.detailQueued');
  if (item.outcome === 'skipped_duplicate') return t('automations.runs.detailSkipped');
  if (detail.to_folder) return t('automations.runs.detailMoved', { folder: String(detail.to_folder) });
  // `applied_as` is what the mailbox actually carries, which is not always the
  // label that was typed: an IMAP keyword cannot hold a space.
  if (detail.applied_as) {
    return detail.already_present
      ? t('automations.runs.detailLabelAlready', { label: String(detail.applied_as) })
      : t('automations.runs.detailLabelled', { label: String(detail.applied_as) });
  }
  return t('automations.runs.detailApplied');
}

/* ── Delete dialog ─────────────────────────────────────────────────────── */

function DeleteDialog({ rule, submitting, onCancel, onConfirm }) {
  const t = useTranslations('dashboard');
  return (
    <div className="scrim" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="automation-delete-title" onClick={(event) => event.stopPropagation()} style={{ width: 460 }}>
        <div className="modal-h">
          <h2 id="automation-delete-title" style={{ margin: 0 }}>{t('automations.delete.title')}</h2>
          <div className="sub" style={{ marginTop: 6 }}>{t('automations.delete.body', { name: rule.name })}</div>
        </div>
        <div className="modal-body">
          <div className="alert" role="note"><span>{t('automations.delete.historyNote')}</span></div>
        </div>
        <div className="modal-foot">
          <Btn variant="ghost" onClick={onCancel} disabled={submitting}>{t('automations.delete.cancel')}</Btn>
          <Btn variant="destructive" onClick={onConfirm} disabled={submitting}>
            {submitting ? t('automations.delete.deleting') : t('automations.delete.confirm')}
          </Btn>
        </div>
      </div>
    </div>
  );
}
