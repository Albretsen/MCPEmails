/**
 * Skeletons.jsx — loading placeholder components for all dashboard pages.
 *
 * Each skeleton matches the structural layout of its corresponding page so
 * there is no layout shift when real data replaces the placeholders. All
 * animation is handled by the `.sk` CSS class (shimmer gradient) defined
 * in dashboard.css.
 *
 * These are pure Server Components — no 'use client' directive, no state.
 * They are rendered by app/dashboard/loading.js (Next.js Suspense fallback)
 * and can also be rendered directly by any page that manages its own loading
 * state via a `loading` prop.
 */

/* ── Shared helpers ──────────────────────────────────────────────────────── */

/** A shimmer block with explicit pixel dimensions. */
function Sk({ w, h, className = '', style = {} }) {
  return (
    <span
      className={'sk ' + className}
      style={{ width: w ?? '100%', height: h ?? 14, display: 'block', ...style }}
      aria-hidden="true"
    />
  );
}

/** Skeleton page header: title block + optional action button placeholder. */
function SkPageHeader({ withAction = true }) {
  return (
    <div className="sk-page-header">
      <div className="grow" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Sk w={180} h={28} style={{ borderRadius: 6 }} />
        <Sk w={280} h={14} />
      </div>
      {withAction && (
        <Sk w={140} h={34} style={{ borderRadius: 8, flexShrink: 0 }} />
      )}
    </div>
  );
}

/** A single skeleton stat card matching the .stat layout. */
function SkStat() {
  return (
    <div className="sk-stat">
      <Sk w={100} h={12} />
      <Sk w={64}  h={26} style={{ borderRadius: 4 }} />
      <Sk w={80}  h={12} />
    </div>
  );
}

/** A single skeleton table row with N column placeholders. */
function SkTableRow({ cols = [120, 180, 80, 60, 60] }) {
  return (
    <div className="sk-row">
      {cols.map((w, i) => (
        <Sk key={i} w={w} h={14} style={{ flexShrink: 0 }} />
      ))}
      <div style={{ flex: 1 }} />
    </div>
  );
}

/** A skeleton card with header and body content. */
function SkCard({ headerWidth = 140, children }) {
  return (
    <div className="sk-card-wrap">
      <div className="sk-card-h">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
          <Sk w={headerWidth} h={15} />
          <Sk w={headerWidth * 0.8} h={12} />
        </div>
      </div>
      {children}
    </div>
  );
}

/* ── Overview skeleton ───────────────────────────────────────────────────── */

export function SkeletonOverviewPage() {
  return (
    <div className="page" aria-busy="true" aria-label="Loading overview…">
      <SkPageHeader />

      {/* Stat grid — 4 cards */}
      <div className="stat-grid">
        <SkStat />
        <SkStat />
        <SkStat />
        <SkStat />
      </div>

      {/* Two-column row: chart + activity feed */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 14, marginTop: 16 }}>
        {/* Calls per day chart */}
        <SkCard headerWidth={120}>
          <div style={{ padding: '18px 20px' }}>
            {/* Bar chart skeleton: 14 bars at varying heights */}
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                gap: 5,
                height: 120,
                marginBottom: 8,
              }}
            >
              {[60, 80, 45, 100, 90, 70, 110, 95, 85, 105, 120, 115, 100, 130].map((h, i) => (
                <div
                  key={i}
                  className="sk"
                  style={{
                    flex: 1,
                    height: `${(h / 130) * 100}%`,
                    borderRadius: '4px 4px 0 0',
                    minWidth: 0,
                  }}
                  aria-hidden="true"
                />
              ))}
            </div>
            {/* X-axis labels */}
            <div style={{ display: 'flex', gap: 5 }}>
              {Array.from({ length: 14 }).map((_, i) => (
                <Sk key={i} style={{ flex: 1, minWidth: 0 }} h={10} />
              ))}
            </div>
          </div>
        </SkCard>

        {/* Recent activity feed */}
        <SkCard headerWidth={110}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="sk-row"
                style={{ gap: 8, paddingLeft: 16, paddingRight: 16 }}
              >
                <Sk w={8} h={8} className="sk-circle" style={{ flexShrink: 0 }} />
                <Sk w={100} h={13} />
                <Sk w={60} h={12} />
                <div style={{ flex: 1 }} />
                <Sk w={40} h={12} />
              </div>
            ))}
          </div>
        </SkCard>
      </div>
    </div>
  );
}

/* ── Inboxes skeleton ────────────────────────────────────────────────────── */

