#!/usr/bin/env node
/**
 * Check a rendered cut, and be explicit about where the check stops.
 *
 *   npm run verify -- --storyboard add-inbox-then-chat
 *
 * Two halves:
 *
 *   1. MECHANICAL checks, which an agent may assert. Streams, dimensions,
 *      pixel format, duration, black frames, frozen segments, caption sanity,
 *      transcript freshness, and that no masked credential reached any output.
 *      These either pass or they do not.
 *
 *   2. A CONTACT SHEET, which an agent reads with vision. One still at the
 *      start, middle and end of every scene, plus one at every callout, tiled
 *      into a grid. A single frame is checkable exactly like a screenshot,
 *      because it is one.
 *
 * What neither half covers: motion. Pacing, easing, whether an entrance lands,
 * whether a cut holds, continuity across a boundary. Those exist only ACROSS
 * frames and there is no automated check for them here. Say so when reporting.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { emit, fail, heading, log, parseArgs, paths, readJson, loadEnv } from './lib/common.mjs';
import { TRANSCRIPT_MAX_AGE_DAYS } from './lib/inputs.mjs';

loadEnv();
const args = parseArgs();
const id = args.storyboard ?? args._[0];
if (!id) fail('verify', 'Pass a storyboard: npm run verify -- --storyboard add-inbox-then-chat');

const mp4 = resolve(paths.out, `${id}.mp4`);
const manifestPath = resolve(paths.out, `${id}.json`);
if (!existsSync(mp4)) fail('verify', `out/${id}.mp4 does not exist. Run: npm run render -- --storyboard ${id}`);
if (!existsSync(manifestPath)) fail('verify', `out/${id}.json does not exist. Run: npm run render -- --storyboard ${id}`);

const manifest = readJson(manifestPath);

const findings = [];
const check = (name, ok, detail, level = 'hard') => {
  findings.push({ name, ok, detail, level });
  const mark = ok ? 'ok  ' : level === 'hard' ? 'FAIL' : 'warn';
  log(`  [${mark}] ${name}${detail ? ` - ${detail}` : ''}`);
  return ok;
};

/**
 * Run an ffmpeg/ffprobe command and return stdout AND stderr, joined.
 *
 * spawnSync rather than execFileSync, and this is not a style preference.
 * ffmpeg writes its filter output (blackdetect, freezedetect) to STDERR and
 * exits 0. execFileSync returns only stdout on success, so every detector
 * check silently examined an empty string and passed. A verification step that
 * cannot fail is worse than no verification step, because it is reported as a
 * pass. Keep both streams.
 */
const ff = (bin, argv) => {
  const r = spawnSync(bin, argv, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
  if (r.error) throw new Error(`${bin} failed to start: ${r.error.message}`);
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
};

// --- Streams ---------------------------------------------------------------

heading('Streams');

const probeRaw = ff('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', mp4]);
// ff() joins stdout and stderr, so slice out the JSON object rather than
// assuming ffprobe stayed silent on stderr.
const probe = JSON.parse(probeRaw.slice(probeRaw.indexOf('{'), probeRaw.lastIndexOf('}') + 1));
const video = probe.streams.find((s) => s.codec_type === 'video');
const audio = probe.streams.find((s) => s.codec_type === 'audio');
const durationSeconds = Number(probe.format.duration);

check('video stream present', Boolean(video), video ? `${video.codec_name} ${video.width}x${video.height} ${video.pix_fmt}` : 'none');
check('codec is h264', video?.codec_name === 'h264', video?.codec_name ?? '');
check('pixel format is yuv420p', video?.pix_fmt === 'yuv420p', `${video?.pix_fmt} (Safari refuses anything else)`);
check('dimensions match the storyboard', video?.width === manifest.width && video?.height === manifest.height, `${video?.width}x${video?.height} vs ${manifest.width}x${manifest.height}`);

