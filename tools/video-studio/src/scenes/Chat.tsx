import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { revealCount } from '../components/snap-cn';
import { getTheme, type ThemeName } from '../theme';
import type { ChatScene, Transcript, TranscriptTurn } from '../storyboard-types';

/**
 * A NEUTRAL assistant surface. Read the two rules before editing this file.
 *
 * Rule one, whose UI this is. MCP Emails has no first-party chat surface: it is
 * an MCP server consumed by Claude Desktop, Claude Code, Cursor and others. The
 * obvious move is therefore to draw something that looks like Claude Desktop.
 * Do not. Reproducing another company's interface in our marketing material
 * misrepresents whose product is whose, and it also dates badly the moment they
 * restyle. So: our type, our palette, a generic label, no vendor mark and no
 * vendor chrome. If a cut needs to name a client, the voiceover says "works
 * with Claude, Cursor and any MCP client" as a statement of fact.
 *
 * Rule two, whether it is true. Every turn drawn here comes from
 * transcripts/*.json, which scripts/transcript.mjs produces by running the
 * calls against the real MCP endpoint. render.mjs refuses to render this scene
 * if any turn failed or if the transcript is stale. Nothing in this file
 * invents a tool result, and nothing should be added that can.
 */

const MissingTranscript: React.FC<{ file: string; themeName: ThemeName }> = ({ file, themeName }) => {
  const theme = getTheme(themeName);
  return (
    <AbsoluteFill
      style={{
        background: theme.bgPage,
        color: theme.red,
        fontFamily: theme.fontMono,
        fontSize: 26,
        padding: 120,
        justifyContent: 'center',
        gap: 14,
      }}
    >
      <div>Transcript not loaded: {file}</div>
      <div style={{ color: theme.fg3, fontSize: 20 }}>
        Run: npm run transcript -- --storyboard &lt;id&gt;
      </div>
    </AbsoluteFill>
  );
};

