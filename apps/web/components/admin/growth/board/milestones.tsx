/**
 * The milestone board: what has been reached, when, and what is next.
 *
 * WHY THIS WAS REDRAWN, 2026-09-07. The previous version had the right
 * information and the wrong shape: three progress rings over a wrapped soup of
 * coloured pills, each pill carrying a date. It was called the ugliest UI in
 * the building and it was not wrong. A wrapped list has no axis, so the one
 * thing a founder is actually reading here was invisible: not WHICH rungs were
 * reached but HOW FAST, and whether the last three took longer than the three
 * before.
 *
 * So the reached half is now a time axis. One column per calendar month from
 * the first thing ever reached to the month we are in, that month's milestones
 * stacked inside it, and empty months left visibly empty rather than closed
 * up. A busy August beside a bare September is the finding. It is a fact about
 * a rate, and a wrapped chip list literally cannot draw it.
 *
 * WHAT DID NOT CHANGE, because it was right the first time:
 *
 *   IT IS STILL NOT A GAME. No trophies, no tiers, no points, no rarity
 *   language, no confetti, no emoji, no animation. A founder reading this is
 *   trying to read a rate of change, and reward furniture makes a milestone
 *   feel earned rather than measured, which is the wrong feeling exactly when
 *   the honest read is "this is slowing down".
 *
 *   COLOUR IS A CATEGORY, NEVER A RANK. Money, people, usage and reliability
 *   get four different edge colours; none of them means "better". The rings
 *   are all one colour for the same reason: a ring encodes progress, and
 *   colouring it by category would put a mint ring beside an amber one and
 *   imply one of them is in better shape.
 *
 *   UNDATED UNLOCKS STAY VISIBLE. A rung whose series cannot prove the day it
 *   was crossed gets a chip below the track rather than a guessed month.
 *   Inventing a date is the one edit here that would turn a record into a
 *   story.
 *
 * Synchronous Server Component.
 */

import type { Achievement, AchievementReport } from '@/lib/analytics/growth-achievements';
import { formatCount, formatMoney, formatPercent } from '../../charts/format';
import { Ring } from './panels';

/** Locked rungs given a ring and a line of prose. The rest become chips. */
const FEATURED = 3;

