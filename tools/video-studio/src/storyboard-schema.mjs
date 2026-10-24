/**
 * The storyboard contract, and its validator.
 *
 * This file is plain .mjs with JSDoc types rather than .ts, on purpose: the
 * node scripts (render, verify) and the Remotion bundle both need it, and
 * Remotion's bundler handles .mjs while `node` will not run .ts without a
 * loader. src/storyboard-types.ts mirrors these shapes for the TSX side.
 *
 * Design rules this enforces, from the development guide:
 *   - Seconds at the authoring layer. Frames are computed once, downstream.
 *   - Every failure names the scene INDEX and the offending KEY, because a
 *     schema error discovered at second 3 of a nine minute render is a wasted
 *     nine minutes.
 *   - Unknown keys are errors, not warnings. A typo that silently does nothing
 *     is the worst outcome: the render succeeds and the video is wrong.
 */

import { lintCopy } from './copy-lint.mjs';

export const SCENE_TYPES = ['title', 'capture', 'chat', 'terminal', 'outro', 'clip', 'query'];

/**
 * `format` picks the canvas and the layout rules every scene follows.
 * "vertical" is the 9:16 short (TikTok, Reels, Shorts): 1080x1920, text kept
 * out of the bottom 20% and the right-hand button rail. See src/layout.tsx.
 */
export const FORMATS = {
  landscape: { width: 1920, height: 1080 },
  vertical: { width: 1080, height: 1920 },
};

/** Where a query card says the question came from. Shown as a display name. */
export const QUERY_PLATFORMS = {
  reddit: 'Reddit',
  x: 'X',
  'hacker-news': 'Hacker News',
  'stack-overflow': 'Stack Overflow',
  github: 'GitHub',
  discord: 'Discord',
  forum: 'a forum',
  quora: 'Quora',
};

/** Keys whose values a viewer reads or hears. Linted by src/copy-lint.mjs. */
const COPY_KEYS = new Set(['headline', 'sub', 'cta', 'text', 'question', 'caption', 'label', 'lead']);

/**
 * How much a clip may overrun its recording before it is an error rather than
 * jitter. Half a second is far longer than the run-to-run variance of a capture
 * and far shorter than any deliberate mis-edit.
 */
const CLIP_OVERSHOOT_TOLERANCE = 0.5;

/**
 * Per scene type: which keys are required, which are optional, and the default
 * applied when an optional key is absent. `undefined` as a default means the
 * key stays absent.
 *
 * `durationInSeconds` is required everywhere EXCEPT `capture`, where it is
 * derived from the clip.
 */
const SCENE_SPEC = {
  title: {
    required: { durationInSeconds: 'number', headline: 'string' },
    optional: { sub: ['string', undefined], align: ['string', 'center'] },
  },
  capture: {
    required: { shot: 'string' },
    optional: {
      // Derived from the clip when absent. Present only to allow an override.
      durationInSeconds: ['number', undefined],
      clip: ['clip', undefined],
      speed: ['number', 1],
      autoZoom: ['boolean', true],
      maxZoom: ['number', 1.8],
      callouts: ['callouts', []],
      frame: ['string', 'browser'],
    },
  },
  chat: {
    required: { transcript: 'string', durationInSeconds: 'number' },
    optional: { title: ['string', 'Your AI assistant'] },
  },
  terminal: {
    required: { durationInSeconds: 'number', lines: 'lines' },
    optional: { title: ['string', 'Terminal'], cps: ['number', 28] },
  },
  outro: {
    required: { durationInSeconds: 'number', cta: 'string' },
    optional: { sub: ['string', undefined] },
  },
  // An external mp4, typically a generated hook. Always carries the
  // "AI-generated" badge: there is deliberately no key to turn it off.
  clip: {
    required: { durationInSeconds: 'number', src: 'string' },
    optional: {
      from: ['number', 0],
      caption: ['string', undefined],
      muted: ['boolean', true],
    },
  },
  // A paraphrased real question, with where it was asked. The URL is evidence
  // for post.json and is never drawn: it may carry a username.
  query: {
    required: { durationInSeconds: 'number', question: 'string', platform: 'string', sourceUrl: 'string' },
    optional: { lead: ['string', undefined] },
  },
};

