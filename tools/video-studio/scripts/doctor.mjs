#!/usr/bin/env node
/**
 * Preflight. Run this first, and run it again whenever something behaves oddly.
 *
 * It checks the things that are cheap to check and expensive to discover late:
 * the isolation guarantees, the binaries, whether the saved demo session is
 * still alive, and whether any secret has leaked into git.
 *
 * Exit code 0 means every hard check passed. Warnings do not fail the run: a
 * missing voiceover only matters if a storyboard asks for one.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { emit, heading, log, paths, ROOT, loadEnv } from './lib/common.mjs';

loadEnv();

const checks = [];
const add = (name, level, ok, detail) => {
  checks.push({ name, level, ok, detail });
  const mark = ok ? 'ok  ' : level === 'hard' ? 'FAIL' : 'warn';
  log(`  [${mark}] ${name}${detail ? ` - ${detail}` : ''}`);
};

function sh(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
  } catch {
    return null;
  }
}

heading('Isolation');

// 1. This directory must NOT be part of the root npm workspace. If it ever
//    became one, a root `npm install` would start rewriting our lockfile and
//    hoisting our React next to the app's.
const rootPkgPath = resolve(ROOT, '..', '..', 'package.json');
if (existsSync(rootPkgPath)) {
  const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
  const globs = rootPkg.workspaces || [];
  const captured = globs.some((g) => g === 'tools/*' || g === 'tools/**' || g === '*');
  add(
    'tools/video-studio is outside the root workspace glob',
    'hard',
    !captured,
    `root workspaces: ${JSON.stringify(globs)}`,
  );
  const pollutedScripts = Object.keys(rootPkg.scripts || {}).filter((k) => /video|remotion|storyboard/i.test(k));
  add('root package.json has no video-studio scripts', 'hard', pollutedScripts.length === 0, pollutedScripts.join(', ') || 'none');
} else {
  add('root package.json found', 'warn', false, 'could not locate it, skipping workspace check');
}

// 2. Our own node_modules must exist, or we are silently resolving upward.
add('local node_modules present', 'hard', existsSync(resolve(ROOT, 'node_modules')), 'never rely on the ancestor repo to resolve our deps');

// 3. Our React must be OUR React, not the app's.
const localReact = resolve(ROOT, 'node_modules', 'react', 'package.json');
if (existsSync(localReact)) {
  add('react resolves locally', 'hard', true, `v${JSON.parse(readFileSync(localReact, 'utf8')).version}`);
} else {
  add('react resolves locally', 'hard', false, 'not in tools/video-studio/node_modules');
}

heading('Binaries');

const node = process.versions.node;
add('node >= 20', 'hard', Number(node.split('.')[0]) >= 20, `v${node}`);

const ffmpegVersion = sh('ffmpeg', ['-version']);
add('ffmpeg on PATH', 'hard', Boolean(ffmpegVersion), ffmpegVersion ? ffmpegVersion.split('\n')[0].slice(0, 60) : 'brew install ffmpeg');

const ffprobeVersion = sh('ffprobe', ['-version']);
add('ffprobe on PATH', 'hard', Boolean(ffprobeVersion), ffprobeVersion ? 'present' : 'ships with ffmpeg');

const remotionBin = resolve(ROOT, 'node_modules', '.bin', 'remotion');
add('remotion CLI installed locally', 'hard', existsSync(remotionBin), remotionBin);

// Playwright's browsers are a separate download from the npm package, and the
// error you get without them is not obviously about that.
let browsersOk = false;
let browsersDetail = 'run: npm run capture -- --install-browser';
try {
  const { chromium } = await import('playwright');
  const path = chromium.executablePath();
  browsersOk = existsSync(path);
  browsersDetail = browsersOk ? path.replace(process.env.HOME || '~', '~') : browsersDetail;
} catch (e) {
  browsersDetail = `playwright not importable: ${e.message}`;
}
add('playwright chromium downloaded', 'warn', browsersOk, browsersDetail);

heading('Secrets and git hygiene');

// The saved session state is a live token. If it is ever tracked, that is an
// incident, not a lint finding.
const tracked = sh('git', ['ls-files', '--error-unmatch', '.auth/demo.json'], { cwd: ROOT });
add('.auth/demo.json is NOT tracked by git', 'hard', tracked === null, tracked ? 'TRACKED. Remove it from the index immediately.' : 'untracked');

const envTracked = sh('git', ['ls-files', '--error-unmatch', '.env'], { cwd: ROOT });
add('.env is NOT tracked by git', 'hard', envTracked === null, envTracked ? 'TRACKED. Remove it from the index immediately.' : 'untracked');

const ignoreFile = resolve(ROOT, '.gitignore');
const ignored = existsSync(ignoreFile) ? readFileSync(ignoreFile, 'utf8') : '';
for (const entry of ['node_modules/', 'captures/', 'out/', '.auth/', 'assets/vo/']) {
  add(`.gitignore covers ${entry}`, 'hard', ignored.includes(entry), '');
}

// Media must never reach git. A single 1080p cut is tens of megabytes.
const bigTracked = sh('git', ['ls-files', '--', '*.mp4', '*.webm', '*.mov', '*.mp3'], { cwd: ROOT });
add('no media files tracked in git', 'hard', !bigTracked, bigTracked ? bigTracked.split('\n').join(', ') : 'none');

heading('Demo session');

if (existsSync(paths.authState)) {
  const ageDays = (Date.now() - statSync(paths.authState).mtimeMs) / 86_400_000;
  // Supabase refresh tokens outlive this comfortably, but a session that has
  // sat unused for a fortnight is more likely stale than not, and discovering
  // that halfway through a capture wastes the take.
  add('saved demo session', ageDays < 14 ? 'warn' : 'warn', ageDays < 14, `${ageDays.toFixed(1)} days old${ageDays >= 14 ? ', re-run: npm run auth' : ''}`);
} else {
  add('saved demo session', 'warn', false, 'absent. Capture needs it: npm run auth');
}

heading('Environment');

for (const key of ['DEMO_BASE_URL', 'DEMO_ACCOUNT_EMAIL', 'DEMO_WORKSPACE_ID']) {
  add(`${key} set`, 'warn', Boolean(process.env[key]), process.env[key] ? '' : 'needed by capture and reset');
}
add('MCP_API_KEY set', 'warn', Boolean(process.env.MCP_API_KEY), process.env.MCP_API_KEY ? 'present (not printed)' : 'needed by transcript');

heading('Storyboards');

const { readdirSync } = await import('node:fs');
const { validateStoryboard } = await import('../src/storyboard-schema.mjs');
const { captureMeta, loadTimelines } = await import('./lib/inputs.mjs');

// Validate against the recordings that actually exist, the way render does.
// Validating with no capture data reports every clip that derives its length
// from a recording as broken, which is a false alarm and trains people to
// ignore doctor.
const durations = captureMeta(loadTimelines());
const files = existsSync(paths.storyboards)
  ? readdirSync(paths.storyboards).filter((f) => f.endsWith('.json'))
  : [];
if (files.length === 0) {
  add('storyboards present', 'warn', false, 'none found in storyboards/');
}
for (const f of files) {
  try {
    validateStoryboard(JSON.parse(readFileSync(resolve(paths.storyboards, f), 'utf8')), durations);
    add(`storyboards/${f} validates`, 'hard', true, '');
  } catch (e) {
    // "not captured yet" is a state, not a fault: a storyboard is allowed to
    // reference a shot nobody has recorded on this machine.
    const soft = /cannot work out how long this scene is|has not been captured/.test(e.message);
    add(`storyboards/${f} validates`, soft ? 'warn' : 'hard', false, soft ? 'needs a capture before it can be rendered' : e.message);
  }
}

const hardFails = checks.filter((c) => c.level === 'hard' && !c.ok);
const warns = checks.filter((c) => c.level === 'warn' && !c.ok);

log('');
log(`${checks.length - hardFails.length - warns.length} passed, ${warns.length} warning(s), ${hardFails.length} failure(s).`);
if (hardFails.length) {
  log('\nHard failures, fix these before anything else:');
  for (const c of hardFails) log(`  - ${c.name}: ${c.detail}`);
}

emit({
  ok: hardFails.length === 0,
  script: 'doctor',
  passed: checks.length - hardFails.length - warns.length,
  warnings: warns.map((c) => c.name),
  failures: hardFails.map((c) => ({ name: c.name, detail: c.detail })),
});

process.exit(hardFails.length === 0 ? 0 : 1);
