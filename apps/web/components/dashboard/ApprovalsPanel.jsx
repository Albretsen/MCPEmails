'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Btn, Icon } from '../Primitives';
import { OriginalMessage } from '../approvals/OriginalMessage';
import { deliveryInFlight, deliveryReasonText, formatTimeLeft, useNow } from '../approvals/approvalDisplay';
import { useToast } from './Toast';

/** How often the page looks again while a send is on its way, and for how long. */
const POLL_MS = 4000;
const POLL_MAX = 45;

function approvalLabel(item, t) {
  return item.inboxes?.display_name ?? item.inboxes?.email_address ?? t('approvals.panel.unknownInbox');
}

function recipientsOf(item) {
  return Array.isArray(item.summary?.to) ? item.summary.to.filter(Boolean) : [];
}

function recipientLabel(item, t) {
  const recipients = recipientsOf(item);
  return recipients.length ? recipients.join(', ') : t('approvals.panel.noRecipient');
}

function isPastDeadline(item, nowMs) {
  return Boolean(item.expires_at) && Date.parse(item.expires_at) <= nowMs;
}

/** A decision the server refused because the request changed after it was shown. */
class ChangedError extends Error {}
/** A decision the server refused because the request is over: expired or decided. */
class ClosedError extends Error {}

/**
 * Waiting forwards grouped by the rule that queued them, from the live list on this
 * page. A rule qualifies for "Approve all" only when every row goes to one address,
 * with nobody copied. The server checks the same thing again.
 */
function ruleGroups(items) {
  const groups = new Map();
  for (const item of items) {
    if (item.kind !== 'rule_forward' || !item.rule_id || item.rule_deleted) continue;
    const group = groups.get(item.rule_id) ?? { ruleId: item.rule_id, ruleName: item.rule_name, rows: [] };
    group.rows.push(item);
    groups.set(item.rule_id, group);
  }
  return [...groups.values()].filter((group) => group.rows.length > 1).map((group) => {
    const addresses = new Set();
    let single = true;
    for (const row of group.rows) {
      const to = recipientsOf(row);
      if (to.length !== 1 || (row.summary?.cc ?? []).length > 0 || Number(row.summary?.bcc_count ?? 0) > 0) single = false;
      to.forEach((address) => addresses.add(String(address).trim().toLowerCase()));
    }
    return { ...group, address: single && addresses.size === 1 ? [...addresses][0] : null };
  });
}

/**
 * Pending email send decisions. The list only shows the small review summary
 * supplied by the API. The original of a forward is read live, for one row, when a
 * person opens it.
 */
