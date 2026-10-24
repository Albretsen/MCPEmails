import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { getTheme, type ThemeName } from '../theme';
import { useLayout } from '../layout';

/**
 * A stopwatch drawn over a run of scenes: the "speedrun" clock.
 *
 * What it counts, stated plainly because a caption will be tempted to quote
 * it: the VIDEO's own clock, from the first frame of the start scene to the
 * frame the answer finishes arriving (or the end of the stop scene, when that
 * is not a chat). It is not the server's latency. The real round trip of each
 * call is recorded per tool turn as `ms` in the transcript; quote that if you
 * want a number about the product.
 *
 * Mounted once in Storyboard.tsx, outside the scene Sequences, so it runs
 * continuously across cuts instead of restarting with each scene.
 */
export const Timer: React.FC<{
  startFrame: number;
  stopFrame: number;
  endFrame: number;
  label?: string;
  themeName: ThemeName;
}> = ({ startFrame, stopFrame, endFrame, label, themeName }) => {
  const theme = getTheme(themeName);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const layout = useLayout();

  if (frame < startFrame || frame >= endFrame) return null;

  const local = frame - startFrame;
  const elapsed = (Math.min(frame, stopFrame) - startFrame) / fps;
  const stopped = frame >= stopFrame;

  const enter = spring({ frame: local, fps, config: { damping: 18, stiffness: 220 }, durationInFrames: Math.round(fps * 0.4) });
  const pop = stopped
    ? interpolate(frame - stopFrame, [0, Math.round(fps * 0.12), Math.round(fps * 0.35)], [1, 1.08, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : 1;

  const minutes = Math.floor(elapsed / 60);
  const secs = elapsed - minutes * 60;
  const text = `${minutes}:${secs.toFixed(1).padStart(4, '0')}`;
  const accent = stopped ? theme.live : theme.brand;

  const size = layout.vertical ? 1 : 0.72;

  return (
    <div
      style={{
        position: 'absolute',
        top: layout.vertical ? layout.timerBand.top + 12 : layout.timerBand.top,
        // Vertical: centred on the safe column. Landscape: the top-right
        // corner, in the gap above the chat card.
        ...(layout.vertical
          ? { left: layout.safe.left, right: layout.safe.right, display: 'flex', justifyContent: 'center' }
          : { right: 28 }),
        opacity: enter,
        transform: `translateY(${(1 - enter) * -16}px)`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14 * size,
          background: theme.overlay,
          border: `2px solid ${accent}`,
          borderRadius: 999,
          padding: `${12 * size}px ${26 * size}px`,
          boxShadow: theme.shadow3,
          transform: `scale(${pop})`,
        }}
      >
        <svg width={36 * size} height={36 * size} viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="13.5" r="7.5" stroke={accent} strokeWidth="2" />
          <path d="M10 2.5h4M12 2.5v3.5" stroke={accent} strokeWidth="2" strokeLinecap="round" />
          <path
            d={`M12 13.5 L${12 + 5 * Math.sin((elapsed % 60) / 60 * Math.PI * 2 * 12)} ${13.5 - 5 * Math.cos((elapsed % 60) / 60 * Math.PI * 2 * 12)}`}
            stroke={accent}
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
        {label ? (
          <span style={{ fontFamily: theme.fontSans, fontWeight: 500, fontSize: 30 * size, color: theme.fg2 }}>{label}</span>
        ) : null}
        <span
          style={{
            fontFamily: theme.fontMono,
            fontWeight: 600,
            fontSize: 40 * size,
            color: theme.overlayFg,
            fontVariantNumeric: 'tabular-nums',
            minWidth: `${text.length * 0.62}em`,
          }}
        >
          {text}
        </span>
      </div>
    </div>
  );
};
