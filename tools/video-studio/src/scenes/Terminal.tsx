import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { revealCount } from '../components/snap-cn';
import { getTheme, type ThemeName } from '../theme';
import type { TerminalScene } from '../storyboard-types';

/**
 * A terminal simulator, for the install beat.
 *
 * Lines beginning with "$ " are treated as typed input and reveal character by
 * character; everything else is output and appears whole, the way a real
 * terminal behaves. A cursor block sits on the line currently being typed.
 *
 * This is drawn, not captured. That is honest for a terminal in a way it would
 * not be for the product UI, because the command shown here is the documented
 * install command and the output is the literal string the CLI prints. If a
 * storyboard ever wants to show real, variable terminal output, capture it with
 * vhs instead of inventing it here.
 */
export const Terminal: React.FC<{ scene: TerminalScene; themeName: ThemeName }> = ({
  scene,
  themeName,
}) => {
  const theme = getTheme(themeName);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Walk the lines, spending frames on each: typed lines cost their length at
  // `cps`, output lines cost a short beat.
  const OUTPUT_BEAT = Math.round(fps * 0.28);
  let spent = 0;
  const rendered = scene.lines.map((line) => {
    const isInput = line.startsWith('$ ');
    const local = frame - spent;

    if (isInput) {
      const body = line.slice(2);
      const cost = Math.max(1, Math.round((body.length / scene.cps) * fps));
      const count = local <= 0 ? 0 : revealCount(local, fps, body.length, scene.cps);
      spent += cost + Math.round(fps * 0.35); // a beat before the output
      return { kind: 'input' as const, text: body.slice(0, count), visible: local > 0, typing: count < body.length && local > 0 };
    }

    const visible = local > 0;
    spent += OUTPUT_BEAT;
    return { kind: 'output' as const, text: line, visible, typing: false };
  });

  const windowIn = interpolate(frame, [0, Math.round(fps * 0.45)], [0.97, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        background: theme.bgPage,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 120,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 1420,
          borderRadius: 16,
          overflow: 'hidden',
          background: theme.bgSunken,
          border: `1px solid ${theme.border1}`,
          boxShadow: theme.shadow4,
          transform: `scale(${windowIn})`,
        }}
      >
        <div
          style={{
            height: 54,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '0 20px',
            background: theme.bgSurface,
            borderBottom: `1px solid ${theme.border1}`,
          }}
        >
          {[theme.red, theme.amber, theme.live].map((c) => (
            <div key={c} style={{ width: 13, height: 13, borderRadius: 999, background: c, opacity: 0.85 }} />
          ))}
          <div
            style={{
              marginLeft: 14,
              fontFamily: theme.fontSans,
              fontSize: 16,
              color: theme.fg3,
            }}
          >
            {scene.title}
          </div>
        </div>

        <div
          style={{
            padding: '34px 40px 44px',
            fontFamily: theme.fontMono,
            fontSize: 27,
            lineHeight: 1.65,
            color: theme.fg2,
            minHeight: 340,
            // Several mono faces ligate "--" into a single long dash. On a
            // command line that is not a cosmetic issue: it makes a flag look
            // like an em dash, and anyone retyping what they see gets it wrong.
            fontVariantLigatures: 'none',
          }}
        >
          {rendered.map((line, i) =>
            !line.visible ? null : (
              <div key={i} style={{ whiteSpace: 'pre-wrap' }}>
                {line.kind === 'input' ? (
                  <>
                    <span style={{ color: theme.live, marginRight: 12 }}>$</span>
                    <span style={{ color: theme.fg1 }}>{line.text}</span>
                    {line.typing ? (
                      <span
                        style={{
                          display: 'inline-block',
                          width: '0.58em',
                          height: '1.05em',
                          marginLeft: 2,
                          verticalAlign: '-0.16em',
                          background: theme.brand,
                          // Blink on a 2 Hz cadence, quantised to frames so it
                          // is identical on every render.
                          opacity: Math.floor(frame / (fps / 4)) % 2 === 0 ? 1 : 0.15,
                        }}
                      />
                    ) : null}
                  </>
                ) : (
                  <span style={{ color: theme.fg3 }}>{line.text}</span>
                )}
              </div>
            ),
          )}
        </div>
      </div>
    </AbsoluteFill>
  );
};