export function SkeletonInboxesPage() {
  return (
    <div className="page" aria-busy="true" aria-label="Loading inboxes…">
      <SkPageHeader />
      <SkCard headerWidth={60}>
        {/* Table header */}
        <div className="sk-row" style={{ paddingTop: 12, paddingBottom: 12, background: 'var(--ink-25)' }}>
          {['Label', 'Address', 'Provider', 'Status', 'Calls (30d)', ''].map((col, i) => (
            <Sk key={i} w={i === 5 ? 32 : 80} h={11} style={{ flexShrink: 0 }} />
          ))}
          <div style={{ flex: 1 }} />
        </div>
        {/* Rows */}
        {Array.from({ length: 4 }).map((_, i) => (
          <SkTableRow
            key={i}
            cols={[80, 160, 60, 80, 40]}
          />
        ))}
      </SkCard>
    </div>
  );
}

/* ── API Keys skeleton ───────────────────────────────────────────────────── */

export function SkeletonKeysPage() {
  return (
    <div className="page" aria-busy="true" aria-label="Loading API keys…">
      <SkPageHeader />
      <SkCard headerWidth={80}>
        {/* Table header */}
        <div className="sk-row" style={{ paddingTop: 12, paddingBottom: 12, background: 'var(--ink-25)' }}>
          {['Name', 'Key', 'Scopes', 'Created', 'Last used', ''].map((_, i) => (
            <Sk key={i} w={i === 5 ? 32 : 80} h={11} style={{ flexShrink: 0 }} />
          ))}
          <div style={{ flex: 1 }} />
        </div>
        {/* Rows */}
        {Array.from({ length: 3 }).map((_, i) => (
          <SkTableRow
            key={i}
            cols={[100, 140, 120, 80, 80]}
          />
        ))}
      </SkCard>
    </div>
  );
}

/* ── Usage skeleton ──────────────────────────────────────────────────────── */

export function SkeletonUsagePage() {
  return (
    <div className="page" aria-busy="true" aria-label="Loading usage…">
      <SkPageHeader withAction={false} />

      {/* Summary stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 20 }}>
        <SkStat />
        <SkStat />
        <SkStat />
      </div>

      {/* 30-day chart card */}
      <SkCard headerWidth={130}>
        <div style={{ padding: '18px 20px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-end',
              gap: 3,
              height: 140,
              marginBottom: 8,
            }}
          >
            {Array.from({ length: 30 }).map((_, i) => {
              const h = 20 + Math.abs(Math.sin(i * 0.7)) * 80;
              return (
                <div
                  key={i}
                  className="sk"
                  style={{
                    flex: 1,
                    height: `${h}%`,
                    borderRadius: '4px 4px 0 0',
                    minWidth: 0,
                  }}
                  aria-hidden="true"
                />
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 3 }}>
            {Array.from({ length: 7 }).map((_, i) => (
              <Sk key={i} style={{ flex: 1, minWidth: 0 }} h={10} />
            ))}
          </div>
        </div>
      </SkCard>

      {/* Two breakdown tables side-by-side */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 16 }}>
        {/* By tool */}
        <SkCard headerWidth={80}>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="sk-row">
              <Sk w={100} h={13} />
              <div style={{ flex: 1 }} />
              <Sk w={40} h={13} />
              <Sk w={60} h={8} style={{ borderRadius: 4 }} />
            </div>
          ))}
        </SkCard>

        {/* By inbox */}
        <SkCard headerWidth={80}>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="sk-row">
              <Sk w={120} h={13} />
              <div style={{ flex: 1 }} />
              <Sk w={40} h={13} />
              <Sk w={60} h={8} style={{ borderRadius: 4 }} />
            </div>
          ))}
        </SkCard>
      </div>
    </div>
  );
}

/* ── Settings skeleton ───────────────────────────────────────────────────── */

