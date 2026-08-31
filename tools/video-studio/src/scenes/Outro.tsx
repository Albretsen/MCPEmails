import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { easings } from '../components/snap-cn';
import { getTheme, type ThemeName } from '../theme';
import type { OutroScene } from '../storyboard-types';

/** The envelope from the product mark, drawn rather than loaded, so the outro
 *  has no asset dependency and cannot render as a broken image. */
const Mark: React.FC<{ color: string; size: number }> = ({ color, size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <rect x="2" y="5" width="20" height="14" rx="3" stroke={color} strokeWidth="1.8" />
    <path d="M3 7.5l8.2 5.4a1.5 1.5 0 0 0 1.6 0L21 7.5" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

export const Outro: React.FC<{ scene: OutroScene; themeName: ThemeName }> = ({
  scene,
  themeName,
}) => {
  const theme = getTheme(themeName);
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const enter = spring({
    frame,
    fps,
    config: { damping: 16, stiffness: 140, mass: 0.9 },
    durationInFrames: Math.round(fps * 1.0),
  });

  const ctaOpacity = interpolate(frame, [Math.round(fps * 0.5), Math.round(fps * 1.1)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Fade the last third of a second to black so the file does not end on a
  // hard frame. verify's blackdetect uses d=0.4, so keep this under that.
  const tail = Math.round(fps * 0.33);
  const fadeOut = interpolate(frame, [durationInFrames - tail, durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: easings.in,
  });

  return (
    <AbsoluteFill
      style={{
        background: theme.bgPage,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: fadeOut,
      }}
    >
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at 50% 46%, ${theme.brandSoft} 0%, transparent 58%)`,
        }}
      />

      <div
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          transform: `scale(${0.94 + enter * 0.06})`,
          opacity: enter,
        }}
      >
        <div
          style={{
            width: 108,
            height: 108,
            borderRadius: 26,
            background: theme.bgSurface,
            border: `1px solid ${theme.border1}`,
            boxShadow: theme.shadow4,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 44,
          }}
        >
          <Mark color={theme.brand} size={54} />
        </div>

        <div
          style={{
            fontFamily: theme.fontSans,
            fontWeight: 600,
            fontSize: 76,
            letterSpacing: '-0.03em',
            color: theme.fg1,
            opacity: ctaOpacity,
          }}
        >
          {scene.cta}
        </div>

        {scene.sub ? (
          <div
            style={{
              marginTop: 22,
              fontFamily: theme.fontSans,
              fontSize: 30,
              color: theme.fg3,
              opacity: ctaOpacity,
            }}
          >
            {scene.sub}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
