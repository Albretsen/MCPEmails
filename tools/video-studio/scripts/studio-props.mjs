#!/usr/bin/env node
/**
 * Write the inputProps that Remotion Studio needs, so `npm run studio` shows
 * capture and chat scenes instead of their "missing" placeholder cards.
 *
 * WHY THIS EXISTS. `render` hands the composition its timelines and
 * transcripts as inputProps. Studio is launched by the Remotion CLI and gets
 * none, so src/Root.tsx falls back to a nominal 20s capture scene and
 * Capture.tsx draws "No recording for shot: ...". That fallback is correct as a
 * last resort and useless as a working state: the Studio is exactly where you
 * want to scrub a capture.
 *
 * So this dumps the same two maps to a file and `studio` passes it with
 * --props. It is deliberately NOT per-storyboard: both maps are keyed by shot
 * and by transcript path, so one file serves every composition in the sidebar.
 *
 * Nothing here validates. `render` still owns the checks that decide whether a
 * cut may ship (transcript freshness, failed calls, missing recordings); a
 * preview that refuses to draw a stale transcript would just be a worse
 * Studio. Anything this shows you is provisional until `render` agrees.
 */

import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { paths, readJson } from './lib/common.mjs';
import { loadTimelines } from './lib/inputs.mjs';

const timelines = loadTimelines();

// Keyed the way a storyboard names them: "transcripts/<id>.json".
const transcripts = {};
if (existsSync(paths.transcripts)) {
  for (const file of readdirSync(paths.transcripts)) {
    if (!file.endsWith('.json')) continue;
    try {
      transcripts[`transcripts/${file}`] = readJson(resolve(paths.transcripts, file));
    } catch {
      // A half-written transcript should not stop the Studio from opening.
    }
  }
}

mkdirSync(paths.out, { recursive: true });
const out = resolve(paths.out, 'studio.props.json');
writeFileSync(out, JSON.stringify({ timelines, transcripts }, null, 2) + '\n');

console.error(
  `studio props: ${Object.keys(timelines).length} recording(s), ` +
  `${Object.keys(transcripts).length} transcript(s) -> out/studio.props.json`,
);
