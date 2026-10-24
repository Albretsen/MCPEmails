#!/usr/bin/env node
/**
 * Turn a storyboard's voiceover script into an mp3.
 *
 *   npm run voice -- --storyboard query-speedrun-sample
 *   npm run voice -- --storyboard query-speedrun-sample --force
 *
 * Reads vo/<id>.txt (tracked), writes the storyboard's `voiceover` path
 * (default assets/vo/<id>.mp3, gitignored) and a provenance sidecar next to it,
 * assets/vo/<id>.voice.json. render reads the sidecar to label the cut as
 * AI-generated, so do not delete it while keeping the mp3.
 *
 * ONE voice, pinned. A channel whose narrator changes from video to video
 * sounds like several channels, and caption spellings for homophones are
 * voice-dependent (see SPELLINGS in scripts/lib/captions.mjs): change VOICE and
 * you owe a recheck of every homophone entry. Override for an experiment with
 * VOICE_NAME, never by editing a storyboard.
 *
 * Needs OPENAI_API_KEY in .env. Re-running with an unchanged script, voice and
 * model is free: the request is hashed and a matching mp3 is reused.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { emit, fail, heading, log, parseArgs, paths, readJson, loadEnv } from './lib/common.mjs';
import { mediaSeconds } from './lib/inputs.mjs';
import { lintCopy } from '../src/copy-lint.mjs';
import { validateStoryboard } from '../src/storyboard-schema.mjs';

loadEnv();
const args = parseArgs();
const id = args.storyboard ?? args._[0];
if (!id) fail('voice', 'Pass a storyboard: npm run voice -- --storyboard <id>');

const MODEL = process.env.VOICE_MODEL || 'gpt-4o-mini-tts';
const VOICE = process.env.VOICE_NAME || 'cedar';
const INSTRUCTIONS =
  'A calm, clear narrator explaining a software tool to a friend. Conversational, ' +
  'medium-brisk pace, no hype, no announcer voice. Short pause at each full stop.';

/**
 * The script is written the way it must READ (the product is "MCPEmails", one
 * word, and the copy rules are enforced on that). Speech engines read an
 * unfamiliar camel-case word unpredictably, so the request spells it the way it
 * is SAID. whisper hears "M C P emails" as fragments that the caption
 * speller re-joins into "MCPEmails", so captions still print the brand.
 */
const SAY = [
  [/\bmcpemails\.com\b/gi, 'M C P emails dot com'],
  [/\bMCPEmails\b/g, 'M C P Emails'],
];

const scriptFile = resolve(paths.voScripts, `${id}.txt`);
if (!existsSync(scriptFile)) fail('voice', `vo/${id}.txt does not exist. Write the voiceover script there first.`);
const text = readFileSync(scriptFile, 'utf8').replace(/\r\n/g, '\n').trim();
if (!text) fail('voice', `vo/${id}.txt is empty.`);

const problems = text.split('\n').flatMap((line, i) => lintCopy(line, `vo/${id}.txt line ${i + 1}`));
if (problems.length) fail('voice', problems.join('\n  '), { problems });

// Where the mp3 goes, and how long it may be: both come from the storyboard
// when there is one, so a script that outgrows its video fails here, not as a
// truncated last sentence after a render.
const storyboardFile = resolve(paths.storyboards, `${id}.json`);
let storyboard = null;
if (existsSync(storyboardFile)) {
  try {
    storyboard = validateStoryboard(readJson(storyboardFile), {});
  } catch (e) {
    // A capture scene without a recording cannot be measured here. The
    // voiceover path is still readable from the raw file.
    log(`  note: storyboard not fully validated (${e.message.split('\n')[0]})`);
  }
}
const rawVoiceover = storyboard?.voiceover ?? (existsSync(storyboardFile) ? readJson(storyboardFile).voiceover : undefined);
const outRel = rawVoiceover ?? `assets/vo/${id}.mp3`;
if (!/^assets\/vo\/[A-Za-z0-9._-]+\.mp3$/.test(outRel)) {
  fail('voice', `the storyboard's "voiceover" must be an mp3 directly in assets/vo/, got "${outRel}".`);
}
const mp3 = resolve(paths.root, outRel);
const sidecar = mp3.replace(/\.mp3$/, '.voice.json');

const spoken = SAY.reduce((t, [re, say]) => t.replace(re, say), text);
const request = { model: MODEL, voice: VOICE, instructions: INSTRUCTIONS, input: spoken, response_format: 'mp3' };
const requestSha = createHash('sha256').update(JSON.stringify(request)).digest('hex');

heading(`Voiceover for "${id}"`);
log(`  ${MODEL}, voice "${VOICE}", ${text.split(/\s+/).length} words`);

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

let reused = false;
if (!args.force && existsSync(mp3) && existsSync(sidecar)) {
  try {
    const prev = readJson(sidecar);
    if (prev.requestSha256 === requestSha && prev.audioSha256 === sha(mp3)) reused = true;
  } catch {
    // Unreadable sidecar: regenerate.
  }
}

if (reused) {
  log('  script, voice and model unchanged, reusing the existing mp3');
} else {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    fail('voice', 'OPENAI_API_KEY is not set. Put a key in tools/video-studio/.env (it is gitignored).');
  }
  let res;
  try {
    res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch (e) {
    fail('voice', `request failed: ${e.message}`);
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    fail('voice', `OpenAI answered HTTP ${res.status}: ${body}`);
  }
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length < 1000) fail('voice', `OpenAI returned ${audio.length} bytes, which is not an mp3.`);

  mkdirSync(dirname(mp3), { recursive: true });
  const tmp = `${mp3}.partial`;
  writeFileSync(tmp, audio);
  renameSync(tmp, mp3);
}

const seconds = mediaSeconds(mp3);
const provenance = {
  generator: `openai ${MODEL}`,
  model: MODEL,
  voice: VOICE,
  instructions: INSTRUCTIONS,
  script: `vo/${id}.txt`,
  textSha256: createHash('sha256').update(text).digest('hex'),
  requestSha256: requestSha,
  audioSha256: sha(mp3),
  seconds,
  generatedAt: reused ? readJson(sidecar).generatedAt : new Date().toISOString(),
};
writeFileSync(sidecar, JSON.stringify(provenance, null, 2) + '\n');
log(`  ${outRel}: ${seconds?.toFixed(2)}s`);

if (storyboard && seconds !== null) {
  const videoSeconds = storyboard.durationInFrames / storyboard.fps;
  if (seconds > videoSeconds + 0.05) {
    fail(
      'voice',
      `the voiceover is ${seconds.toFixed(2)}s but the video is ${videoSeconds.toFixed(2)}s. Cut words from vo/${id}.txt or lengthen the scenes.`,
      { seconds, videoSeconds },
    );
  }
  log(`  fits: ${(videoSeconds - seconds).toFixed(2)}s to spare in a ${videoSeconds.toFixed(2)}s cut`);
}

emit({ ok: true, script: 'voice', id, mp3: outRel, sidecar: outRel.replace(/\.mp3$/, '.voice.json'), seconds, reused, voice: VOICE, model: MODEL });
