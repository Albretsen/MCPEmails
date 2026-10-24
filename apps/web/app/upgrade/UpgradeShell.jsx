import Link from 'next/link';

/**
 * The card both /upgrade pages render: a status line, one sentence, and the
 * links out. No workspace data, no plan details, nothing about the buyer.
 */
export default function UpgradeShell({ tone = 'neutral', title, body, children }) {
  return (
    <div className="review-shell">
      <div className="review-wrap">
        <Link className="review-brand" href="/">
          <img className="logo-light" src="/logo-wordmark.svg" width="280" height="48" alt="MCPEmails" /><img className="logo-dark" src="/logo-wordmark-dark.svg" width="280" height="48" alt="MCPEmails" />
        </Link>
        <div className="card review-card review-card-narrow">
          <div className={`review-banner review-banner-${tone}`} role="status" aria-live="polite">
            <div>
              <strong>{title}</strong>
              <p>{body}</p>
            </div>
          </div>
          {children ? <div className="review-actions">{children}</div> : null}
        </div>
      </div>
    </div>
  );
}
