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
import { Chat } from './scenes/Chat';
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
  let cursor = 0;

  return (
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

      {storyboard.captions ? (
        <BurnedInCaptions storyboardId={storyboard.id} themeName={storyboard.theme} />
      ) : null}
    </AbsoluteFill>
  );
};

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
    default: {
      // Exhaustiveness: adding a scene type to the schema without adding it
      // here becomes a compile error rather than a blank scene.
      const never: never = scene;
      return <MissingStoryboard reason={`Unhandled scene type: ${JSON.stringify(never)}`} />;
    }
  }
};
