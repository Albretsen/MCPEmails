'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Btn } from '../Primitives';
import { useToast } from './Toast';
import {
  NO_APPROVAL_DEFAULT_LIMIT,
  NO_APPROVAL_MAX_LIMIT,
  NO_APPROVAL_MAX_NAME,
  NO_APPROVAL_MAX_RECIPIENTS,
  parseExactAddresses,
} from '@/lib/approvals/no-approval';

/* NoApprovalRules.jsx: the addresses a person trusts to receive rule forwards with
   nobody approving each one. Approval stays the default for everything else.

   Everything here goes through /api/no-approval-rules, which runs as the signed-in
   person. Saving a rule that is on always passes through a dialog naming the
   addresses, so nobody turns this on without reading where the mail goes. */

function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

async function send(url, method, body) {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, payload };
}

function errorText(t, code) {
  const key = `automations.noApproval.errors.${code}`;
  return t.has(key) ? t(key) : t('automations.noApproval.errors.generic');
}

/** What a saved rule sends to the routes, from a row as the overview returns it. */
function ruleBody(rule, changes = {}) {
  return {
    name: rule.name,
    recipients: rule.recipients,
    scope: rule.scope,
    automation_ids: (rule.automations ?? []).map((automation) => automation.id),
    inbox_ids: rule.inbox_ids,
    daily_limit: rule.daily_limit,
    time_zone: rule.time_zone,
    verified_senders_only: rule.verified_senders_only,
    enabled: rule.enabled,
    ...changes,
  };
}