// A storyboard with a voiceover must carry audio; one without legitimately
// does not, and an absent stream is then correct rather than a fault.
const wantsAudio = Boolean(manifest.sources.transcripts.length >= 0 && manifest.outputs.captions);
if (wantsAudio) {
  check('audio stream present', Boolean(audio), audio ? `${audio.codec_name}` : 'none, but captions were generated so a voiceover was expected');
  check('audio codec is aac', audio?.codec_name === 'aac', audio?.codec_name ?? '');
} else {
  check('no voiceover, so no audio stream expected', true, audio ? `has ${audio.codec_name} anyway` : 'none');
}

// --- Duration --------------------------------------------------------------

heading('Duration');

const expected = manifest.durationInSeconds;
const drift = Math.abs(durationSeconds - expected);
check('duration matches the storyboard', drift < 0.25, `${durationSeconds.toFixed(2)}s vs ${expected.toFixed(2)}s expected (drift ${drift.toFixed(3)}s)`);

const shortScenes = manifest.boundaries.filter((b) => b.endSeconds - b.startSeconds < 1.5);
check('no scene under 1.5s', shortScenes.length === 0, shortScenes.map((b) => `scene ${b.index} (${b.type})`).join(', ') || 'none');

// --- Black frames ----------------------------------------------------------

heading('Black frames');

/**
 * pix_th is deliberately 0.05, NOT the 0.10 default.
 *
 * This project's dark theme paints its page background #0B1020, whose
 * luminance is about 0.07 of full range. At the default threshold every
 * correctly-rendered dark frame counts as "black" and the check fires on the
 * entire video. 0.05 sits below the background and above true black, so it
 * catches a scene that failed to mount without condemning the house style.
 */
const blackOut = ff('ffmpeg', ['-i', mp4, '-vf', 'blackdetect=d=0.4:pic_th=0.98:pix_th=0.05', '-f', 'null', '-']);
const blackHits = [...blackOut.matchAll(/black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/g)].map((m) => ({
  start: Number(m[1]),
  end: Number(m[2]),
  duration: Number(m[3]),
}));

// The outro deliberately fades out over the last third of a second. A black
// run that ENDS at the end of the file and is shorter than half a second is
// that fade, not a fault.
const tailFade = (h) => h.end >= durationSeconds - 0.08 && h.duration < 0.5;
const realBlack = blackHits.filter((h) => !tailFade(h));
check(
  'no unexpected black segments',
  realBlack.length === 0,
  realBlack.length
    ? realBlack.map((h) => `${h.start.toFixed(2)}s for ${h.duration.toFixed(2)}s -> ${sceneAt(h.start)}`).join('; ')
    : blackHits.length
      ? 'only the intended outro fade'
      : 'none',
);

// --- Frozen segments -------------------------------------------------------

heading('Frozen segments');

const freezeOut = ff('ffmpeg', ['-i', mp4, '-vf', 'freezedetect=n=-60dB:d=2', '-f', 'null', '-']);
const freezeStarts = [...freezeOut.matchAll(/freeze_start:\s*([\d.]+)/g)].map((m) => Number(m[1]));
const freezeDurs = [...freezeOut.matchAll(/freeze_duration:\s*([\d.]+)/g)].map((m) => Number(m[1]));
const freezes = freezeStarts.map((start, i) => ({ start, duration: freezeDurs[i] ?? 0 }));

// A dwell is a deliberate freeze: the recipe pauses so a viewer can read the
// result. So a stall is only a FAILURE past three seconds, which is longer
// than any dwell the shots use; between two and three it is worth a look.
const stalls = freezes.filter((f) => f.duration >= 3);
const dwells = freezes.filter((f) => f.duration < 3);
check('no segment frozen for 3s or more', stalls.length === 0, stalls.map((f) => `${f.start.toFixed(2)}s for ${f.duration.toFixed(2)}s -> ${sceneAt(f.start)}`).join('; ') || 'none');
if (dwells.length) {
  check('short static holds (dwells, or a scene that stopped moving)', true, dwells.map((f) => `${f.start.toFixed(2)}s for ${f.duration.toFixed(2)}s`).join('; '), 'warn');
}

// --- Captions --------------------------------------------------------------

heading('Captions');

