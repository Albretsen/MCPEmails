/**
 * Maps a validated storyboard onto scene components, in order.
 *
 * This is the only place that knows the scene-type-to-component mapping, and
 * the only place frames are laid end to end. Scenes themselves are written as
 * if they start at frame 0.
 */

import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion';
import { getTheme } from './theme';
import type { Scene, StoryboardProps } from './storyboard-types';
import { Title } from './scenes/Title';
import { Capture } from './scenes/Capture';
import { Chat, chatSchedule } from './scenes/Chat';
import { Clip } from './scenes/Clip';
import { Query } from './scenes/Query';
import { Timer } from './components/Timer';
import { LayoutProvider, computeLayout } from './layout';
import { Terminal } from './scenes/Terminal';
import { Outro } from './scenes/Outro';
import { BurnedInCaptions } from './components/Captions';

const MissingStoryboard: React.FC<{ reason: string }> = ({ reason }) => (
  <AbsoluteFill
    style={{
      background: '#0B1020',
      color: '#E5484D',
      fontFamily: 'ui-monospace, Menlo, monospace',
      fontSize: 28,
      padding: 80,
      justifyContent: 'center',
    }}
  >
    <div>Storyboard not resolved.</div>
    <div style={{ color: '#8389A6', fontSize: 20, marginTop: 16 }}>{reason}</div>
  </AbsoluteFill>
);

export const StoryboardComposition: React.FC<StoryboardProps> = ({
  storyboard,
  timelines,
  transcripts,
}) => {
  if (!storyboard) {
    // Only reachable if calculateMetadata was bypassed. Better a legible frame
    // than a white screen that verify would report as "black frame detected".
    return <MissingStoryboard reason="calculateMetadata did not run. Render through scripts/render.mjs." />;
  }

  const theme = getTheme(storyboard.theme);
  const layout = computeLayout({
    format: storyboard.format ?? 'landscape',
    width: storyboard.width,
    height: storyboard.height,
    captions: storyboard.captions,
    timer: Boolean(storyboard.timer),
  });
  const timer = storyboard.timer ? timerFrames(storyboard, transcripts) : null;
  let cursor = 0;

  return (
    <LayoutProvider value={layout}>
    <AbsoluteFill style={{ background: theme.bgPage }}>
      {storyboard.scenes.map((scene, i) => {
        const from = cursor;
        cursor += scene.durationInFrames;
        return (
          <Sequence
            key={i}
            from={from}
            durationInFrames={scene.durationInFrames}
            // Named so the Studio timeline reads as the storyboard does.
            name={`${i}: ${scene.type}`}
          >
            <SceneSwitch
              scene={scene}
              timelines={timelines}
              transcripts={transcripts}
              themeName={storyboard.theme}
            />
          </Sequence>
        );
      })}

      {storyboard.voiceover ? (
        <Audio src={staticFile(voiceoverStaticPath(storyboard.voiceover))} />
      ) : null}

      {timer ? (
        <Timer
          startFrame={timer.startFrame}
          stopFrame={timer.stopFrame}
          endFrame={timer.endFrame}
          label={storyboard.timer?.label}
          themeName={storyboard.theme}
        />
      ) : null}

      {storyboard.captions ? (
        <BurnedInCaptions storyboardId={storyboard.id} themeName={storyboard.theme} />
      ) : null}
    </AbsoluteFill>
    </LayoutProvider>
  );
};

/**
 * Where the stopwatch starts, stops and disappears, in composition frames.
 * It stops on the frame a chat scene's answer finishes arriving, which is the
 * moment the viewer has their answer; for any other stop scene, at its end.
 */
function timerFrames(
  storyboard: NonNullable<StoryboardProps['storyboard']>,
  transcripts: StoryboardProps['transcripts'],
): { startFrame: number; stopFrame: number; endFrame: number } {
  const spec = storyboard.timer!;
  const start = storyboard.boundaries[spec.from];
  const stop = storyboard.boundaries[spec.to];
  const stopScene = storyboard.scenes[spec.to];
  let stopFrame = stop.endFrame;
  if (stopScene.type === 'chat') {
    const t = transcripts[stopScene.transcript];
    if (t) stopFrame = stop.startFrame + chatSchedule(t.turns, stopScene.durationInFrames, storyboard.fps).answerDoneFrame;
  }
  return { startFrame: start.startFrame, stopFrame, endFrame: stop.endFrame };
}

/**
 * A storyboard writes its voiceover as a repo-relative path
 * ("assets/vo/x.mp3") because that is where the file actually lives. Remotion
 * serves assets/vo through the public/vo symlink, so translate.
 */
function voiceoverStaticPath(authored: string): string {
  return authored.replace(/^\.?\/?assets\/vo\//, 'vo/');
}

const SceneSwitch: React.FC<{
  scene: Scene;
  timelines: StoryboardProps['timelines'];
  transcripts: StoryboardProps['transcripts'];
  themeName: 'dark' | 'light';
}> = ({ scene, timelines, transcripts, themeName }) => {
  switch (scene.type) {
    case 'title':
      return <Title scene={scene} themeName={themeName} />;
    case 'capture':
      return <Capture scene={scene} timeline={timelines[scene.shot]} themeName={themeName} />;
    case 'chat':
      return <Chat scene={scene} transcript={transcripts[scene.transcript]} themeName={themeName} />;
    case 'terminal':
      return <Terminal scene={scene} themeName={themeName} />;
    case 'outro':
      return <Outro scene={scene} themeName={themeName} />;
    case 'clip':
      return <Clip scene={scene} themeName={themeName} />;
    case 'query':
      return <Query scene={scene} themeName={themeName} />;
    default: {
      // Exhaustiveness: adding a scene type to the schema without adding it
      // here becomes a compile error rather than a blank scene.
      const never: never = scene;
      return <MissingStoryboard reason={`Unhandled scene type: ${JSON.stringify(never)}`} />;
    }
  }
};
