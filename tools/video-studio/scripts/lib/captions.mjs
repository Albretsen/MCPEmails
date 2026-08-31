/**
 * Voiceover to word timings to captions.
 *
 * One transcription produces BOTH outputs: the burned-in captions the scene
 * component draws, and the sidecar .vtt the marketing player loads. They are
 * generated from the same word list so they cannot drift apart.
 *
 * Whisper runs locally through @remotion/install-whisper-cpp. The first run
 * downloads whisper.cpp and a model into .whisper/ (gitignored, a few hundred
 * megabytes); later runs reuse it. If the timings for a given voiceover already
 * exist and the audio has not changed, transcription is skipped entirely.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { log, paths, ROOT } from './common.mjs';

const exec = promisify(execFile);

const WHISPER_DIR = resolve(ROOT, '.whisper');
const WHISPER_VERSION = '1.5.5';
// medium.en is the default because caption timing errors are visible and this
// runs rarely. Override with WHISPER_MODEL=base.en for a much smaller download
// when you are testing the pipeline rather than cutting a deliverable.
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'medium.en';

/** Absolute path of the voiceover a storyboard names. */
function voiceoverPath(storyboard) {
  return resolve(ROOT, storyboard.voiceover);
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Whisper wants 16 kHz mono 16-bit PCM. Feeding it an mp3 either fails or
 * silently mistimes, which is worse, so convert explicitly.
 */
async function toWav(mp3, wav) {
  await exec('ffmpeg', ['-y', '-i', mp3, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], {
    maxBuffer: 1024 * 1024 * 32,
  });
}

/**
 * Join word tokens into readable text.
 *
 * whisper emits punctuation as its own token, so a naive space-join produces
 * "password , no O Auth review ," on screen. Close the space before punctuation
 * and after an opening bracket. This is duplicated in src/components/Captions.tsx
 * on purpose: the two must produce identical strings, and a shared import would
 * have to cross the node/bundle boundary for four lines.
 */
export function joinWords(words) {
  return words
    .map((w) => (typeof w === 'string' ? w : w.text))
    .join(' ')
    .replace(/\s+([,.!?;:%\)\]])/g, '$1')
    .replace(/([(\[])\s+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function toVtt(words) {
  const stamp = (ms) => {
    const total = Math.max(0, ms) / 1000;
    const h = String(Math.floor(total / 3600)).padStart(2, '0');
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const s = String(Math.floor(total % 60)).padStart(2, '0');
    const cs = String(Math.floor((total % 1) * 1000)).padStart(3, '0');
    return `${h}:${m}:${s}.${cs}`;
  };

  // Same grouping rule as the burned-in captions component, for the same
  // reason: a cue per word is unreadable, a cue per sentence covers the frame.
  const MAX_CHARS = 42;
  const MAX_GAP_MS = 500;
  const cues = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    cues.push({
      text: joinWords(cur),
      startMs: cur[0].startMs,
      endMs: cur[cur.length - 1].endMs,
    });
    cur = [];
  };
  for (const w of words) {
    const wouldBe = joinWords([...cur, w]).length;
    const gap = cur.length ? w.startMs - cur[cur.length - 1].endMs : 0;
    if (cur.length && (wouldBe > MAX_CHARS || gap > MAX_GAP_MS)) flush();
    cur.push(w);
    if (/[.!?]$/.test(w.text)) flush();
  }
  flush();

  const body = cues
    .map((c, i) => `${i + 1}\n${stamp(c.startMs)} --> ${stamp(c.endMs)}\n${c.text}\n`)
    .join('\n');

  return { vtt: `WEBVTT\n\n${body}`, cues: cues.length };
}

export async function generateCaptions(storyboard) {
  const mp3 = voiceoverPath(storyboard);
  if (!existsSync(mp3)) {
    throw new Error(
      `voiceover "${storyboard.voiceover}" does not exist. ` +
      'Generate it into assets/vo/ first, or set "captions": false.',
    );
  }

  // captures/ is what the public/ symlink exposes to staticFile(), so the
  // timing file lives there rather than in out/.
  const timingsPath = resolve(paths.captures, `${storyboard.id}.captions.json`);
  const audioHash = sha256(mp3);

  if (existsSync(timingsPath)) {
    try {
      const cached = JSON.parse(readFileSync(timingsPath, 'utf8'));
      if (cached.audioSha256 === audioHash && Array.isArray(cached.words)) {
        log('  voiceover unchanged, reusing cached word timings');
        const { vtt, cues } = toVtt(cached.words);
        writeFileSync(resolve(paths.out, `${storyboard.id}.vtt`), vtt);
        return { words: cached.words, cues };
      }
    } catch {
      // Corrupt cache. Fall through and re-transcribe.
    }
  }

  const { downloadWhisperModel, installWhisperCpp, transcribe, toCaptions } = await import(
    '@remotion/install-whisper-cpp'
  );

  // Do NOT create WHISPER_DIR first. installWhisperCpp treats an existing
  // directory as an existing installation and then fails looking for a binary
  // that was never downloaded.
  log('  preparing whisper.cpp (first run downloads it, a few hundred MB)');
  await installWhisperCpp({ to: WHISPER_DIR, version: WHISPER_VERSION });
  mkdirSync(WHISPER_DIR, { recursive: true });
  await downloadWhisperModel({ folder: WHISPER_DIR, model: WHISPER_MODEL });

  const wav = resolve(WHISPER_DIR, `${storyboard.id}.wav`);
  log('  converting voiceover to 16 kHz mono wav');
  await toWav(mp3, wav);

  log('  transcribing');
  const whisperOutput = await transcribe({
    inputPath: wav,
    whisperPath: WHISPER_DIR,
    // Required, and it is not optional in the way the docs example suggests:
    // omitting it fails with "Both inputs should be strings. Expected x.x.x",
    // which is a semver comparison against undefined and says nothing about
    // the missing argument.
    whisperCppVersion: WHISPER_VERSION,
    model: WHISPER_MODEL,
    tokenLevelTimestamps: true,
  });

  const { captions } = toCaptions({ whisperCppOutput: whisperOutput });
  const words = captions
    .map((c) => ({
      text: String(c.text).trim(),
      startMs: Math.round(c.startMs),
      endMs: Math.round(c.endMs),
    }))
    .filter((w) => w.text.length > 0);

  if (words.length === 0) {
    throw new Error('whisper returned no words. Check that the voiceover file actually contains speech.');
  }

  writeFileSync(
    timingsPath,
    JSON.stringify({ id: storyboard.id, audioSha256: audioHash, words }, null, 2) + '\n',
  );

  const { vtt, cues } = toVtt(words);
  writeFileSync(resolve(paths.out, `${storyboard.id}.vtt`), vtt);

  return { words, cues };
}
