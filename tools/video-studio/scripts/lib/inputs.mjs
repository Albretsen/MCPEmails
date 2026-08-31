/**
 * Resolving a storyboard's inputs: the recordings it references, and the
 * transcripts it puts on camera.
 *
 * The transcript rules live here rather than in the schema because they are
 * about EVIDENCE, not shape. A storyboard that references a transcript is
 * well-formed; a storyboard that references a transcript full of failed calls
 * is a lie, and the difference can only be judged with the file in hand.
 */

import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { paths, readJson } from './common.mjs';

/** A transcript older than this cannot be filmed without re-verifying. */
export const TRANSCRIPT_MAX_AGE_DAYS = 14;

/** Read every capture timeline on disk, keyed by shot id. */
export function loadTimelines() {
  const out = {};
  if (!existsSync(paths.captures)) return out;
  for (const file of readdirSync(paths.captures)) {
    if (!file.endsWith('.timeline.json')) continue;
    const shot = file.replace(/\.timeline\.json$/, '');
    try {
      out[shot] = readJson(resolve(paths.captures, file));
    } catch (e) {
      throw new Error(`captures/${file} is not valid JSON: ${e.message}`);
    }
  }
  return out;
}

/**
 * What the validator needs to know about each recording: how long it is, and
 * when the page actually painted. A capture scene with no `clip` starts at the
 * paint, not at frame zero, so a cut never opens on the browser's unpainted
 * background.
 */
export function captureMeta(timelines) {
  const out = {};
  for (const [shot, tl] of Object.entries(timelines)) {
    out[shot] = {
      duration: tl.durationMs / 1000,
      // Recordings captured before this was measured have no value. Zero is
      // the old behaviour, which is correct for anything not browser-based.
      contentStart: typeof tl.contentStartSeconds === 'number' ? tl.contentStartSeconds : 0,
    };
  }
  return out;
}

/** Durations only. Kept for callers that do not care where the paint is. */
export function captureDurations(timelines) {
  const out = {};
  for (const [shot, tl] of Object.entries(timelines)) out[shot] = tl.durationMs / 1000;
  return out;
}

/**
 * Load and vet every transcript a storyboard's chat scenes reference.
 *
 * Throws on the two conditions that must block a render, both of which exist
 * because of a real finding: a production audit on 2026-08-19 showed
 * email_compose with 0 successes and 29 errors over 14 days, and four other
 * tools with no calls at all. Zero calls and zero failures are indistinguishable
 * in a dashboard and very distinguishable on camera, so the freshness window and
 * the ok check are what stop a cut animating a feature that does not work.
 */
export function loadTranscripts(storyboard) {
  const out = {};
  const problems = [];

  for (const [i, scene] of storyboard.scenes.entries()) {
    if (scene.type !== 'chat') continue;

    const rel = scene.transcript;
    const file = resolve(paths.root, rel);
    if (!existsSync(file)) {
      problems.push(
        `scene ${i} (chat): transcript "${rel}" does not exist. ` +
        `Run: npm run transcript -- --storyboard ${storyboard.id}`,
      );
      continue;
    }

    let t;
    try {
      t = readJson(file);
    } catch (e) {
      problems.push(`scene ${i} (chat): ${rel} is not valid JSON: ${e.message}`);
      continue;
    }

    if (!Array.isArray(t.turns) || t.turns.length === 0) {
      problems.push(`scene ${i} (chat): ${rel} has no turns.`);
      continue;
    }

    const failed = t.turns
      .map((turn, ti) => ({ turn, ti }))
      .filter(({ turn }) => turn.role === 'tool' && turn.ok === false);
    if (failed.length) {
      const detail = failed
        .map(({ turn, ti }) => `turn ${ti} (${turn.name}): ${turn.summary ?? 'failed'}`)
        .join('; ');
      problems.push(
        `scene ${i} (chat): ${rel} contains ${failed.length} failed tool call(s), so it cannot go on camera. ${detail}. ` +
        `Fix the call or cut the beat, then re-run: npm run transcript -- --storyboard ${storyboard.id}`,
      );
      continue;
    }

    const verifiedAt = Date.parse(t.verifiedAt ?? '');
    if (!Number.isFinite(verifiedAt)) {
      problems.push(`scene ${i} (chat): ${rel} has no valid "verifiedAt". A transcript with no verification date is not evidence.`);
      continue;
    }
    const ageDays = (Date.now() - verifiedAt) / 86_400_000;
    if (ageDays > TRANSCRIPT_MAX_AGE_DAYS) {
      problems.push(
        `scene ${i} (chat): ${rel} was verified ${ageDays.toFixed(1)} days ago, past the ${TRANSCRIPT_MAX_AGE_DAYS} day limit. ` +
        `Re-run: npm run transcript -- --storyboard ${storyboard.id}`,
      );
      continue;
    }

    out[rel] = t;
  }

  if (problems.length) {
    const err = new Error('Refusing to render.\n  - ' + problems.join('\n  - '));
    err.name = 'TranscriptError';
    err.problems = problems;
    throw err;
  }

  return out;
}

/** Every capture scene must have a recording on disk before a render. */
export function assertCapturesPresent(storyboard, timelines) {
  const missing = [];
  for (const [i, scene] of storyboard.scenes.entries()) {
    if (scene.type !== 'capture') continue;
    if (!timelines[scene.shot]) {
      missing.push(`scene ${i} (capture): no captures/${scene.shot}.timeline.json`);
    } else if (!existsSync(resolve(paths.captures, `${scene.shot}.webm`))) {
      missing.push(`scene ${i} (capture): timeline exists but captures/${scene.shot}.webm does not`);
    }
  }
  if (missing.length) {
    const err = new Error(
      'Refusing to render.\n  - ' + missing.join('\n  - ') +
      '\nRun: npm run capture -- --shot <id>',
    );
    err.name = 'CaptureError';
    err.problems = missing;
    throw err;
  }
}
