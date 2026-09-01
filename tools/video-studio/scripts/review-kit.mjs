#!/usr/bin/env node
/**
 * Print the camera facts a frame-by-frame reviewer needs, in CUT time.
 *
 *   node scripts/review-kit.mjs connect-and-triage
 *
 * WHY THIS IS A SCRIPT AND NOT A ONE-OFF SNIPPET. The first version was a
 * throwaway, and it subtracted `clip.from` TWICE when converting a recorded
 * event time into cut time: once while building the anchor list and again
 * converting scene time to cut time. Every timestamp handed to the reviewer was
 * 1.6s early, so the review was reasoning about beats that were not where the
 * document said they were. A fact sheet that is confidently wrong is worse than
 * no fact sheet, so the conversion now lives in one named function with the
 * arithmetic spelled out, and the constants are read from one place.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { paths, readJson } from './lib/common.mjs';

const id = process.argv[2];
if (!id) {
  console.error('Pass a storyboard id: node scripts/review-kit.mjs <id>');
  process.exit(1);
}

const storyboard = readJson(resolve(paths.storyboards, `${id}.json`));
const manifest = readJson(resolve(paths.out, `${id}.json`));
const capture = storyboard.scenes.find((s) => s.type === 'capture');
const bound = manifest.boundaries.find((b) => b.type === 'capture');

const CLIP = capture?.clip?.from ?? 0;
const SPEED = capture?.speed ?? 1;
const SCENE_START = bound.startSeconds;

/** Recorded event time -> time in the finished cut. Subtract the clip ONCE. */
const toCut = (recorded) => SCENE_START + (recorded - CLIP) / SPEED;

// Mirrors src/scenes/Capture.tsx. Update together.
const HOLD = 1.4, GAP = 2.3, MINZ = 1.22, WM = 3.0, HM = 4.0, SPLIT = 0.32;
const HOVER = 0.6, TRAVEL = 0.45;
const MAXZ = capture?.maxZoom ?? 1.8;
const vw = 1920, vh = 1080;

const tl = readJson(resolve(paths.captures, `${capture.shot}.timeline.json`));
const evs = (tl.events ?? tl).filter((e) => e.rect);
const ideal = (r) => Math.min(MAXZ, Math.max(1, Math.min(vw / (r.width * WM), vh / (r.height * HM))));

const a = evs.map((e) => ({ t: e.t, dur: e.duration ?? 0, rect: e.rect, note: e.note, kind: e.kind }));
const wins = a.map((x, i) => ({
  start: x.t,
  end: Math.max(x.t, a[i + 1] ? Math.min(x.t + x.dur + HOLD * SPEED, a[i + 1].t) : x.t + x.dur + HOLD * SPEED),
  cx: (x.rect.x + x.rect.width / 2) / vw,
  cy: (x.rect.y + x.rect.height / 2) / vh,
  ideal: ideal(x.rect), note: x.note, kind: x.kind, rect: x.rect,
}));

const runs = [];
let cur = [];
wins.forEach((w, i) => {
  cur.push(w);
  const n = wins[i + 1];
  if (!n) { runs.push(cur); cur = []; return; }
  if (toCut(n.start) - toCut(w.end) > GAP) { runs.push(cur); cur = []; return; }
  if (Math.hypot(n.cx - w.cx, (n.cy - w.cy) * (vh / vw)) > SPLIT) { runs.push(cur); cur = []; }
});
if (cur.length) runs.push(cur);

const L = [];
L.push(`CUT ${id}: capture scene ${SCENE_START.toFixed(2)}s -> ${bound.endSeconds.toFixed(2)}s`);
L.push(`cut time = ${SCENE_START} + (recorded - ${CLIP}) / ${SPEED}`);
L.push('');
L.push('ANCHORS, in CUT time:');
for (const w of wins) {
  L.push(`  ${toCut(w.start).toFixed(2).padStart(6)}s  ${String(w.kind).padEnd(5)}  `
    + `centre(${(w.cx * 100).toFixed(0)}%,${(w.cy * 100).toFixed(0)}%)  `
    + `${String(w.rect.width + 'x' + w.rect.height).padEnd(9)}  ideal ${w.ideal.toFixed(2)}   ${w.note}`);
}
L.push('');
L.push('RUNS (one scale each; inside a run only the aim pans):');
for (const r of runs) {
  const sc = Math.min(MAXZ, Math.max(MINZ, Math.min(...r.map((x) => x.ideal))));
  L.push(`  ${toCut(r[0].start).toFixed(2)}s -> ${toCut(r[r.length - 1].end).toFixed(2)}s  `
    + `scale ${sc.toFixed(2)}  (${r.length}: ${r.map((x) => x.note).join(' | ')})`);
}
L.push('');
L.push(`GAPS BETWEEN RUNS (> CONTINUOUS_GAP ${GAP}s means the frame goes home):`);
if (runs.length < 2) L.push('  none, single run');
for (let i = 1; i < runs.length; i += 1) {
  const g = toCut(runs[i][0].start) - toCut(runs[i - 1][runs[i - 1].length - 1].end);
  L.push(`  run ${i} -> ${i + 1}: ${g.toFixed(2)}s  ${g > GAP ? 'RESTS (frame goes home)' : 'travels straight across'}`);
}
L.push('');
L.push('LARGEST JUMP INSIDE EACH RUN (must stay under RUN_SPLIT_DISTANCE ' + SPLIT + '):');
runs.forEach((r, i) => {
  let worst = 0, which = 'n/a';
  for (let k = 1; k < r.length; k += 1) {
    const j = Math.hypot(r[k].cx - r[k - 1].cx, (r[k].cy - r[k - 1].cy) * (vh / vw));
    if (j > worst) { worst = j; which = `${r[k - 1].note} -> ${r[k].note}`; }
  }
  L.push(`  run ${i + 1}: ${worst.toFixed(3)}  (${which})`);
});
L.push('');
L.push('POINTER, and the camera now pans on the SAME schedule:');
for (const w of wins) {
  const ev = toCut(w.start);
  L.push(`  sets off ${(ev - HOVER - TRAVEL).toFixed(2)}s -> settles ${(ev - HOVER).toFixed(2)}s -> event ${ev.toFixed(2)}s   ${w.note}`);
}

mkdirSync(resolve(paths.out, 'review'), { recursive: true });
writeFileSync(resolve(paths.out, 'review', 'FACTS.txt'), L.join('\n') + '\n');
console.log(L.join('\n'));