export function SkeletonSettingsPage() {
  return (
    <div className="page" aria-busy="true" aria-label="Loading settings…">
      <SkPageHeader withAction={false} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 640 }}>
        {/* Profile section */}
        <div className="sk-form-section">
          <Sk w={80} h={16} style={{ borderRadius: 4 }} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Sk w={80} h={13} />
              <Sk w="100%" h={36} style={{ borderRadius: 8 }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Sk w={60} h={13} />
              <Sk w="100%" h={36} style={{ borderRadius: 8 }} />
            </div>
          </div>
          <Sk w={100} h={34} style={{ borderRadius: 8, alignSelf: 'flex-start' }} />
        </div>

        {/* Password section */}
        <div className="sk-form-section">
          <Sk w={120} h={16} style={{ borderRadius: 4 }} />
          {['Current password', 'New password', 'Confirm password'].map((_, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Sk w={120} h={13} />
              <Sk w="100%" h={36} style={{ borderRadius: 8 }} />
            </div>
          ))}
          <Sk w={120} h={34} style={{ borderRadius: 8, alignSelf: 'flex-start' }} />
        </div>

        {/* Danger zone / delete account */}
        <div
          className="sk-form-section"
          style={{ borderColor: 'rgba(229,72,77,0.2)' }}
        >
          <Sk w={100} h={16} style={{ borderRadius: 4 }} />
          <Sk w="100%" h={13} />
          <Sk w="70%" h={13} />
          <Sk w={140} h={34} style={{ borderRadius: 8, alignSelf: 'flex-start' }} />
        </div>
      </div>
    </div>
  );
}

/* ── Security skeleton ───────────────────────────────────────────────────── */

export function SkeletonSecurityPage() {
  return (
    <div className="page" aria-busy="true" aria-label="Loading security…">
      <SkPageHeader withAction={false} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Audit log card */}
        <SkCard headerWidth={80}>
          {/* Table header */}
          <div
            className="sk-row"
            style={{ paddingTop: 12, paddingBottom: 12, background: 'var(--ink-25)' }}
          >
            {[100, 120, 80, 80, 60, 60].map((w, i) => (
              <Sk key={i} w={w} h={11} style={{ flexShrink: 0 }} />
            ))}
            <div style={{ flex: 1 }} />
          </div>
          {Array.from({ length: 8 }).map((_, i) => (
            <SkTableRow
              key={i}
              cols={[90, 130, 80, 80, 60, 56]}
            />
          ))}
        </SkCard>

        {/* Sessions card */}
        <SkCard headerWidth={120}>
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="sk-row" style={{ justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Sk w={140} h={14} />
                <Sk w={200} h={12} />
              </div>
              <Sk w={100} h={30} style={{ borderRadius: 8, flexShrink: 0 }} />
            </div>
          ))}
        </SkCard>
      </div>
    </div>
  );
}

/* ── Full-shell skeleton (used by loading.js) ────────────────────────────── */

/**
 * SkeletonDashboardShell renders a static version of the two-column dashboard
 * layout with a shimmer sidebar and the Overview page skeleton in the main area.
 * Used by app/dashboard/loading.js as the Next.js Suspense fallback while
 * the server fetches data.
 */
export function SkeletonDashboardShell() {
  const navItems = [120, 90, 80, 100, 80, 90];

  return (
    <div className="shell" aria-busy="true" aria-label="Loading dashboard…">
      {/* Sidebar skeleton */}
      <div
        className="sidebar"
        style={{ gap: 0 }}
        aria-hidden="true"
      >
        {/* Brand */}
        <div style={{ padding: '6px 8px 22px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Sk w={28} h={28} className="sk-circle" />
          <Sk w={100} h={18} />
        </div>

        {/* Nav section label */}
        <Sk w={60} h={10} style={{ margin: '0 10px 8px', borderRadius: 3 }} />

        {/* Nav items */}
        <div className="nav" style={{ gap: 4 }}>
          {navItems.map((w, i) => (
            <div
              key={i}
              style={{
                height: 32,
                padding: '0 10px',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                borderRadius: 6,
                background: i === 0 ? 'var(--cobalt-50)' : 'transparent',
              }}
            >
              <Sk w={16} h={16} style={{ borderRadius: 3, flexShrink: 0 }} />
              <Sk w={w} h={13} />
            </div>
          ))}
        </div>

        {/* Footer user */}
        <div
          style={{
            marginTop: 'auto',
            padding: 10,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            borderTop: '1px solid var(--border-1)',
          }}
        >
          <Sk w={28} h={28} className="sk-circle" style={{ flexShrink: 0 }} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 5 }}>
            <Sk w={80} h={13} />
            <Sk w={120} h={11} />
          </div>
        </div>
      </div>

      {/* Main column */}
      <div className="main-col">
        {/* Topbar skeleton */}
        <div
          className="topbar"
          aria-hidden="true"
          style={{ display: 'flex', alignItems: 'center', gap: 16 }}
        >
          <Sk w={160} h={14} />
          <div style={{ flex: 1 }} />
          <Sk w={280} h={32} style={{ borderRadius: 8 }} />
        </div>

        {/* Overview page skeleton (default landing section) */}
        <SkeletonOverviewPage />
      </div>
    </div>
  );
}
