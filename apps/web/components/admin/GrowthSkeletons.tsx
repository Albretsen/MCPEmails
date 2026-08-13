/**
 * GrowthSkeletons: Suspense fallbacks for the /admin/growth sections.
 *
 * The growth page renders as a shell plus one independently-streamed section
 * per query. Each section is wrapped in its own Suspense boundary, so the
 * expensive retention and cohort queries can no longer hold the whole page
 * hostage the way they did when everything sat behind a single `Promise.all`.
 *
 * Every skeleton mirrors the real section's structure (same card counts, same
 * heights, same grid) so nothing jumps when the data lands. They are pure
 * server components: no state, no client JavaScript. The shimmer comes from
 * `.growth-sk` in admin-growth.css, which the page already imports; the
 * dashboard's own `.sk` class is deliberately not reused, because that would
 * make this page depend on dashboard.css for a single animation.
 */

function Block({ width, height = 14, radius = 6 }: { width?: number | string; height?: number; radius?: number }) {
  return <span className="growth-sk" aria-hidden="true" style={{ width: width ?? '100%', height, borderRadius: radius }} />;
}

/** One stat card placeholder, including the sparkline strip below the number. */
function StatCard({ withSparkline = true }: { withSparkline?: boolean }) {
  return (
    <div className="growth-stat">
      <Block width={110} height={11} />
      <div style={{ margin: '10px 0 8px' }}><Block width={72} height={28} /></div>
      <Block width={150} height={11} />
      {withSparkline && <div style={{ marginTop: 12 }}><Block height={28} radius={4} /></div>}
    </div>
  );
}

/** A row of stat cards. Defaults to the hero row's five. */
export function SkeletonStatRow({ count = 5, label }: { count?: number; label?: string }) {
  return (
    <section className="growth-stat-grid" aria-label={label ? `${label} loading` : 'Loading summary'} aria-busy="true">
      {Array.from({ length: count }, (_, index) => <StatCard key={index} />)}
    </section>
  );
}

/** Section header placeholder: title plus the one-line explanation under it. */
function SectionHead() {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ marginBottom: 7 }}><Block width={190} height={16} /></div>
      <Block width={420} height={12} />
    </div>
  );
}

/** A charted section. `height` should match the real chart's rendered height. */
export function SkeletonChart({ height = 220, label }: { height?: number; label?: string }) {
  return (
    <section className="growth-section" aria-label={label ? `${label} loading` : 'Loading chart'} aria-busy="true">
      <SectionHead />
      <div className="growth-panel"><Block height={height} radius={8} /></div>
    </section>
  );
}

/** Two charts side by side, matching the `.growth-split` grid. */
export function SkeletonSplitChart({ height = 200, label }: { height?: number; label?: string }) {
  return (
    <section className="growth-section" aria-label={label ? `${label} loading` : 'Loading charts'} aria-busy="true">
      <SectionHead />
      <div className="growth-split">
        <div className="growth-panel"><Block height={height} radius={8} /></div>
        <div className="growth-panel"><Block height={height} radius={8} /></div>
      </div>
    </section>
  );
}

/** A tabular section. `rows` should match the real table's typical row count. */
export function SkeletonTable({ rows = 6, label }: { rows?: number; label?: string }) {
  return (
    <section className="growth-section" aria-label={label ? `${label} loading` : 'Loading table'} aria-busy="true">
      <SectionHead />
      <div className="growth-panel">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} style={{ display: 'flex', gap: 16, padding: '11px 14px', alignItems: 'center' }}>
            <Block width={index === 0 ? 120 : 90 + (index % 3) * 24} height={12} />
            <span style={{ flex: 1 }} />
            <Block width={54} height={12} />
          </div>
        ))}
      </div>
    </section>
  );
}

/** The Gmail cap card: a wide meter with its projection line underneath. */
export function SkeletonCapCard() {
  return (
    <section className="growth-section" aria-label="Gmail OAuth headroom loading" aria-busy="true">
      <div className="growth-panel" style={{ padding: 20 }}>
        <Block width={210} height={12} />
        <div style={{ margin: '12px 0 14px' }}><Block width={140} height={34} /></div>
        <Block height={12} radius={999} />
        <div style={{ marginTop: 14 }}><Block width={330} height={12} /></div>
      </div>
    </section>
  );
}
