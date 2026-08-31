/**
 * TypeScript mirror of the shapes enforced by src/storyboard-schema.mjs.
 *
 * The schema file is the authority: it is plain .mjs so that the node scripts
 * and the Remotion bundle can both load it without a TypeScript loader. These
 * types exist so the TSX side is checked. If you add a scene type, add it in
 * BOTH files and in AGENTS.md, which is what a future agent reads instead of
 * either.
 */

import type { ThemeName } from './theme';

export interface Clip {
  from: number;
  /** Optional when authored; the validator fills it in from the recording's
   *  length. Always present after validation. */
  to: number;
}

export interface Callout {
  /** Seconds from the start of the CLIP, not the start of the recording. */
  at: number;
  /** How long it stays up, in seconds. */
  for: number;
  text: string;
  /** Override the automatic placement. Default: opposite the event's rect. */
  anchor?: 'above' | 'below' | 'left' | 'right';
}

interface SceneBase {
  durationInSeconds: number;
  /** Computed by the validator. Never authored. */
  durationInFrames: number;
}

export interface TitleScene extends SceneBase {
  type: 'title';
  headline: string;
  sub?: string;
  align: string;
}

export interface CaptureScene extends SceneBase {
  type: 'capture';
  shot: string;
  clip?: Clip;
  speed: number;
  autoZoom: boolean;
  maxZoom: number;
  callouts: Callout[];
  frame: string;
}

export interface ChatScene extends SceneBase {
  type: 'chat';
  transcript: string;
  title: string;
}

export interface TerminalScene extends SceneBase {
  type: 'terminal';
  lines: string[];
  title: string;
  cps: number;
}

export interface OutroScene extends SceneBase {
  type: 'outro';
  cta: string;
  sub?: string;
}

export type Scene =
  | TitleScene
  | CaptureScene
  | ChatScene
  | TerminalScene
  | OutroScene;

export interface SceneBoundary {
  index: number;
  type: Scene['type'];
  startFrame: number;
  endFrame: number;
  startSeconds: number;
  endSeconds: number;
}

export interface Storyboard {
  id: string;
  width: number;
  height: number;
  fps: number;
  theme: ThemeName;
  voiceover?: string;
  captions: boolean;
  posterFrame?: number;
  scenes: Scene[];
  durationInFrames: number;
  boundaries: SceneBoundary[];
  /** Non-fatal notes from the validator, e.g. a clip trimmed to fit its
   *  recording. render prints these; they never block a render. */
  warnings: string[];
}

// --- capture timeline, written by scripts/capture.mjs ----------------------

export interface TimelineRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TimelineEvent {
  /** Seconds since the recording started. */
  t: number;
  kind: 'click' | 'type' | 'wait' | 'dwell' | 'navigate';
  note?: string;
  rect?: TimelineRect;
  masked?: boolean;
  /** For `type`: how long the typing lasted, so the caret can persist. */
  duration?: number;
}

export interface CaptureTimeline {
  shot: string;
  recordedAt: string;
  baseUrl: string;
  durationMs: number;
  viewport: { width: number; height: number };
  events: TimelineEvent[];
}

// --- transcript, written by scripts/transcript.mjs -------------------------

export interface TranscriptTurn {
  role: 'user' | 'tool' | 'assistant';
  text?: string;
  name?: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  summary?: string;
}

export interface Transcript {
  id: string;
  verifiedAt: string;
  endpoint: string;
  turns: TranscriptTurn[];
}

/**
 * Everything the render passes into the composition beyond the storyboard
 * itself: the loaded capture timelines and transcripts, resolved in Node where
 * the filesystem is available.
 */
export interface StoryboardProps {
  storyboard: Storyboard;
  timelines: Record<string, CaptureTimeline>;
  transcripts: Record<string, Transcript>;
}
