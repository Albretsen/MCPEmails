/**
 * /admin/growth: the internal growth board.
 *
 * ONE READER, ONCE A WEEK, ON A LAPTOP, asking how the business is doing and
 * what to do about it. Four designs have been judged and three rejected, and
 * the verdicts are the whole specification.
 *
 *   The first was eleven sections of product usage, with everything that
 *   decides whether this becomes a business below the fold.
 *
 *   The second fixed the ordering and was still "badly laid out, and not very
 *   interesting". The charts and the cards in it were fine; the vertical list
 *   of eight equally weighted full-width sections was not.
 *
 *   The third threw the cards away for a hairline-ruled sheet of prose and
 *   figures, and was "a wall of text, horrible to look at, and super boring".
 *   The boxes and the graphs were never the problem.
 *
 *   The fourth put the boxes back as a light twelve column bento, and is what
 *   this replaces. The verdict on it, 2026-09-07: "impossibly hard to use,
 *   boring, and ugly", with the milestone board singled out as the ugliest UI
 *   in the building despite being the part worth keeping.
 *
 * THE ANSWER WAS TWO METRES AWAY THE WHOLE TIME. The kiosk hanging on the wall
 * reads the same RPCs and is none of those things, and there was never a
 * reason for this page to speak a second visual language about the same
 * numbers. So this board IS the kiosk: the same tiles from
 * components/admin/kiosk/primitives, the same dark ground, the same funnel
 * arithmetic out of kiosk/shared, sized for a laptop instead of a wall.
 *
 * WHAT A LAPTOP ADDS, and why this is not simply the kiosk at a URL:
 *
 *   - A POINTER, so tiles have hover states, charts keep their exact-numbers
 *     drawers, and every number on the page is selectable text. The wall board
 *     suppresses all three because a display nobody touches has no use for
 *     them.
 *   - A SCROLLBAR, so all five kiosk views can be on one page at once as
 *     bands, rather than five buttons that hide four fifths of the board. The
 *     kiosk switches views because it has exactly one screen; this does not.
 *   - AN AUTHENTICATED OPERATOR, so it can carry the two things the kiosk must
 *     never carry: the account roster and the Stripe customer detail, both of
 *     which name people. The wall is reachable with a shared token by anyone
 *     in the room.
 *   - ROOM FOR THE PANELS A GLANCE CANNOT USE: the cohort grid, the year of
 *     daily signup cells, the computed to-do list, and the milestone track.
 *
 * WHAT IS NEW HERE AND IS ON NEITHER OF THE OLD BOARDS, because a founder
 * reading this weekly needs it and neither surface had it:
 *
 *   - WHICH CHANNELS PRODUCE CUSTOMERS. The donut this replaces ranked sources
 *     by signup count, which is the wrong question: a source that sends fifty
 *     people who never connect an inbox is worth less than one that sends five
 *     who pay. The acquisition RPC has carried the activated and paying counts
 *     per channel all along and nothing drew them.
 *   - RECORDS. Best signup day, current and longest signup streak, busiest
 *     call day, days since the last sale. Every other figure on the page is a
 *     level or a rate, and none of them can say that last Tuesday was the best
 *     day this product has ever had.
 *   - THE MONEY SAID FOUR WAYS in one panel: MRR, the year of it, what each
 *     paying customer is worth, and the notional valuation the kiosk already
 *     showed but this page did not.
 *
 * THE MILESTONE BOARD IS STILL HERE AND WAS REDRAWN, not removed. It was asked
 * for, it is the part of the old page the operator liked, and it is a real
 * statistics feature: every rung is a counted fact, dated wherever a series can
 * prove the day it was crossed. It is still deliberately not gamified: no
 * points, no trophies, no confetti, no emoji. See board/milestones.tsx for why
 * the reached half is now a time axis rather than a wrapped list of pills.
 *
 * WHAT IS DELIBERATELY ABSENT, so it is not helpfully re-added:
 *   - A jump nav. It was a patch on a page that was too long and too uniform.
 *   - Any measure of the ACTION cap: connected inboxes have been the value
 *     metric since the August 2026 repricing, and four panels once reported a
 *     structural zero.
 *   - A cumulative-signups curve under a signups bar chart, which restated it.
 *   - The MCP client mix, which reads "unknown, 100%" on every render.
 *   - Any figure stated twice.
 *
 * PRIVACY. Everything is an aggregate except the two tables in the last band,
 * which name accounts and sit behind the ADMIN_EMAILS session. No credential,
 * message content, subject, recipient or IP address appears here. The kiosk
 * board carries neither table and must not gain one.
 */

