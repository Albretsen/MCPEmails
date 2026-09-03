/**
 * /admin/growth: the weekly brief on how the business is doing and what to do
 * about it.
 *
 * ONE READER, ONCE A WEEK, ON A LAPTOP. Two previous designs of this page were
 * judged not worth opening. The first put everything that decides whether this
 * becomes a business below eleven sections of product usage. The second fixed
 * the ordering and was still called messy, and the reason it was still messy is
 * that it kept the first one's vocabulary: a strip of equal stat cards, then a
 * vertical list of titled sections each holding a chart and a table. It
 * rearranged the parts instead of changing what the parts were.
 *
 * SO THIS IS A SHEET, NOT A DASHBOARD. There are no cards. Regions are divided
 * by a hairline and a lot of space, columns by a hairline and nothing else,
 * and the only borders below that are inside tables. A card is a container
 * that says "this number is separate from that one", and on a page whose whole
 * argument is that the numbers explain each other, drawing forty of those
 * boundaries is the mess.
 *
 * FIVE REGIONS, EACH A QUESTION, IN THE ORDER THEY GET ASKED:
 *
 *   1. How much are we paid, and what changed. One display-size number (MRR,
 *      the only one on the page), a signed ledger of movements that are never
 *      netted, and cash as a third thing at a third weight. Levels, movements
 *      and a different question, rendered at three different sizes rather than
 *      as three identical cards.
 *   2. What needs attention. Computed from thresholds in growth-attention.ts,
 *      every item carrying the number that tripped it and the population it
 *      applies to. Full width and second, because "what should I do" is half
 *      of the question this page exists to answer and neither previous version
 *      answered it at all.
 *   3. Where does everyone stop. ONE ladder from stranger to dollar, which
 *      absorbs what used to be four separate sections (acquisition,
 *      onboarding, retention, path to paid). Those are consecutive stages of
 *      one journey, and cutting the journey into four titled boxes is exactly
 *      the fragmentation that made the page a pile of tools rather than a
 *      story. The things that were section headings are now annotations in a
 *      gutter, hanging off the rung they explain.
 *   4. What is running out, or broken. Google's 100 user OAuth cap, which is
 *      the only hard calendar deadline in the business, beside reliability.
 *   5. Has anything ever been better. Records, streaks and distances to the
 *      next round number: one dense row of small type, last, because it is the
 *      least decision-bearing thing here and must not be sized like the money.
 *
 * Then a drawer holding the two tables that name accounts, collapsed.
 *
 * WHAT IS DELIBERATELY ABSENT, so it is not helpfully re-added:
 *   - A jump nav. The previous page needed one because it was long and uniform;
 *     this one is neither, and a nav over five regions is a patch on a problem
 *     that should not exist.
 *   - Any measure of the ACTION cap. Connected inboxes have been the value
 *     metric since the August 2026 repricing and the action cap survives only
 *     as a silent abuse ceiling, so all four of the old panels measuring it
 *     reported a structural zero.
 *   - A cumulative-signups curve under a signups bar chart, which restated the
 *     chart above it.
 *   - The MCP client mix, which reads "unknown, 100%" on every render.
 *   - A cohort heatmap: sixty-four cells whose denominators are almost all
 *     under ten, which is the size at which `ratio()` refuses to print a
 *     percentage at all. The pooled retention curve is in the gutter instead.
 *   - Any figure stated twice. MRR appears once, the inbox ceiling once, cash
 *     once.
 *
 * PRIVACY. Everything is an aggregate except the two tables in the drawer (the
 * Stripe subscriptions and the active roster), which name accounts and sit
 * behind the ADMIN_EMAILS session. No credential, message content, subject,
 * recipient or IP address appears here. The kiosk board carries neither table
 * and must not gain one: it hangs on a wall behind a shared token.
 */

import { Suspense } from 'react';
import { requireAdmin } from '@/lib/admin/require-admin';
import {
  AttentionSection,
  CeilingsSection,
  ChainSection,
  RecordsSection,
  ReferenceSection,
  StandingSection,
} from '../../../components/admin/growth/sections';
import '../../../styles/admin-brief.css';

export const metadata = { title: 'Growth analytics · MCP Emails', robots: { index: false, follow: false } };

