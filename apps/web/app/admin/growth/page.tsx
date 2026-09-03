/**
 * /admin/growth: the internal growth board.
 *
 * ONE READER, ONCE A WEEK, ON A LAPTOP, asking how the business is doing and
 * what to do about it. Three designs have been judged and two rejected, and
 * the verdicts are worth keeping here because they are the whole specification.
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
 *   That was the wrong lesson drawn from the second verdict: the boxes and the
 *   graphs were never the problem.
 *
 * So this one keeps the graphs and the boxes, both of them literally: every
 * chart is a component from components/admin/charts, each of which draws its
 * own bordered card. What changes is the LAYOUT and the AMOUNT OF PROSE. It is
 * a twelve column bento: cards span three to twelve columns by how much they
 * matter, tiling into rows of two, three and four, so the eye gets a shape
 * rather than a column. Nothing on the page is a paragraph. A card gets a
 * title, one line of subtitle, and a footnote only where a number would
 * otherwise mislead.
 *
 * THE MILESTONE BOARD IS HERE BECAUSE IT WAS ASKED FOR. Achievements and the
 * distance to the next one are the part of the previous design the operator
 * liked, and they are a real statistics feature: every rung is a counted fact,
 * dated wherever a series can prove the day it was crossed. It is deliberately
 * not gamified: no points, no trophies, no confetti, no emoji.
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
 * PRIVACY. Everything is an aggregate except the two tables in the last card,
 * which name accounts and sit behind the ADMIN_EMAILS session. No credential,
 * message content, subject, recipient or IP address appears here. The kiosk
 * board carries neither table and must not gain one: it hangs on a wall behind
 * a shared token.
 */

import { Suspense } from 'react';
import { requireAdmin } from '@/lib/admin/require-admin';
import {
  GrowthSection,
  HealthSection,
  MilestoneSection,
  MoneySection,
  PulseSection,
  TablesSection,
} from '../../../components/admin/growth/sections';
import '../../../styles/admin-board.css';

export const metadata = { title: 'Growth analytics · MCP Emails', robots: { index: false, follow: false } };

/**
 * Windows for the figures that are genuinely windowed: MRR movements,
 * acquisition channels, connection attempts, call volume and the error
 * breakdown. Capped at 90 because activity_log is purged there, so a wider
 * window would divide real counts into a denominator that decays as history
 * ages out.
 *
 * The funnels, the milestones and the retention curve ignore this control and
 * say so in their own subtitles: they read durable timestamp columns and are
 * all-time whatever is selected. A switch that appeared to apply to numbers it
 * does not touch would be worse than no switch.
 */
const WINDOWS = { '7d': 7, '28d': 28, '90d': 90 } as const;
type WindowKey = keyof typeof WINDOWS;

function resolveWindow(raw: string | undefined): WindowKey {
  return raw === '7d' || raw === '90d' ? raw : '28d';
}

/** Holds a cell open while its band loads, so the grid never jumps. */
function Cell({ span, height }: { span: number; height: number }) {
  return <div className={`bd-w${span} bd-skeleton`} style={{ minHeight: height }} aria-hidden="true" />;
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
    <main className="board">
      <header className="bd-head">
        <div>
          <h1>Growth</h1>
          <p className="bd-head-sub">
            Money from Stripe, everything else from the product database. UTC. Cached ten minutes.
          </p>
        </div>
        <div className="bd-tools">
          <nav aria-label="Reporting window">
            {(Object.keys(WINDOWS) as WindowKey[]).map((key) => (
              <a key={key} href={`/admin/growth?window=${key}`} aria-current={key === windowKey ? 'true' : undefined}>
                {WINDOWS[key]}d
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

      <div className="bd-grid">
        <Suspense
          fallback={
            <>
              <Cell span={5} height={300} />
              <Cell span={7} height={300} />
            </>
          }
        >
          <MoneySection days={days} />
        </Suspense>

        <Suspense
          fallback={
            <>
              <Cell span={3} height={150} />
              <Cell span={3} height={150} />
              <Cell span={3} height={150} />
              <Cell span={3} height={150} />
            </>
          }
        >
          <PulseSection days={days} />
        </Suspense>

        <p className="bd-band">Milestones</p>
        <Suspense fallback={<Cell span={12} height={220} />}>
          <MilestoneSection />
        </Suspense>

        <p className="bd-band">Who arrives, and where they stop</p>
        <Suspense
          fallback={
            <>
              <Cell span={7} height={300} />
              <Cell span={5} height={300} />
              <Cell span={5} height={240} />
              <Cell span={3} height={240} />
              <Cell span={4} height={240} />
              <Cell span={4} height={260} />
              <Cell span={4} height={260} />
              <Cell span={4} height={260} />
              <Cell span={6} height={260} />
              <Cell span={6} height={260} />
            </>
          }
        >
          <GrowthSection days={days} />
        </Suspense>

        <p className="bd-band">Reliability and ceilings</p>
        <Suspense
          fallback={
            <>
              <Cell span={4} height={230} />
              <Cell span={4} height={230} />
              <Cell span={4} height={230} />
              <Cell span={4} height={270} />
              <Cell span={8} height={270} />
            </>
          }
        >
          <HealthSection days={days} />
        </Suspense>

        <p className="bd-band">Accounts</p>
        <Suspense fallback={<Cell span={12} height={110} />}>
          <TablesSection days={days} />
        </Suspense>
      </div>

      <p className="bd-foot">
        Money is priced from Stripe because Postgres stores no amount, interval or coupon. Anything
        derived from activity_log is bounded at 90 days, because that is when it is purged. Comped and
        internal accounts are excluded from customer counts and reported separately.
      </p>
    </main>
  );
}
