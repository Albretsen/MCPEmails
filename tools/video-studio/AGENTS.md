# Video Studio

Make a product video from one storyboard JSON. Read this file, not
DEVELOPMENT-GUIDE.md, which is the build record.

**Every command below runs from `tools/video-studio/`, never the repo root.**
Nothing was added to the root `package.json`, on purpose, so running these from
the root gives you `npm error Missing script: "auth"`. If you see that, you are
in the wrong directory:

```bash
cd tools/video-studio
npm install        # once per clone; the repo's own install does not cover this
```

Never a bare `npx <bin>` here either: `npx` resolves upward and will run the
ancestor repo's binary instead of ours.

## Just make a test video

```bash
npm run demo
```

One command, no configuration, no account. Records the public site, composites
it with a title and an outro, renders, verifies, prints the path. Use this to
check the pipeline works, or as a starting point to copy. `--fresh` forces a
re-record, `--storyboard <id>` and `--url <base>` override the defaults.

## The five commands

For a real cut.

```bash
npm run doctor
npm run capture    -- --shot add-inbox
npm run transcript -- --storyboard add-inbox-then-chat
npm run render     -- --storyboard add-inbox-then-chat
npm run verify     -- --storyboard add-inbox-then-chat
```

Supporting commands: `npm run auth` (once, a human signs in), `npm run whoami`
(read-only: prints the account, workspace id and connected inboxes as .env
lines), `npm run reset -- --yes` (empty the demo workspace), `npm run studio`
(Remotion Studio, which hot-reloads storyboard JSON and scene code in ~150ms
and is the fastest way to iterate), `npm run typecheck`,
`node scripts/review-kit.mjs <id>` (camera facts for a frame-by-frame review).
Chromium downloads itself on the first capture.

`storyboards/*.json` is mapped to `storyboard.schema.json` by `.vscode/settings.json`,
so an editor gives completion, enum dropdowns and inline errors. The schema is
deliberately NOT referenced with a `$schema` key inside the storyboard files:
the validator treats an unknown top-level key as a hard error.

`demo`, `auth` and `capture` need no `.env`: the site defaults to
https://mcpemails.com. `reset` requires the full config and refuses without it,
because it is the one that deletes things.

Every script prints one line of JSON to stdout beginning `VIDEO_STUDIO_RESULT`.
Parse that. The human-readable log goes to stderr.

## Making a new video

Write `storyboards/<id>.json`, then render and verify. That is the whole job.
Writing React is for genuinely new scene types only.

```json
{
  "id": "add-inbox-then-chat",
  "width": 1920, "height": 1080, "fps": 30,
  "theme": "dark",
  "voiceover": "assets/vo/add-inbox-then-chat.mp3",
  "captions": true,
  "posterFrame": 120,
  "scenes": [ ... ]
}
```

| Key | Required | Default | Notes |
|---|---|---|---|
| `id` | yes | | lower-case kebab-case; becomes the output filename |
| `width`, `height` | no | 1920, 1080 | must be even (H.264 yuv420p) |
| `fps` | no | 30 | positive integer |
| `theme` | no | `"dark"` | `"dark"` or `"light"` |
| `voiceover` | no | | path from this directory, e.g. `assets/vo/x.mp3` |
| `captions` | no | `false` | requires `voiceover` |
| `posterFrame` | no | first frame of scene 2 + 1s | integer frame index |
| `scenes` | yes | | at least one |

Durations are in **seconds**. Frames are computed for you. No scene may be
shorter than 1.5s.

## Scene types

### `title`

```json
{ "type": "title", "durationInSeconds": 2.5,
  "headline": "Connect a mailbox",
  "sub": "IMAP and an app password. No OAuth review.",
  "align": "center" }
```

| Prop | Required | Default |
|---|---|---|
| `durationInSeconds` | yes | |
| `headline` | yes | |
| `sub` | no | none |
| `align` | no | `"center"` (or `"left"`) |

### `capture`

Composites a real recording with a drawn cursor, auto zoom and callouts, all
from `captures/<shot>.timeline.json`.

