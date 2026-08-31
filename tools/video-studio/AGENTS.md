# Video Studio

Make a product video from one storyboard JSON. Read this file, not
DEVELOPMENT-GUIDE.md, which is the build record.

**Always run commands as `npm run <script>` from `tools/video-studio/`.**
Never a bare `npx <bin>` here: `npx` resolves upward and will run the ancestor
repo's binary instead of ours.

## The five commands

```bash
npm run doctor
npm run capture    -- --shot add-inbox
npm run transcript -- --storyboard add-inbox-then-chat
npm run render     -- --storyboard add-inbox-then-chat
npm run verify     -- --storyboard add-inbox-then-chat
```

Supporting commands: `npm run auth` (once, a human signs in), `npm run reset --
--yes` (empty the demo workspace), `npm run studio` (Remotion Studio),
`npm run typecheck`, `npm run capture -- --install-browser` (once).

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
| `clip` | no | whole recording. `{from, to}` in seconds |
| `speed` | no | `1.0` |
| `autoZoom` | no | `true` |
| `maxZoom` | no | `1.8`. Above this a 1080p source visibly softens |
| `frame` | no | `"browser"` (or `"laptop"`, `"none"`) |
| `callouts` | no | `[]` |

Callout `at` is measured **from the start of the clip**, not the recording.
`anchor` (`"above"`/`"below"`/`"left"`/`"right"`) overrides automatic placement.

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
| `public-tour` | Public marketing pages only. Needs no session. Doubles as the pipeline self-test, with `storyboards/pipeline-selftest.json`. |

A shot exports `id`, `description`, `async run(page, t, { baseUrl })`, and
optionally `requiresSession = false`. `t` is the timeline recorder: use
`t.click`, `t.type`, `t.waitFor`, `t.dwell`, `t.settle`, `t.goto`. Never call
`page.fill` or `page.click` directly, or the action leaves no timeline event and
the composite gets no cursor, no zoom and no callout anchor.

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
no unexpected black segments, nothing frozen for 3s or more, captions present
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