export function NoApprovalRules({ canManage, overview, automations = [], inboxes = [], onChanged }) {
  const t = useTranslations('dashboard');
  const { toast } = useToast();
  const [form, setForm] = useState(null); // { rule | null }
  const [confirm, setConfirm] = useState(null); // { id, body }
  const [remove, setRemove] = useState(null);
  const [reconfirm, setReconfirm] = useState(null); // { rule, automation }
  const [working, setWorking] = useState(false);

  if (!overview) return null;
  const rules = overview.rules ?? [];
  const pausedAll = overview.paused_all === true;

  const run = async (action) => {
    setWorking(true);
    try {
      const { ok, payload } = await action();
      if (!ok) {
        toast({ message: errorText(t, payload.code), variant: 'error' });
        return false;
      }
      await onChanged?.();
      return true;
    } catch {
      toast({ message: t('automations.noApproval.errors.generic'), variant: 'error' });
      return false;
    } finally {
      setWorking(false);
    }
  };

  const save = async ({ id, body }) => {
    const done = await run(() => (id
      ? send(`/api/no-approval-rules/${id}`, 'PATCH', body)
      : send('/api/no-approval-rules', 'POST', body)));
    if (done) {
      setForm(null);
      setConfirm(null);
      toast({ message: t('automations.noApproval.saved'), variant: 'success' });
    }
    return done;
  };

  const toggle = (rule) => {
    const body = ruleBody(rule, { enabled: !rule.enabled });
    if (body.enabled) setConfirm({ id: rule.id, body });
    else void save({ id: rule.id, body });
  };

  const pauseAll = async () => {
    const done = await run(() => send('/api/no-approval-rules/pause', 'POST', { paused: !pausedAll }));
    if (done) toast({ message: t(pausedAll ? 'automations.noApproval.resumedAll' : 'automations.noApproval.pausedAll'), variant: 'success' });
  };

  return (
    <div className="card" style={{ marginTop: 16 }} data-testid="no-approval-rules">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', padding: '14px 16px' }}>
        <div style={{ flex: '1 1 320px' }}>
          <div style={{ fontWeight: 500 }}>{t('automations.noApproval.title')}</div>
          <div className="sub" style={{ fontSize: 13, marginTop: 2 }}>{t('automations.noApproval.sub')}</div>
        </div>
        {canManage ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            {rules.length > 0 ? (
              <Btn size="sm" variant="secondary" onClick={pauseAll} disabled={working}>
                {t(pausedAll ? 'automations.noApproval.resumeAllButton' : 'automations.noApproval.pauseAllButton')}
              </Btn>
            ) : null}
            <Btn size="sm" variant="secondary" icon="plus" onClick={() => setForm({ rule: null })} disabled={working}>
              {t('automations.noApproval.add')}
            </Btn>
          </div>
        ) : null}
      </div>

      {pausedAll ? (
        <div className="alert" role="status" style={{ margin: '0 16px 14px' }}>
          <span>{t('automations.noApproval.pausedAllNotice')}</span>
        </div>
      ) : null}

      {rules.length > 0 ? (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('automations.noApproval.colName')}</th>
                <th>{t('automations.noApproval.colAddresses')}</th>
                <th>{t('automations.noApproval.colScope')}</th>
                <th>{t('automations.noApproval.colToday')}</th>
                <th>{t('automations.table.enabled')}</th>
                <th className="right">{t('automations.table.actionsCol')}</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{rule.name}</div>
                    {rule.paused_at ? (
                      <div className="sub" style={{ fontSize: 12, color: 'var(--amber-700)', marginTop: 2 }}>
                        {t('automations.noApproval.pausedByFailures')}
                      </div>
                    ) : null}
                  </td>
                  <td style={{ overflowWrap: 'break-word' }}>{rule.recipients.join(', ')}</td>
                  <td>
                    {rule.scope === 'all_automations' ? t('automations.noApproval.scopeAll') : t('automations.noApproval.scopeChosen')}
                    {(rule.automations ?? []).map((automation) => (
                      <div key={automation.id} className="sub" style={{ fontSize: 12, marginTop: 2, overflowWrap: 'anywhere' }}>
                        {automation.name}
                        {automation.voided ? (
                          <>
                            {' · '}
                            <span style={{ color: 'var(--amber-700)' }}>{t('automations.noApproval.voided')}</span>
                            {canManage ? (
                              <>
                                {' '}
                                <button type="button" className="link-btn" style={{ background: 'none', border: 0, padding: 0, color: 'var(--brand)', cursor: 'pointer', font: 'inherit', textDecoration: 'underline' }} onClick={() => setReconfirm({ rule, automation })}>
                                  {t('automations.noApproval.reconfirm')}
                                </button>
                              </>
                            ) : null}
                          </>
                        ) : null}
                      </div>
                    ))}
                  </td>
                  <td>{t('automations.noApproval.todayCount', { used: rule.used_today ?? 0, limit: rule.daily_limit })}</td>
                  <td>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: canManage && !working ? 'pointer' : 'default' }}>
                      <input type="checkbox" checked={Boolean(rule.enabled)} onChange={() => toggle(rule)} disabled={!canManage || working} style={{ accentColor: 'var(--brand)' }} aria-label={rule.enabled ? t('automations.enabledOn') : t('automations.enabledOff')} />
                      <span className="sub" style={{ fontSize: 12.5 }}>{rule.enabled ? t('automations.enabledOn') : t('automations.enabledOff')}</span>
                    </label>
                  </td>
                  <td className="right">
                    {canManage ? (
                      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                        <Btn size="sm" variant="secondary" onClick={() => setForm({ rule })} disabled={working}>{t('automations.rowEdit')}</Btn>
                        <Btn size="sm" variant="danger" onClick={() => setRemove(rule)} disabled={working}>{t('automations.rowDelete')}</Btn>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {form ? (
        <RuleForm
          rule={form.rule}
          automations={automations}
          inboxes={inboxes}
          working={working}
          onClose={() => setForm(null)}
          onSubmit={(payload) => {
            if (payload.body.enabled) setConfirm(payload);
            else void save(payload);
          }}
        />
      ) : null}

      {confirm ? (
        <ConfirmDialog
          title={t('automations.noApproval.confirmTitle')}
          body={t('automations.noApproval.confirmBody', { addresses: confirm.body.recipients.join(', ') })}
          note={confirm.body.scope === 'all_automations' ? t('automations.noApproval.confirmAllNote') : t('automations.noApproval.confirmChosenNote')}
          confirmLabel={t('automations.noApproval.confirmButton')}
          working={working}
          onCancel={() => setConfirm(null)}
          onConfirm={() => save(confirm)}
        />
      ) : null}

      {reconfirm ? (
        <ConfirmDialog
          title={t('automations.noApproval.reconfirmTitle', { automation: reconfirm.automation.name })}
          body={t('automations.noApproval.reconfirmBody', { addresses: reconfirm.rule.recipients.join(', ') })}
          confirmLabel={t('automations.noApproval.reconfirmButton')}
          working={working}
          onCancel={() => setReconfirm(null)}
          onConfirm={async () => {
            const done = await run(() => send(`/api/no-approval-rules/${reconfirm.rule.id}/confirm`, 'POST', { automation_id: reconfirm.automation.id }));
            if (done) setReconfirm(null);
          }}
        />
      ) : null}

      {remove ? (
        <ConfirmDialog
          title={t('automations.noApproval.deleteTitle', { name: remove.name })}
          body={t('automations.noApproval.deleteBody')}
          confirmLabel={t('automations.rowDelete')}
          danger
          working={working}
          onCancel={() => setRemove(null)}
          onConfirm={async () => {
            const done = await run(() => send(`/api/no-approval-rules/${remove.id}`, 'DELETE', {}));
            if (done) setRemove(null);
          }}
        />
      ) : null}
    </div>
  );
}