const TOP_REQUIRED = { id: 'string', scenes: 'array' };
const TOP_OPTIONAL = {
  width: ['number', 1920],
  height: ['number', 1080],
  fps: ['number', 30],
  theme: ['string', 'dark'],
  voiceover: ['string', undefined],
  captions: ['boolean', false],
  posterFrame: ['number', undefined],
  format: ['string', 'landscape'],
  // true = written by a routine with nobody watching. Refuses capture scenes,
  // which need a human-signed-in browser session.
  automated: ['boolean', false],
  timer: ['timer', undefined],
  post: ['post', undefined],
};

class StoryboardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StoryboardError';
  }
}

const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

function checkPrimitive(where, key, value, expected) {
  const actual = typeOf(value);

  if (expected === 'clip') {
    if (actual !== 'object') {
      throw new StoryboardError(`${where}: "clip" must be an object like { "from": 1.2, "to": 34 }, got ${actual}.`);
    }
    for (const k of Object.keys(value)) {
      if (k !== 'from' && k !== 'to') {
        throw new StoryboardError(`${where}: "clip" has unknown key "${k}". Only "from" and "to" are allowed.`);
      }
    }
    // "from" is optional: left out, the scene starts where the page painted,
    // which capture measures per recording. That is more robust than any number
    // you can write here, so prefer omitting it.
    if (value.from !== undefined && typeOf(value.from) !== 'number') {
      throw new StoryboardError(`${where}: "clip.from" must be a number, in seconds, or left out to start where the page painted.`);
    }
    // "to" is optional, and leaving it out is usually right. Trimming the HEAD
    // is a stable decision: a recording always opens on the browser's first
    // paint, which is a black frame. Pinning the TAIL to an exact number is
    // what breaks on the next take, because a recording's length depends on how
    // fast the site answered that day.
    if (value.to !== undefined) {
      if (typeOf(value.to) !== 'number') {
        throw new StoryboardError(`${where}: "clip.to" must be a number, in seconds, or left out to run to the end of the recording.`);
      }
      if (value.from !== undefined && value.to <= value.from) {
        throw new StoryboardError(`${where}: "clip.to" (${value.to}) must be greater than "clip.from" (${value.from}).`);
      }
    }
    if (value.from !== undefined && value.from < 0) {
      throw new StoryboardError(`${where}: "clip.from" must not be negative.`);
    }
    return;
  }

  if (expected === 'callouts') {
    if (actual !== 'array') {
      throw new StoryboardError(`${where}: "callouts" must be an array, got ${actual}.`);
    }
    value.forEach((c, ci) => {
      const cw = `${where}, callout ${ci}`;
      if (typeOf(c) !== 'object') {
        throw new StoryboardError(`${cw}: must be an object with "at", "for" and "text".`);
      }
      for (const k of Object.keys(c)) {
        if (!['at', 'for', 'text', 'anchor'].includes(k)) {
          throw new StoryboardError(`${cw}: unknown key "${k}". Allowed: at, for, text, anchor.`);
        }
      }
      if (typeOf(c.at) !== 'number') throw new StoryboardError(`${cw}: "at" must be a number, in seconds from the start of the CLIP.`);
      if (typeOf(c.for) !== 'number' || c.for <= 0) throw new StoryboardError(`${cw}: "for" must be a positive number of seconds.`);
      if (typeOf(c.text) !== 'string' || !c.text.trim()) throw new StoryboardError(`${cw}: "text" must be a non-empty string.`);
      const problems = lintCopy(c.text, `${cw}: "text"`);
      if (problems.length) throw new StoryboardError(problems[0]);
    });
    return;
  }

  if (expected === 'timer') {
    if (actual !== 'object') {
      throw new StoryboardError(`${where}: "timer" must be an object like { "from": 1, "to": 2 }, got ${actual}.`);
    }
    for (const k of Object.keys(value)) {
      if (!['from', 'to', 'label'].includes(k)) {
        throw new StoryboardError(`${where}: "timer" has unknown key "${k}". Allowed: from, to, label.`);
      }
    }
    for (const k of ['from', 'to']) {
      if (!Number.isInteger(value[k]) || value[k] < 0) {
        throw new StoryboardError(`${where}: "timer.${k}" must be a scene index (an integer from 0).`);
      }
    }
    if (value.label !== undefined) checkPrimitive(where, 'label', value.label, 'string');
    return;
  }

  if (expected === 'post') {
    if (actual !== 'object') {
      throw new StoryboardError(`${where}: "post" must be an object like { "caption": "...", "hashtags": ["#email"] }, got ${actual}.`);
    }
    for (const k of Object.keys(value)) {
      if (!['caption', 'hashtags', 'sourceUrl'].includes(k)) {
        throw new StoryboardError(`${where}: "post" has unknown key "${k}". Allowed: caption, hashtags, sourceUrl.`);
      }
    }
    if (typeOf(value.caption) !== 'string' || !value.caption.trim()) {
      throw new StoryboardError(`${where}: "post.caption" must be a non-empty string.`);
    }
    if (value.caption.length > 2200) {
      throw new StoryboardError(`${where}: "post.caption" is ${value.caption.length} characters. TikTok's limit is 2200.`);
    }
    checkPrimitive(where, 'caption', value.caption, 'string');
    if (value.hashtags !== undefined) {
      if (!Array.isArray(value.hashtags) || value.hashtags.length > 8) {
        throw new StoryboardError(`${where}: "post.hashtags" must be an array of at most 8 tags.`);
      }
      for (const h of value.hashtags) {
        if (typeOf(h) !== 'string' || !/^#?[A-Za-z0-9_]{2,40}$/.test(h)) {
          throw new StoryboardError(`${where}: hashtag ${JSON.stringify(h)} must be letters, digits or underscores, with or without a leading #.`);
        }
        checkPrimitive(where, 'label', h, 'string');
      }
    }
    if (value.sourceUrl !== undefined && !/^https:\/\/\S+$/.test(String(value.sourceUrl))) {
      throw new StoryboardError(`${where}: "post.sourceUrl" must be an https URL.`);
    }
    return;
  }

  if (expected === 'lines') {
    if (actual !== 'array' || value.length === 0) {
      throw new StoryboardError(`${where}: "lines" must be a non-empty array of strings.`);
    }
    value.forEach((l, li) => {
      if (typeOf(l) !== 'string') {
        throw new StoryboardError(`${where}: "lines[${li}]" must be a string, got ${typeOf(l)}.`);
      }
      const problems = lintCopy(l, `${where}: "lines[${li}]"`);
      if (problems.length) throw new StoryboardError(problems[0]);
    });
    return;
  }

  if (actual !== expected) {
    throw new StoryboardError(`${where}: "${key}" must be a ${expected}, got ${actual}.`);
  }
  if (expected === 'number' && !Number.isFinite(value)) {
    throw new StoryboardError(`${where}: "${key}" must be a finite number.`);
  }
  if (expected === 'string' && value.includes('—')) {
    throw new StoryboardError(`${where}: "${key}" contains an em dash. House style forbids them in on-screen text. Use a comma, colon or full stop.`);
  }
  if (expected === 'string' && COPY_KEYS.has(key)) {
    const problems = lintCopy(value, `${where}: "${key}"`);
    if (problems.length) throw new StoryboardError(problems[0]);
  }
}

