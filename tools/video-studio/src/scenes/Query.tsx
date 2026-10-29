import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { revealCount } from '../components/snap-cn';
import { getTheme, type ThemeName } from '../theme';
import { useLayout } from '../layout';
import type { QueryPlatform, QueryScene } from '../storyboard-types';

/**
 * The question a real person asked, paraphrased, and where they asked it.
 *
 * Paraphrased because the original belongs to its author: the card never
 * shows a username, a link or a verbatim quote, and the validator rejects a
 * question containing a handle, an address or a URL. The "Paraphrased" tag is
 * drawn on every card so the viewer is not led to read it as a quote. The
 * source URL travels to out/<id>.post.json for the person who publishes, and
 * never onto the frame.
 *
 * Platform names are text, not logos: reproducing another company's mark is
 * the same problem the chat scene avoids by not drawing a vendor's UI.
 */

// Mirrors QUERY_PLATFORMS in src/storyboard-schema.mjs.
const PLATFORM_NAMES: Record<QueryPlatform, string> = {
  reddit: 'Reddit',
  x: 'X',
  'hacker-news': 'Hacker News',
  'stack-overflow': 'Stack Overflow',
  github: 'GitHub',
  discord: 'Discord',
  forum: 'a forum',
  quora: 'Quora',
};

export const Query: React.FC<{ scene: QueryScene; themeName: ThemeName }> = ({ scene, themeName }) => {
  const theme = getTheme(themeName);
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const layout = useLayout();
  const { content } = layout;

  const enter = spring({
    frame,
    fps,
    config: { damping: 18, stiffness: 180, mass: 0.8 },
    durationInFrames: Math.round(fps * 0.7),
  });

  // The question types in over the first 55% of the scene, then holds to be
  // read. Typing keeps the frame moving, which freezedetect needs, and reads
  // as someone asking rather than a slide.
  const typeFrames = Math.max(1, Math.round(durationInFrames * 0.55));
  const startTyping = Math.round(fps * 0.35);
  const cps = (scene.question.length / typeFrames) * fps;
  const shown = frame < startTyping ? 0 : revealCount(frame - startTyping, fps, scene.question.length, cps);

  const exit = interpolate(frame, [durationInFrames - Math.round(fps * 0.4), durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const lead = scene.lead ?? `Someone asked on ${PLATFORM_NAMES[scene.platform]}`;

  return (
    <AbsoluteFill
      style={{
        background: theme.bgPage,
        justifyContent: 'center',
        alignItems: 'center',
        padding: layout.vertical
          ? `${content.top}px ${content.right}px ${content.bottom}px ${content.left}px`
          : '0 240px',
      }}
    >
      <AbsoluteFill
        style={{
          backgroundImage: `radial-gradient(${theme.fg4}22 1px, transparent 1px)`,
          backgroundSize: '32px 32px',
          opacity: 0.7,
        }}
      />

      <div
        style={{
          position: 'relative',
          width: '100%',
          opacity: enter * exit,
          transform: `translateY(${(1 - enter) * 30}px) scale(${0.97 + enter * 0.03})`,
          background: theme.bgSurface,
          border: `1px solid ${theme.border1}`,
          borderRadius: 26,
          boxShadow: theme.shadow4,
          padding: layout.vertical ? '40px 40px 44px' : '44px 56px 50px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div
            style={{
              fontFamily: theme.fontSans,
              fontSize: layout.vertical ? 32 : 26,
              fontWeight: 500,
              color: theme.fg3,
            }}
          >
            {lead}
          </div>
          <div
            style={{
              fontFamily: theme.fontSans,
              fontSize: layout.vertical ? 24 : 18,
              fontWeight: 600,
              color: theme.brand,
              background: theme.brandSoft,
              borderRadius: 999,
              padding: '6px 14px',
              letterSpacing: '0.02em',
            }}
          >
            Paraphrased
          </div>
        </div>

        <div
          style={{
            marginTop: 28,
            fontFamily: theme.fontSans,
            fontWeight: 600,
            fontSize: layout.vertical ? 58 : 54,
            lineHeight: 1.22,
            letterSpacing: '-0.02em',
            color: theme.fg1,
            // Reserve the full height from the first frame, so the card does
            // not grow line by line while the question types in.
            position: 'relative',
          }}
        >
          <span style={{ visibility: 'hidden' }}>{scene.question}</span>
          <span style={{ position: 'absolute', inset: 0 }}>
            {scene.question.slice(0, shown)}
            {shown < scene.question.length && frame >= startTyping ? (
              <span style={{ color: theme.brand, opacity: Math.floor(frame / (fps / 4)) % 2 === 0 ? 1 : 0.2 }}>|</span>
            ) : null}
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};
