'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Btn, Icon } from '../Primitives';
import { useToast } from './Toast';

function approvalLabel(item) {
  return item.inboxes?.display_name ?? item.inboxes?.email_address ?? 'Inbox';
}

function recipientLabel(item) {
  const recipients = Array.isArray(item.summary?.to) ? item.summary.to.filter(Boolean) : [];
  return recipients.length ? recipients.join(', ') : 'No recipient supplied';
}

function requestErrorMessage(error) {
  return error instanceof Error && error.message ? error.message : 'Could not load approvals.';
}

/** A decision the server refused because the request changed after it was shown. */
class ChangedError extends Error {}

/**
 * Pending email send decisions. The page intentionally only shows the small
 * review summary supplied by the API, never an email body or attachment.
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
  const canDecide = userRole === 'owner' || userRole === 'admin';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/approvals', { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Could not load approvals.');
      const pending = Array.isArray(payload.approvals) ? payload.approvals : [];
      setItems(pending);
      setDecided(Array.isArray(payload.decided) ? payload.decided : []);
      setError('');
      return pending;
    } catch (loadError) {
      setError(requestErrorMessage(loadError));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

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
      if (!response.ok) throw new Error(payload.error || 'Could not record this decision.');
      setItems(current => current.filter(item => item.id !== decisionItem.item.id));
      // Refresh so the row reappears under "Recently decided" with its
      // provenance, rather than just vanishing from the queue.
      void load();
      toast({
        message: decisionItem.decision === 'approve'
          ? t('approvals.panel.approvedToast')
          : 'Email request rejected.',
        variant: 'success',
      });
      setDecisionItem(null);
    } catch (decisionError) {
      if (decisionError instanceof ChangedError) {
        // Not a failure to retry blindly: the request now says something else.
        // Reload it and keep the dialog open on the CURRENT version, so the
        // person confirms what will actually be sent.
        const fresh = await load();
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
      const message = requestErrorMessage(decisionError);
      toast({ message, variant: 'error' });
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div className="grow">
          <div className="page-title">Approvals</div>
          <div className="page-sub">Review prepared email sends before they leave an inbox.</div>
        </div>
      </div>

      {!canDecide && !loading && !error ? (
        <div className="alert" role="status" style={{ marginBottom: 16 }}>
          You can review pending sends, but only a workspace owner or admin can approve or reject them.
        </div>
      ) : null}

      {error ? (
        <div className="alert alert-error" role="alert" style={{ marginBottom: 16 }}>
          <span>{error}</span>
          <Btn size="sm" variant="secondary" icon="refresh" onClick={load} disabled={loading}>Try again</Btn>
        </div>
      ) : null}

      <div className="card approvals-card" style={{ overflowX: 'auto' }}>
        {loading ? <ApprovalListSkeleton /> : items.length === 0 ? (
          <div className="approvals-empty">
            <div className="approvals-empty-summary">
              <div className="approvals-empty-icon" aria-hidden="true"><Icon name="shield" size={26} /></div>
              <div className="approvals-empty-copy">
                <span className="approvals-empty-kicker">All clear</span>
                <h2>Nothing is waiting for approval</h2>
                <p>Prepared sends that need a decision will appear here. You can safely return when there’s something to review.</p>
                <Link className="btn btn-primary" href="/dashboard/inboxes">
                  <Icon name="settings" size={14} className="btn-ico" />
                  Configure an inbox
                </Link>
              </div>
            </div>
            <aside className="approvals-empty-guide" aria-label="How email approvals work">
              <div className="approvals-empty-guide-title">How approvals work</div>
              <ol>
                <li><span>1</span> Enable approval for an inbox.</li>
                <li><span>2</span> An agent prepares an email send.</li>
                <li><span>3</span> An owner or admin approves it here.</li>
              </ol>
            </aside>
          </div>
        ) : (
          <table className="data-table">
            <thead><tr><th>Inbox</th><th>Recipients</th><th>Subject</th><th>Requested</th><th aria-label="Decision" /></tr></thead>
            <tbody>{items.map((item) => (
              <tr key={item.id}>
                <td>{approvalLabel(item)}</td>
                <td>{recipientLabel(item)}</td>
                <td>{item.summary?.subject || '(no subject)'}</td>
                <td>{item.created_at ? new Date(item.created_at).toLocaleString() : 'Unknown time'}</td>
                <td className="right">
                  {canDecide ? (
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                      <Btn size="sm" variant="secondary" onClick={() => setDecisionItem({ item, decision: 'reject' })}>Reject</Btn>
                      <Btn size="sm" variant="primary" onClick={() => setDecisionItem({ item, decision: 'approve' })}>Review & approve</Btn>
                    </div>
                  ) : <span className="sub">Owner or admin required</span>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>

      {!loading && decided.length ? <DecidedTable rows={decided} t={t} /> : null}

      {decisionItem ? <DecisionDialog key={`${decisionItem.item.id}:${decisionItem.nonce ?? 0}`} item={decisionItem.item} decision={decisionItem.decision} changed={decisionItem.changed === true} submitting={submitting} onCancel={() => !submitting && setDecisionItem(null)} onConfirm={decide} t={t} /> : null}
    </div>
  );
}

/**
 * Recently decided sends, with the surface each decision was made on.
 *
 * Provenance matters here because there are three places a decision can come
 * from — the review card in the AI conversation, the authenticated review link
 * that card opens, and this dashboard — and they carry different weight. A
 * reject can happen in the card; an approve can only ever have come from a
 * signed-in browser session (docs/mcp-apps/contract.md §6). Showing where each
 * decision happened makes that visible instead of merely documented.
 *
 * `decided_via` is populated by a migration that may land after this code; the
 * column simply renders as a dash until then.
 */
