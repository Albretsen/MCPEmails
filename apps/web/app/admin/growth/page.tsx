/**
 * /admin/growth: the internal product and growth reporting view.
 *
 * This file is deliberately thin. It resolves the window, renders the header,
 * and mounts one independently-streamed section per question. Every section is
 * its own async server component behind its own Suspense boundary, so the page
 * paints immediately and each panel arrives when its query does.
 *
 * ORDER IS THE DESIGN. Sections run in the order the questions get asked on a
 * weekly review, and the order changed in this revision because the product
 * did. Until 2026-08-29 it had no paying customer, so the page opened with
 * usage and put anything to do with money near the bottom; the operator's own
 * verdict was that it was not worth opening most weeks. It now opens with a
 * six-number pulse and then revenue, and the sections descend through the
 * causes: what we earn, who could pay next, who is arriving, how far they get,
 * whether they stay, who they are, and what is broken.
 *
 * WHAT WAS REMOVED, so it is not quietly re-added later:
 *   - Four separate panels measuring the ACTION cap. The 2026-08-19 repricing
 *     made connected inboxes the value metric and left the action cap as an
 *     abuse ceiling, so all four now report a structural zero. Replaced by one
 *     line in Health, and by the inbox-ceiling numbers that measure the paywall
 *     that actually exists.
 *   - The cumulative-signups chart, which restated the bar chart above it.
 *   - The MCP client mix, which read "unknown, 100%" on every render. It comes
 *     back automatically if a real client is ever recorded.
 *   - A second "Paying customers" card that disagreed in wording with the first.
 *   - Fourteen of the twenty error rows, now behind a disclosure.
 *
 * Privacy contract, unchanged in substance and widened by one section: this
 * page shows aggregates except for two tables that name accounts, the active
 * roster and the Stripe subscription list. Both are behind the ADMIN_EMAILS
 * session. No credential, message content, subject, recipient or IP address
 * appears anywhere on it. The kiosk board at /admin/growth/kiosk carries
 * neither table, deliberately, because it hangs on a wall behind a shared token.
 */

import { Suspense } from 'react';
import { requireAdmin } from '@/lib/admin/require-admin';
import { refreshGrowthData } from '@/lib/analytics/growth-queries';
import {
  SkeletonChart,
  SkeletonSplitChart,
  SkeletonStatRow,
  SkeletonTable,
} from '../../../components/admin/GrowthSkeletons';
import { PulseSection } from '../../../components/admin/growth/PulseSection';
import { RevenueSection } from '../../../components/admin/growth/RevenueSection';
import { PathToPaidSection } from '../../../components/admin/growth/PathToPaidSection';
import { AcquisitionSection } from '../../../components/admin/growth/AcquisitionSection';
import { OnboardingSection } from '../../../components/admin/growth/OnboardingSection';
import { RetentionSection } from '../../../components/admin/growth/RetentionSection';
import { ActiveUsersSection } from '../../../components/admin/growth/ActiveUsersSection';
import { HealthSection } from '../../../components/admin/growth/HealthSection';
import '../../../styles/admin-growth.css';
import '../../../styles/admin-charts.css';

export const metadata = { title: 'Growth analytics · MCP Emails', robots: { index: false, follow: false } };

/**
 * Selectable reporting windows. Capped at 90 days on purpose: a pg_cron job
 * deletes `activity_log` rows older than 90 days, so a longer window would
 * quietly report a shrinking denominator as history aged out. Cohort and
 * activation metrics read the durable `workspaces.onboarding_*_at` columns and
 * are unaffected by that limit. Seven days is offered because at 60-plus
 * signups a week there is now enough volume for a weekly read to mean
 * something, which there was not when this page was built.
 */
const WINDOWS = { '7d': 7, '28d': 28, '90d': 90 } as const;
type WindowKey = keyof typeof WINDOWS;
const WINDOW_LABELS: Record<WindowKey, string> = {
  '7d': 'Last 7 days',
  '28d': 'Last 28 days',
  '90d': 'Last 90 days',
};

export default async function GrowthAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>;
}) {
  await requireAdmin();
  const params = await searchParams;
  const windowKey: WindowKey = params.window === '90d' ? '90d' : params.window === '7d' ? '7d' : '28d';
  const days = WINDOWS[windowKey];

  return (
    <main className="growth-page">
      <header className="growth-header">
        <div>
          <h1 className="growth-title">Growth</h1>
          <p className="growth-subtitle">
            Money from Stripe, everything else from the product database. All dates are UTC.
          </p>
        </div>
        <div className="growth-toolbar">
          <nav className="growth-windows" aria-label="Reporting window">
            {(Object.keys(WINDOWS) as WindowKey[]).map((key) => (
              <a
                key={key}
                href={`/admin/growth?window=${key}`}
                aria-current={key === windowKey ? 'true' : undefined}
              >
                {WINDOW_LABELS[key]}
              </a>
            ))}
          </nav>
          <form action={refreshGrowthData}>
            <button type="submit" className="growth-refresh">Refresh</button>
          </form>
        </div>
      </header>

      <p className="growth-definition">
        <strong>Active workspace:</strong> at least one successful MCP tool call in the rolling window.
        Two sections name accounts: <strong>Revenue</strong> and <strong>Accounts</strong>. Everything
        else is aggregate. Cached for up to 10 minutes; cohort and funnel stages read durable timestamps
        and are all-time.
      </p>

      <Suspense fallback={<SkeletonStatRow count={6} label="This week" />}>
        <PulseSection days={days} />
      </Suspense>

      <Suspense fallback={<SkeletonSplitChart label="Revenue" height={220} />}>
        <RevenueSection days={days} />
      </Suspense>

      <Suspense fallback={<SkeletonSplitChart label="The path to paid" height={220} />}>
        <PathToPaidSection />
      </Suspense>

      <Suspense fallback={<SkeletonChart label="Acquisition" height={240} />}>
        <AcquisitionSection days={days} />
      </Suspense>

      <Suspense fallback={<SkeletonChart label="Onboarding" height={240} />}>
        <OnboardingSection days={days} />
      </Suspense>

      <Suspense fallback={<SkeletonChart label="Retention" height={240} />}>
        <RetentionSection />
      </Suspense>

      <Suspense fallback={<SkeletonTable label="Accounts" rows={10} />}>
        <ActiveUsersSection days={days} />
      </Suspense>

      <Suspense fallback={<SkeletonSplitChart label="Health and ceilings" height={220} />}>
        <HealthSection days={days} />
      </Suspense>
    </main>
  );
}
