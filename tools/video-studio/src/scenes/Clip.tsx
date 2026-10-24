import React from 'react';
import { AbsoluteFill, OffthreadVideo, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { getTheme, type ThemeName } from '../theme';
import { useLayout } from '../layout';
import type { ClipScene } from '../storyboard-types';

/**
 * An external mp4, usually a generated hook shot, filling the frame.
 *
 * The "AI-generated" badge is not optional and has no storyboard key. A clip
 * scene exists for footage this tool did not record from the product, which in
 * practice means a model made it, and a viewer is owed that label on the frame
 * itself, not only in the platform's metadata. If a clip ever is real footage,
 * that is a different scene type with its own provenance, not a flag on this one.
 *
 * The file lives in assets/clips/ (gitignored) and is served through the
 * public/clips symlink. render.mjs checks it exists and is long enough before a
 * frame is drawn.
 */
export const Clip: React.FC<{ scene: ClipScene; themeName: ThemeName }> = ({ scene, themeName }) => {
  const theme = getTheme(themeName);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const layout = useLayout();
  const { content } = layout;

  const captionIn = interpolate(frame, [Math.round(fps * 0.2), Math.round(fps * 0.6)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{ background: '#000' }}>
      <OffthreadVideo
        src={staticFile(scene.src.replace(/^assets\//, ''))}
        startFrom={Math.round(scene.from * fps)}
        muted={scene.muted}
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />

      {scene.caption ? (
        <AbsoluteFill
          style={{
            justifyContent: 'center',
            alignItems: 'center',
            padding: layout.vertical
              ? `${content.top}px ${content.right}px ${content.bottom}px ${content.left}px`
              : '0 200px',
          }}
        >
          <div
            style={{
              opacity: captionIn,
              transform: `translateY(${(1 - captionIn) * 18}px)`,
              background: 'rgba(11,16,32,0.78)',
              color: '#FFFFFF',
              fontFamily: theme.fontSans,
              fontWeight: 600,
              fontSize: layout.vertical ? 64 : 60,
              lineHeight: 1.15,
              letterSpacing: '-0.02em',
              textAlign: 'center',
              padding: '22px 30px',
              borderRadius: 18,
            }}
          >
            {scene.caption}
          </div>
        </AbsoluteFill>
      ) : null}

      <AiBadge layout={layout} fontFamily={theme.fontSans} />
    </AbsoluteFill>
  );
};

/** Top-left, inside the safe area, on every frame of the scene. */
const AiBadge: React.FC<{ layout: ReturnType<typeof useLayout>; fontFamily: string }> = ({ layout, fontFamily }) => (
  <div
    style={{
      position: 'absolute',
      top: layout.vertical ? layout.safe.top + 16 : 32,
      left: layout.vertical ? layout.safe.left : 40,
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      background: 'rgba(11,16,32,0.82)',
      color: '#FFFFFF',
      border: '1px solid rgba(255,255,255,0.28)',
      borderRadius: 999,
      padding: layout.vertical ? '12px 22px' : '9px 18px',
      fontFamily,
      fontWeight: 600,
      fontSize: layout.vertical ? 30 : 22,
      letterSpacing: '0.01em',
    }}
  >
    <svg width={layout.vertical ? 26 : 20} height={layout.vertical ? 26 : 20} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" fill="#FFFFFF" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" fill="#FFFFFF" opacity="0.8" />
    </svg>
    AI-generated
  </div>
);