function applySpec(where, obj, required, optional) {
  const out = {};
  const known = new Set([...Object.keys(required), ...Object.keys(optional)]);

  for (const [key, expected] of Object.entries(required)) {
    if (!(key in obj)) {
      throw new StoryboardError(`${where}: missing required key "${key}".`);
    }
    checkPrimitive(where, key, obj[key], expected);
    out[key] = obj[key];
  }

  for (const [key, [expected, fallback]] of Object.entries(optional)) {
    if (key in obj && obj[key] !== undefined) {
      checkPrimitive(where, key, obj[key], expected);
      out[key] = obj[key];
    } else if (fallback !== undefined) {
      out[key] = fallback;
    }
  }

  for (const key of Object.keys(obj)) {
    if (!known.has(key) && key !== 'type') {
      const list = [...known].sort().join(', ');
      throw new StoryboardError(`${where}: unknown key "${key}". Allowed keys: ${list}.`);
    }
  }

  return out;
}

/**
 * Validate and normalise a storyboard. Returns a new object with every default
 * filled in and `durationInFrames` computed per scene. Throws StoryboardError
 * with a message naming the scene index on the first problem found.
 *
 * `captureDurations` maps a shot id to the recorded duration in seconds. It is
 * only needed when a capture scene has no `clip` and no explicit
 * `durationInSeconds`. Pass `{}` for a pure schema check that does not need the
 * capture files to exist yet.
 */
