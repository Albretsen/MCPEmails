/**
 * /admin/growth: the internal product and growth reporting view.
 *
 * This file is deliberately thin. It is a shell that resolves the window,
 * renders the header, and mounts one independently-streamed section per
 * question. Every section is its own async server component behind its own
 * Suspense boundary, so the page paints immediately and each panel arrives
 * when its query does.
 *
 * The previous version was a single component that pulled ~104,000 raw
 * `activity_log` rows over the wire in 104 sequential PostgREST pages and
 * aggregated them in Node on every request, behind `force-dynamic` so nothing
 * was ever cached. Nothing rendered until the slowest query finished, and one
 * failing query threw and blanked the whole page. Aggregation now happens in
 * Postgres (migration 20260813140000), results are cached with tags, and each
 * section degrades on its own.
 *
 * Privacy contract, unchanged: this page shows aggregates only. No customer
 * name, email address, workspace id or request content appears anywhere on it,
 * including in the new Gmail cap card, which counts distinct addresses
 * server-side and renders only an integer.
 */

import { Suspense } from 'react';
import { requireAdmin } from '@/lib/admin/require-admin';
import { refreshGrowthData } from '@/lib/analytics/growth-queries';
import {
  SkeletonCapCard,
  SkeletonChart,
  SkeletonSplitChart,
  SkeletonStatRow,
  SkeletonTable,
} from '../../../components/admin/GrowthSkeletons';
import { GmailCapSection } from '../../../components/admin/growth/GmailCapSection';
import { HeroStatsSection } from '../../../components/admin/growth/HeroStatsSection';
import { AcquisitionSection } from '../../../components/admin/growth/AcquisitionSection';
import { ActivationFunnelSection } from '../../../components/admin/growth/ActivationFunnelSection';
import { ProviderFunnelSection } from '../../../components/admin/growth/ProviderFunnelSection';
import { RetentionSection } from '../../../components/admin/growth/RetentionSection';
import { BillingFunnelSection } from '../../../components/admin/growth/BillingFunnelSection';
import { ReliabilitySection } from '../../../components/admin/growth/ReliabilitySection';
import { MixSection } from '../../../components/admin/growth/MixSection';
import '../../../styles/admin-growth.css';
import '../../../styles/admin-charts.css';

export const metadata = { title: 'Growth analytics · MCP Emails', robots: { index: false, follow: false } };

/**
 * Selectable reporting windows. Capped at 90 days on purpose: a pg_cron job
 * deletes `activity_log` rows older than 90 days, so a longer window would
 * quietly report a shrinking denominator as history aged out. Cohort and
 * activation metrics read the durable `workspaces.onboarding_*_at` columns and
 * are unaffected by that limit.
 */
const WINDOWS = { '28d': 28, '90d': 90 } as const;
type WindowKey = keyof typeof WINDOWS;

export default async function GrowthAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>;
}) {
  await requireAdmin();
  const params = await searchParams;
  const windowKey: WindowKey = params.window === '90d' ? '90d' : '28d';
  const days = WINDOWS[windowKey];

  return (
    <main className="growth-page">
      <header className="growth-header">
        <div>
          <h1 className="growth-title">Growth analytics</h1>
          <p className="growth-subtitle">Aggregate product usage only. All dates are UTC.</p>
        </div>
        <p className="growth-definition">
          <strong>Active workspace:</strong> at least one successful MCP tool call in the rolling window.
          No customer names, email addresses, IDs, or request content are shown.
        </p>
      </header>

      <div className="growth-toolbar">
        <nav className="growth-windows" aria-label="Reporting window">
          {(Object.keys(WINDOWS) as WindowKey[]).map((key) => (
            <a key={key} href={`/admin/growth?window=${key}`} aria-current={key === windowKey ? 'true' : undefined}>
              {key === '28d' ? 'Last 28 days' : 'Last 90 days'}
            </a>
          ))}
        </nav>
        <form action={refreshGrowthData}>
          <button type="submit" className="growth-refresh">Refresh data</button>
        </form>
        <span className="growth-stamp">
          Cached for up to 10 minutes. Cohort and funnel stages read durable timestamps and are all-time.
        </span>
      </div>

      <Suspense fallback={<SkeletonCapCard />}>
        <GmailCapSection />
      </Suspense>

      <Suspense fallback={<SkeletonStatRow count={5} label="Summary" />}>
        <HeroStatsSection days={days} />
      </Suspense>

      <Suspense fallback={<SkeletonChart label="Acquisition and activation" height={240} />}>
        <AcquisitionSection days={days} />
      </Suspense>

      <Suspense fallback={<SkeletonChart label="Signup to value funnel" height={200} />}>
        <ActivationFunnelSection days={days} />
      </Suspense>

      <Suspense fallback={<SkeletonTable label="Connection funnel by provider" rows={7} />}>
        <ProviderFunnelSection days={days} />
      </Suspense>

      <Suspense fallback={<SkeletonChart label="Retention" height={240} />}>
        <RetentionSection />
      </Suspense>

      <Suspense fallback={<SkeletonChart label="Billing funnel" height={200} />}>
        <BillingFunnelSection />
      </Suspense>

      <Suspense fallback={<SkeletonSplitChart label="Reliability" height={200} />}>
        <ReliabilitySection days={days} />
      </Suspense>

      <Suspense fallback={<SkeletonSplitChart label="Estate mix" height={200} />}>
        <MixSection days={days} />
      </Suspense>
    </main>
  );
}