const vtt = resolve(paths.out, `${id}.vtt`);
if (manifest.outputs.captions) {
  const body = readFileSync(vtt, 'utf8');
  check('captions file is non-empty', body.trim().length > 10, `${statSync(vtt).size} bytes`);
  check('captions file is WebVTT', body.startsWith('WEBVTT'), body.slice(0, 12).replace(/\n/g, ' '));

  const stamps = [...body.matchAll(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})/g)];
  check('captions have cues', stamps.length > 0, `${stamps.length} cue(s)`);
  if (stamps.length) {
    const last = stamps[stamps.length - 1];
    const lastEnd = Number(last[5]) * 3600 + Number(last[6]) * 60 + Number(last[7]) + Number(last[8]) / 1000;
    check('last cue ends inside the video', lastEnd <= durationSeconds + 0.05, `${lastEnd.toFixed(2)}s vs ${durationSeconds.toFixed(2)}s`);
  }
} else {
  check('no captions expected', true, 'storyboard did not request them', 'warn');
}

// --- Evidence --------------------------------------------------------------

heading('Evidence');

if (manifest.sources.transcripts.length === 0) {
  check('no transcript to check', true, 'this cut has no chat scene', 'warn');
}
for (const t of manifest.sources.transcripts) {
  const file = resolve(paths.root, t.file);
  const ageDays = (Date.now() - Date.parse(t.verifiedAt)) / 86_400_000;
  check(`${t.file} is fresh`, ageDays <= TRANSCRIPT_MAX_AGE_DAYS, `verified ${ageDays.toFixed(1)} days ago (limit ${TRANSCRIPT_MAX_AGE_DAYS})`);

  if (existsSync(file)) {
    const doc = readJson(file);
    const failedTurns = doc.turns.filter((x) => x.role === 'tool' && x.ok === false);
    check(`${t.file} has no failed tool call`, failedTurns.length === 0, failedTurns.map((x) => x.name).join(', ') || `${t.toolCalls} tool call(s), all ok`);
  }
}

// A capture recorded in the other theme, letterboxed into this cut, reads as a
// mistake even though every mechanical check passes. Warn rather than fail: a
// storyboard may deliberately cut a light product shot into a dark surround.
for (const shot of manifest.sources.captures) {
  if (shot.appearance === 'unknown' || !shot.appearance) continue;
  check(
    `capture "${shot.shot}" matches the ${manifest.theme} theme`,
    shot.appearance === manifest.theme,
    shot.appearance === manifest.theme
      ? shot.appearance
      : `recording is ${shot.appearance} but the storyboard is ${manifest.theme}. Set the theme in the demo account and re-capture, or change the storyboard's theme.`,
    'warn',
  );
}

/**
 * The credential check, and what it actually proves.
 *
 * It proves that no masked value leaked into anything TEXTUAL this pipeline
 * writes: the timeline, the manifest, the captions. It does NOT prove the
 * password rendered as dots on screen, because that is a claim about pixels.
 * The contact sheet is where a human or a vision pass settles that, and the
 * shot recipe types into an input[type=password] so the app itself masks it.
 */
const secrets = [process.env.DEMO_IMAP_PASS, process.env.MCP_API_KEY].filter((s) => s && s.length >= 8);
const textualOutputs = [manifestPath, existsSync(vtt) ? vtt : null].filter(Boolean);
for (const shot of manifest.sources.captures) {
  const tl = resolve(paths.captures, `${shot.shot}.timeline.json`);
  if (existsSync(tl)) textualOutputs.push(tl);
}
let leaked = [];
for (const file of textualOutputs) {
  const body = readFileSync(file, 'utf8');
  for (const s of secrets) if (body.includes(s)) leaked.push(file);
}
check(
  'no credential in any text output',
  leaked.length === 0,
  secrets.length === 0 ? 'no secrets in env to check against' : leaked.join(', ') || `checked ${textualOutputs.length} file(s)`,
);

const maskedEvents = manifest.sources.captures.flatMap((s) => {
  const tl = resolve(paths.captures, `${s.shot}.timeline.json`);
  if (!existsSync(tl)) return [];
  return readJson(tl).events.filter((e) => e.masked).map((e) => ({ shot: s.shot, t: e.t }));
});
if (maskedEvents.length) {
  check('masked fields recorded as masked', true, `${maskedEvents.length} event(s). Pixel masking is NOT proven here, check the contact sheet.`, 'warn');
}