```json
{ "type": "capture", "shot": "add-inbox",
  "clip": { "from": 1.2, "to": 34.0 },
  "speed": 1.0, "autoZoom": true, "maxZoom": 1.8, "frame": "browser",
  "callouts": [
    { "at": 11.4, "for": 2.2, "text": "An app password, never your login password" }
  ] }
```

| Prop | Required | Default |
|---|---|---|
| `shot` | yes | must match `shots/<shot>.shot.mjs` and a completed capture |
| `durationInSeconds` | no | derived from `clip`, else the recording's length |
| `clip` | no | omit it. `from` defaults to the measured first paint, `to` to the end |
| `speed` | no | `1.0` |
| `autoZoom` | no | `true` |
| `maxZoom` | no | `1.8`. Above this a 1080p source visibly softens |
| `frame` | no | `"browser"` (or `"laptop"`, `"none"`) |
| `callouts` | no | `[]` |

Callout `at` is measured **from the start of the clip**, not the recording.
`anchor` (`"above"`/`"below"`/`"left"`/`"right"`) overrides automatic placement.

**Almost every capture scene wants a `clip.from` of about a second.** A
recording opens before the page has painted, on the browser's default
background, and dropping that straight into a cut gives you a second of flat
grey between the title and the site. `verify` fails on it and names the fix, but
it is cheaper to write it than to re-render.

Leave `clip.to` out unless you actually need to trim the tail. A recording's
length depends on how fast the site answered that day, so a pinned `to` breaks
on the next take. Without it the scene runs to the end of whatever was recorded.
An overshoot under 0.5s is treated as jitter and trimmed with a note; anything
larger is an error.

### `chat`

A neutral assistant surface driven by a verified transcript. See the guard
rails below before touching it.

```json
{ "type": "chat", "transcript": "transcripts/add-inbox-then-chat.json",
  "durationInSeconds": 14, "title": "Your AI assistant" }
```

| Prop | Required | Default |
|---|---|---|
| `transcript` | yes | path from this directory |
| `durationInSeconds` | yes | |
| `title` | no | `"Your AI assistant"` |

### `terminal`

Drawn, not captured. Lines starting `"$ "` type character by character;
everything else is output and appears whole.

```json
{ "type": "terminal", "durationInSeconds": 5, "title": "claude", "cps": 28,
  "lines": [
    "$ claude mcp add --transport http mcpemails https://mcpemails.com/api/mcp",
    "Added HTTP MCP server mcpemails."
  ] }
```

| Prop | Required | Default |
|---|---|---|
| `durationInSeconds` | yes | |
| `lines` | yes | non-empty array of strings |
| `title` | no | `"Terminal"` |
| `cps` | no | `28` characters per second |

### `outro`

```json
{ "type": "outro", "durationInSeconds": 3,
  "cta": "mcpemails.com", "sub": "One inbox free, forever." }
```

| Prop | Required | Default |
|---|---|---|
| `durationInSeconds` | yes | |
| `cta` | yes | |
| `sub` | no | none |

## Shots

| Shot | Captures |
|---|---|
| `add-inbox` | The connect flow: open the modal, choose generic IMAP, enter host and an app password, connect. Needs a session and a throwaway mailbox. |
| `public-tour` | Public marketing pages only. Needs no session, and defaults to production, which is what makes `npm run demo` work with nothing configured. |

### The demo environment, as it actually is

Facts about the live account that are not derivable from this repo. Re-check
them with `npm run whoami` before trusting them.

