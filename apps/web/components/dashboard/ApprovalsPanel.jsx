'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
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

/**
 * Pending email send decisions. The page intentionally only shows the small
 * review summary supplied by the API, never an email body or attachment.
 */
export function ApprovalsPanel({ userRole }) {
  const { toast } = useToast();
  const [items, setItems] = useState([]);
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
      setItems(Array.isArray(payload.approvals) ? payload.approvals : []);
      setError('');
    } catch (loadError) {
      setError(requestErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const decide = async () => {
    if (!decisionItem || submitting) return;
    setSubmitting(true);
    try {
      const response = await fetch('/api/approvals', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: decisionItem.item.id, decision: decisionItem.decision }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Could not record this decision.');
      setItems(current => current.filter(item => item.id !== decisionItem.item.id));
      toast({
        message: decisionItem.decision === 'approve'
          ? 'Email approved and queued for sending.'
          : 'Email request rejected.',
        variant: 'success',
      });
      setDecisionItem(null);
    } catch (decisionError) {
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
        <Link className="btn btn-secondary" href="/dashboard/inboxes">Manage inbox settings</Link>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-h">
          <div>
            <div className="title">Approval is set per inbox</div>
            <div className="sub">Enable “Require approval before sending” in an inbox’s settings. Workspace owners and admins can then approve or reject pending sends here.</div>
          </div>
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

      <div className="card" style={{ overflowX: 'auto' }}>
        {loading ? <p className="sub" role="status">Loading pending approvals…</p> : items.length === 0 ? (
          <div className="empty-state">
            <Icon name="shield" size={24} />
            <h3>No messages need a decision</h3>
            <p>When an inbox requires approval, prepared email sends will appear here.</p>
            <Link className="btn btn-secondary" href="/dashboard/inboxes">Choose an inbox</Link>
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

      {decisionItem ? <DecisionDialog item={decisionItem.item} decision={decisionItem.decision} submitting={submitting} onCancel={() => !submitting && setDecisionItem(null)} onConfirm={decide} /> : null}
    </div>
  );
}

function DecisionDialog({ item, decision, submitting, onCancel, onConfirm }) {
  const approving = decision === 'approve';
  return (
    <div className="scrim" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="approval-decision-title" onClick={(event) => event.stopPropagation()} style={{ width: 460 }}>
        <div className="modal-h">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <h2 id="approval-decision-title" style={{ margin: 0 }}>{approving ? 'Approve email send?' : 'Reject email send?'}</h2>
              <div className="sub" style={{ marginTop: 4 }}>{approving ? 'This will queue the prepared email to be sent.' : 'This prepared email will not be sent.'}</div>
            </div>
            <button type="button" onClick={onCancel} disabled={submitting} aria-label="Close" style={{ background: 'transparent', border: 0, color: 'var(--fg-3)', cursor: submitting ? 'not-allowed' : 'pointer', padding: 4 }}><Icon name="x" size={16} /></button>
          </div>
        </div>
        <div className="modal-body">
          <dl style={{ margin: 0, display: 'grid', gap: 10 }}>
            <div><dt className="sub">Inbox</dt><dd style={{ margin: '2px 0 0' }}>{approvalLabel(item)}</dd></div>
            <div><dt className="sub">Recipients</dt><dd style={{ margin: '2px 0 0', overflowWrap: 'anywhere' }}>{recipientLabel(item)}</dd></div>
            <div><dt className="sub">Subject</dt><dd style={{ margin: '2px 0 0' }}>{item.summary?.subject || '(no subject)'}</dd></div>
          </dl>
        </div>
        <div className="modal-foot">
          <Btn variant="secondary" onClick={onCancel} disabled={submitting}>Cancel</Btn>
          <Btn variant={approving ? 'primary' : 'danger'} onClick={onConfirm} disabled={submitting}>{submitting ? 'Saving…' : approving ? 'Approve & queue' : 'Reject request'}</Btn>
        </div>
      </div>
    </div>
  );
}
