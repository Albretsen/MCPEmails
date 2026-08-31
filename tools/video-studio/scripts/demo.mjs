#!/usr/bin/env node
/**
 * Make a test video. One command, no configuration, no account.
 *
 *   npm run demo
 *
 * Captures the public marketing site, composites it with a title and an outro,
 * renders, verifies, and tells you where the file is. Downloads Chromium on the
 * first run. Needs nothing in .env, no sign in and no mailbox.
 *
 * Options:
 *   --fresh                 re-record even if a recent capture exists
 *   --storyboard <id>       use a different storyboard (default: demo)
 *   --shot <id>             use a different shot (default: public-tour)
 *   --url <base>            capture a different deployment
 *
 * This exists because the five-command path is the right shape for making a
 * real cut and the wrong shape for answering "does any of this work". Reaching
 * a playable file should cost one command.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { emit, heading, log, parseArgs, paths, readJson, loadEnv } from './lib/common.mjs';

loadEnv();
const args = parseArgs();

const storyboardId = args.storyboard ?? 'demo';
const shotId = args.shot ?? 'public-tour';
const baseUrl = args.url ?? process.env.DEMO_BASE_URL ?? 'https://mcpemails.com';

/** Re-record a capture older than this rather than cut against a stale site. */
const CAPTURE_MAX_AGE_HOURS = 24;

const step = (name, argv, env = {}) => {
  const r = spawnSync(process.execPath, [resolve(paths.root, 'scripts', name), ...argv], {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) {
    log(`\n${name} failed. Stopping here rather than rendering something wrong.`);
    emit({ ok: false, script: 'demo', failedStep: name });
    process.exit(1);
  }
  // Each script prints one machine-readable line; pass it back up.
  const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('VIDEO_STUDIO_RESULT '));
  return line ? JSON.parse(line.slice('VIDEO_STUDIO_RESULT '.length)) : null;
};

const webm = resolve(paths.captures, `${shotId}.webm`);
const timeline = resolve(paths.captures, `${shotId}.timeline.json`);
const haveCapture = existsSync(webm) && existsSync(timeline);
const ageHours = haveCapture ? (Date.now() - statSync(webm).mtimeMs) / 3_600_000 : Infinity;

log('');
log('Making a test video. Nothing to configure, and nothing signed in.');
log(`  site       ${baseUrl}`);
log(`  shot       ${shotId}`);
log(`  storyboard ${storyboardId}`);

if (!haveCapture || ageHours > CAPTURE_MAX_AGE_HOURS || args.fresh) {
  heading('1/3  Recording the site');
  if (haveCapture && !args.fresh) {
    log(`  the existing recording is ${ageHours.toFixed(1)}h old, re-recording`);
  }
  step('capture.mjs', ['--shot', shotId], { DEMO_BASE_URL: baseUrl });
} else {
  heading('1/3  Recording the site');
  log(`  reusing captures/${shotId}.webm, recorded ${ageHours.toFixed(1)}h ago`);
  log('  pass --fresh to re-record');
}

heading('2/3  Rendering');
const rendered = step('render.mjs', ['--storyboard', storyboardId]);

heading('3/3  Verifying');
const verified = step('verify.mjs', ['--storyboard', storyboardId]);

const manifest = readJson(resolve(paths.out, `${storyboardId}.json`));

log('');
log('Done.');
log('');
log(`  Video          out/${storyboardId}.mp4      ${(manifest.outputs.mp4.bytes / 1_000_000).toFixed(1)} MB, ${manifest.durationInSeconds}s`);
log(`  Poster         out/${storyboardId}.jpg`);
log(`  Contact sheet  out/${storyboardId}.sheet.png`);
log('');
log(`  open out/${storyboardId}.mp4`);
log('');
log('Motion was not checked. Nothing here can check pacing or easing, so watch');
log('it before you use it anywhere.');

emit({
  ok: true,
  script: 'demo',
  id: storyboardId,
  mp4: `out/${storyboardId}.mp4`,
  poster: `out/${storyboardId}.jpg`,
  contactSheet: `out/${storyboardId}.sheet.png`,
  durationSeconds: manifest.durationInSeconds,
  bytes: manifest.outputs.mp4.bytes,
  verifyWarnings: verified?.warnings ?? [],
  motionVerified: false,
});