export const Chat: React.FC<{
  scene: ChatScene;
  transcript?: Transcript;
  themeName: ThemeName;
}> = ({ scene, transcript, themeName }) => {
  const theme = getTheme(themeName);
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  if (!transcript) return <MissingTranscript file={scene.transcript} themeName={themeName} />;

  const turns = transcript.turns;

  // Budget the scene across the turns by weight: a user turn types, tool turns
  // are quick beats, the assistant answer needs the most time because it is the
  // payload. Weights are relative, then normalised to the scene length, so the
  // scene always fits exactly the duration the storyboard asked for.
  const weights = turns.map((t) => {
    if (t.role === 'user') return Math.max(2.2, (t.text?.length ?? 0) / 22);
    if (t.role === 'tool') return 1.0;
    return Math.max(4.0, (t.text?.length ?? 0) / 26);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  const usable = durationInFrames - Math.round(fps * 0.4); // leave a beat at the end
  const starts: number[] = [];
  let acc = 0;
  for (const w of weights) {
    starts.push(Math.round((acc / total) * usable));
    acc += w;
  }

  return (
    <AbsoluteFill style={{ background: theme.bgPage, padding: '70px 200px' }}>
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          background: theme.bgSurface,
          border: `1px solid ${theme.border1}`,
          borderRadius: 22,
          boxShadow: theme.shadow3,
          overflow: 'hidden',
        }}
      >
        {/* Generic header. No vendor name, no vendor mark. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: '22px 32px',
            borderBottom: `1px solid ${theme.border1}`,
          }}
        >
          <div
            style={{
              width: 12,
              height: 12,
              borderRadius: 999,
              background: theme.live,
              boxShadow: `0 0 0 5px ${theme.liveSoft}`,
            }}
          />
          <div style={{ fontFamily: theme.fontSans, fontSize: 22, color: theme.fg2, fontWeight: 500 }}>
            {scene.title}
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ fontFamily: theme.fontMono, fontSize: 18, color: theme.fg4 }}>
            MCP Emails
          </div>
        </div>

        <div
          style={{
            flex: 1,
            padding: '36px 44px',
            display: 'flex',
            flexDirection: 'column',
            gap: 22,
            justifyContent: 'flex-end',
          }}
        >
          {turns.map((turn, i) => (
            <Turn
              key={i}
              turn={turn}
              startFrame={starts[i]}
              frame={frame}
              fps={fps}
              theme={theme}
            />
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};

const Turn: React.FC<{
  turn: TranscriptTurn;
  startFrame: number;
  frame: number;
  fps: number;
  theme: ReturnType<typeof getTheme>;
}> = ({ turn, startFrame, frame, fps, theme }) => {
  const local = frame - startFrame;
  if (local < 0) return null;

  const enter = spring({
    frame: local,
    fps,
    config: { damping: 20, stiffness: 200, mass: 0.6 },
    durationInFrames: Math.round(fps * 0.5),
  });
  const lift = { opacity: enter, transform: `translateY(${(1 - enter) * 14}px)` };

  if (turn.role === 'user') {
    const text = turn.text ?? '';
    const count = revealCount(local, fps, text.length, 30);
    return (
      <div style={{ ...lift, display: 'flex', justifyContent: 'flex-end' }}>
        <div
          style={{
            maxWidth: '76%',
            background: theme.brand,
            color: theme.fgOnBrand,
            fontFamily: theme.fontSans,
            fontSize: 30,
            lineHeight: 1.45,
            padding: '20px 28px',
            borderRadius: '20px 20px 6px 20px',
          }}
        >
          {text.slice(0, count)}
          {count < text.length ? (
            <span style={{ opacity: Math.floor(local / (fps / 4)) % 2 === 0 ? 0.9 : 0.2 }}>|</span>
          ) : null}
        </div>
      </div>
    );
  }

  if (turn.role === 'tool') {
    // A tool call is the interesting part: it is the evidence that the model is
    // reaching real mail rather than making something up. Shown as a compact
    // row with the tool's real name, its real arguments and the real outcome.
    const args = turn.args && Object.keys(turn.args).length ? JSON.stringify(turn.args) : '{}';
    return (
      <div style={{ ...lift, display: 'flex', justifyContent: 'flex-start' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            background: theme.bgSunken,
            border: `1px solid ${theme.border1}`,
            borderRadius: 12,
            padding: '14px 20px',
            fontFamily: theme.fontMono,
            fontSize: 22,
            color: theme.fg2,
          }}
        >
          <Check color={turn.ok === false ? theme.red : theme.live} />
          <span style={{ color: theme.fg1 }}>{turn.name}</span>
          <span style={{ color: theme.fg4 }}>{args}</span>
          {turn.summary ? (
            <>
              <span style={{ color: theme.fg4 }}>{'→'}</span>
              <span style={{ color: theme.fg2 }}>{turn.summary}</span>
            </>
          ) : null}
        </div>
      </div>
    );
  }

  // Assistant. Streams in word by word: a wall of text appearing at once reads
  // as a screenshot, and the streaming is what makes it read as a live answer.
  const text = turn.text ?? '';
  const words = text.split(' ');
  const perWord = Math.max(1, Math.round(fps / 9));
  return (
    <div style={{ ...lift, display: 'flex', justifyContent: 'flex-start' }}>
      <div
        style={{
          maxWidth: '84%',
          background: theme.bgSunken,
          border: `1px solid ${theme.border1}`,
          color: theme.fg1,
          fontFamily: theme.fontSans,
          fontSize: 30,
          lineHeight: 1.5,
          padding: '22px 30px',
          borderRadius: '20px 20px 20px 6px',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0 0.28em',
        }}
      >
        {words.map((w, i) => {
          const o = interpolate(local, [i * perWord, i * perWord + perWord], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });
          return (
            <span key={i} style={{ opacity: o }}>
              {w}
            </span>
          );
        })}
      </div>
    </div>
  );
};

const Check: React.FC<{ color: string }> = ({ color }) => (
  <svg width={20} height={20} viewBox="0 0 24 24" fill="none" aria-hidden>
    <circle cx="12" cy="12" r="9" stroke={color} strokeWidth="2" />
    <path d="M8.2 12.3l2.6 2.6 5-5.2" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