export function validateStoryboard(raw, captureDurations = {}) {
  const warnings = [];

  if (typeOf(raw) !== 'object') {
    throw new StoryboardError(`Storyboard must be a JSON object, got ${typeOf(raw)}.`);
  }

  const top = applySpec('storyboard', raw, TOP_REQUIRED, TOP_OPTIONAL);

  if (!/^[a-z0-9][a-z0-9-]*$/.test(top.id)) {
    throw new StoryboardError(`storyboard: "id" must be lower-case kebab-case (it becomes the output filename), got "${top.id}".`);
  }
  if (!Object.hasOwn(FORMATS, top.format)) {
    throw new StoryboardError(`storyboard: "format" must be ${Object.keys(FORMATS).map((f) => `"${f}"`).join(' or ')}, got "${top.format}".`);
  }
  // The format owns the canvas. Width and height are only defaults for the
  // landscape cut, so a vertical storyboard that also writes 1920x1080 is a
  // contradiction, not an override.
  if (top.format === 'vertical') {
    const wantW = FORMATS.vertical.width;
    const wantH = FORMATS.vertical.height;
    if (('width' in raw && raw.width !== wantW) || ('height' in raw && raw.height !== wantH)) {
      throw new StoryboardError(`storyboard: "format": "vertical" is ${wantW}x${wantH}. Leave "width" and "height" out.`);
    }
    top.width = wantW;
    top.height = wantH;
    if (!top.post) {
      throw new StoryboardError('storyboard: a vertical short needs "post": { "caption", "hashtags" }, which verify writes to out/<id>.post.json for the person who publishes it.');
    }
  }
  if (!['dark', 'light'].includes(top.theme)) {
    throw new StoryboardError(`storyboard: "theme" must be "dark" or "light", got "${top.theme}".`);
  }
  if (!Number.isInteger(top.fps) || top.fps < 1) {
    throw new StoryboardError(`storyboard: "fps" must be a positive integer, got ${top.fps}.`);
  }
  for (const dim of ['width', 'height']) {
    if (!Number.isInteger(top[dim]) || top[dim] % 2 !== 0) {
      // H.264 with yuv420p needs even dimensions. Failing here beats failing
      // inside ffmpeg after the frames are rendered.
      throw new StoryboardError(`storyboard: "${dim}" must be an even integer (H.264 yuv420p requires it), got ${top[dim]}.`);
    }
  }
  if (top.scenes.length === 0) {
    throw new StoryboardError('storyboard: "scenes" is empty. A storyboard needs at least one scene.');
  }
  if (top.captions && !top.voiceover) {
    throw new StoryboardError('storyboard: "captions" is true but "voiceover" is not set. Captions are generated from the voiceover audio, so there is nothing to transcribe.');
  }

  const scenes = top.scenes.map((scene, i) => {
    const where = `scene ${i}`;
    if (typeOf(scene) !== 'object') {
      throw new StoryboardError(`${where}: must be an object, got ${typeOf(scene)}.`);
    }
    const type = scene.type;
    if (typeof type !== 'string') {
      throw new StoryboardError(`${where}: missing "type". One of: ${SCENE_TYPES.join(', ')}.`);
    }
    if (!SCENE_TYPES.includes(type)) {
      throw new StoryboardError(`${where}: unknown type "${type}". One of: ${SCENE_TYPES.join(', ')}.`);
    }

    if (top.automated && type === 'capture') {
      throw new StoryboardError(`${where}: an "automated" storyboard cannot use a capture scene. Captures need a human-signed-in browser session. Use chat, terminal, title, query or clip.`);
    }

    const spec = SCENE_SPEC[type];
    const w = `${where} (${type})`;
    const norm = applySpec(w, scene, spec.required, spec.optional);
    norm.type = type;

    if (type === 'capture') {
      // The second argument accepts a bare duration or a richer
      // { duration, contentStart } record, so older callers keep working.
      const rawMeta = captureDurations[norm.shot];
      const meta =
        typeof rawMeta === 'number'
          ? { duration: rawMeta, contentStart: 0 }
          : rawMeta ?? null;
      const recorded = meta ? meta.duration : undefined;
      const contentStart = meta ? meta.contentStart ?? 0 : 0;
      let seconds = norm.durationInSeconds;

      // No clip at all, or a clip with no "from": start where the page painted.
      // Guessing a fixed head trim in the storyboard does not survive a slow
      // load, which is how an unpainted frame reached a clean-room render.
      if (!norm.clip && typeof recorded === 'number' && contentStart > 0) {
        norm.clip = { from: contentStart, to: recorded };
      } else if (norm.clip && norm.clip.from === undefined) {
        norm.clip = { ...norm.clip, from: contentStart };
      }

      if (norm.clip && norm.clip.to === undefined) {
        if (typeof recorded !== 'number') {
          throw new StoryboardError(
            `${w}: "clip" has no "to", so the recording's length is needed to work out where the scene ends, ` +
            `but shot "${norm.shot}" has not been captured. Run: npm run capture -- --shot ${norm.shot}`,
          );
        }
        norm.clip = { ...norm.clip, to: recorded };
      }

      if (seconds === undefined) {
        if (norm.clip) {
          seconds = (norm.clip.to - norm.clip.from) / (norm.speed || 1);
        } else if (typeof recorded === 'number') {
          seconds = recorded / (norm.speed || 1);
        } else {
          throw new StoryboardError(
            `${w}: cannot work out how long this scene is. Give it a "clip", or a "durationInSeconds", ` +
            `or run "npm run capture -- --shot ${norm.shot}" first so the recorded length can be read from captures/${norm.shot}.timeline.json.`,
          );
        }
      }
      if (norm.clip && typeof recorded === 'number' && norm.clip.to > recorded + 0.001) {
        const overshoot = norm.clip.to - recorded;
        // A recording's length is not reproducible: it depends on how fast the
        // site answered on the day. A clip authored against one take will
        // overshoot the next by a few hundredths of a second, and refusing that
        // makes every re-record an edit. Clamp small overshoots and say so;
        // anything larger is an authoring mistake, not jitter.
        if (overshoot <= CLIP_OVERSHOOT_TOLERANCE) {
          warnings.push(
            `${w}: "clip.to" was ${norm.clip.to}s but shot "${norm.shot}" recorded ${recorded.toFixed(2)}s. ` +
            `Trimmed by ${overshoot.toFixed(3)}s, which is recording jitter.`,
          );
          norm.clip = { ...norm.clip, to: recorded };
          seconds = (norm.clip.to - norm.clip.from) / (norm.speed || 1);
        } else {
          throw new StoryboardError(
            `${w}: "clip.to" is ${norm.clip.to}s but the recording of shot "${norm.shot}" is only ${recorded.toFixed(2)}s long, ` +
            `${overshoot.toFixed(2)}s short. Re-record, or lower "clip.to".`,
          );
        }
      }
      if (norm.speed <= 0) {
        throw new StoryboardError(`${w}: "speed" must be greater than 0.`);
      }
      if (norm.maxZoom < 1) {
        throw new StoryboardError(`${w}: "maxZoom" must be at least 1.`);
      }
      if (!['browser', 'laptop', 'none'].includes(norm.frame)) {
        throw new StoryboardError(`${w}: "frame" must be "browser", "laptop" or "none", got "${norm.frame}".`);
      }
      for (const [ci, c] of norm.callouts.entries()) {
        if (c.at > seconds) {
          throw new StoryboardError(`${w}, callout ${ci}: "at" is ${c.at}s but the scene is only ${seconds.toFixed(2)}s long. "at" is measured from the start of the clip, not the start of the recording.`);
        }
      }
      norm.durationInSeconds = seconds;
    }

    if (type === 'clip') {
      // Served through the public/clips symlink, so it has to live there.
      if (!/^assets\/clips\/[A-Za-z0-9._-]+\.mp4$/.test(norm.src)) {
        throw new StoryboardError(`${w}: "src" must be an mp4 directly inside assets/clips/, like "assets/clips/hook.mp4", got "${norm.src}".`);
      }
      if (norm.from < 0) throw new StoryboardError(`${w}: "from" must not be negative.`);
    }

    if (type === 'query') {
      if (!Object.hasOwn(QUERY_PLATFORMS, norm.platform)) {
        throw new StoryboardError(`${w}: "platform" must be one of ${Object.keys(QUERY_PLATFORMS).join(', ')}, got "${norm.platform}".`);
      }
      if (!/^https:\/\/\S+$/.test(norm.sourceUrl)) {
        throw new StoryboardError(`${w}: "sourceUrl" must be the https URL of the original question.`);
      }
      // A paraphrase, not a quote: no handles, addresses or links, which are
      // how a stranger's identity would reach the frame.
      if (/@|https?:\/\/|www\./i.test(norm.question)) {
        throw new StoryboardError(`${w}: "question" contains a handle, address or link. Paraphrase it without them.`);
      }
      if (norm.question.length > 160) {
        throw new StoryboardError(`${w}: "question" is ${norm.question.length} characters. Paraphrase it to 160 or fewer so it reads in one go.`);
      }
    }

    if (top.format === 'vertical' && type === 'capture') {
      warnings.push(`${w}: a 16:9 recording in a vertical cut is letterboxed to a third of the frame. Prefer chat, terminal or query scenes.`);
    }

    if (norm.durationInSeconds <= 0) {
      throw new StoryboardError(`${w}: "durationInSeconds" must be greater than 0, got ${norm.durationInSeconds}.`);
    }
    if (norm.durationInSeconds < 1.5) {
      // Not a taste rule: below about a second and a half a viewer cannot read
      // a headline or register a cut, so the scene is wasted frames.
      throw new StoryboardError(`${w}: "durationInSeconds" is ${norm.durationInSeconds}, under the 1.5s floor. A scene shorter than that cannot be read.`);
    }

    // Frames are computed HERE and only here.
    norm.durationInFrames = Math.max(1, Math.round(norm.durationInSeconds * top.fps));
    return norm;
  });

  const durationInFrames = scenes.reduce((a, s) => a + s.durationInFrames, 0);

  if (top.posterFrame !== undefined) {
    if (!Number.isInteger(top.posterFrame) || top.posterFrame < 0 || top.posterFrame >= durationInFrames) {
      throw new StoryboardError(`storyboard: "posterFrame" must be an integer between 0 and ${durationInFrames - 1}, got ${top.posterFrame}.`);
    }
  }

  if (top.timer) {
    const { from, to } = top.timer;
    if (from >= scenes.length || to >= scenes.length || to < from) {
      throw new StoryboardError(`storyboard: "timer" runs from scene ${from} to scene ${to}, but there are ${scenes.length} scenes (0 to ${scenes.length - 1}) and "to" may not come before "from".`);
    }
  }

  // Scene boundaries, in frames and seconds. verify.mjs samples the contact
  // sheet from these, and the manifest publishes them.
  let cursor = 0;
  const boundaries = scenes.map((s, i) => {
    const start = cursor;
    cursor += s.durationInFrames;
    return {
      index: i,
      type: s.type,
      startFrame: start,
      endFrame: cursor,
      startSeconds: start / top.fps,
      endSeconds: cursor / top.fps,
    };
  });

  return { ...top, scenes, durationInFrames, boundaries, warnings };
}

export { StoryboardError };
