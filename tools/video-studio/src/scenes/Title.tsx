import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { easings } from '../components/snap-cn';
import { getTheme, type ThemeName } from '../theme';
import type { TitleScene } from '../storyboard-types';

/**
 * A title card. Headline lifts in word by word, rule draws under it, sub
 * fades. The last half second eases the whole block up slightly so the cut to
 * the next scene has somewhere to go, rather than landing on a static frame.
 */
export const Title: React.FC<{ scene: TitleScene; themeName: ThemeName }> = ({
  scene,
  themeName,
}) => {
  const theme = getTheme(themeName);
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const words = scene.headline.split(' ');
  const outStart = durationInFrames - Math.round(fps * 0.5);
  const exit = interpolate(frame, [outStart, durationInFrames], [0, -28], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: easings.in,
  });
  const exitFade = interpolate(frame, [outStart, durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const ruleWidth = interpolate(frame, [Math.round(fps * 0.45), Math.round(fps * 1.1)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: easings.inOut,
  });

  const subOpacity = interpolate(frame, [Math.round(fps * 0.8), Math.round(fps * 1.4)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        background: theme.bgPage,
        alignItems: scene.align === 'left' ? 'flex-start' : 'center',
        justifyContent: 'center',
        padding: '0 160px',
        textAlign: scene.align === 'left' ? 'left' : 'center',
      }}
    >
      {/* The same faint dot grid the marketing hero uses, so a title card and
          the product it introduces read as one surface. */}
      <AbsoluteFill
        style={{
          backgroundImage: `radial-gradient(${theme.fg4}22 1px, transparent 1px)`,
          backgroundSize: '32px 32px',
          opacity: 0.7,
        }}
      />

      <div style={{ transform: `translateY(${exit}px)`, opacity: exitFade, position: 'relative' }}>
        <h1
          style={{
            margin: 0,
            fontFamily: theme.fontSans,
            fontWeight: 600,
            fontSize: 96,
            lineHeight: 1.06,
            letterSpacing: '-0.03em',
            color: theme.fg1,
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0 0.28em',
            justifyContent: scene.align === 'left' ? 'flex-start' : 'center',
          }}
        >
          {words.map((word, i) => {
            // Each word gets its own spring, staggered. Springs rather than a
            // linear fade because a title that arrives with no weight reads as
            // a slide deck, not a film.
            const s = spring({
              frame: frame - i * 3,
              fps,
              config: { damping: 18, stiffness: 220, mass: 0.7 },
              durationInFrames: Math.round(fps * 0.8),
            });
            return (
              <span
                key={i}
                style={{
                  display: 'inline-block',
                  opacity: s,
                  transform: `translateY(${(1 - s) * 26}px)`,
                }}
              >
                {word}
              </span>
            );
          })}
        </h1>

        <div
          style={{
            height: 3,
            marginTop: 34,
            background: theme.brand,
            borderRadius: 2,
            width: `${ruleWidth * 100}%`,
            maxWidth: 220,
            marginLeft: scene.align === 'left' ? 0 : 'auto',
            marginRight: scene.align === 'left' ? 0 : 'auto',
          }}
        />

        {scene.sub ? (
          <p
            style={{
              margin: '34px 0 0',
              fontFamily: theme.fontSans,
              fontWeight: 400,
              fontSize: 34,
              lineHeight: 1.45,
              color: theme.fg3,
              opacity: subOpacity,
              maxWidth: 1100,
              marginLeft: scene.align === 'left' ? 0 : 'auto',
              marginRight: scene.align === 'left' ? 0 : 'auto',
            }}
          >
            {scene.sub}
          </p>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