const MONTH_LABEL = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' });
const MONTH_YEAR_LABEL = new Intl.DateTimeFormat('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });
const DAY_LABEL = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export function Milestones({ report }: { report: AchievementReport }) {
  const featured = report.next.slice(0, FEATURED);
  const later = report.next.slice(FEATURED);
  const months = trackMonths(report.unlocked);
  const undated = report.unlocked.filter((entry) => !entry.unlockedOn);

  return (
    <div className="gb-miles">
      <section>
        <h4 className="gb-miles-label">Closest three</h4>
        {featured.length === 0 ? (
          <p className="kiosk-empty">Every rung on every ladder has been reached.</p>
        ) : (
          <ul className="gb-next">
            {featured.map((badge) => (
              <li key={badge.id}>
                <Ring
                  progress={badge.progress}
                  size={58}
                  center={formatPercent(clampFraction(badge.progress))}
                  label={`${badge.title}: ${formatPercent(clampFraction(badge.progress))} of the way there.`}
                />
                <div>
                  <p className="gb-next-title">{badge.title}</p>
                  <p className="gb-next-detail">{badge.detail}</p>
                  <p className="gb-next-remaining">{remainingLabel(badge)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}

        {later.length > 0 && (
          <details className="gb-drawer">
            <summary>{formatCount(later.length)} further out</summary>
            <ul className="gb-chips">
              {later.map((badge) => (
                <li key={badge.id} title={badge.detail}>
                  <b>{badge.title}</b> {formatPercent(clampFraction(badge.progress))}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section>
        <h4 className="gb-miles-label">
          Reached &middot; {formatCount(report.unlockedCount)} of {formatCount(report.totalCount)}
        </h4>
        {months.length === 0 ? (
          <p className="kiosk-empty">Nothing has been reached with a date behind it yet.</p>
        ) : (
          <div className="gb-track">
            {months.map((month) => (
              <div key={month.key} className={`gb-month${month.items.length > 0 ? ' is-live' : ''}`}>
                <span className="gb-month-rail" aria-hidden="true" />
                <span className="gb-month-name">{month.label}</span>
                {month.items.length === 0 ? (
                  <span className="gb-month-empty">none</span>
                ) : (
                  <ul>
                    {month.items.map((badge) => (
                      <li key={badge.id} className={`gb-mile is-${badge.category}`} title={badge.detail}>
                        <b>{badge.title}</b>
                        <span>{dayLabel(badge.unlockedOn)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}

        {/* A rung whose series cannot prove the day it was crossed. It gets a
            chip below the track rather than a guessed month: inventing a date
            is the one edit here that would turn a record into a story. The
            caveat is stated once, on the heading, rather than repeated on
            every chip. */}
        {undated.length > 0 && (
          <>
            <h4 className="gb-miles-label" style={{ margin: '14px 0 8px' }}>Reached, day unknown</h4>
            <ul className="gb-chips">
              {undated.map((badge) => (
                <li key={badge.id} title={badge.detail}>
                  <b>{badge.title}</b>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

/* ================================================================ helpers */

type TrackMonth = { key: string; label: string; items: Achievement[] };

/**
 * Every calendar month from the first dated unlock to the current one, in
 * order, INCLUDING the months where nothing happened.
 *
 * Skipping the empty ones is the tempting simplification and it is the one
 * that destroys the panel: a track of only busy months is a wrapped chip list
 * again, with the gaps that carry half the meaning silently closed up.
 *
 * A month is labelled with its year only when the track crosses one, so a
 * board that has been running four months does not print "26" eleven times.
 */
function trackMonths(unlocked: Achievement[], now: Date = new Date()): TrackMonth[] {
  const dated = unlocked.filter((entry) => entry.unlockedOn);
  if (dated.length === 0) return [];

  const keys = dated.map((entry) => entry.unlockedOn!.slice(0, 7)).sort();
  const first = keys[0];
  const current = now.toISOString().slice(0, 7);
  const last = current > keys[keys.length - 1] ? current : keys[keys.length - 1];

  const byMonth = new Map<string, Achievement[]>();
  for (const entry of dated) {
    const key = entry.unlockedOn!.slice(0, 7);
    const bucket = byMonth.get(key);
    if (bucket) bucket.push(entry);
    else byMonth.set(key, [entry]);
  }

  const months: TrackMonth[] = [];
  let cursor = first;
  // Bounded by construction, but guarded anyway: a corrupt date that parses to
  // 1970 would otherwise spin this loop for six hundred iterations.
  for (let guard = 0; guard < 120 && cursor <= last; guard += 1) {
    const date = new Date(`${cursor}-01T00:00:00Z`);
    const spansYears = first.slice(0, 4) !== last.slice(0, 4);
    months.push({
      key: cursor,
      label: (spansYears ? MONTH_YEAR_LABEL : MONTH_LABEL).format(date),
      // Oldest first inside a month, so a column reads downward in time like
      // the track reads rightward in time.
      items: (byMonth.get(cursor) ?? []).sort((a, b) => (a.unlockedOn ?? '').localeCompare(b.unlockedOn ?? '')),
    });
    cursor = nextMonth(cursor);
  }
  return months;
}

/** `2026-08` to `2026-09`, and `2026-12` to `2027-01`. */
function nextMonth(key: string): string {
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
}

function dayLabel(day: string | null): string {
  if (!day) return '';
  const date = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? day : DAY_LABEL.format(date);
}

/**
 * The distance still to go, and the pace, when a pace exists.
 *
 * "About N days" is only printed where the ladder could project one; a rung
 * with no recent movement says how far it is and stops, rather than reporting
 * a date derived from a division by zero.
 */
function remainingLabel(badge: Achievement): string {
  const remaining = Math.max(0, badge.target - badge.current);
  // Money ladders are stored in minor units so they can be compared with
  // `mrrMinor` directly, so the distance has to be formatted by the same rule
  // the rung's own title was. Printing it as a count is how a $50 rung came to
  // announce "4,000 to go".
  const distance =
    badge.format.kind === 'money'
      ? `${formatMoney(remaining, badge.format.currency)} to go`
      : `${formatCount(remaining)} to go`;
  return badge.daysToGo === null
    ? `${distance}, no pace to project from`
    : `${distance}, about ${formatCount(badge.daysToGo)} days at this pace`;
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