export function ApprovalsPanel({ userRole }) {
  const t = useTranslations('dashboard');
  const { toast } = useToast();
  const [items, setItems] = useState([]);
  const [decided, setDecided] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [decisionItem, setDecisionItem] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [again, setAgain] = useState(null);
  const [approveAll, setApproveAll] = useState(null);
  const canDecide = userRole === 'owner' || userRole === 'admin';
  const now = useNow();
  const polls = useRef(0);

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const response = await fetch('/api/approvals', { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || t('approvals.panel.loadFailed'));
      const pending = Array.isArray(payload.approvals) ? payload.approvals : [];
      setItems(pending);
      setDecided(Array.isArray(payload.decided) ? payload.decided : []);
      setError('');
      return pending;
    } catch (loadError) {
      setError(loadError instanceof Error && loadError.message ? loadError.message : t('approvals.panel.loadFailed'));
      return null;
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  // A send on its way: look again until it has an outcome.
  const inFlight = decided.some((row) => deliveryInFlight(row.delivery));
  useEffect(() => {
    if (!inFlight) { polls.current = 0; return undefined; }
    if (polls.current >= POLL_MAX) return undefined;
    const timer = window.setTimeout(() => {
      polls.current += 1;
      void load({ quiet: true });
    }, POLL_MS);
    return () => window.clearTimeout(timer);
  }, [inFlight, decided, load]);

  // A row whose deadline passed while the page was open moves to the decided list.
  const lapsed = items.some((item) => isPastDeadline(item, now));
  useEffect(() => {
    if (!lapsed) return undefined;
    const timer = window.setTimeout(() => { void load({ quiet: true }); }, 0);
    return () => window.clearTimeout(timer);
  }, [lapsed, load]);

  // The open dialog can not stay open on a request that can no longer be approved.
  const decisionLapsed = Boolean(decisionItem) && isPastDeadline(decisionItem.item, now);
  useEffect(() => {
    if (!decisionLapsed) return undefined;
    const timer = window.setTimeout(() => {
      setDecisionItem(null);
      toast({ message: t('approvals.panel.expiredWhileOpen'), variant: 'error' });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [decisionLapsed, toast, t]);

  const decide = async (details) => {
    if (!decisionItem || submitting) return;
    setSubmitting(true);
    try {
      const response = await fetch('/api/approvals', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // The revision this dialog shows. An approve of any other version is
        // refused as `changed` (src/lib/approvals/decide.ts).
        body: JSON.stringify({
          id: decisionItem.item.id,
          decision: decisionItem.decision,
          revision: details?.revision ?? null,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok && payload.code === 'changed') throw new ChangedError(payload.error);
      if (!response.ok && payload.code === 'expired') throw new ClosedError(t('approvals.panel.expiredWhileOpen'));
      if (!response.ok && payload.code === 'not_pending') throw new ClosedError(t('approvals.panel.decidedElsewhere'));
      if (!response.ok) throw new Error(payload.error || t('approvals.panel.decisionFailed'));
      setItems(current => current.filter(item => item.id !== decisionItem.item.id));
      // Refresh so the row reappears under "Recently decided" with its
      // provenance, rather than just vanishing from the queue.
      void load({ quiet: true });
      toast({
        message: decisionItem.decision === 'approve'
          ? t('approvals.panel.approvedToast')
          : t('approvals.panel.rejectedToast'),
        variant: 'success',
      });
      setDecisionItem(null);
    } catch (decisionError) {
      if (decisionError instanceof ClosedError) {
        // Nothing to retry: it is over. Close, say why, and show where it went.
        setDecisionItem(null);
        toast({ message: decisionError.message, variant: 'error' });
        void load({ quiet: true });
        return;
      }
      if (decisionError instanceof ChangedError) {
        // Not a failure to retry blindly: the request now says something else.
        // Reload it and keep the dialog open on the CURRENT version, so the
        // person confirms what will actually be sent.
        const fresh = await load({ quiet: true });
        const current = fresh?.find((item) => item.id === decisionItem.item.id) ?? null;
        if (current) {
          // A new `nonce` remounts the dialog, which reloads its details.
          setDecisionItem({
            item: current,
            decision: decisionItem.decision,
            changed: true,
            nonce: (decisionItem.nonce ?? 0) + 1,
          });
        } else {
          setDecisionItem(null);
          toast({ message: t('approvals.panel.changedGone'), variant: 'error' });
        }
        return;
      }
      const message = decisionError instanceof Error && decisionError.message ? decisionError.message : t('approvals.panel.decisionFailed');
      toast({ message, variant: 'error' });
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const visible = items.filter((item) => !isPastDeadline(item, now));
  const groups = canDecide ? ruleGroups(visible) : [];

  return (
    <div className="page">
      <div className="page-header">
        <div className="grow">
          <div className="page-title">{t('approvals.panel.title')}</div>
          <div className="page-sub">{t('approvals.panel.sub')}</div>
        </div>
      </div>

      {!canDecide && !loading && !error ? (
        <div className="alert" role="status" style={{ marginBottom: 16 }}>
          {t('approvals.panel.memberNotice')}
        </div>
      ) : null}

      {error ? (
        <div className="alert alert-error" role="alert" style={{ marginBottom: 16 }}>
          <span>{error}</span>
          <Btn size="sm" variant="secondary" icon="refresh" onClick={() => load()} disabled={loading}>{t('approvals.panel.tryAgain')}</Btn>
        </div>
      ) : null}

      <div className="card approvals-card">
        {loading ? <ApprovalListSkeleton t={t} /> : visible.length === 0 ? (
          <div className="approvals-empty">
            <div className="approvals-empty-summary">
              <div className="approvals-empty-icon" aria-hidden="true"><Icon name="shield" size={26} /></div>
              <div className="approvals-empty-copy">
                <span className="approvals-empty-kicker">{t('approvals.panel.emptyKicker')}</span>
                <h2>{t('approvals.panel.emptyTitle')}</h2>
                <p>{t('approvals.panel.emptyBody')}</p>
                <Link className="btn btn-primary" href="/dashboard/inboxes">
                  <Icon name="settings" size={14} className="btn-ico" />
                  {t('approvals.panel.configureInbox')}
                </Link>
              </div>
            </div>
            <aside className="approvals-empty-guide" aria-label={t('approvals.panel.guideTitle')}>
              <div className="approvals-empty-guide-title">{t('approvals.panel.guideTitle')}</div>
              <ol>
                <li><span>1</span> {t('approvals.panel.guide1')}</li>
                <li><span>2</span> {t('approvals.panel.guide2')}</li>
                <li><span>3</span> {t('approvals.panel.guide3')}</li>
              </ol>
            </aside>
          </div>
        ) : (
          <>
            {groups.map((group) => (
              <div className="approvals-rule-bar" key={group.ruleId}>
                <span>
                  {group.address
                    ? t('approvals.panel.ruleGroup', { rule: group.ruleName ?? '', count: group.rows.length, address: group.address })
                    : t('approvals.panel.ruleGroupMixed', { rule: group.ruleName ?? '', count: group.rows.length })}
                </span>
                {group.address ? (
                  <Btn size="sm" variant="secondary" onClick={() => setApproveAll({ group, outcomes: null })}>
                    {t('approvals.panel.approveAll')}
                  </Btn>
                ) : null}
              </div>
            ))}
            <table className="data-table approvals-table">
              <thead>
                <tr>
                  <th>{t('approvals.panel.colRequest')}</th>
                  <th>{t('approvals.panel.colRecipient')}</th>
                  <th>{t('approvals.panel.colSubject')}</th>
                  <th>{t('approvals.panel.colTimeLeft')}</th>
                  <th aria-label={t('approvals.panel.colDecision')} />
                </tr>
              </thead>
              <tbody>{visible.map((item) => (
                <tr key={item.id}>
                  <td data-label={t('approvals.panel.colRequest')}>
                    <RequestSource item={item} t={t} />
                  </td>
                  <td data-label={t('approvals.panel.colRecipient')} className="approvals-wrap">{recipientLabel(item, t)}</td>
                  <td data-label={t('approvals.panel.colSubject')}>
                    <span className="approvals-wrap">{item.summary?.subject || t('approvals.panel.noSubject')}</span>
                    <span className="approvals-cell-sub">{approvalLabel(item, t)}</span>
                  </td>
                  <td data-label={t('approvals.panel.colTimeLeft')} className="approvals-time-left">
                    {formatTimeLeft(t, item.expires_at, now) ?? '—'}
                  </td>
                  <td data-label="" className="right">
                    {canDecide ? (
                      <div className="approvals-actions">
                        <Btn size="sm" variant="secondary" onClick={() => setDecisionItem({ item, decision: 'reject' })}>{t('approvals.panel.reject')}</Btn>
                        <Btn size="sm" variant="primary" onClick={() => setDecisionItem({ item, decision: 'approve' })}>{t('approvals.panel.reviewApprove')}</Btn>
                      </div>
                    ) : <span className="sub">{t('approvals.panel.ownerRequired')}</span>}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </>
        )}
      </div>

      {!loading && decided.length ? <DecidedTable rows={decided} canDecide={canDecide} onForwardAgain={setAgain} t={t} /> : null}

      {decisionItem ? <DecisionDialog key={`${decisionItem.item.id}:${decisionItem.nonce ?? 0}`} item={decisionItem.item} decision={decisionItem.decision} changed={decisionItem.changed === true} submitting={submitting} now={now} onCancel={() => !submitting && setDecisionItem(null)} onConfirm={decide} t={t} /> : null}
      {again ? <ForwardAgainDialog row={again} onClose={() => setAgain(null)} onDone={() => { setAgain(null); void load({ quiet: true }); }} t={t} toast={toast} /> : null}
      {approveAll ? <ApproveAllDialog state={approveAll} setState={setApproveAll} onDone={() => void load({ quiet: true })} t={t} /> : null}
    </div>
  );
}

function RequestSource({ item, t }) {
  const operationKey = `approvals.review.operations.${item.operation}`;
  const operation = t.has(operationKey) ? t(operationKey) : item.operation;
  if (item.kind === 'rule_forward') {
    return (
      <span className="approvals-source">
        {item.rule_name ?? t('approvals.panel.unnamedRule')}
        <span className="approvals-source-kind">
          {operation}{item.rule_deleted ? ` · ${t('approvals.panel.ruleDeleted')}` : ''}
        </span>
      </span>
    );
  }
  return (
    <span className="approvals-source">
      {t('approvals.panel.sourceAi')}
      <span className="approvals-source-kind">{operation}</span>
    </span>
  );
}

/** A row's outcome: the decision, then what became of the send. */
function Outcome({ row, t }) {
  const statusKey = {
    approved: 'approvals.panel.statusApproved',
    rejected: 'approvals.panel.statusRejected',
    expired: 'approvals.panel.statusExpired',
    cancelled: 'approvals.panel.statusCancelled',
  }[row.status];
  const delivery = row.delivery;
  const label = delivery ? t(`approvals.delivery.${delivery.state}`) : statusKey ? t(statusKey) : row.status;
  const reason = deliveryReasonText(t, delivery);
  return (
    <>
      <span className={`approvals-outcome${delivery?.state === 'failed' ? ' approvals-outcome-failed' : ''}`}>{label}</span>
      {reason ? <span className="approvals-outcome-reason">{reason}</span> : null}
    </>
  );
}

/**
 * Recently decided sends, with the surface each decision was made on.
 *
 * Provenance matters here because there are several places a decision can come
 * from, and they carry different weight. A reject can happen in the card; an
 * approve can only ever have come from a signed-in browser session
 * (docs/mcp-apps/contract.md §6). `decider` says who: a person, nobody (it expired
 * or was cancelled), or something automatic. Only a person's decision names a
 * surface, so an expired row never reads as decided by someone.
 */
function DecidedTable({ rows, canDecide, onForwardAgain, t }) {
  return (
    <div className="approvals-decided">
      <div className="approvals-decided-title">{t('approvals.panel.decidedTitle')}</div>
      <div className="card">
        <table className="data-table approvals-table">
          <thead>
            <tr>
              <th>{t('approvals.panel.colRequest')}</th>
              <th>{t('approvals.panel.colSubject')}</th>
              <th>{t('approvals.panel.colOutcome')}</th>
              <th>{t('approvals.panel.colWhere')}</th>
              <th>{t('approvals.panel.colDecided')}</th>
              <th aria-label={t('approvals.panel.colDecision')} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const viaKey = row.decided_via ? `approvals.review.via.${row.decided_via}` : null;
              const closedAt = row.decided_at ?? row.expires_at;
              return (
                <tr key={row.id}>
                  <td data-label={t('approvals.panel.colRequest')}><RequestSource item={row} t={t} /></td>
                  <td data-label={t('approvals.panel.colSubject')}>
                    <span className="approvals-wrap">{row.summary?.subject || t('approvals.panel.noSubject')}</span>
                    <span className="approvals-cell-sub">{approvalLabel(row, t)}</span>
                  </td>
                  <td data-label={t('approvals.panel.colOutcome')}><Outcome row={row} t={t} /></td>
                  <td data-label={t('approvals.panel.colWhere')}>
                    {row.decider === 'automatic' ? (
                      <span className="approvals-via"><Icon name="zap" size={12} />{t('approvals.panel.decidedAutomatically')}</span>
                    ) : row.decider === 'person' && viaKey && t.has(viaKey) ? (
                      <span className="approvals-via">
                        <Icon name={row.decided_via === 'dashboard' ? 'activity' : 'zap'} size={12} />
                        {t(viaKey)}
                      </span>
                    ) : row.status === 'expired' ? (
                      <span className="sub">{t('approvals.panel.nobodyDecided')}</span>
                    ) : (
                      <span className="sub">—</span>
                    )}
                  </td>
                  <td data-label={t('approvals.panel.colDecided')}>{closedAt ? new Date(closedAt).toLocaleString() : '—'}</td>
                  <td data-label="" className="right">
                    {canDecide && row.can_forward_again ? (
                      <div className="approvals-actions">
                        <Btn size="sm" variant="secondary" onClick={() => onForwardAgain(row)}>{t('approvals.panel.forwardAgain')}</Btn>
                      </div>
                    ) : canDecide && row.status === 'expired' && row.kind === 'rule_forward' && row.rule_deleted ? (
                      <span className="sub">{t('approvals.panel.forwardAgainRuleDeleted')}</span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ForwardAgainDialog({ row, onClose, onDone, t, toast }) {
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState('');
  const address = recipientLabel(row, t);
  const submit = async () => {
    setWorking(true);
    setFailure('');
    try {
      const response = await fetch(`/api/approvals/${row.id}/forward-again`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const key = `approvals.panel.forwardAgainErrors.${payload.code}`;
        setFailure(t.has(key) ? t(key) : t('approvals.panel.forwardAgainErrors.generic'));
        return;
      }
      toast({ message: t('approvals.panel.forwardAgainDone'), variant: 'success' });
      onDone();
    } catch {
      setFailure(t('approvals.panel.forwardAgainErrors.generic'));
    } finally {
      setWorking(false);
    }
  };
  return (
    <div className="scrim" onClick={() => !working && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="forward-again-title" onClick={(event) => event.stopPropagation()} style={{ width: 460 }}>
        <div className="modal-h">
          <h2 id="forward-again-title" style={{ margin: 0 }}>{t('approvals.panel.forwardAgainTitle')}</h2>
          <div className="sub" style={{ marginTop: 4 }}>{t('approvals.panel.forwardAgainBody')}</div>
        </div>
        <div className="modal-body">
          {failure ? <div className="alert alert-error" role="alert">{failure}</div> : null}
          <dl style={{ margin: 0, display: 'grid', gap: 10 }}>
            <div><dt className="sub">{t('approvals.panel.colRecipient')}</dt><dd style={{ margin: '2px 0 0', overflowWrap: 'anywhere' }}>{address}</dd></div>
            <div><dt className="sub">{t('approvals.panel.colSubject')}</dt><dd style={{ margin: '2px 0 0', overflowWrap: 'anywhere' }}>{row.summary?.subject || t('approvals.panel.noSubject')}</dd></div>
          </dl>
        </div>
        <div className="modal-foot">
          <Btn variant="secondary" onClick={onClose} disabled={working}>{t('approvals.panel.cancel')}</Btn>
          <Btn variant="primary" onClick={submit} disabled={working}>{working ? t('approvals.panel.saving') : t('approvals.panel.forwardAgainConfirm')}</Btn>
        </div>
      </div>
    </div>
  );
}

function ApproveAllDialog({ state, setState, onDone, t }) {
  const { group, outcomes } = state;
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState('');
  const close = () => { if (!working) setState(null); };
  const subjectOf = (id) => group.rows.find((row) => row.id === id)?.summary?.subject || t('approvals.panel.noSubject');

  const submit = async () => {
    setWorking(true);
    setFailure('');
    try {
      const response = await fetch('/api/approvals/approve-rule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rule_id: group.ruleId,
          address: group.address,
          // Exactly the rows this dialog counted, at the versions the page holds.
          items: group.rows.map((row) => ({ id: row.id, revision: row.revision })),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const key = `approvals.panel.approveAllErrors.${payload.code}`;
        setFailure(t.has(key) ? t(key) : t('approvals.panel.approveAllErrors.generic'));
        onDone();
        return;
      }
      setState({ group, outcomes: payload.outcomes ?? [] });
      onDone();
    } catch {
      setFailure(t('approvals.panel.approveAllErrors.generic'));
    } finally {
      setWorking(false);
    }
  };

  const approvedCount = (outcomes ?? []).filter((row) => row.outcome === 'approved').length;
  return (
    <div className="scrim" onClick={close}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="approve-all-title" onClick={(event) => event.stopPropagation()} style={{ width: 500 }}>
        <div className="modal-h">
          <h2 id="approve-all-title" style={{ margin: 0 }}>
            {outcomes
              ? t('approvals.panel.approveAllDone', { approved: approvedCount, total: outcomes.length })
              : t('approvals.panel.approveAllTitle', { count: group.rows.length })}
          </h2>
          {outcomes ? null : (
            <div className="sub" style={{ marginTop: 4, overflowWrap: 'anywhere' }}>
              {t('approvals.panel.approveAllBody', { count: group.rows.length, rule: group.ruleName ?? '', address: group.address })}
            </div>
          )}
        </div>
        <div className="modal-body">
          {failure ? <div className="alert alert-error" role="alert">{failure}</div> : null}
          {outcomes ? (
            <ul className="approvals-result-list">
              {outcomes.map((row) => (
                <li key={row.id}>
                  <span>{subjectOf(row.id)}</span>
                  <span>{t(`approvals.panel.approveAllOutcome.${row.outcome}`)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="sub" style={{ margin: 0 }}>{t('approvals.panel.approveAllPacing')}</p>
          )}
        </div>
        <div className="modal-foot">
          {outcomes ? (
            <Btn variant="primary" onClick={close}>{t('approvals.panel.close')}</Btn>
          ) : (
            <>
              <Btn variant="secondary" onClick={close} disabled={working}>{t('approvals.panel.cancel')}</Btn>
              <Btn variant="primary" onClick={submit} disabled={working || failure !== ''}>
                {working ? t('approvals.panel.saving') : t('approvals.panel.approveAllConfirm', { count: group.rows.length })}
              </Btn>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ApprovalListSkeleton({ t }) {
  return (
    <div className="approval-list-skeleton" role="status" aria-label={t('approvals.panel.loading')}>
      <div className="sub" style={{ padding: '14px 20px' }}>{t('approvals.panel.loading')}</div>
    </div>
  );
}

/**
 * The decision dialog. On open it loads this one approval's details
 * (`GET /api/approvals/[id]`): the current recipients and subject, the Bcc
 * addresses, the `revision` the decision carries, and whether it can be
 * approved at all. For a forward it also reads the original live. The queue
 * itself decrypts nothing. Approve waits for those details; Reject never does,
 * since rejecting is safe whatever the request says.
 */
function DecisionDialog({ item, decision, changed, submitting, now, onCancel, onConfirm, t }) {
  const approving = decision === 'approve';
  const [details, setDetails] = useState(null);
  const [detailsFailed, setDetailsFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/approvals/${item.id}`, { cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!live) return;
        if (!response.ok || !payload) setDetailsFailed(true);
        else setDetails(payload);
      })
      .catch(() => { if (live) setDetailsFailed(true); });
    return () => { live = false; };
  }, [item.id]);

  const bcc = Array.isArray(details?.bcc) ? details.bcc.filter(Boolean) : [];
  const bccCount = Math.max(
    typeof details?.bcc_count === 'number' ? details.bcc_count
      : typeof item.summary?.bcc_count === 'number' ? item.summary.bcc_count : 0,
    bcc.length,
  );
  const recipients = details
    ? (details.to?.length ? details.to.join(', ') : t('approvals.panel.noRecipient'))
    : recipientLabel(item, t);
  const subject = details ? details.subject : item.summary?.subject;
  const notApprovable = details?.approvable === false;
  const confirmDisabled = submitting || (approving && (!details || notApprovable));
  const timeLeft = formatTimeLeft(t, item.expires_at, now);
  const isForward = item.operation === 'email_forward';

  return (
    <div className="scrim" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="approval-decision-title" onClick={(event) => event.stopPropagation()} style={{ width: 500 }}>
        <div className="modal-h">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <h2 id="approval-decision-title" style={{ margin: 0 }}>{approving ? t('approvals.panel.approveTitle') : t('approvals.panel.rejectTitle')}</h2>
              <div className="sub" style={{ marginTop: 4 }}>{approving ? t('approvals.panel.approveSub') : t('approvals.panel.rejectSub')}</div>
            </div>
            <button type="button" onClick={onCancel} disabled={submitting} aria-label={t('approvals.panel.close')} style={{ background: 'transparent', border: 0, color: 'var(--fg-3)', cursor: submitting ? 'not-allowed' : 'pointer', padding: 4 }}><Icon name="x" size={16} /></button>
          </div>
        </div>
        <div className="modal-body">
          {changed ? (
            <div className="alert" role="alert">
              {t('approvals.panel.changedNotice')}
            </div>
          ) : null}
          {detailsFailed ? (
            <div className="alert alert-error" role="alert">
              {t('approvals.panel.detailsFailed')}
            </div>
          ) : null}
          {approving && notApprovable ? (
            <div className="alert" role="status">
              {t('approvals.review.bodyStoredWithProvider')}
            </div>
          ) : null}
          <dl style={{ margin: 0, display: 'grid', gap: 10 }}>
            <div><dt className="sub">{t('approvals.panel.fieldRequest')}</dt><dd style={{ margin: '2px 0 0' }}><RequestSource item={item} t={t} /></dd></div>
            <div><dt className="sub">{t('approvals.panel.fieldInbox')}</dt><dd style={{ margin: '2px 0 0', overflowWrap: 'anywhere' }}>{approvalLabel(item, t)}</dd></div>
            <div><dt className="sub">{t('approvals.panel.fieldRecipients')}</dt><dd style={{ margin: '2px 0 0', overflowWrap: 'anywhere' }}>{recipients}</dd></div>
            {bccCount > 0 ? (
              <div>
                <dt className="sub">{t('approvals.review.bcc')}</dt>
                <dd style={{ margin: '2px 0 0', overflowWrap: 'anywhere' }}>
                  {bcc.length ? bcc.join(', ') : t('approvals.review.bccCount', { count: bccCount })}
                </dd>
              </div>
            ) : null}
            <div><dt className="sub">{t('approvals.panel.fieldSubject')}</dt><dd style={{ margin: '2px 0 0', overflowWrap: 'anywhere' }}>{subject || t('approvals.panel.noSubject')}</dd></div>
            {timeLeft ? <div><dt className="sub">{t('approvals.panel.colTimeLeft')}</dt><dd style={{ margin: '2px 0 0' }}>{timeLeft}</dd></div> : null}
          </dl>
          {isForward ? <OriginalMessage approvalId={item.id} /> : null}
          <p className="sub" style={{ margin: 0 }}>
            <Link href={`/approvals/${item.id}`}>{t('approvals.panel.openReview')}</Link>
          </p>
        </div>
        <div className="modal-foot">
          <Btn variant="secondary" onClick={onCancel} disabled={submitting}>{t('approvals.panel.cancel')}</Btn>
          <Btn variant={approving ? 'primary' : 'danger'} onClick={() => onConfirm(details)} disabled={confirmDisabled}>
            {submitting ? t('approvals.panel.saving') : approving && !details && !detailsFailed ? t('approvals.panel.loadingDetails') : approving ? t('approvals.panel.approveAndSend') : t('approvals.panel.rejectConfirm')}
          </Btn>
        </div>
      </div>
    </div>
  );
}
