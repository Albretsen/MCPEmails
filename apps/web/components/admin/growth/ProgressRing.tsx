/**
 * ProgressRing.tsx: a small circular "how far along" indicator.
 *
 * WHY it renders BARE, with no card of its own: it is never the subject of a
 * card. It sits inside one, next to the thing it describes (see BadgeGrid),
 * and a component that wrapped itself in .ac-card could not be used there. The
 * shared card shells in this kit are for components that own a whole panel.
 *
 * WHY a ring rather than the horizontal bar ProgressMeter already provides:
 * ProgressMeter is for a hard cliff you are approaching, so it is wide, it
 * prints headroom in plain counts and it changes colour at thresholds. This is
 * for a target you are walking toward, where the only question is "how close",
 * and the answer has to fit beside three lines of text in a dense grid. A
 * 56px bar would be unreadable; a 56px ring is not.
 *
 * The two ends of the range are the ones that break naive dash arithmetic, so
 * both are handled explicitly: at 0 no arc element is emitted at all (a
 * zero-length dash still renders a cap and shows as a stray dot), and at 1 the
 * gap is zero, which closes the ring properly instead of leaving a hairline.
 *
 * Synchronous Server Component. The percentage is announced through <title>.
 */

import type { ReactNode } from 'react';
import { STATUS_COLORS, clamp } from '../charts';

export type ProgressRingProps = {
  /** 0..1. Clamped defensively, since callers derive it from live counts. */
  progress: number;
  /** Pixel diameter. Default 56. */
  size?: number;
  /** About four characters. Anything longer will not fit the hole. */
  center?: ReactNode;
  tone?: 'brand' | 'good' | 'warn' | 'bad';
  /** Full sentence for screen readers, for example "100 signups: 62% there". */
  label: string;
};

const TONE_COLORS = {
  brand: 'var(--brand)',
  good: STATUS_COLORS.ok,
  warn: STATUS_COLORS.warn,
  bad: STATUS_COLORS.danger,
} as const;

export function ProgressRing({ progress, size = 56, center, tone = 'brand', label }: ProgressRingProps) {
  const diameter = Number.isFinite(size) && size > 0 ? size : 56;
  const fraction = clamp(Number.isFinite(progress) ? progress : 0, 0, 1);

  // Stroke scales with the ring so a 40px and a 96px ring look like the same
  // object, with a floor so the small end does not thin out to a hairline.
  const stroke = Math.max(4, Math.round(diameter * 0.11));
  const radius = (diameter - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const length = fraction * circumference;
  const middle = diameter / 2;

  return (
    <span className="bd-ring" style={{ width: diameter, height: diameter }}>
      <svg
        className="bd-ring-svg"
        viewBox={`0 0 ${diameter} ${diameter}`}
        width={diameter}
        height={diameter}
        role="img"
        aria-label={label}
      >
        <title>{label}</title>
        <circle
          className="bd-ring-track"
          cx={middle}
          cy={middle}
          r={radius}
          fill="none"
          strokeWidth={stroke}
        />
        {length > 0 ? (
          /* The -90 degree rotation is what makes the arc start at twelve
             o'clock. SVG angles start at three o'clock, and a progress dial
             that begins on the right reads as though it is already a quarter
             of the way round. */
          <circle
            className="bd-ring-arc"
            cx={middle}
            cy={middle}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            stroke={TONE_COLORS[tone]}
            strokeDasharray={`${length.toFixed(3)} ${Math.max(0, circumference - length).toFixed(3)}`}
            transform={`rotate(-90 ${middle} ${middle})`}
          />
        ) : null}
      </svg>
      {center ? (
        <span className="bd-ring-center" aria-hidden="true">
          {center}
        </span>
      ) : null}
    </span>
  );
}

export default ProgressRing;