/**
 * Selectable windows for the figures that are genuinely windowed: MRR
 * movements, acquisition channels, connection attempts and the error
 * breakdown. Capped at 90 because `activity_log` is purged there, so a wider
 * window would divide real counts into a denominator that is quietly decaying
 * as history ages out.
 *
 * The ladder, the records and the retention curve ignore this control entirely
 * and say so in their own text: they read durable timestamp columns and are
 * all-time whatever is selected here. A window switch that appeared to apply
 * to numbers it does not touch would be worse than no switch.
 */
const WINDOWS = { '7d': 7, '28d': 28, '90d': 90 } as const;
type WindowKey = keyof typeof WINDOWS;

function resolveWindow(raw: string | undefined): WindowKey {
  return raw === '7d' || raw === '90d' ? raw : '28d';
}

export default async function GrowthBriefPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>;
}) {
  await requireAdmin();
  const params = await searchParams;
  const windowKey = resolveWindow(params.window);
  const days = WINDOWS[windowKey];

  return (
    <main className="brief">
      <header className="br-head">
        <h1>Growth</h1>
        <div className="br-tools">
          <nav aria-label="Reporting window">
            {(Object.keys(WINDOWS) as WindowKey[]).map((key) => (
              <a key={key} href={`/admin/growth?window=${key}`} aria-current={key === windowKey ? 'true' : undefined}>
                {WINDOWS[key]} days
              </a>
            ))}
          </nav>
          <a href="/admin/growth/kiosk">Kiosk</a>
          {/* A route handler rather than a Server Action: the action-ID lookup
              failed on every submission in production (verified live
              2026-08-30), and a URL is not a build-generated hash. */}
          <form action="/admin/growth/refresh" method="POST">
            <button type="submit">Refresh</button>
          </form>
        </div>
      </header>

      <section className="br-region br-region-first">
        <header className="br-region-head">
          <h2>How much are we paid, and what changed?</h2>
          <p>Every figure priced from Stripe, never from the plan column. Last {days} days for the movements.</p>
        </header>
        <Suspense fallback={<div className="br-skeleton" style={{ height: 210 }} />}>
          <StandingSection days={days} />
        </Suspense>
      </section>

      <section className="br-region">
        <header className="br-region-head">
          <h2>What needs attention?</h2>
          <p>Computed from thresholds in code. Each line states the number that tripped it.</p>
        </header>
        <Suspense fallback={<div className="br-skeleton" style={{ height: 120 }} />}>
          <AttentionSection days={days} />
        </Suspense>
      </section>

      <section className="br-region">
        <header className="br-region-head">
          <h2>Where does everyone stop?</h2>
          <p>
            One ladder from stranger to dollar. Workspaces above the seam, external workspaces below it.
            The gutter explains the rung beside it.
          </p>
        </header>
        <Suspense fallback={<div className="br-skeleton" style={{ height: 620 }} />}>
          <ChainSection days={days} />
        </Suspense>
      </section>

      <section className="br-region">
        <header className="br-region-head">
          <h2>What is running out, or broken?</h2>
          <p>The only deadline somebody else set, beside the only numbers that include our own traffic.</p>
        </header>
        <Suspense fallback={<div className="br-skeleton" style={{ height: 340 }} />}>
          <CeilingsSection days={days} />
        </Suspense>
      </section>

      <section className="br-region">
        <header className="br-region-head">
          <h2>Has anything ever been better?</h2>
          <p>Counted facts, each with the window it was counted over. Nothing here is scored.</p>
        </header>
        <Suspense fallback={<div className="br-skeleton" style={{ height: 120 }} />}>
          <RecordsSection />
        </Suspense>
      </section>

      <section className="br-region">
        <header className="br-region-head">
          <h2>Who, exactly?</h2>
          <p>
            The only two tables on this page that name accounts. Collapsed by default, and absent from the
            kiosk entirely.
          </p>
        </header>
        <Suspense fallback={<div className="br-skeleton" style={{ height: 80 }} />}>
          <ReferenceSection days={days} />
        </Suspense>
      </section>

      <p className="br-foot">
        Dates are UTC. Reads are cached for ten minutes; Refresh drops the lot. Money comes from Stripe
        because Postgres stores no amount, interval or coupon. Anything derived from `activity_log` is
        bounded at 90 days, because that is when it is purged.
      </p>
    </main>
  );
}
