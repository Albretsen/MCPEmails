import React from 'react';
import {
  AbsoluteFill,
  OffthreadVideo,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { clamp01, easings } from '../components/snap-cn';
import { getTheme, type ThemeName } from '../theme';
import type { CaptureScene, CaptureTimeline, TimelineEvent, TimelineRect } from '../storyboard-types';

/**
 * The composite scene: a real screen recording, plus everything Playwright
 * could not record.
 *
 * Playwright's video contains no cursor at all, so without the overlay drawn
 * from the event log the recording has an invisible protagonist: fields fill
 * themselves and buttons depress with nothing touching them. The auto zoom is
 * the other half. A 1920x1080 recording of a dashboard, played at 1920x1080,
 * puts the control being used at about 2% of the frame. Pushing in on the
 * event's own bounding box is what turns a test artifact into a product video,
 * and it costs nothing at author time because the boxes were recorded.
 *
 * Everything here is derived from captures/<shot>.timeline.json. Nothing is
 * positioned by hand, which is what lets a re-record land without a re-edit.
 */

// A full second, not the half it was. The push-in on a control has to READ
// before whatever the click does lands on top of it: the "Connect inbox"
// button opens a modal that covers it immediately, so a 0.4s ramp meant the
// button was only legible for about a third of a second. The ramp runs before
// the click, so this buys time out of the dwell that is already there.
const ZOOM_IN = 1.0; // seconds to push in
const ZOOM_OUT = 0.7; // seconds to ease back out
const HOLD_AFTER_CLICK = 1.4; // seconds held on a click before releasing
const CURSOR_TRAVEL = 0.45; // seconds the cursor takes to reach the next target
// Click-ring lifetime. Must stay well under HOVER_BEFORE_CLICK so the ring is
// always gone before the pointer leaves the control it marks.
const RIPPLE = 0.25;
// The cursor settles on a control this long BEFORE the event fires. Without it
// travel ended exactly on the event time, so the pointer arrived and the click
// ripple went off on the same frame: the button was never seen being pointed
// at, only being hit. A real hand rests on a control before pressing it.
const HOVER_BEFORE_CLICK = 0.6;
// Gap between two anchors above which the frame returns to rest rather than
// gliding straight on. Below it, travelling out and back would be a stutter.
const CONTINUOUS_GAP = 2.3; // seconds
const PAN = 0.35; // seconds the origin takes to slide to the next control
const MIN_RUN_ZOOM = 1.22; // a run never reads as "not zoomed at all"
// Centre-to-centre distance, as a fraction of frame width, above which two
// consecutive anchors are treated as different shots rather than one pan.
const RUN_SPLIT_DISTANCE = 0.32;
const WIDTH_MARGIN = 3.0; // frame at least this many rect-widths across
const HEIGHT_MARGIN = 4.0; // and this many rect-heights down

interface Anchor {
  t: number;
  rect: TimelineRect;
  event: TimelineEvent;
}

const centre = (r: TimelineRect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

const MissingCapture: React.FC<{ shot: string; themeName: ThemeName }> = ({ shot, themeName }) => {
  const theme = getTheme(themeName);
  return (
    <AbsoluteFill
      style={{
        background: theme.bgPage,
        color: theme.amber,
        fontFamily: theme.fontMono,
        fontSize: 26,
        padding: 120,
        justifyContent: 'center',
        gap: 14,
      }}
    >
      <div>No recording for shot: {shot}</div>
      <div style={{ color: theme.fg3, fontSize: 20 }}>Run: npm run capture -- --shot {shot}</div>
    </AbsoluteFill>
  );
};

export const Capture: React.FC<{
  scene: CaptureScene;
  timeline?: CaptureTimeline;
  themeName: ThemeName;
}> = ({ scene, timeline, themeName }) => {
  const theme = getTheme(themeName);
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  if (!timeline) return <MissingCapture shot={scene.shot} themeName={themeName} />;

  const clipFrom = scene.clip?.from ?? 0;
  // Time inside the SOURCE recording that this frame shows.
  const sceneSeconds = frame / fps;
  const sourceSeconds = clipFrom + sceneSeconds * scene.speed;

  const vw = timeline.viewport.width;
  const vh = timeline.viewport.height;

  // Events that fall inside the clip, expressed in scene time.
  const anchors: Anchor[] = timeline.events
    .filter((e): e is TimelineEvent & { rect: TimelineRect } => Boolean(e.rect))
    .map((e) => ({ t: (e.t - clipFrom) / scene.speed, rect: e.rect, event: e }))
    .filter((a) => a.t >= -ZOOM_IN && a.t <= (scene.durationInSeconds ?? Infinity) + ZOOM_OUT);

  // lookAt converts the camera's look-at point into a CSS transform-origin.
  const { scale, originX, originY } = lookAt(computeZoom(anchors, sceneSeconds, scene, vw, vh));
  const cursor = computeCursor(anchors, sceneSeconds, vw, vh);

  // The video is letterboxed into the composition, then the zoom transform is
  // applied about the point of interest. Doing it in one transform (rather than
  // scaling then translating) keeps the overlay and the video in lockstep: the
  // cursor is positioned in VIDEO coordinates inside the same transformed
  // container, so it can never drift from the control it is pointing at.
  const fit = Math.min(width / vw, height / vh);
  const stageW = vw * fit;
  const stageH = vh * fit;

  return (
    <AbsoluteFill style={{ background: theme.bgPage, alignItems: 'center', justifyContent: 'center' }}>
      <div
        style={{
          width: stageW,
          height: stageH,
          position: 'relative',
          overflow: 'hidden',
          borderRadius: scene.frame === 'none' ? 0 : 14,
          border: scene.frame === 'none' ? 'none' : `1px solid ${theme.border1}`,
          boxShadow: scene.frame === 'none' ? 'none' : theme.shadow4,
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            transform: `scale(${scale})`,
            transformOrigin: `${originX * 100}% ${originY * 100}%`,
          }}
        >
          <OffthreadVideo
            src={staticFile(`captures/${scene.shot}.webm`)}
            startFrom={Math.round(clipFrom * fps)}
            playbackRate={scene.speed}
            // The recording is muted: a screen capture's audio is room tone at
            // best, and the cut carries a voiceover.
            muted
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />

          {cursor ? (
            <Cursor
              x={cursor.x / vw}
              y={cursor.y / vh}
              click={cursor.click}
              rippleX={cursor.ripple ? cursor.ripple.x / vw : null}
              rippleY={cursor.ripple ? cursor.ripple.y / vh : null}
              scale={scale}
              theme={theme}
            />
          ) : null}
        </div>

        <Callouts scene={scene} anchors={anchors} sceneSeconds={sceneSeconds} theme={theme} vw={vw} vh={vh} />
      </div>
    </AbsoluteFill>
  );
};

/**
 * The camera path across a capture.
 *
 * WHY THIS IS NOT "push in on the active event, rest at 1.0 between".
 *
 * That was the first design and on a real recording it visibly pumped in and
 * out on every click. Three separate causes, all measurable in
 * captures/<shot>.timeline.json rather than matters of taste:
 *
 *   1. Consecutive anchors OVERLAP. A click holds for HOLD_AFTER_CLICK after it
 *      lands and a form is filled faster than that: in the add-inbox shot seven
 *      of eight consecutive pairs overlap. Picking "the last anchor whose
 *      window contains t" handed the frame to the NEXT anchor while its
 *      push-in progress was still near zero, so the scale fell to 1.0 and
 *      immediately climbed again.
 *   2. Releasing to 1.0 between two clicks 0.6s apart spends the whole gap
 *      travelling out and back for nothing. The eye is thrown to full frame and
 *      dragged in again.
 *   3. The real culprit: the target scale was computed PER CONTROL, from that
 *      control's own width. A 143px button wants 1.8x; the 418px email field
 *      next to it wants 1.02x, which is no zoom at all. So the camera lurched
 *      between deep and flat as the shot moved from a button to a field and
 *      back, which is what the pumping actually was.
 *
 * So anchors are grouped into RUNS separated by gaps longer than
 * CONTINUOUS_GAP, and a run is shot at ONE scale: the tightest that still
 * frames every anchor in it. Within a run only the origin moves, panning from
 * control to control the way an operator would, and the scale never changes.
 * The frame returns to rest only between runs, which here is the wait while the
 * server actually opens the IMAP session: pulling back to the whole page while
 * something happens off screen is motivated, pulling back between two adjacent
 * form fields is not.
 *
 * Scale is still capped by maxZoom: past roughly 1.8x a 1080p source visibly
 * softens, and a mushy zoom looks worse than no zoom.
 */

interface Cam {
  scale: number;
  originX: number;
  originY: number;
}

const REST: Cam = { scale: 1, originX: 0.5, originY: 0.5 };

/**
 * The tightest scale that still frames one rect with room around it. The
 * margins are what "with room around it" means: a control needs context to be
 * readable, and filling the frame with a button loses the page it sits on.
 */
function idealScale(rect: TimelineRect, scene: CaptureScene, vw: number, vh: number): number {
  return Math.min(
    scene.maxZoom,
    Math.max(1, Math.min(vw / (rect.width * WIDTH_MARGIN), vh / (rect.height * HEIGHT_MARGIN))),
  );
}

/**
 * Turn a "look at this point" origin into the CSS transform-origin that puts
 * that point in the middle of the frame.
 *
 * A CSS transform-origin is the point that stays FIXED while the element
 * scales, NOT the point the camera centres on. Storing the anchor's own
 * position there magnified the page ABOUT the control and left it exactly where
 * it already sat: a button 78% down the page stayed 78% down the frame at any
 * zoom. That is why the modal's footer fell off the bottom edge, why the
 * pointer walked out of the crop reaching for it, and why the payoff shot put
 * the connected row in the top quarter with white space under it. The camera
 * was magnifying, never aiming.
 *
 * Solving `o + (c - o) * S = 0.5` for `o` gives the origin that lands `c` dead
 * centre. Clamped to [0,1] so the frame still cannot show past the edge of the
 * recording, which is what keeps a corner control as tightly framed as the
 * source allows instead of drifting off it.
 */
function lookAt(cam: Cam): Cam {
  if (cam.scale <= 1.0001) return { scale: cam.scale, originX: 0.5, originY: 0.5 };
  const d = cam.scale - 1;
  return {
    scale: cam.scale,
    originX: clamp01((cam.originX * cam.scale - 0.5) / d),
    originY: clamp01((cam.originY * cam.scale - 0.5) / d),
  };
}

function mix(a: Cam, b: Cam, p: number): Cam {
  const q = clamp01(p);
  return {
    scale: a.scale + (b.scale - a.scale) * q,
    originX: clamp01(a.originX + (b.originX - a.originX) * q),
    originY: clamp01(a.originY + (b.originY - a.originY) * q),
  };
}

interface Win {
  start: number;
  end: number;
  cx: number;
  cy: number;
  ideal: number;
}

interface Run {
  wins: Win[];
  start: number;
  end: number;
  scale: number;
  /** Where the previous run left the frame, when it butts straight onto this
   *  one with no gap at all to travel across. */
  from?: Cam;
  /** The next run, when it follows closely enough to glide to rather than
   *  going home in between. */
  nextStart?: number;
  nextCam?: Cam;
}

function buildRuns(anchors: Anchor[], scene: CaptureScene, vw: number, vh: number): Run[] {
  // Each anchor owns a window, truncated when the next anchor begins inside it
  // so the windows tile instead of overlapping and no two are ever active.
  const wins: Win[] = anchors.map((a, i) => {
    const rawEnd = a.t + (a.event.duration ?? 0) / scene.speed + HOLD_AFTER_CLICK;
    const next = anchors[i + 1];
    const c = centre(a.rect);
    return {
      start: a.t,
      end: Math.max(a.t, next ? Math.min(rawEnd, next.t) : rawEnd),
      cx: clamp01(c.x / vw),
      cy: clamp01(c.y / vh),
      ideal: idealScale(a.rect, scene, vw, vh),
    };
  });

  const runs: Run[] = [];
  let current: Win[] = [];

  const flush = () => {
    if (!current.length) return;
    // One scale for the whole run: the tightest that still frames every anchor
    // in it, so a wide field does not flatten the shot and a small button does
    // not spike it. Floored, or a single wide control would mean no zoom at all.
    const tightest = Math.min(...current.map((w) => w.ideal));
    runs.push({
      wins: current,
      start: current[0].start,
      end: current[current.length - 1].end,
      scale: Math.min(scene.maxZoom, Math.max(MIN_RUN_ZOOM, tightest)),
    });
    current = [];
  };

  wins.forEach((w, i) => {
    current.push(w);
    const next = wins[i + 1];
    if (!next) return flush();

    // A long pause: there is nothing to look at, so the frame goes home.
    if (next.start - w.end > CONTINUOUS_GAP) return flush();

    // A big spatial jump: pan for small moves, re-frame for large ones. Panning
    // a long way at full zoom whips the frame across, and more importantly it
    // forces both ends into ONE scale. That is what buried the "Connect inbox"
    // button: it sits in the top-right corner, 53% of the frame away from the
    // provider grid, and sharing a run with the credential fields dragged the
    // whole sequence down to the widest framing any of them needed, so the
    // button that opens the flow was 11% of the frame.
    const jump = Math.hypot(next.cx - w.cx, (next.cy - w.cy) * (vh / vw));
    if (jump > RUN_SPLIT_DISTANCE) flush();
  });
  flush();

  // An adjacent run is a re-frame, not a return to rest. The frame travels from
  // one run's last framing to the next one's first across whatever gap sits
  // between them, so a split never reintroduces the pop-out the split exists to
  // avoid. Only a run that butts on with no gap at all needs `from`, because
  // there is no time to travel and the move has to happen inside the next run's
  // own pan.
  for (let i = 1; i < runs.length; i += 1) {
    const prev = runs[i - 1];
    const gap = runs[i].start - prev.end;
    if (gap > CONTINUOUS_GAP) continue;

    const head = runs[i].wins[0];
    prev.nextStart = runs[i].start;
    prev.nextCam = { scale: runs[i].scale, originX: head.cx, originY: head.cy };

    if (gap < 0.001) {
      const last = prev.wins[prev.wins.length - 1];
      runs[i].from = { scale: prev.scale, originX: last.cx, originY: last.cy };
    }
  }

  return runs;
}

/** Where the frame sits inside a run: fixed scale, origin panning between
 *  controls so consecutive anchors do not cut from one framing to another. */
function camInRun(run: Run, t: number): Cam {
  // Select from the moment the pan STARTS, not from the event, or the pan below
  // could never run: the window it belongs to would not yet be current.
  let idx = 0;
  for (let i = 0; i < run.wins.length; i += 1) {
    if (t >= run.wins[i].start - HOVER_BEFORE_CLICK - CURSOR_TRAVEL) idx = i;
  }
  const w = run.wins[idx];
  const target: Cam = { scale: run.scale, originX: w.cx, originY: w.cy };

  // The pan is tied to the POINTER's travel window, not to the event.
  //
  // Panning from `w.start` left the frame aimed at the PREVIOUS control at the
  // instant of every click, arriving only PAN seconds late, while the pointer
  // had been scheduled to set off HOVER_BEFORE_CLICK + CURSOR_TRAVEL earlier.
  // The two were computed independently and never reconciled, so the pointer
  // walked out of the crop toward a control the camera had not begun moving to.
  // Now they leave together and both settle HOVER_BEFORE_CLICK before the click.
  const panStart = w.start - HOVER_BEFORE_CLICK - CURSOR_TRAVEL;
  if (t >= panStart + CURSOR_TRAVEL) return target;

  const prev = run.wins[idx - 1];
  // Inside the run, pan from the previous control. On the run's first window,
  // blend out of the previous run's framing if it ran straight into this one.
  const from: Cam | undefined = prev
    ? { scale: run.scale, originX: prev.cx, originY: prev.cy }
    : run.from;
  if (!from) return target;

  return mix(from, target, easings.inOut((t - panStart) / CURSOR_TRAVEL));
}

function computeZoom(
  anchors: Anchor[],
  t: number,
  scene: CaptureScene,
  vw: number,
  vh: number,
): Cam {
  if (!scene.autoZoom || anchors.length === 0) return REST;

  const runs = buildRuns(anchors, scene, vw, vh);

  for (const run of runs) {
    // A run covers itself, its lead-in, and either the travel to the next run
    // or the ease back to rest.
    const coverEnd = run.nextStart ?? run.end + ZOOM_OUT;
    if (t < run.start - ZOOM_IN || t >= coverEnd) continue;

    if (t < run.start) {
      // Entered by the previous run's travel, or by its own pan when the two
      // butt together. Either way, not by a push-in from rest.
      if (run.from) continue;
      return mix(REST, camInRun(run, run.start), easings.inOut((t - (run.start - ZOOM_IN)) / ZOOM_IN));
    }
    if (t < run.end) return camInRun(run, t);

    const held = camInRun(run, run.end);
    if (run.nextCam && run.nextStart !== undefined) {
      const gap = run.nextStart - run.end;
      return gap > 0.001 ? mix(held, run.nextCam, easings.inOut((t - run.end) / gap)) : held;
    }
    return mix(held, REST, easings.inOut((t - run.end) / ZOOM_OUT));
  }

  return REST;
}

/** Where the pointer is, and whether it is mid-click. Interpolated between
 *  event rects, because the recording contains no pointer to follow. */
function computeCursor(
  anchors: Anchor[],
  t: number,
  vw: number,
  vh: number,
): { x: number; y: number; click: number; ripple: { x: number; y: number } | null } | null {
  if (anchors.length === 0) return null;

  const first = anchors[0];
  if (t < first.t - HOVER_BEFORE_CLICK - CURSOR_TRAVEL) return null;

  let prev: Anchor | null = null;
  let next: Anchor | null = null;
  for (const a of anchors) {
    if (a.t <= t) prev = a;
    else {
      next = a;
      break;
    }
  }

  const target = prev ?? first;
  const c = centre(target.rect);

  let x = c.x;
  let y = c.y;

  if (!prev) {
    // Approaching the first event: come in from just off the lower right, the
    // way a hand does, rather than materialising on the button.
    // Arrive early and rest: clamp01 holds the pointer on the target once the
    // travel completes, which is the hover.
    const arriveAt = first.t - HOVER_BEFORE_CLICK;
    const p = easings.out(clamp01((t - (arriveAt - CURSOR_TRAVEL)) / CURSOR_TRAVEL));
    x = interpolate(p, [0, 1], [vw * 0.72, c.x]);
    y = interpolate(p, [0, 1], [vh * 0.94, c.y]);
  } else if (next) {
    const travelStart = next.t - HOVER_BEFORE_CLICK - CURSOR_TRAVEL;
    if (t > travelStart) {
      const p = easings.inOut(clamp01((t - travelStart) / CURSOR_TRAVEL));
      const nc = centre(next.rect);
      x = interpolate(p, [0, 1], [c.x, nc.x]);
      y = interpolate(p, [0, 1], [c.y, nc.y]);
    }
  }

  // Click ripple: a short expanding ring where the click LANDED.
  //
  // Two things were wrong with drawing it at the pointer. The pointer starts
  // travelling to the next control HOVER_BEFORE_CLICK + CURSOR_TRAVEL before
  // that anchor, which overlapped the tail of a 0.45s ripple and dragged the
  // ring off its target, so a click on "Enter credentials" finished as a ring
  // floating over a paragraph of body copy 180px away. And the very first
  // anchor's rect was measured on the pre-click page, where the modal that
  // opens 80ms later happens to put a competitor's tile, so a full ring was
  // drawn over "Yahoo Mail".
  //
  // So the ring is pinned to the rect that was actually clicked, and shortened
  // to RIPPLE seconds, which is short enough that it can never outlive the
  // pointer's stay on that control.
  let click = 0;
  let ripple: { x: number; y: number } | null = null;
  if (prev && prev.event.kind === 'click' && t - prev.t <= RIPPLE) {
    click = clamp01((t - prev.t) / RIPPLE);
    const pc = centre(prev.rect);
    ripple = { x: pc.x, y: pc.y };
  }

  return { x, y, click, ripple };
}

const Cursor: React.FC<{
  x: number;
  y: number;
  click: number;
  rippleX: number | null;
  rippleY: number | null;
  scale: number;
  theme: ReturnType<typeof getTheme>;
}> = ({ x, y, click, rippleX, rippleY, scale, theme }) => {
  // Counter-scale so the pointer stays the same size on screen however far the
  // frame has pushed in. A cursor that grows with the zoom reads as a bug.
  const inv = 1 / scale;
  return (
    <>
      {/* The ring is a SIBLING of the pointer, not a child, so it stays on the
          control that was clicked while the pointer moves on. */}
      {click > 0 && rippleX !== null && rippleY !== null ? (
        <div
          style={{
            position: 'absolute',
            left: `${rippleX * 100}%`,
            top: `${rippleY * 100}%`,
            transform: `scale(${inv})`,
            transformOrigin: '50% 50%',
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              width: 22 + click * 62,
              height: 22 + click * 62,
              marginLeft: -(11 + click * 31),
              marginTop: -(11 + click * 31),
              borderRadius: 999,
              border: `2px solid ${theme.brand}`,
              opacity: (1 - click) * 0.85,
            }}
          />
        </div>
      ) : null}
      <div
        style={{
          position: 'absolute',
          left: `${x * 100}%`,
          top: `${y * 100}%`,
          transform: `translate(-4px, -2px) scale(${inv})`,
          transformOrigin: '0 0',
          pointerEvents: 'none',
        }}
      >
        <svg width={34} height={34} viewBox="0 0 24 24" style={{ display: 'block', filter: 'drop-shadow(0 2px 5px rgba(0,0,0,0.45))' }}>
          <path d="M5 2.5l13.2 8.1-5.9 1.2 3.2 6.3-2.6 1.3-3.2-6.3-4.7 3.7z" fill="#FFFFFF" stroke="#0B1020" strokeWidth="1.1" strokeLinejoin="round" />
        </svg>
      </div>
    </>
  );
};

/**
 * Callouts sit OUTSIDE the zoom transform, in composition space, so they stay
 * legible at a fixed size and never get scaled with the frame. Placement flips
 * to whichever side of the anchor has room, so a callout never covers the thing
 * it is describing.
 */
const Callouts: React.FC<{
  scene: CaptureScene;
  anchors: Anchor[];
  sceneSeconds: number;
  theme: ReturnType<typeof getTheme>;
  vw: number;
  vh: number;
}> = ({ scene, anchors, sceneSeconds, theme }) => (
  <>
    {scene.callouts.map((c, i) => {
      const local = sceneSeconds - c.at;
      if (local < -0.3 || local > c.for) return null;

      const inP = easings.out(clamp01((local + 0.3) / 0.45));
      const outP = 1 - easings.in(clamp01((local - (c.for - 0.35)) / 0.35));
      const opacity = Math.min(inP, outP);

      // Anchor to the nearest event in time, so the bubble points at whatever
      // is actually being used at that moment.
      const nearest = anchors.reduce<Anchor | null>((best, a) => {
        if (!best) return a;
        return Math.abs(a.t - c.at) < Math.abs(best.t - c.at) ? a : best;
      }, null);

      const anchorY = nearest ? (nearest.rect.y + nearest.rect.height / 2) / 1080 : 0.5;
      const side = c.anchor ?? (anchorY > 0.5 ? 'above' : 'below');

      return (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: '50%',
            [side === 'above' ? 'top' : 'bottom']: '7%',
            transform: `translate(-50%, ${(1 - inP) * 14}px)`,
            opacity,
            maxWidth: '62%',
            background: theme.overlay,
            color: theme.overlayFg,
            border: `1px solid ${theme.border2}`,
            borderRadius: 14,
            boxShadow: theme.shadow4,
            padding: '18px 26px',
            fontFamily: theme.fontSans,
            fontSize: 30,
            lineHeight: 1.35,
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            gap: 16,
          }}
        >
          <div style={{ width: 4, alignSelf: 'stretch', borderRadius: 2, background: theme.brand, flexShrink: 0 }} />
          {c.text}
        </div>
      );
    })}
  </>
);
