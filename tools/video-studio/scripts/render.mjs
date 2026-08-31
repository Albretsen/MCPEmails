#!/usr/bin/env node
/**
 * Render one storyboard to out/.
 *
 *   npm run render -- --storyboard add-inbox-then-chat
 *
 * Options:
 *   --skip-captions   render without generating word timings (faster iteration)
 *   --quality N       CRF, lower is better. Default 18.
 *   --concurrency N   parallel renderers. Default 4.
 *
 * Everything that can reject the render does so BEFORE a frame is drawn:
 * schema, missing recordings, failed or stale transcripts. A nine minute render
 * that fails at the end on a typo is the failure mode this ordering exists to
 * prevent.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { emit, fail, heading, log, parseArgs, paths, readJson, loadEnv } from './lib/common.mjs';
import { ensurePublicDir } from './lib/public-dir.mjs';
import { assertCapturesPresent, captureDurations, loadTimelines, loadTranscripts } from './lib/inputs.mjs';
import { validateStoryboard } from '../src/storyboard-schema.mjs';
import { generateCaptions } from './lib/captions.mjs';

loadEnv();
const args = parseArgs();
const id = args.storyboard ?? args._[0];

if (!id) {
  fail('render', 'Pass a storyboard: npm run render -- --storyboard add-inbox-then-chat');
}

const storyboardFile = resolve(paths.storyboards, `${id}.json`);
if (!existsSync(storyboardFile)) {
  fail('render', `storyboards/${id}.json does not exist.`);
}

mkdirSync(paths.out, { recursive: true });
ensurePublicDir();

// --- 1. Validate -----------------------------------------------------------

heading('Validating');

const timelines = loadTimelines();
let storyboard;
try {
  storyboard = validateStoryboard(readJson(storyboardFile), captureDurations(timelines));
} catch (e) {
  fail('render', e.message);
}
log(`  ${storyboard.scenes.length} scene(s), ${(storyboard.durationInFrames / storyboard.fps).toFixed(2)}s at ${storyboard.fps}fps, ${storyboard.width}x${storyboard.height}`);

try {
  assertCapturesPresent(storyboard, timelines);
} catch (e) {
  fail('render', e.message, { problems: e.problems });
}

let transcripts;
try {
  transcripts = loadTranscripts(storyboard);
} catch (e) {
  fail('render', e.message, { problems: e.problems });
}
for (const [rel, t] of Object.entries(transcripts)) {
  const age = ((Date.now() - Date.parse(t.verifiedAt)) / 86_400_000).toFixed(1);
  log(`  ${rel}: ${t.turns.length} turns, verified ${age} days ago, every tool call ok`);
}

// --- 2. Captions -----------------------------------------------------------
// Word timings must exist BEFORE the render, because the burned-in captions
// component fetches them as a static file while the frames are being drawn.

let captions = null;
if (storyboard.captions && !args['skip-captions']) {
  heading('Captions');
  try {
    captions = await generateCaptions(storyboard);
    log(`  ${captions.words.length} words, ${captions.cues} cue(s) -> out/${id}.vtt`);
  } catch (e) {
    fail('render', `Caption generation failed: ${e.message}`);
  }
} else if (storyboard.captions) {
  log('\n  Skipping captions (--skip-captions). The cut will render without them.');
}

// --- 3. Bundle -------------------------------------------------------------

heading('Bundling');
const serveUrl = await bundle({
  entryPoint: paths.entry,
  publicDir: resolve(paths.root, 'public'),
  onProgress: (p) => {
    if (p === 100) log('  bundled');
  },
});

const inputProps = { storyboard, timelines, transcripts };

const composition = await selectComposition({
  serveUrl,
  id: storyboard.id,
  inputProps,
});

// --- 4. Render -------------------------------------------------------------

const mp4 = resolve(paths.out, `${id}.mp4`);
const jpg = resolve(paths.out, `${id}.jpg`);

heading('Rendering');
let lastPct = -1;
await renderMedia({
  composition,
  serveUrl,
  codec: 'h264',
  // Safari will not play anything else, and the marketing site has to play in
  // Safari.
  pixelFormat: 'yuv420p',
  // Without this the file lands as yuvj420p, not yuv420p, and verify fails.
  //
  // The cause is not the pixelFormat option being ignored. Remotion hands
  // ffmpeg full-range JPEG frames, ffmpeg keeps that range, and full-range
  // 4:2:0 is spelled "yuvj420p". Naming a colour space makes the encoder tag
  // limited range (tv), which is what yuv420p means and what every player
  // expects from web video. Getting this wrong does not break playback, it
  // shifts the blacks and whites, so it fails quietly rather than loudly.
  colorSpace: 'bt709',
  crf: Number(args.quality ?? 18),
  audioCodec: 'aac',
  outputLocation: mp4,
  inputProps,
  concurrency: Number(args.concurrency ?? 4),
  onProgress: ({ progress }) => {
    const pct = Math.floor(progress * 100);
    if (pct !== lastPct && pct % 5 === 0) {
      lastPct = pct;
      log(`  ${pct}%`);
    }
  },
});
log(`  wrote out/${id}.mp4`);

// The poster is taken at a frame the storyboard names, not guessed. Default to
// one second into the second scene, which is past the title's entrance and on
// the first frame of real content.
const posterFrame =
  storyboard.posterFrame ??
  Math.min(
    storyboard.durationInFrames - 1,
    (storyboard.boundaries[1]?.startFrame ?? 0) + storyboard.fps,
  );

await renderStill({
  composition,
  serveUrl,
  output: jpg,
  frame: posterFrame,
  imageFormat: 'jpeg',
  jpegQuality: 92,
  inputProps,
});
log(`  wrote out/${id}.jpg (frame ${posterFrame})`);

// --- 5. Manifest -----------------------------------------------------------

const sha = (file) =>
  existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16) : null;

const vtt = resolve(paths.out, `${id}.vtt`);

const manifest = {
  id,
  renderedAt: new Date().toISOString(),
  width: storyboard.width,
  height: storyboard.height,
  fps: storyboard.fps,
  durationInFrames: storyboard.durationInFrames,
  durationInSeconds: Number((storyboard.durationInFrames / storyboard.fps).toFixed(3)),
  posterFrame,
  theme: storyboard.theme,
  boundaries: storyboard.boundaries,
  callouts: storyboard.scenes.flatMap((s, i) =>
    s.type === 'capture'
      ? s.callouts.map((c) => ({
          scene: i,
          // Callout times are authored relative to the clip; the manifest
          // publishes them in TIMELINE seconds, which is what verify needs to
          // pull a frame.
          atSeconds: Number((storyboard.boundaries[i].startSeconds + c.at).toFixed(3)),
          text: c.text,
        }))
      : [],
  ),
  sources: {
    captures: storyboard.scenes
      .filter((s) => s.type === 'capture')
      .map((s) => ({
        shot: s.shot,
        recordedAt: timelines[s.shot]?.recordedAt ?? null,
        appearance: timelines[s.shot]?.appearance ?? 'unknown',
        baseUrl: timelines[s.shot]?.baseUrl ?? null,
        events: timelines[s.shot]?.events.length ?? 0,
        clip: s.clip ?? null,
        speed: s.speed,
      })),
    transcripts: Object.entries(transcripts).map(([rel, t]) => ({
      file: rel,
      verifiedAt: t.verifiedAt,
      endpoint: t.endpoint,
      turns: t.turns.length,
      toolCalls: t.turns.filter((x) => x.role === 'tool').length,
    })),
  },
  outputs: {
    mp4: { path: `out/${id}.mp4`, bytes: statSync(mp4).size, sha256: sha(mp4) },
    poster: { path: `out/${id}.jpg`, bytes: statSync(jpg).size, sha256: sha(jpg) },
    captions: existsSync(vtt)
      ? { path: `out/${id}.vtt`, bytes: statSync(vtt).size, sha256: sha(vtt) }
      : null,
  },
};

const manifestPath = resolve(paths.out, `${id}.json`);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
log(`  wrote out/${id}.json`);

log('\nRendered. Nothing about how this MOVES has been checked yet.');
log(`Next: npm run verify -- --storyboard ${id}`);

emit({
  ok: true,
  script: 'render',
  id,
  mp4: `out/${id}.mp4`,
  poster: `out/${id}.jpg`,
  captions: existsSync(vtt) ? `out/${id}.vtt` : null,
  manifest: `out/${id}.json`,
  durationInSeconds: manifest.durationInSeconds,
  bytes: manifest.outputs.mp4.bytes,
});
