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

const ZOOM_IN = 0.4; // seconds to push in
const ZOOM_OUT = 0.5; // seconds to ease back out
const HOLD_AFTER_CLICK = 0.7; // seconds held on a click before releasing
const CURSOR_TRAVEL = 0.45; // seconds the cursor takes to reach the next target

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

  const { scale, originX, originY } = computeZoom(anchors, sceneSeconds, scene, vw, vh);
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

          {cursor ? <Cursor x={cursor.x / vw} y={cursor.y / vh} click={cursor.click} scale={scale} theme={theme} /> : null}
        </div>

        <Callouts scene={scene} anchors={anchors} sceneSeconds={sceneSeconds} theme={theme} vw={vw} vh={vh} />
      </div>
    </AbsoluteFill>
  );
};

/**
 * Push in on whichever event is currently in play, and rest at 1.0 between
 * them. Scale is capped: past roughly 1.8x a 1080p source visibly softens, and
 * a mushy zoom looks worse than no zoom.
 */
function computeZoom(
  anchors: Anchor[],
  t: number,
  scene: CaptureScene,
  vw: number,
  vh: number,
): { scale: number; originX: number; originY: number } {
  if (!scene.autoZoom || anchors.length === 0) return { scale: 1, originX: 0.5, originY: 0.5 };

  // The active anchor is the last one whose push-in has begun and whose
  // release has not finished.
  let active: Anchor | null = null;
  let progress = 0;

  for (const a of anchors) {
    const holdUntil = a.t + (a.event.duration ?? 0) / scene.speed + HOLD_AFTER_CLICK;
    const start = a.t - ZOOM_IN;
    const end = holdUntil + ZOOM_OUT;
    if (t < start || t > end) continue;

    active = a;
    if (t < a.t) {
      progress = easings.inOut(clamp01((t - start) / ZOOM_IN));
    } else if (t <= holdUntil) {
      progress = 1;
    } else {
      progress = 1 - easings.inOut(clamp01((t - holdUntil) / ZOOM_OUT));
    }
  }

  if (!active) return { scale: 1, originX: 0.5, originY: 0.5 };

  // Frame the rect with generous margin: filling the frame with a 168px button
  // loses the context that makes the shot readable.
  const c = centre(active.rect);
  const wanted = Math.min(
    scene.maxZoom,
    Math.max(1, Math.min(vw / (active.rect.width * 4.5), vh / (active.rect.height * 5.5))),
  );
  const scale = 1 + (wanted - 1) * progress;

  // Ease the origin toward the target as we push in, so consecutive events in
  // different corners do not whip the frame across at full scale.
  const ox = 0.5 + (c.x / vw - 0.5) * progress;
  const oy = 0.5 + (c.y / vh - 0.5) * progress;

  return { scale, originX: clamp01(ox), originY: clamp01(oy) };
}

/** Where the pointer is, and whether it is mid-click. Interpolated between
 *  event rects, because the recording contains no pointer to follow. */
function computeCursor(
  anchors: Anchor[],
  t: number,
  vw: number,
  vh: number,
): { x: number; y: number; click: number } | null {
  if (anchors.length === 0) return null;

  const first = anchors[0];
  if (t < first.t - CURSOR_TRAVEL) return null;

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
    const p = easings.out(clamp01((t - (first.t - CURSOR_TRAVEL)) / CURSOR_TRAVEL));
    x = interpolate(p, [0, 1], [vw * 0.72, c.x]);
    y = interpolate(p, [0, 1], [vh * 0.94, c.y]);
  } else if (next) {
    const travelStart = next.t - CURSOR_TRAVEL;
    if (t > travelStart) {
      const p = easings.inOut(clamp01((t - travelStart) / CURSOR_TRAVEL));
      const nc = centre(next.rect);
      x = interpolate(p, [0, 1], [c.x, nc.x]);
      y = interpolate(p, [0, 1], [c.y, nc.y]);
    }
  }

  // Click ripple: a short expanding ring on the frame the click lands.
  let click = 0;
  if (prev && prev.event.kind === 'click') {
    click = clamp01((t - prev.t) / 0.45);
    if (t - prev.t > 0.45) click = 0;
  }

  return { x, y, click };
}

const Cursor: React.FC<{
  x: number;
  y: number;
  click: number;
  scale: number;
  theme: ReturnType<typeof getTheme>;
}> = ({ x, y, click, scale, theme }) => {
  // Counter-scale so the pointer stays the same size on screen however far the
  // frame has pushed in. A cursor that grows with the zoom reads as a bug.
  const inv = 1 / scale;
  return (
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
      {click > 0 ? (
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: 22 + click * 62,
            height: 22 + click * 62,
            marginLeft: -(11 + click * 31),
            marginTop: -(11 + click * 31),
            borderRadius: 999,
            border: `2px solid ${theme.brand}`,
            opacity: (1 - click) * 0.85,
          }}
        />
      ) : null}
      <svg width={34} height={34} viewBox="0 0 24 24" style={{ display: 'block', filter: 'drop-shadow(0 2px 5px rgba(0,0,0,0.45))' }}>
        <path d="M5 2.5l13.2 8.1-5.9 1.2 3.2 6.3-2.6 1.3-3.2-6.3-4.7 3.7z" fill="#FFFFFF" stroke="#0B1020" strokeWidth="1.1" strokeLinejoin="round" />
      </svg>
    </div>
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
