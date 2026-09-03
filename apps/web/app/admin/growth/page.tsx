/**
 * /admin/growth: PLACEHOLDER. The reporting UI was deleted on 2026-09-03 and is
 * being rebuilt from scratch.
 *
 * WHY THERE IS NOTHING HERE. Two designs of this page in a row were judged not
 * worth opening, and the second was a revision of the first: it inherited the
 * section list, the card vocabulary and the stylesheet, and so it inherited the
 * problem. The whole presentation layer was therefore removed rather than
 * revised again, so that the next attempt is not anchored to the shape of the
 * two that failed.
 *
 * WHAT WAS DELETED, and it is all UI:
 *   components/admin/growth/**            every section, card and table
 *   components/admin/{MetricCard,MetricDrawer,MetricLink,InfoDot,
 *                     GrowthSkeletons}.tsx
 *   styles/admin-growth.css
 *
 * WHAT SURVIVES UNTOUCHED, because none of it was the problem:
 *   src/lib/analytics/**                  every query, RPC wrapper and pure
 *                                         helper, with its tests
 *   app/api/admin/growth/metric/[key]     the per-metric history endpoint
 *   app/admin/growth/refresh              the cache-invalidation handler
 *   components/admin/charts/**            unopinionated SVG primitives and the
 *                                         number formatters, still used by the
 *                                         kiosk; free to reuse, ignore or
 *                                         replace
 *   app/admin/growth/kiosk/**             the wall board, which nobody has
 *                                         complained about
 *
 * Until the replacement lands, the numbers are all still readable on the kiosk
 * board, which is why this page points at it rather than apologising.
 */

import { requireAdmin } from '@/lib/admin/require-admin';

export const metadata = { title: 'Growth analytics · MCP Emails', robots: { index: false, follow: false } };

export default async function GrowthAnalyticsPage() {
  await requireAdmin();

  return (
    <main style={{ maxWidth: 560, margin: '0 auto', padding: '80px 24px', color: 'var(--fg-1)' }}>
      <h1 style={{ fontSize: 28, letterSpacing: '-0.025em', margin: 0 }}>Growth</h1>
      <p style={{ color: 'var(--fg-3)', fontSize: 14, lineHeight: 1.6, marginTop: 12 }}>
        This dashboard is being rebuilt. The data layer, the queries and the cached RPCs behind it are
        all intact and untouched; only the presentation was removed.
      </p>
      <p style={{ color: 'var(--fg-3)', fontSize: 14, lineHeight: 1.6 }}>
        Every number it used to show is still on the{' '}
        <a href="/admin/growth/kiosk" style={{ color: 'var(--brand)' }}>kiosk board</a>, which has five
        views: the pulse, money, growth, stickiness and uptime.
      </p>
    </main>
  );
}
