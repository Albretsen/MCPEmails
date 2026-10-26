/**
 * A fixed corner label on every page of the staging deployment (APP_ENV=staging,
 * rendered from app/layout.js). Production never renders it. The word is an
 * environment name, not copy, so it is the same in every locale. It ignores the
 * pointer so it can never cover a control.
 */
export default function StagingRibbon() {
  return (
    <div
      role="note"
      aria-label="Staging environment"
      style={{
        position: 'fixed',
        left: 8,
        bottom: 8,
        zIndex: 2147483647,
        padding: '2px 8px',
        borderRadius: 4,
        background: 'var(--red-500, #ef4444)',
        color: '#fff',
        font: '600 11px/16px system-ui, sans-serif',
        letterSpacing: '0.08em',
        pointerEvents: 'none',
      }}
    >
      STAGING
    </div>
  );
}
