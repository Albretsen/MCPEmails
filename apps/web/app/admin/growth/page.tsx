/**
 * /admin/growth: the internal product and growth reporting view.
 *
 * This file is deliberately thin. It resolves the window, renders the header
 * and the section nav, and mounts one independently-streamed section per
 * question. Every section is its own async server component behind its own
 * Suspense boundary, so the page paints immediately and each panel arrives when
 * its query does.
 *
 * ORDER IS THE DESIGN, and this revision changed the top of it.
 *
 * The page used to open with a strip of six equal cards and then descend
 * through revenue, the paywall, acquisition, onboarding, retention, accounts
 * and health. The descent was right and is unchanged. The opening was not: six
 * cards of identical weight is a list, not a hierarchy, and it mixed LEVELS
 * (MRR, which is what the business is) with MOVEMENTS (new workspaces this
 * week, which is what changed) at the same size, so neither could be read in
 * the five seconds a person actually gives an overview. It also put a driver,
 * the count of workspaces standing at the inbox ceiling, in the headline row,
 * where it competed with revenue for attention it does not deserve; that number
 * now lives only in "The path to paid", beside the rest of the paywall
 * population it belongs with.
 *
 * So the page now opens as an inverted pyramid, which is the layout every
 * source on dashboard design converges on and which this page previously did
 * not use:
 *
 *   1. SCOREBOARD. Four large cards carrying the levels: MRR, cash collected,
 *      paying customers, people. Beneath them one strip of six small cards
 *      carrying the movements, with MRR broken into new, churned and at risk
 *      rather than netted into one figure that hides whether a flat month was
 *      quiet or was one sale cancelling one churn.
 *   2. RECORDS. The series read for its shape rather than its level: longest
 *      run, highest day, distance to the next round number. It is the
 *      enjoyable section and it is made entirely of counted facts.
 *   3. Everything else, in the order the questions get asked: what we earn, who
 *      could pay next, who is arriving, how far they get, whether they stay,
 *      who they are, and what is broken.
 *
 * The nav under the header exists because the page is long by design. The
 * alternative to a long page is a page that hides the causes behind the
 * headline, and the reason this one was worth rewriting is that the headline
 * without the causes is exactly what was not worth opening.
 *
 * WHAT WAS REMOVED, so it is not quietly re-added later:
 *   - The six-card pulse strip, replaced by the scoreboard as described above.
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
 * Privacy contract, unchanged: this page shows aggregates except for two tables
 * that name accounts, the active roster and the Stripe subscription list. Both
 * are behind the ADMIN_EMAILS session. No credential, message content, subject,
 * recipient or IP address appears anywhere on it. The kiosk board at
 * /admin/growth/kiosk carries neither table, deliberately, because it hangs on
 * a wall behind a shared token.
 */

import { Suspense } from 'react';
import { requireAdmin } from '@/lib/admin/require-admin';
import {
  SkeletonChart,
  SkeletonSplitChart,
  SkeletonStatRow,
  SkeletonTable,
} from '../../../components/admin/GrowthSkeletons';
import { ScoreboardSection } from '../../../components/admin/growth/ScoreboardSection';
import { RecordsSection } from '../../../components/admin/growth/RecordsSection';
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

/**
 * The nav, and therefore the page's table of contents.
 *
 * Every id here must match the `id` passed to the corresponding `Section`. A
 * jump link to an anchor that does not exist silently does nothing, which is
 * the one failure mode a nav must not have, so the two lists are kept adjacent
 * in review: the ids live in the section components, one line under the title.
 */
const SECTIONS: { id: string; label: string }[] = [
  { id: 'records', label: 'Records' },
  { id: 'revenue', label: 'Revenue' },
  { id: 'path-to-paid', label: 'Path to paid' },
  { id: 'acquisition', label: 'Acquisition' },
  { id: 'onboarding', label: 'Onboarding' },
  { id: 'retention', label: 'Retention' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'health', label: 'Health' },
];

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
          <a className="growth-refresh" href="/admin/growth/kiosk">Kiosk</a>
          <form action="/admin/growth/refresh" method="POST">
            <button type="submit" className="growth-refresh">Refresh</button>
          </form>
        </div>
      </header>

      {/* Above the scoreboard, not below it: the levels are the first thing on
          the page and this is one line of chrome, not an introduction to be
          read. It sticks so the page stays navigable at any scroll depth. */}
      <nav className="growth-nav" aria-label="Sections">
        {SECTIONS.map((section) => (
          <a key={section.id} href={`#${section.id}`}>{section.label}</a>
        ))}
      </nav>

      <Suspense fallback={<SkeletonStatRow count={4} label="The business, right now" />}>
        <ScoreboardSection days={days} />
      </Suspense>

      <Suspense fallback={<SkeletonStatRow count={6} label="Records" />}>
        <RecordsSection />
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

      <p className="growth-definition growth-footnote">
        <strong>Active workspace:</strong> at least one successful MCP tool call in the rolling window.
        Two sections name accounts: <strong>Revenue</strong> and <strong>Accounts</strong>. Everything
        else is aggregate. Cached for up to 10 minutes; cohort, funnel and record figures read durable
        timestamps and are all-time.
      </p>
    </main>
  );
}
