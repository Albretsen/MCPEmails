#!/usr/bin/env node
/**
 * Record a shot against the real product.
 *
 *   npm run capture -- --shot add-inbox
 *   npm run capture -- --install-browser    (one-off: download Chromium)
 *   npm run capture -- --shot add-inbox --headed
 *
 * Produces TWO artifacts, and the second is the point:
 *
 *   captures/<shot>.webm           the recording
 *   captures/<shot>.timeline.json  every action, when it happened, and the
 *                                  bounding box of the element it happened to
 *
 * Remotion consumes both. The timeline is what lets the composite stage draw a
 * cursor, push in on the control being used, and place callouts, with nobody
 * touching a timeline by hand.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { emit, fail, heading, log, parseArgs, paths, loadEnv } from './lib/common.mjs';
import { launch, demoContext, VIEWPORT } from './lib/browser.mjs';
import { Recorder } from './lib/recorder.mjs';
import { ensurePublicDir } from './lib/public-dir.mjs';

loadEnv();
const args = parseArgs();

// Playwright's browsers are a separate download from the npm package, and the
// failure without them does not obviously say so.
if (args['install-browser']) {
  log('Downloading Chromium for Playwright...');
  const r = spawnSync(resolve(paths.root, 'node_modules', '.bin', 'playwright'), ['install', 'chromium'], {
    stdio: 'inherit',
  });
  process.exit(r.status ?? 1);
}

const shotId = args.shot ?? args._[0];
if (!shotId) {
  const available = existsSync(paths.shots)
    ? readdirSync(paths.shots).filter((f) => f.endsWith('.shot.mjs')).map((f) => f.replace('.shot.mjs', ''))
    : [];
  fail('capture', `Pass a shot. Available: ${available.join(', ') || 'none in shots/'}`);
}

const shotFile = resolve(paths.shots, `${shotId}.shot.mjs`);
if (!existsSync(shotFile)) fail('capture', `shots/${shotId}.shot.mjs does not exist.`);

// Shots that need a session need a deployment you are signed in to, so those
// still want DEMO_BASE_URL. A public shot has a sensible default, which is what
// lets `npm run demo` work with no configuration at all.
const baseUrl = (process.env.DEMO_BASE_URL || 'https://mcpemails.com').replace(/\/$/, '');

const shot = await import(pathToFileURL(shotFile).href);
if (typeof shot.run !== 'function') fail('capture', `shots/${shotId}.shot.mjs does not export an async run(page, t).`);

heading(`Capturing "${shot.id ?? shotId}"`);
log(`  ${shot.description ?? ''}`);
log(`  against ${baseUrl}`);
log('');

mkdirSync(paths.captures, { recursive: true });
mkdirSync(paths.capturesRaw, { recursive: true });
// Playwright names the video file itself, so clear the staging directory to
// know which file this run produced.
rmSync(paths.capturesRaw, { recursive: true, force: true });
mkdirSync(paths.capturesRaw, { recursive: true });

// Playwright's browsers are a separate download from the npm package, and the
// error without them does not obviously say so. Fetch it rather than fail.
const { chromium } = await import('playwright');
if (!existsSync(chromium.executablePath())) {
  log('  Chromium is not downloaded yet. Fetching it once, about 95 MB.');
  const dl = spawnSync(resolve(paths.root, 'node_modules', '.bin', 'playwright'), ['install', 'chromium'], {
    stdio: 'inherit',
  });
  if (dl.status !== 0) fail('capture', 'Could not download Chromium for Playwright.');
  log('');
}

const browser = await launch({ headless: !args.headed });
let context;
let startedAt;
try {
  ({ context, startedAt } = await demoContext(browser, { record: true, requiresSession: shot.requiresSession !== false, theme: args.theme ?? shot.theme ?? 'dark' }));
} catch (e) {
  await browser.close();
  fail('capture', e.message);
}

const page = await context.newPage();
const t = new Recorder(page, startedAt, { onLog: log });

let runError = null;
try {
  await shot.run(page, t, { baseUrl });
} catch (e) {
  runError = e;
  log(`\n  Shot threw: ${e.message}`);
  log('  Keeping the partial recording so you can see where it stopped.');
}

const timeline = t.toTimeline({ shot: shotId, baseUrl, viewport: VIEWPORT });

// The video file is only flushed to disk when the context closes.
await context.close();
await browser.close();

const produced = readdirSync(paths.capturesRaw).filter((f) => f.endsWith('.webm'));
if (produced.length === 0) {
  fail('capture', 'Playwright produced no video file. Was the context created with recordVideo?');
}
// Newest wins, in case a stray file survived.
const newest = produced
  .map((f) => ({ f, mtime: statSync(resolve(paths.capturesRaw, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)[0].f;

const webm = resolve(paths.captures, `${shotId}.webm`);
rmSync(webm, { force: true });
renameSync(resolve(paths.capturesRaw, newest), webm);
rmSync(paths.capturesRaw, { recursive: true, force: true });

/**
 * Measure how the recording actually LOOKS, light or dark.
 *
 * The theme preference seeded in browser.mjs is a request the app is free to
 * ignore, and production does ignore it on marketing pages. Rather than trust
 * it, read the mean luma straight off the recording. verify compares this
 * against the storyboard's theme, so a light capture dropped into a dark cut
 * is reported rather than shipped.
 */
