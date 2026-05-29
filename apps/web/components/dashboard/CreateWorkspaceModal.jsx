'use client';

import { useState } from 'react';
import { Icon, Btn } from '../Primitives';

/**
 * CreateWorkspaceModal: names and creates a new workspace.
 *
 * Only rendered for users who own a Team workspace (the create route enforces
 * this server-side too). On success the API sets the new workspace as active;
 * we do a full reload so the dashboard re-fetches scoped to it.
 *
 * @param {() => void} onClose
 * @param {string}     planLabel  - The plan the new workspace inherits (e.g. "Team").
 */
export function CreateWorkspaceModal({ onClose, planLabel = 'Team' }) {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Enter a name for the workspace.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'Failed to create workspace.');
        setSubmitting(false);
        return;
      }
      // The new workspace is now active (cookie set by the route). Reload into it.
      window.location.assign('/dashboard');
    } catch {
      setError('Network error. Please try again.');
      setSubmitting(false);
    }
  };

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 440 }}>
        <div className="modal-h">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <h2 style={{ margin: 0 }}>New workspace</h2>
              <div className="sub" style={{ marginTop: 4 }}>
                Inboxes, API keys and members are scoped per workspace. This one inherits your {planLabel} plan.
              </div>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)', padding: 4, flexShrink: 0, lineHeight: 1 }}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>

        <div className="modal-body">
          <div className="field">
            <label htmlFor="ws-name">Workspace name</label>
            <input
              id="ws-name"
              className="input"
              type="text"
              maxLength={60}
              placeholder="Acme Marketing"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !submitting) handleCreate(); }}
              autoFocus
            />
          </div>

          {error && (
            <div
              role="alert"
              style={{
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
              {error}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <Btn variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Btn>
          <Btn variant="primary" icon="plus" onClick={handleCreate} disabled={submitting}>
            {submitting ? 'Creating…' : 'Create workspace'}
          </Btn>
        </div>
      </div>
    </div>
  );
}