// --- Contact sheet ---------------------------------------------------------

heading('Contact sheet');

const sheetDir = resolve(paths.out, `.frames-${id}`);
rmSync(sheetDir, { recursive: true, force: true });
mkdirSync(sheetDir, { recursive: true });

// Sampled from the manifest, not at a fixed interval: start, middle and end of
// every scene, plus the exact moment of every callout. A fixed grid samples
// the boring parts and misses the ones that were authored.
const samples = [];
for (const b of manifest.boundaries) {
  const span = b.endSeconds - b.startSeconds;
  samples.push({ t: b.startSeconds + Math.min(0.35, span * 0.15), label: `${b.index} ${b.type} in` });
  samples.push({ t: b.startSeconds + span / 2, label: `${b.index} ${b.type} mid` });
  samples.push({ t: b.endSeconds - Math.min(0.35, span * 0.15), label: `${b.index} ${b.type} out` });
}
for (const c of manifest.callouts) {
  samples.push({ t: c.atSeconds + 0.6, label: `callout: ${c.text.slice(0, 28)}` });
}
samples.sort((a, b) => a.t - b.t);

samples.forEach((s, i) => {
  const t = Math.max(0, Math.min(durationSeconds - 0.02, s.t));
  ff('ffmpeg', ['-y', '-ss', String(t), '-i', mp4, '-frames:v', '1', '-vf', 'scale=480:-1', resolve(sheetDir, `${String(i).padStart(3, '0')}.png`)]);
});

const cols = Math.min(5, Math.max(1, samples.length));
const rows = Math.ceil(samples.length / cols);
const sheet = resolve(paths.out, `${id}.sheet.png`);
ff('ffmpeg', ['-y', '-framerate', '1', '-i', resolve(sheetDir, '%03d.png'), '-vf', `tile=${cols}x${rows}:padding=8:margin=8:color=0x11162B`, '-frames:v', '1', sheet]);
rmSync(sheetDir, { recursive: true, force: true });

const sheetOk = existsSync(sheet) && statSync(sheet).size > 1000;
check('contact sheet written', sheetOk, sheetOk ? `out/${id}.sheet.png, ${samples.length} frames in a ${cols}x${rows} grid` : 'ffmpeg produced nothing');

log('\n  Frames in the sheet, left to right, top to bottom:');
samples.forEach((s, i) => log(`    ${String(i + 1).padStart(2)}. ${s.t.toFixed(2)}s  ${s.label}`));

// --- Result ----------------------------------------------------------------

function sceneAt(t) {
  const b = manifest.boundaries.find((x) => t >= x.startSeconds && t < x.endSeconds);
  return b ? `scene ${b.index} (${b.type})` : 'outside every scene';
}

const hard = findings.filter((f) => f.level === 'hard' && !f.ok);
const warn = findings.filter((f) => f.level === 'warn' && !f.ok);

log('');
log(`${findings.filter((f) => f.ok).length} passed, ${warn.length} warning(s), ${hard.length} failure(s).`);
if (hard.length) {
  log('\nFailures:');
  for (const f of hard) log(`  - ${f.name}: ${f.detail}`);
}

log('\nWhat this DID NOT check: motion. Pacing, easing, whether an entrance');
log('lands, and continuity across a cut exist only across frames, and nothing');
log('here samples them. Open out/' + id + '.sheet.png for layout, typography and');
log('framing, then have a human watch the cut before it ships.');

emit({
  ok: hard.length === 0,
  script: 'verify',
  id,
  mp4: `out/${id}.mp4`,
  contactSheet: `out/${id}.sheet.png`,
  durationSeconds: Number(durationSeconds.toFixed(3)),
  passed: findings.filter((f) => f.ok).length,
  warnings: warn.map((f) => ({ name: f.name, detail: f.detail })),
  failures: hard.map((f) => ({ name: f.name, detail: f.detail })),
  motionVerified: false,
  note: 'Mechanical checks and a contact sheet only. Motion, pacing and timing are not verified and need a human pass.',
});

process.exit(hard.length === 0 ? 0 : 1);
