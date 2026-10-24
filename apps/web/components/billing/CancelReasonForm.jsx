'use client';

import { useState } from 'react';
import { Btn } from '../Primitives';

/**
 * The optional "why did you cancel" answer on /billing/feedback.
 *
 * Reached from a reason link in the post-cancel email, so `initialReason` is
 * usually set already. Nothing is recorded until Send is pressed: the page's
 * GET is read-only because mail scanners prefetch every link. After a
 * successful send it shows the thank-you line and nothing else, on purpose
 * (no offer keyed to the answer). Every string comes from `copy`
 * (app/[locale]/billing/feedback/content.mjs).
 */

const ENDPOINT = '/api/billing/feedback';
const DETAIL_MAX = 500;

export default function CancelReasonForm({ copy, token, reasons, initialReason = null }) {
  const [reason, setReason] = useState(reasons.includes(initialReason) ? initialReason : null);
  const [detail, setDetail] = useState('');
  const [sending, setSending] = useState(false);
  const [state, setState] = useState('edit'); // 'edit' | 'done' | 'invalid'
  const [error, setError] = useState(null);

  async function onSubmit(event) {
    event.preventDefault();
    if (!reason || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ t: token, reason, ...(reason === 'other' && detail.trim() ? { detail: detail.trim() } : {}) }),
      });
      if (res.ok) return setState('done');
      let code = null;
      try {
        code = (await res.json())?.error ?? null;
      } catch {
        code = null;
      }
      if (code === 'invalid_token') return setState('invalid');
      setError(code === 'rate_limited' ? 'rate_limited' : 'unknown');
    } catch {
      setError('unknown');
    } finally {
      setSending(false);
    }
  }

  if (state === 'done') {
    return <p className="feedback-thanks" role="status">{copy.thanks}</p>;
  }
  if (state === 'invalid') {
    return (
      <p role="status">
        {copy.invalid} <a href="/dashboard">{copy.dashboard}</a>
      </p>
    );
  }

  return (
    <form className="help-form" onSubmit={onSubmit} noValidate>
      <fieldset className="contract-fieldset">
        <legend className="help-label">{copy.reasonsLegend}</legend>
        <div className="feedback-reasons">
          {reasons.map((value) => (
            <button
              key={value}
              type="button"
              className="feedback-reason"
              aria-pressed={reason === value}
              data-reason={value}
              onClick={() => setReason(value)}
            >
              {copy.reasons[value]}
            </button>
          ))}
        </div>
      </fieldset>

      {reason === 'other' ? (
        <div className="help-field">
          <label htmlFor="feedback-detail" className="help-label">{copy.detailLabel}</label>
          <textarea
            id="feedback-detail"
            name="detail"
            className="help-input help-textarea"
            rows={4}
            maxLength={DETAIL_MAX}
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
          />
        </div>
      ) : null}

      <div className="help-actions">
        <Btn type="submit" variant="primary" disabled={!reason || sending} busy={sending}>
          {sending ? copy.sending : copy.send}
        </Btn>
      </div>
      {error ? <p className="help-error" role="alert" data-error-code={error}>{copy.errors[error]}</p> : null}
    </form>
  );
}