- **The demo workspace is on the Team plan** (`workspaces.plan = 'pro'`, set
  2026-09-01 so the capture would not show the Free tier's "You're at your inbox
  limit / Upgrade to Personal" banner at the moment of connection). It has no
  Stripe subscription behind it; it is a plan flag. Set it back to `'free'` if
  the demo should show what a new user sees.
- **`demo@mcpemails.com` is on Migadu, which has no `requiresAppPassword`
  preset**, so the credential field renders "Password", not "App password". Do
  not write a callout claiming otherwise; the frame contradicts it.
- **The provider grid shows an Outlook tile, greyed, "Coming soon"**, for about
  two seconds of the `add-inbox` shot. Marketing says not to show Outlook at
  all. No clip, zoom or framing removes it without faking the UI or cutting the
  provider-choice beat, so it is an open decision, not an oversight.
- **`DEMO_SAFE_INBOX_DOMAINS` must include `mcpemails.com`**, or `reset` refuses
  to touch the only mailbox there. `.env.example` suggests `demo.mcpemails.com`,
  which no mailbox uses. A mailbox cannot live on a `.example` domain at all;
  only the fixture SENDERS are `.example`.

A shot exports `id`, `description`, `async run(page, t, { baseUrl })`, and
optionally `requiresSession = false`. `t` is the timeline recorder: use
`t.click`, `t.type`, `t.waitFor`, `t.dwell`, `t.settle`, `t.goto`. Never call
`page.fill` or `page.click` directly, or the action leaves no timeline event and
the composite gets no cursor, no zoom and no callout anchor.

## Things that have already gone wrong

Each of these cost hours once. None is guessable from the code.

**The camera aims with `lookAt`, and `transformOrigin` is NOT a look-at point.**
A CSS transform-origin is the point that stays FIXED while an element scales. An
earlier version stored the anchor's own position there, so the frame magnified
ABOUT each control and left it exactly where it already sat: a button 78% down
the page stayed 78% down the frame at any zoom. That one mistake put the modal's
footer off the bottom edge, walked the pointer out of the crop reaching for it,
and left the payoff row in the top quarter with white space beneath. `lookAt()`
solves `o + (c - o) * S = 0.5` for the origin that centres the subject. Never
feed a raw anchor position to `transformOrigin`.

**The camera and the pointer must share one schedule.** They were computed
independently: the pointer set off `HOVER_BEFORE_CLICK + CURSOR_TRAVEL` before an
event, the camera panned only AT the event. The pointer therefore walked toward
a control the camera had not started moving to, and left the frame. Both now pan
on the pointer's window. If you change one, change the other.

**One scale per RUN, never per anchor.** Anchor rects vary wildly (a 143px
button wants 1.8x, the 418px field beside it wants 1.53x), so a per-anchor scale
pumps in and out on every click. Anchors also OVERLAP, because a click holds for
`HOLD_AFTER_CLICK` and a form is filled faster than that, so "the last anchor
whose window contains t" hands the frame to the next anchor at near-zero
progress and the zoom collapses to 1.0 and climbs again.

**`HOLD_AFTER_CLICK`, `CONTINUOUS_GAP` and `RUN_SPLIT_DISTANCE` interact.**
Lengthening the hold lengthens every window, which shrinks the gaps between
runs, which changes whether the frame travels or goes home. Never tune one
alone. `node scripts/review-kit.mjs <id>` prints the runs, the gap between each
pair and the largest jump inside each run: read it after every change.

**The click ring belongs to the rect that was clicked, not to the pointer.** As
a child of the moving pointer its tail got dragged onto whatever came next, and
the first anchor's rect is measured on the PRE-click page, where the modal that
opens 80ms later can put something else entirely (it landed a full ring on a
competitor's tile). It is a sibling pinned to `centre(prev.rect)` and capped at
`RIPPLE`, which must stay well under `HOVER_BEFORE_CLICK`.

**The dashboard paints ~2s after `goto` returns.** Without `t.settle()` the
"empty inbox list" dwell is spent on a blank page and the shot reaches the modal
0.07s after the list appears. Also: `contentStartSeconds` in the timeline is a
luma heuristic and has been wrong by 2s or more. Verify `clip.from` by extracting
actual frames before trusting it.

**Pacing between clicks belongs in the SHOT, not in `speed`.** `dwell:` on
`t.click` slows only the beat you mean; `speed` also stretches the typing, which
already reads at the right rate.

**The account's stored theme beats the requested `colorScheme`.** Pass
`--theme light` (or whatever the account is set to) or the recording opens on a
dark flash before the app resolves its own theme, and `verify` fails the cut for
a theme mismatch.

**A capture scene cannot be previewed in Studio without inputProps.** `prestudio`
writes `out/studio.props.json` and `studio` passes it with `--props`. Without it
Remotion's CLI supplies nothing, `Root.tsx` falls back to a nominal 20s scene and
you get the "No recording for shot" card.

**whisper fragments this product's vocabulary.** `MCP` arrives as "M" "CP",
`IMAP` as "IM" "AP", `mcpemails.com` as six tokens split across two cues. The
`SPELLINGS` table in `scripts/lib/captions.mjs` fixes them, and is DUPLICATED in
`src/components/Captions.tsx`; the two must stay identical. It holds two classes:
re-joins, where the fragments already spell the term and nothing can change
meaning, and homophones (only `Claude`, pronounced "clawed"), which really do
substitute one word for another and are VOICE-DEPENDENT: recheck them whenever
the voiceover is re-recorded. A genuine mis-hearing is fixed by rewording the
script, never by adding a homophone entry.

**`freezedetect` sees the whole frame, captions included.** A long deliberate
hold (the assistant's answer sitting still to be read) does not trip the 3s
frozen-segment check as long as caption cues keep changing. That is what lets
the chat answer arrive fast and then wait.

**`verify` can pass against a STALE mp4.** If `render` fails, the previous
`out/<id>.mp4` is still on disk and `verify` will happily check it. Always
confirm `render` printed its result line before trusting a green verify.

**A capture scene's `clip.from` is subtracted exactly ONCE.** Cut time is
`sceneStart + (recorded - clip.from) / speed`. Subtracting it again while
building an anchor list produced a fact sheet 1.6s wrong on every row, which
sent a reviewer to the wrong beats. `scripts/review-kit.mjs` owns this
conversion now; use it rather than rewriting the arithmetic.

## Guard rails

These are prohibitions, not preferences.

- **Never point `reset` at a workspace that is not the demo workspace.** It
  disconnects inboxes on a live deployment with paying customers. Five guards
  enforce this in `scripts/reset.mjs`; do not weaken them, and do not "fix" a
  guard failure by editing the environment variable it complained about until
  you have checked which value is actually wrong.
- **Never film a real inbox.** Use the throwaway mailbox. Every fixture address
  is on a `.example` domain, reserved by RFC 2606 so it can never be registered.
- **Never copy another vendor's UI.** MCP Emails has no chat surface of its own,
  so the `chat` scene is drawn. Draw it in our type and colours with a generic
  label. Do not reproduce Claude Desktop, Cursor or anyone else's chrome. Name a
  client in the voiceover as a fact if you must.
- **Never claim a capability the transcript does not prove.** `render` refuses a
  chat scene whose transcript has any `ok: false` turn, or is more than 14 days
  old. Do not hand-edit `ok: false` to `ok: true`, and do not extend the window
  to get a render through. Re-run `npm run transcript`.
- **Never write outside `out/`.** Publishing to the marketing site is a separate
  human step. This tool does not touch `apps/web`.
- **Never run a bare `npx` in this directory.**
- **Never type a password into a login form from a script.** `npm run auth`
  opens a headed browser and waits for a person. There is no
  `DEMO_ACCOUNT_PASSWORD`, and adding one is a regression.

## What `verify` proves, and what it does not

It proves, mechanically: the streams, codec (`h264`), pixel format
(`yuv420p`), dimensions, duration against the storyboard, no scene under 1.5s,
no unexpected black segments, no capture scene opening on an unpainted frame,
nothing frozen for 3s or more, captions present
and ending inside the video, every transcript fresh with no failed call, no
credential in any text output, and whether each capture's measured appearance
matches the storyboard's theme. It writes `out/<id>.sheet.png`, a contact sheet
sampled at the start, middle and end of every scene plus every callout. Open it
and read it: layout, typography, contrast, framing and clipped text are all
visible in a single frame.

**It does not check motion.** Pacing, easing, whether an entrance lands, and
continuity across a cut exist only across frames, and nothing here samples them.
When reporting, say what was checked and state plainly that motion, pacing and
timing were not verified and need a human pass. Do not say the video "looks
good". You have not seen it move.

## House style

No em dashes anywhere in on-screen text, captions or voiceover copy. Use
commas, colons, or full stops. The storyboard validator rejects them, so this is
enforced rather than remembered.