function measureAppearance(file) {
  // Sample two frames a second across the WHOLE recording, and skip the first
  // second. Reading only the opening frames measures the browser still
  // painting: a first attempt at this sampled 40 frames and called a white
  // page "dark" at a mean luma of 122, one point under the threshold.
  const r = spawnSync(
    'ffmpeg',
    ['-ss', '1', '-i', file, '-vf', 'fps=2,signalstats,metadata=print:file=-', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 32 },
  );
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const values = [...out.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  if (values.length === 0) return { appearance: 'unknown', meanLuma: null, samples: 0 };
  // Median, not mean. A single modal or a full-bleed hero image drags a mean
  // across the threshold; the median describes what most of the recording
  // actually looked like.
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  // Y is 16..235 for limited range. The dark page sits near 25 and the light
  // one near 235, so 128 separates them with a wide margin either side.
  return {
    appearance: median >= 128 ? 'light' : 'dark',
    meanLuma: Number(median.toFixed(1)),
    samples: values.length,
  };
}

/**
 * When does the page actually appear?
 *
 * Every recording opens on the browser's default background, before the first
 * paint, and how long that lasts depends entirely on how fast the site answered
 * that day. Composited straight in, a cut jumps from the title to a second of
 * flat grey. Hard-coding `"clip": { "from": 1.0 }` in the storyboard only moves
 * the problem: a clean-room run took longer than a second to paint and the
 * unpainted frame came back.
 *
 * So measure it instead of guessing. Walk the recording at 20 samples a second
 * and find the first one whose luma is close to the recording's own median.
 * The storyboard can then leave `clip` out entirely and get the right trim on
 * every take.
 */
function measureContentStart(file, medianLuma) {
  if (medianLuma === null) return 0;
  const r = spawnSync(
    'ffmpeg',
    ['-i', file, '-vf', 'fps=20,signalstats,metadata=print:file=-', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 },
  );
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const values = [...out.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  const TOLERANCE = 40;
  for (let i = 0; i < values.length; i++) {
    if (Math.abs(values[i] - medianLuma) <= TOLERANCE) {
      // Back off one sample so the trim lands on the paint, not just after it.
      return Math.max(0, (i - 1) / 20);
    }
  }
  return 0;
}

const appearance = measureAppearance(webm);
timeline.appearance = appearance.appearance;
timeline.meanLuma = appearance.meanLuma;
timeline.contentStartSeconds = Number(measureContentStart(webm, appearance.meanLuma).toFixed(2));

const timelinePath = resolve(paths.captures, `${shotId}.timeline.json`);
writeFileSync(timelinePath, JSON.stringify(timeline, null, 2) + '\n');

ensurePublicDir();

// A recording with no events produces no cursor, no zoom and no callout
// anchors, which is a silent way to get a flat screen recording back.
const withRects = timeline.events.filter((e) => e.rect).length;

log('');
log(`  captures/${shotId}.webm            ${(statSync(webm).size / 1_000_000).toFixed(1)} MB`);
log(`  captures/${shotId}.timeline.json   ${timeline.events.length} events, ${withRects} with a bounding box`);
log(`  duration                           ${(timeline.durationMs / 1000).toFixed(2)}s`);
log(`  appearance                         ${timeline.appearance}${timeline.meanLuma === null ? '' : ` (median luma ${timeline.meanLuma} over ${appearance.samples} samples)`}`);
log(`  page painted at                    ${timeline.contentStartSeconds}s (a clip with no "from" starts here)`);

if (withRects === 0) {
  log('\n  WARNING: no event carried a bounding box, so the composite will have no');
  log('  cursor, no auto zoom and nothing to anchor a callout to. Check the recipe.');
}

emit({
  ok: !runError,
  script: 'capture',
  shot: shotId,
  webm: `captures/${shotId}.webm`,
  timeline: `captures/${shotId}.timeline.json`,
  durationSeconds: Number((timeline.durationMs / 1000).toFixed(3)),
  events: timeline.events.length,
  eventsWithRect: withRects,
  appearance: timeline.appearance,
  contentStartSeconds: timeline.contentStartSeconds,
  error: runError ? runError.message : null,
});

process.exit(runError ? 1 : 0);