function ConfirmDialog({ title, body, note, confirmLabel, danger = false, working, onCancel, onConfirm }) {
  const t = useTranslations('dashboard');
  return (
    <div className="scrim" onClick={() => !working && onCancel()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="no-approval-confirm-title" onClick={(event) => event.stopPropagation()} style={{ width: 460 }}>
        <div className="modal-h">
          <h2 id="no-approval-confirm-title" style={{ margin: 0, overflowWrap: 'anywhere' }}>{title}</h2>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0, overflowWrap: 'anywhere', fontSize: 13.5 }}>{body}</p>
          {note ? <p className="sub" style={{ margin: 0, fontSize: 12.5 }}>{note}</p> : null}
        </div>
        <div className="modal-foot">
          <Btn variant="secondary" onClick={onCancel} disabled={working}>{t('automations.noApproval.cancel')}</Btn>
          <Btn variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={working}>{confirmLabel}</Btn>
        </div>
      </div>
    </div>
  );
}

function RuleForm({ rule, automations, inboxes, working, onClose, onSubmit }) {
  const t = useTranslations('dashboard');
  const [name, setName] = useState(rule?.name ?? '');
  const [recipients, setRecipients] = useState((rule?.recipients ?? []).join(', '));
  const [scope, setScope] = useState(rule?.scope ?? 'all_automations');
  const [chosen, setChosen] = useState(() => new Set((rule?.automations ?? []).map((a) => a.id)));
  const [limitInboxes, setLimitInboxes] = useState(Array.isArray(rule?.inbox_ids));
  const [chosenInboxes, setChosenInboxes] = useState(() => new Set(rule?.inbox_ids ?? []));
  const [dailyLimit, setDailyLimit] = useState(rule?.daily_limit ?? NO_APPROVAL_DEFAULT_LIMIT);
  const [verified, setVerified] = useState(rule?.verified_senders_only ?? true);
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [problem, setProblem] = useState('');

  const forwardRules = automations.filter((automation) => automation.action?.type === 'forward');
  const toggleIn = (setter, id) => setter((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const submit = (event) => {
    event.preventDefault();
    const parsed = parseExactAddresses(recipients);
    if (!name.trim()) return setProblem(t('automations.noApproval.errors.invalid_name'));
    if (parsed.invalid.length > 0) return setProblem(t('automations.noApproval.errors.notExact', { address: parsed.invalid[0] }));
    if (parsed.addresses.length === 0 || parsed.addresses.length > NO_APPROVAL_MAX_RECIPIENTS) {
      return setProblem(t('automations.noApproval.errors.invalid_recipients'));
    }
    const limit = Number(dailyLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > NO_APPROVAL_MAX_LIMIT) {
      return setProblem(t('automations.noApproval.errors.invalid_limit', { max: NO_APPROVAL_MAX_LIMIT }));
    }
    if (scope === 'chosen_automations' && chosen.size === 0) return setProblem(t('automations.noApproval.errors.automations_required'));
    if (limitInboxes && chosenInboxes.size === 0) return setProblem(t('automations.noApproval.errors.invalid_inbox'));
    setProblem('');
    return onSubmit({
      id: rule?.id ?? null,
      body: {
        name: name.trim(),
        recipients: parsed.addresses,
        scope,
        automation_ids: scope === 'chosen_automations' ? [...chosen] : [],
        inbox_ids: limitInboxes ? [...chosenInboxes] : null,
        daily_limit: limit,
        time_zone: localTimeZone(),
        verified_senders_only: verified,
        enabled,
      },
    });
  };

  const check = { display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13.5, fontFamily: 'var(--font-sans)', overflowWrap: 'anywhere' };

  return (
    <div className="scrim" onClick={() => !working && onClose()}>
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="no-approval-form-title" onClick={(event) => event.stopPropagation()} onSubmit={submit} style={{ width: 520 }}>
        <div className="modal-h">
          <h2 id="no-approval-form-title" style={{ margin: 0 }}>{t(rule ? 'automations.noApproval.formEditTitle' : 'automations.noApproval.formAddTitle')}</h2>
        </div>
        <div className="modal-body">
          {problem ? <div className="alert alert-error" role="alert">{problem}</div> : null}
          <div className="field">
            <label htmlFor="no-approval-name">{t('automations.noApproval.nameLabel')}</label>
            <input id="no-approval-name" className="input" type="text" maxLength={NO_APPROVAL_MAX_NAME} value={name} onChange={(event) => setName(event.target.value)} placeholder={t('automations.noApproval.namePlaceholder')} />
          </div>
          <div className="field">
            <label htmlFor="no-approval-recipients">{t('automations.noApproval.recipientsLabel')}</label>
            <input id="no-approval-recipients" className="input" type="text" value={recipients} onChange={(event) => setRecipients(event.target.value)} placeholder={t('automations.noApproval.recipientsPlaceholder')} />
            <div className="sub" style={{ fontSize: 12 }}>{t('automations.noApproval.recipientsHelp')}</div>
          </div>
          <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <legend style={{ fontSize: 13, fontWeight: 500, padding: 0, marginBottom: 6 }}>{t('automations.noApproval.scopeLabel')}</legend>
            <label style={check}>
              <input type="radio" name="no-approval-scope" checked={scope === 'all_automations'} onChange={() => setScope('all_automations')} />
              <span>
                {t('automations.noApproval.scopeAll')}
                <span className="sub" style={{ display: 'block', fontSize: 12 }}>{t('automations.noApproval.scopeAllHelp')}</span>
              </span>
            </label>
            <label style={check}>
              <input type="radio" name="no-approval-scope" checked={scope === 'chosen_automations'} onChange={() => setScope('chosen_automations')} />
              <span>
                {t('automations.noApproval.scopeChosen')}
                <span className="sub" style={{ display: 'block', fontSize: 12 }}>{t('automations.noApproval.scopeChosenHelp')}</span>
              </span>
            </label>
            {scope === 'chosen_automations' ? (
              forwardRules.length > 0 ? forwardRules.map((automation) => (
                <label key={automation.id} style={{ ...check, marginLeft: 24 }}>
                  <input type="checkbox" checked={chosen.has(automation.id)} onChange={() => toggleIn(setChosen, automation.id)} />
                  <span>{automation.name}</span>
                </label>
              )) : <div className="sub" style={{ fontSize: 12, marginLeft: 24 }}>{t('automations.noApproval.noForwardRules')}</div>
            ) : null}
          </fieldset>
          <div className="field">
            <label htmlFor="no-approval-limit">{t('automations.noApproval.limitLabel')}</label>
            <input id="no-approval-limit" className="input" type="number" min={1} max={NO_APPROVAL_MAX_LIMIT} value={dailyLimit} onChange={(event) => setDailyLimit(event.target.value)} style={{ maxWidth: 120 }} />
            <div className="sub" style={{ fontSize: 12 }}>{t('automations.noApproval.limitHelp', { max: NO_APPROVAL_MAX_LIMIT, zone: localTimeZone() })}</div>
          </div>
          <label style={check}>
            <input type="checkbox" checked={verified} onChange={(event) => setVerified(event.target.checked)} />
            <span>
              {t('automations.noApproval.verifiedLabel')}
              <span className="sub" style={{ display: 'block', fontSize: 12 }}>{t('automations.noApproval.verifiedHelp')}</span>
            </span>
          </label>
          <label style={check}>
            <input type="checkbox" checked={limitInboxes} onChange={(event) => setLimitInboxes(event.target.checked)} />
            <span>{t('automations.noApproval.inboxesLabel')}</span>
          </label>
          {limitInboxes ? inboxes.map((inbox) => (
            <label key={inbox.id} style={{ ...check, marginLeft: 24 }}>
              <input type="checkbox" checked={chosenInboxes.has(inbox.id)} onChange={() => toggleIn(setChosenInboxes, inbox.id)} />
              <span>{inbox.email_address ?? inbox.display_name}</span>
            </label>
          )) : null}
          <label style={check}>
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            <span>{t('automations.noApproval.enabledLabel')}</span>
          </label>
          <div className="sub" style={{ fontSize: 12 }}>{t('automations.noApproval.receiptHelp')}</div>
        </div>
        <div className="modal-foot">
          <Btn variant="secondary" onClick={onClose} disabled={working}>{t('automations.noApproval.cancel')}</Btn>
          <button type="submit" className="btn btn-primary" disabled={working}>{t('automations.noApproval.save')}</button>
        </div>
      </form>
    </div>
  );
}

/** The row's badge. Used by AutomationsPanel. */
export function RunsWithoutApprovalBadge() {
  const t = useTranslations('dashboard');
  return <Badge tone="green">{t('automations.noApproval.runsWithoutApproval')}</Badge>;
}
