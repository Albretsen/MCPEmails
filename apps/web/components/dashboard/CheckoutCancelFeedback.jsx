'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon, Btn } from '../Primitives';

/**
 * CheckoutCancelFeedback: one optional question on return from a cancelled
 * Stripe checkout.
 *
 * WHY THIS EXISTS. A cancelled checkout used to get a five second toast. That
 * is the one moment someone who wanted to pay and did not is looking at the
 * product, and the funnel can only say that they left, never why. This card
 * sits where the toast sat and asks.
 *
 * IT MUST BE IGNORABLE. Nothing happened and nothing needs acknowledging, so
 * this is not a dialog: no backdrop, no focus trap, no stolen focus, and the
 * dashboard behind it stays fully usable. It leaves by the close button, by
 * "Not now", by Escape, or by itself after AUTO_DISMISS_MS.
 *
 * THE COUNTDOWN YIELDS TO THE READER. It pauses while the pointer or keyboard
 * focus is on the card, and stops for good at the first answer picked or
 * character typed: a card that vanishes under someone mid-sentence is worse
 * than the toast it replaced.
 *
 * The answer goes to /api/analytics/checkout-feedback, which always returns
 * 204. The card thanks the user without waiting on it; whether the write
 * landed is not something they can act on.
 *
 * Props:
 *   onDismiss  parent callback that unmounts the card.
 */

/** Fixed answers, in display order. Must match CHECKOUT_FEEDBACK_REASONS. */
const REASONS = ['price_too_high', 'compare_plans', 'want_to_try_first', 'payment_method', 'just_checking_price'];

const AUTO_DISMISS_MS = 20000;
const THANKS_MS = 2500;
const DETAIL_MAX = 500;

export function CheckoutCancelFeedback({ onDismiss }) {
  const tr = useTranslations('dashboardChrome');
  const [reason, setReason] = useState(null);
  const [detail, setDetail] = useState('');
  const [sent, setSent] = useState(false);
  // Once the user has answered anything, the countdown never comes back.
  const [engaged, setEngaged] = useState(false);
  const [paused, setPaused] = useState(false);

  // Time left on the countdown, carried across pauses.
  const remaining = useRef(AUTO_DISMISS_MS);

  useEffect(() => {
    if (sent || engaged || paused) return undefined;
    const startedAt = Date.now();
    const id = setTimeout(onDismiss, remaining.current);
    return () => {
      clearTimeout(id);
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt));
    };
  }, [sent, engaged, paused, onDismiss]);

  // After sending, say thanks briefly and leave.
  useEffect(() => {
    if (!sent) return undefined;
    const id = setTimeout(onDismiss, THANKS_MS);
    return () => clearTimeout(id);
  }, [sent, onDismiss]);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onDismiss]);

  const choose = useCallback((value) => {
    setReason(value);
    setEngaged(true);
  }, []);

  const send = (e) => {
    e.preventDefault();
    if (!reason) return;
    fetch('/api/analytics/checkout-feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason, detail: reason === 'other' ? detail : undefined }),
      keepalive: true,
    }).catch(() => { /* best effort */ });
    setSent(true);
  };

  const counting = !sent && !engaged;

  return (
    <section
      className="cancel-feedback"
      aria-label={tr('app.checkoutFeedback.title')}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {sent ? (
        <p className="cancel-feedback-thanks" role="status">
          <span className="cancel-feedback-check" aria-hidden="true">
            <Icon name="check" size={13} />
          </span>
          {tr('app.checkoutFeedback.thanks')}
        </p>
      ) : (
        <form onSubmit={send}>
          <div className="cancel-feedback-head">
            <div>
              <h2 className="cancel-feedback-title">{tr('app.checkoutFeedback.title')}</h2>
              <p className="cancel-feedback-sub">{tr('app.checkoutFeedback.question')}</p>
            </div>
            <button
              type="button"
              className="toast-close"
              onClick={onDismiss}
              aria-label={tr('app.checkoutFeedback.close')}
            >
              <Icon name="x" size={12} />
            </button>
          </div>

          <div className="cancel-feedback-options" role="radiogroup" aria-label={tr('app.checkoutFeedback.question')}>
            {REASONS.map((value) => (
              <label key={value} className={`cancel-feedback-option${reason === value ? ' is-selected' : ''}`}>
                <input
                  type="radio"
                  name="checkout-cancel-reason"
                  value={value}
                  checked={reason === value}
                  onChange={() => choose(value)}
                />
                <span>{tr(`app.checkoutFeedback.reasons.${value}`)}</span>
              </label>
            ))}
            <label className={`cancel-feedback-option cancel-feedback-other${reason === 'other' ? ' is-selected' : ''}`}>
              <input
                type="radio"
                name="checkout-cancel-reason"
                value="other"
                checked={reason === 'other'}
                onChange={() => choose('other')}
              />
              <span>{tr('app.checkoutFeedback.other')}</span>
              <input
                type="text"
                className="input cancel-feedback-input"
                value={detail}
                maxLength={DETAIL_MAX}
                placeholder={tr('app.checkoutFeedback.otherPlaceholder')}
                aria-label={tr('app.checkoutFeedback.otherPlaceholder')}
                onFocus={() => choose('other')}
                onChange={(e) => { setDetail(e.target.value); choose('other'); }}
              />
            </label>
          </div>

          <div className="cancel-feedback-actions">
            <Btn variant="ghost" size="sm" onClick={onDismiss}>
              {tr('app.checkoutFeedback.notNow')}
            </Btn>
            <Btn variant="primary" size="sm" type="submit" disabled={!reason}>
              {tr('app.checkoutFeedback.send')}
            </Btn>
          </div>
        </form>
      )}

      {/* Decorative only: the timer above is what dismisses. Shown so the
          card leaving by itself is not a surprise. */}
      {counting && (
        <div
          className={`cancel-feedback-countdown${paused ? ' is-paused' : ''}`}
          style={{ animationDuration: `${AUTO_DISMISS_MS}ms` }}
          aria-hidden="true"
        />
      )}
    </section>
  );
}
