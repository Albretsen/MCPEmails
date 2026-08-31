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

export const SCENE_TYPES = ['title', 'capture', 'chat', 'terminal', 'outro'];

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
    if (typeOf(value.from) !== 'number') {
      throw new StoryboardError(`${where}: "clip.from" must be a number, in seconds.`);
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
      if (value.to <= value.from) {
        throw new StoryboardError(`${where}: "clip.to" (${value.to}) must be greater than "clip.from" (${value.from}).`);
      }
    }
    if (value.from < 0) {
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
      if (c.text.includes('—')) {
        throw new StoryboardError(`${cw}: "text" contains an em dash. House style forbids them in on-screen text. Use a comma, colon or full stop.`);
      }
    });
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

    const spec = SCENE_SPEC[type];
    const w = `${where} (${type})`;
    const norm = applySpec(w, scene, spec.required, spec.optional);
    norm.type = type;

    if (type === 'capture') {
      const recorded = captureDurations[norm.shot];
      let seconds = norm.durationInSeconds;

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
