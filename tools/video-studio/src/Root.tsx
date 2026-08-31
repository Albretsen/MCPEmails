/**
 * Registers one composition per file in storyboards/.
 *
 * The list is discovered with require.context rather than hand-maintained,
 * because the tool's promise is that a new video costs one JSON file and three
 * commands. Adding an import line here would quietly break that.
 *
 * Duration, size and fps all come from the storyboard through
 * calculateMetadata, so a composition is never out of step with the JSON that
 * defines it.
 */

import React from 'react';
import { Composition } from 'remotion';
// Plain .mjs, deliberately not TypeScript: the node scripts and this bundle
// both load it, and `node` will not run .ts without a loader. Typed here by
// hand rather than left as `any`.
import { validateStoryboard as validateStoryboardUntyped } from './storyboard-schema.mjs';

import { StoryboardComposition } from './Storyboard';
import type { Storyboard, StoryboardProps } from './storyboard-types';

const validateStoryboard = validateStoryboardUntyped as unknown as (
  raw: unknown,
  captureDurations: Record<string, number>,
) => Storyboard;

// webpack API, provided by Remotion's bundler.
declare const require: {
  context: (
    dir: string,
    useSubdirectories: boolean,
    regExp: RegExp,
  ) => { keys: () => string[]; (id: string): unknown };
};

function discoverStoryboards(): { id: string; raw: unknown }[] {
  const ctx = require.context('../storyboards', false, /\.json$/);
  return ctx
    .keys()
    .sort()
    .map((key) => ({
      id: key.replace(/^\.\//, '').replace(/\.json$/, ''),
      raw: ctx(key),
    }));
}

/**
 * Studio has no inputProps, so a capture scene that derives its length from a
 * recording cannot be measured. Rather than refuse to register the composition
 * (which would make the Studio useless precisely when you are iterating on a
 * capture), fall back to a nominal length and let Capture.tsx render its
 * "recording missing" card.
 */
const STUDIO_FALLBACK_SECONDS = 20;

export const RemotionRoot: React.FC = () => {
  const storyboards = discoverStoryboards();

  return (
    <>
      {storyboards.map(({ id, raw }) => (
        <Composition
          key={id}
          id={id}
          // Composition types its component against Record<string, unknown>.
          // StoryboardProps is a narrower object type, which is exactly what
          // calculateMetadata below supplies, so the cast is describing reality
          // rather than hiding a mismatch.
          component={StoryboardComposition as unknown as React.FC<Record<string, unknown>>}
          // Real values are supplied by calculateMetadata. These only have to
          // be legal, and are replaced before a frame is drawn.
          durationInFrames={30}
          fps={30}
          width={1920}
          height={1080}
          defaultProps={{
            storyboard: undefined,
            timelines: {},
            transcripts: {},
          } as Record<string, unknown>}
          calculateMetadata={({ props }) => {
            const p = props as unknown as Partial<StoryboardProps>;
            const timelines = p?.timelines ?? {};
            const durations: Record<string, number> = {};
            for (const [shot, tl] of Object.entries(timelines)) {
              durations[shot] = tl.durationMs / 1000;
            }
            for (const scene of (raw as { scenes?: { type?: string; shot?: string }[] }).scenes ?? []) {
              if (scene.type === 'capture' && scene.shot && durations[scene.shot] === undefined) {
                durations[scene.shot] = STUDIO_FALLBACK_SECONDS;
              }
            }

            const storyboard = validateStoryboard(raw, durations);

            return {
              durationInFrames: storyboard.durationInFrames,
              fps: storyboard.fps,
              width: storyboard.width,
              height: storyboard.height,
              props: { ...props, storyboard } as Record<string, unknown>,
            };
          }}
        />
      ))}
    </>
  );
};