import { Suspense } from 'react';
import { requireAdmin } from '@/lib/admin/require-admin';
import {
  GrowthSection,
  MilestoneSection,
  MoneySection,
  StickinessSection,
  TablesSection,
  TopSection,
  UptimeSection,
} from '../../../components/admin/growth/sections';
import '../../../styles/admin-board.css';
import '../../../styles/admin-board-parts.css';
// The tiles on this board ARE the kiosk's tiles, so the kiosk's sheet is
// what dresses them. admin-growth.css only lays them out and adds the
// pointer affordances a wall display has no use for.
import '../../../styles/admin-kiosk.css';
import '../../../styles/admin-growth.css';

export const metadata = { title: 'Growth analytics · MCP Emails', robots: { index: false, follow: false } };

/**
 * Windows for the figures that are genuinely windowed: MRR movements,
 * acquisition channels, connection attempts, call volume and the error
 * breakdown. Capped at 90 because activity_log is purged there, so a wider
 * window would divide real counts into a denominator that decays as history
 * ages out.
 *
 * The funnels, the milestones, the records and the retention curve ignore this
 * control and say so in their own captions: they read durable timestamp columns
 * and are all-time whatever is selected. A switch that appeared to apply to
 * numbers it does not touch would be worse than no switch.
 */
const WINDOWS = { '7d': 7, '28d': 28, '90d': 90 } as const;
type WindowKey = keyof typeof WINDOWS;

function resolveWindow(raw: string | undefined): WindowKey {
  return raw === '7d' || raw === '90d' ? raw : '28d';
}

/**
 * A band heading.
 *
 * A REAL HEADING, not a tab stop. What this replaces was a 10.5px uppercase
 * grey label on a hairline, indistinguishable at a glance from a tile label,
 * which is why the board read as one undifferentiated field of cards and drew
 * "hard to differentiate sections". The `id` is what the header links jump to.
 */
function Band({ id, title, question }: { id: string; title: string; question: string }) {
  return (
    <h2 className="gb-band" id={id}>
      <b>{title}</b>
      <em>{question}</em>
    </h2>
  );
}

/** The bands, in page order. The header renders these as jump links. */
const BANDS = [
  { id: 'money', title: 'Money', question: 'what have we earned' },
  { id: 'milestones', title: 'Milestones', question: 'how far, and how fast' },
  { id: 'growth', title: 'Growth', question: 'who is arriving' },
  { id: 'stickiness', title: 'Stickiness', question: 'who stays' },
  { id: 'uptime', title: 'Uptime', question: 'is it working' },
  { id: 'accounts', title: 'Accounts', question: 'who they actually are' },
] as const;

/** Holds a cell open while its band loads, so the grid never jumps. */
function Skeleton({ span, tall }: { span: 4 | 6 | 8 | 12; tall?: 2 | 3 }) {
  return (
    <div className={`gb-cell gb-w${span}${tall ? ` gb-h${tall}` : ''}`} aria-hidden="true">
      <div className="gb-skeleton" />
    </div>
  );
}

