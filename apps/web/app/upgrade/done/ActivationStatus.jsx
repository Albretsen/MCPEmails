'use client';

import { useEffect, useState } from 'react';

/**
 * "Payment received, activating..." until the Stripe webhook has moved the
 * workspace onto Personal, then "Personal is active".
 *
 * Polls /api/upgrade/status every POLL_MS, at most MAX_POLLS times (about a
 * minute). The webhook normally lands in a few seconds; if it has not by then,
 * the text says so and the polling stops rather than running forever in a
 * forgotten tab. The status route answers only `{ active }`.
 *
 * Same markup as UpgradeShell, written out here because this is the one client
 * component on these pages and the shell is a server component.
 */
const POLL_MS = 2000;
const MAX_POLLS = 30;

export default function ActivationStatus({ sessionId, copy }) {
  const [state, setState] = useState('activating');

  useEffect(() => {
    let polls = 0;
    let stopped = false;
    let timer = null;

    async function tick() {
      polls += 1;
      try {
        const res = await fetch(`/api/upgrade/status?session_id=${encodeURIComponent(sessionId)}`, {
          cache: 'no-store',
        });
        const body = res.ok ? await res.json() : null;
        if (stopped) return;
        if (body && body.active === true) {
          setState('active');
          return;
        }
      } catch {
        // A failed poll is just another "not yet".
      }
      if (stopped) return;
      if (polls >= MAX_POLLS) {
        setState('slow');
        return;
      }
      timer = setTimeout(tick, POLL_MS);
    }

    timer = setTimeout(tick, POLL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId]);

  const title = state === 'active' ? copy.activeTitle : copy.activatingTitle;
  const body =
    state === 'active' ? copy.activeBody : state === 'slow' ? copy.slowBody : copy.activatingBody;
  const tone = state === 'active' ? 'good' : 'neutral';

  return (
    <div className="review-shell">
      <div className="review-wrap">
        <a className="review-brand" href="/">
          <img className="logo-light" src="/logo-wordmark.svg" width="280" height="48" alt="MCPEmails" /><img className="logo-dark" src="/logo-wordmark-dark.svg" width="280" height="48" alt="MCPEmails" />
        </a>
        <div className="card review-card review-card-narrow">
          <div className={`review-banner review-banner-${tone}`} role="status" aria-live="polite">
            <div>
              <strong>{title}</strong>
              <p>{body}</p>
            </div>
          </div>
          <div className="review-actions">
            <a className="btn btn-secondary" href="/dashboard">{copy.signIn}</a>
          </div>
        </div>
      </div>
    </div>
  );
}
