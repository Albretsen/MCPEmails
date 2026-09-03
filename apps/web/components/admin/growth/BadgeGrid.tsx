/**
 * BadgeGrid.tsx: the milestone board. What has been reached, and what is next.
 *
 * WHY the card has two visually different halves: they answer different
 * questions and deserve different weight. The NEXT few milestones are the only
 * part that can change what anyone does this week, so they get rings, room and
 * a distance-to-go line. The ones already reached are history, so they
 * compress into a dense strip of pills where the DATE is the payload: "100
 * signups, 14 Aug" is a fact about how fast this is moving, and it is worth
 * keeping precisely because it is small.
 *
 * WHY this is not styled like a game: the obvious version of a badge board is
 * trophies, tiers and glow. It was rejected outright. A founder checking the
 * board is trying to read a rate of change, and reward furniture makes a
 * milestone feel earned rather than measured, which is exactly the wrong
 * feeling when the honest read might be "the last three took twice as long as
 * the three before". No trophies, no stars, no points, no rarity language, no
 * animation. A pill is a rounded rectangle with a colour and a date.
 *
 * WHY tone tints the pill BACKGROUND and never the text: --mint-500,
 * --amber-500 and --red-500 land near 2:1 on the page and are unreadable as
 * 12px type. Mixed into transparent at a low percentage they make a perfectly
 * legible tinted chip, with the label staying on the page's own foreground.
 *
 * Every ring is 'brand' regardless of the badge's tone. The ring encodes
 * progress, not category; colouring it by category would put a mint ring and
 * an amber ring side by side and imply one of them is in better shape.
 *
 * Synchronous Server Component.
 */

import { ChartFrame, formatPercent } from '../charts';
import { ProgressRing } from './ProgressRing';

export type Badge = {
  id: string;
  /** The milestone itself, for example "$50 MRR" or "100 signups". */
  title: string;
  /** One short clause saying what it measures. */
  detail: string;
  unlocked: boolean;
  /** Already formatted by the caller, for example "14 Aug 2026". */
  achievedLabel: string | null;
  /** 0..1. Only meaningful for locked badges. */
  progress: number;
  /** For example "161 to go, about 45 days". */
  remainingLabel?: string | null;
  tone?: 'money' | 'people' | 'usage' | 'reliability';
};

export type BadgeGridProps = {
  title: string;
  subtitle?: string;
  unlocked: Badge[];
  /** Already sorted closest-first by the caller. */
  next: Badge[];
  /** Locked badges given a ring instead of a pill. Default 3. */
  featured?: number;
  footnote?: string;
};

const DEFAULT_FEATURED = 3;

function toneClass(tone: Badge['tone']): string {
  return `bd-tone-${tone ?? 'people'}`;
}

function ringLabel(badge: Badge): string {
  const percent = formatPercent(Math.min(1, Math.max(0, badge.progress)));
  return `${badge.title}: ${percent} of the way there.`;
}

export function BadgeGrid({
  title,
  subtitle,
  unlocked,
  next,
  featured = DEFAULT_FEATURED,
  footnote,
}: BadgeGridProps) {
  const count = Math.max(0, Math.floor(featured));
  const highlighted = next.slice(0, count);
  const remainingLocked = next.slice(count);

  if (unlocked.length === 0 && next.length === 0) {
    return (
      <ChartFrame title={title} subtitle={subtitle} footnote={footnote}>
        <p className="ac-empty">No milestones configured.</p>
      </ChartFrame>
    );
  }

  return (
    <ChartFrame title={title} subtitle={subtitle} footnote={footnote}>
      <div className="bd-badges">
        {highlighted.length > 0 ? (
          <section>
            <h4 className="bd-badges-label">Next up</h4>
            <ul className="bd-badges-next">
              {highlighted.map((badge) => (
                <li className="bd-badges-next-item" key={badge.id}>
                  <ProgressRing
                    progress={badge.progress}
                    size={56}
                    tone="brand"
                    label={ringLabel(badge)}
                    center={formatPercent(Math.min(1, Math.max(0, badge.progress)))}
                  />
                  <div className="bd-badges-next-body">
                    <p className="bd-badges-next-title">{badge.title}</p>
                    <p className="bd-badges-next-detail">{badge.detail}</p>
                    {badge.remainingLabel ? (
                      <p className="bd-badges-next-remaining">{badge.remainingLabel}</p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {unlocked.length > 0 ? (
          <section>
            <h4 className="bd-badges-label">{`Reached (${unlocked.length})`}</h4>
            <ul className="bd-badges-pills">
              {unlocked.map((badge) => (
                <li className={`bd-badge-pill ${toneClass(badge.tone)}`} key={badge.id} title={badge.detail}>
                  <span className="bd-badge-pill-title">{badge.title}</span>
                  {badge.achievedLabel ? (
                    <span className="bd-badge-pill-date">{badge.achievedLabel}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {remainingLocked.length > 0 ? (
          <section>
            <h4 className="bd-badges-label">{`Later (${remainingLocked.length})`}</h4>
            <ul className="bd-badges-pills">
              {remainingLocked.map((badge) => (
                <li className="bd-badge-pill bd-badge-pill-locked" key={badge.id} title={badge.detail}>
                  <span className="bd-badge-pill-title">{badge.title}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </ChartFrame>
  );
}

export default BadgeGrid;