export default async function GrowthBoardPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>;
}) {
  await requireAdmin();
  const params = await searchParams;
  const windowKey = resolveWindow(params.window);
  const days = WINDOWS[windowKey];

  return (
    <div className="gb">
      <main className="gb-inner">
        <header className="gb-head">
          <h1 className="gb-wordmark">Growth</h1>
          <nav className="gb-jump" aria-label="Sections">
            {BANDS.map((band) => (
              <a key={band.id} href={`#${band.id}`}>{band.title}</a>
            ))}
          </nav>
          <div className="gb-tools">
            <nav className="gb-windows" aria-label="Reporting window">
              {(Object.keys(WINDOWS) as WindowKey[]).map((key) => (
                <a key={key} href={`/admin/growth?window=${key}`} aria-current={key === windowKey ? 'true' : undefined}>
                  {WINDOWS[key]}d
                </a>
              ))}
            </nav>
            <a className="gb-link" href="/admin/growth/kiosk">Kiosk</a>
            <a className="gb-link" href="/admin/growth/experiments">Experiments</a>
            <a className="gb-link" href="/admin/growth/dunning">Dunning</a>
            {/* A route handler rather than a Server Action: the action-ID lookup
                failed on every submission in production (verified live
                2026-08-30), and a URL is not a build-generated hash. */}
            <form action="/admin/growth/refresh" method="POST">
              <button type="submit">Refresh</button>
            </form>
          </div>
        </header>

        <div className="gb-grid">
          <Suspense
            fallback={
              <>
                <Skeleton span={12} />
                <Skeleton span={8} tall={3} />
                <Skeleton span={4} tall={3} />
              </>
            }
          >
            <TopSection days={days} />
          </Suspense>

          <Band id="money" title="Money" question="what have we earned" />
          <Suspense
            fallback={
              <>
                <Skeleton span={4} />
                <Skeleton span={4} />
                <Skeleton span={4} />
                <Skeleton span={6} tall={2} />
                <Skeleton span={6} tall={2} />
              </>
            }
          >
            <MoneySection days={days} />
          </Suspense>

          <Band id="milestones" title="Milestones" question="how far, and how fast" />
          <Suspense fallback={<Skeleton span={12} tall={3} />}>
            <MilestoneSection />
          </Suspense>

          <Band id="growth" title="Growth" question="who is arriving" />
          <Suspense
            fallback={
              <>
                <Skeleton span={6} tall={2} />
                <Skeleton span={6} tall={2} />
                <Skeleton span={8} tall={2} />
                <Skeleton span={4} tall={2} />
                <Skeleton span={6} />
                <Skeleton span={6} />
              </>
            }
          >
            <GrowthSection days={days} />
          </Suspense>

          <Band id="stickiness" title="Stickiness" question="who stays" />
          <Suspense
            fallback={
              <>
                <Skeleton span={6} tall={2} />
                <Skeleton span={6} tall={2} />
                <Skeleton span={4} />
                <Skeleton span={4} />
                <Skeleton span={4} />
              </>
            }
          >
            <StickinessSection days={days} />
          </Suspense>

          <Band id="uptime" title="Uptime" question="is it working" />
          <Suspense
            fallback={
              <>
                <Skeleton span={4} />
                <Skeleton span={4} />
                <Skeleton span={4} />
                <Skeleton span={4} tall={2} />
                <Skeleton span={8} tall={2} />
                <Skeleton span={12} tall={2} />
                <Skeleton span={12} tall={2} />
              </>
            }
          >
            <UptimeSection days={days} />
          </Suspense>

          <Band id="accounts" title="Accounts" question="who they actually are" />
          <Suspense fallback={<Skeleton span={12} />}>
            <TablesSection days={days} />
          </Suspense>
        </div>

        <p className="gb-foot">
          Money is priced from Stripe because Postgres stores no amount, interval or coupon. Anything derived
          from activity_log is bounded at 90 days, because that is when it is purged. Comped and internal
          accounts are excluded from customer counts and reported separately. UTC throughout, cached ten
          minutes.
        </p>
      </main>
    </div>
  );
}