function DecidedTable({ rows, t }) {
  const statusKey = {
    approved: 'approvals.panel.statusApproved',
    rejected: 'approvals.panel.statusRejected',
    expired: 'approvals.panel.statusExpired',
    cancelled: 'approvals.panel.statusCancelled',
  };
  return (
    <div className="approvals-decided">
      <div className="approvals-decided-title">{t('approvals.panel.decidedTitle')}</div>
      <div className="card" style={{ overflowX: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Inbox</th>
              <th>Subject</th>
              <th>{t('approvals.panel.colOutcome')}</th>
              <th>{t('approvals.panel.colWhere')}</th>
              <th>{t('approvals.panel.colDecided')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const viaKey = row.decided_via ? `approvals.review.via.${row.decided_via}` : null;
              return (
                <tr key={row.id}>
                  <td>{approvalLabel(row)}</td>
                  <td>{row.summary?.subject || '(no subject)'}</td>
                  <td>{statusKey[row.status] ? t(statusKey[row.status]) : row.status}</td>
                  <td>
                    {viaKey && t.has(viaKey) ? (
                      <span className="approvals-via">
                        <Icon name={row.decided_via === 'dashboard' ? 'activity' : 'zap'} size={12} />
                        {t(viaKey)}
                      </span>
                    ) : (
                      <span className="sub">—</span>
                    )}
                  </td>
                  <td>{row.decided_at ? new Date(row.decided_at).toLocaleString() : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ApprovalListSkeleton() {
  return (
    <div className="approval-list-skeleton" role="status" aria-label="Loading pending approvals">
      <div className="approval-skeleton-row approval-skeleton-heading" aria-hidden="true">
        <span className="sk" style={{ width: 52, height: 11 }} />
        <span className="sk" style={{ width: 72, height: 11 }} />
        <span className="sk" style={{ width: 50, height: 11 }} />
        <span className="sk" style={{ width: 64, height: 11 }} />
        <span className="sk" style={{ width: 44, height: 11 }} />
      </div>
      {[0, 1, 2].map((row) => (
        <div className="approval-skeleton-row" key={row} aria-hidden="true">
          <span className="sk" style={{ width: row === 1 ? '74%' : '62%', height: 14 }} />
          <span className="sk" style={{ width: row === 2 ? '88%' : '72%', height: 14 }} />
          <span className="sk" style={{ width: row === 0 ? '82%' : '66%', height: 14 }} />
          <span className="sk" style={{ width: '68%', height: 14 }} />
          <span className="sk sk-pill" style={{ width: 104, height: 28, justifySelf: 'end' }} />
        </div>
      ))}
    </div>
  );
}

/**
 * The decision dialog. On open it loads this one approval's details
 * (`GET /api/approvals/[id]`): the current recipients and subject, the Bcc
 * addresses, the `revision` the decision carries, and whether it can be
 * approved at all. The queue itself decrypts nothing. Approve waits for those
 * details; Reject never does, since rejecting is safe whatever the request
 * says.
 */
function DecisionDialog({ item, decision, changed, submitting, onCancel, onConfirm, t }) {
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
    ? (details.to?.length ? details.to.join(', ') : 'No recipient supplied')
    : recipientLabel(item);
  const subject = details ? details.subject : item.summary?.subject;
  const notApprovable = details?.approvable === false;
  const confirmDisabled = submitting || (approving && (!details || notApprovable));

  return (
    <div className="scrim" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="approval-decision-title" onClick={(event) => event.stopPropagation()} style={{ width: 460 }}>
        <div className="modal-h">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <h2 id="approval-decision-title" style={{ margin: 0 }}>{approving ? 'Approve email send?' : 'Reject email send?'}</h2>
              <div className="sub" style={{ marginTop: 4 }}>{approving ? t('approvals.panel.approveSub') : 'This prepared email will not be sent.'}</div>
            </div>
            <button type="button" onClick={onCancel} disabled={submitting} aria-label="Close" style={{ background: 'transparent', border: 0, color: 'var(--fg-3)', cursor: submitting ? 'not-allowed' : 'pointer', padding: 4 }}><Icon name="x" size={16} /></button>
          </div>
        </div>
        <div className="modal-body">
          {changed ? (
            <div className="alert" role="alert" style={{ marginBottom: 12 }}>
              {t('approvals.panel.changedNotice')}
            </div>
          ) : null}
          {detailsFailed ? (
            <div className="alert alert-error" role="alert" style={{ marginBottom: 12 }}>
              {t('approvals.panel.detailsFailed')}
            </div>
          ) : null}
          {approving && notApprovable ? (
            <div className="alert" role="status" style={{ marginBottom: 12 }}>
              {t('approvals.review.bodyStoredWithProvider')}
            </div>
          ) : null}
          <dl style={{ margin: 0, display: 'grid', gap: 10 }}>
            <div><dt className="sub">Inbox</dt><dd style={{ margin: '2px 0 0' }}>{approvalLabel(item)}</dd></div>
            <div><dt className="sub">Recipients</dt><dd style={{ margin: '2px 0 0', overflowWrap: 'anywhere' }}>{recipients}</dd></div>
            {bccCount > 0 ? (
              <div>
                <dt className="sub">{t('approvals.review.bcc')}</dt>
                <dd style={{ margin: '2px 0 0', overflowWrap: 'anywhere' }}>
                  {bcc.length ? bcc.join(', ') : t('approvals.review.bccCount', { count: bccCount })}
                </dd>
              </div>
            ) : null}
            <div><dt className="sub">Subject</dt><dd style={{ margin: '2px 0 0' }}>{subject || '(no subject)'}</dd></div>
          </dl>
          <p className="sub" style={{ margin: '12px 0 0' }}>
            <Link href={`/approvals/${item.id}`}>{t('approvals.panel.openReview')}</Link>
          </p>
        </div>
        <div className="modal-foot">
          <Btn variant="secondary" onClick={onCancel} disabled={submitting}>Cancel</Btn>
          <Btn variant={approving ? 'primary' : 'danger'} onClick={() => onConfirm(details)} disabled={confirmDisabled}>
            {submitting ? 'Saving…' : approving && !details && !detailsFailed ? t('approvals.panel.loadingDetails') : approving ? t('approvals.panel.approveAndSend') : 'Reject request'}
          </Btn>
        </div>
      </div>
    </div>
  );
}
