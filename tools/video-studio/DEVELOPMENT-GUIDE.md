# Video Studio: development guide

**Audience:** the orchestrator agent that will build this tool, and every agent that later uses it.
**Status:** nothing is built yet. This directory contains only this file.
**Goal:** an internal tool that lets an agent produce a finished product video from one command, by capturing the real product and compositing it with synthetic scenes.

Read this whole file before writing code. Section 2 is a hard constraint list, not advice.

---

## 1. What this tool is

A three stage pipeline with a declarative contract in the middle.

```
  REAL SOFTWARE                SYNTHETIC                  COMPOSITE
  Playwright drives      +     Remotion scenes      ->    Remotion render
  the live dashboard,          built from snapcn          reads one storyboard
  recording video AND          components (chat,          JSON, emits mp4 +
  a structured event           terminal, titles)          poster + captions
  timeline
       |                            |                          |
   captures/*.webm              src/scenes/*.tsx            out/*.mp4
   captures/*.timeline.json     transcripts/*.json          out/*.jpg
                                                            out/*.vtt
```

The design target is the request "make a demo video of adding an inbox, then talking to an agent about that inbox." That splits cleanly:

- **Adding an inbox** is real software. It must be captured, not drawn. A drawn version of a connect flow is a lie, and this product asks sceptics for mailbox credentials, so the video has to survive scepticism.
- **Talking to an agent** is not our UI at all. MCP Emails is an MCP server consumed by Claude Desktop, Claude Code, Cursor and others. There is no first party chat surface to record. That scene is built, not captured. See section 6 for the honesty rules that apply to it.

### The central idea

Capture emits **two** artifacts, not one: the video, and a timeline JSON of every action with timestamps and element bounding boxes. Remotion consumes both. That is what lets the composite stage draw the cursor, auto zoom onto the control being used, and place callouts, all without a human touching a timeline. Playwright's own video does not record a cursor at all, so drawing it downstream from the event log is not a nicety, it is the only way this looks like a product video instead of a test artifact.

---

## 2. Isolation constraints (non negotiable)

The repository is live, has paying customers, and is shared by concurrent agent sessions. Verified facts about this repo as of 2026-08-31:

| Fact | Consequence |
|---|---|
| Root `package.json` declares `workspaces: ["apps/*"]` | `tools/video-studio` is outside the glob. A root `npm install` will never touch it. **Do not** add `tools/*` to workspaces. |
| `.vercel/project.json` sets `rootDirectory: "apps/web"` | Nothing under `tools/` is uploaded or built by a deploy. Keep it that way. |
| The app is Next 16.3.3 / React 19.2.6, plain CSS, no Tailwind | The video project gets its **own** `node_modules`, its own React, and may use Tailwind internally. It must never share. |
| `npx` resolves upward out of nested directories in this repo (documented failure: a bare `npx next build` in a worktree ran the ancestor's Next) | **Never** run a bare `npx <bin>` inside `tools/video-studio`. Declare every command as an npm script and run `npm run <script>` from this directory. |
| Root `.gitignore` already ignores `node_modules/` | Still add a local `.gitignore` here for `captures/`, `out/`, `.auth/`, `.remotion/`, `assets/vo/`. |
| BSD grep treats several source files here as binary because of box drawing characters | Any search this tool does must use `LC_ALL=C grep -a`. |

Rules that follow:

1. **Never import from `apps/web`.** Not components, not styles, not `src/lib`. Brand values get copied into `src/theme.ts` as literal strings. This is not laziness: Remotion renders in a headless browser where CSS custom properties do not survive, so the app's `theme.css` tokens would not work anyway.
2. **Never write into `apps/web`.** The tool's contract ends at `tools/video-studio/out/`. Shipping a cut to the marketing site is a separate, human approved copy. See section 9.
3. **Never add anything to the root `package.json`.** No scripts, no dependencies, no workspace entries.
4. **Do the build in a git worktree.** Other sessions share this checkout. Deploys from other sessions can pick up a dirty tree.
5. **Keep media out of git.** A single 1080p cut is tens of megabytes and captures are larger. Everything generated stays gitignored.

Acceptance test for isolation, which the orchestrator must run and paste the output of before declaring the tool done:

```bash
cd /Users/asgeiralbretsen/Repositories/MCPEmails && git status --short && npm ls --workspaces --depth=0 && cd apps/web && npm run build
```

Root `git status` must show no changes under `apps/`, `packages/`, `supabase/` or `scripts/`, the workspace listing must not mention video-studio, and the web build must still pass.

---

## 3. Directory layout to build

```
tools/video-studio/
  DEVELOPMENT-GUIDE.md      this file
  AGENTS.md                 the short contract every future agent reads first
  README.md                 human entry point
  package.json              isolated deps, all commands as scripts
  .gitignore                captures/ out/ .auth/ .remotion/ assets/vo/ node_modules/
  .env.example              documented, never a real secret

  scripts/
    auth.mjs                one time: save a demo session to .auth/demo.json
    reset.mjs               put the demo workspace back to a known state
    capture.mjs             run a shot recipe, emit .webm + .timeline.json
    transcript.mjs          run real MCP calls, emit a verified transcript
    render.mjs              remotion render -> out/
    verify.mjs              mechanical checks + contact sheet for agent review
    doctor.mjs              preflight: deps, ffmpeg, auth freshness, guards

  shots/                    one file per real-software capture
    add-inbox.shot.mjs
  storyboards/              the declarative video definitions
    add-inbox-then-chat.json
  transcripts/              generated, checked in (small, and they are evidence)
    add-inbox-then-chat.json

  src/                      the Remotion project
    Root.tsx                registers one composition per storyboard
    Storyboard.tsx          reads a storyboard, maps scenes to components
    theme.ts                literal brand tokens, copied not imported
    scenes/
      Title.tsx
      Capture.tsx           OffthreadVideo + cursor + auto zoom + callouts
      Chat.tsx              synthetic assistant surface, driven by a transcript
      Terminal.tsx
      Outro.tsx
    components/snap-cn/     installed by the shadcn CLI, owned source

  captures/                 gitignored raw recordings
  assets/                   logo.svg, vo/*.mp3
  out/                      gitignored deliverables
```

---

## 4. The storyboard contract

This is the single most important design decision. **An agent should be able to make a new video by writing one JSON file and running three commands.** Writing React is the exception, reserved for genuinely new scene types.

`storyboards/add-inbox-then-chat.json`:

```json
{
  "id": "add-inbox-then-chat",
  "width": 1920,
  "height": 1080,
  "fps": 30,
  "theme": "dark",
  "voiceover": "assets/vo/add-inbox-then-chat.mp3",
  "captions": true,
  "scenes": [
    {
      "type": "title",
      "durationInSeconds": 2.5,
      "headline": "Connect a mailbox",
      "sub": "IMAP and an app password. No OAuth review."
    },
    {
      "type": "capture",
      "shot": "add-inbox",
      "clip": { "from": 1.2, "to": 34.0 },
      "speed": 1.0,
      "autoZoom": true,
      "callouts": [
        { "at": 11.4, "for": 2.2, "text": "An app password, never your login password" }
      ]
    },
    {
      "type": "chat",
      "transcript": "transcripts/add-inbox-then-chat.json",
      "durationInSeconds": 14
    },
    {
      "type": "outro",
      "durationInSeconds": 3,
      "cta": "mcpemails.com"
    }
  ]
}
```

Design rules for the schema:

- **Seconds, not frames, at the authoring layer.** Convert to frames once, inside `Storyboard.tsx`. Frames are a rendering detail and agents get them wrong.
- **Validate the storyboard before rendering** and fail with a precise message naming the scene index and the offending key. A schema error at second 3 of a nine minute render is a wasted nine minutes.
- **Every scene type is a discriminated union member** with an exported TypeScript type. `AGENTS.md` must list every type and its full prop shape, because that listing is what a future agent reads instead of the source.
- **`durationInSeconds` is optional for `capture`**; it derives from the clip. It is required everywhere else.
- Adding a capability means adding one scene type plus one entry in `AGENTS.md`. Nothing else.

---

## 5. Stage one: capture the real software

### Target environment

The dashboard route is a server component with `export const dynamic = 'force-dynamic'` that loads its initial state from Supabase server side, then hydrates `DashboardApp` with props. **Playwright network interception cannot stub the dashboard's initial state**, because that state never crosses the network as JSON. Do not waste a day discovering this.

So capture runs against a real deployment with a real, dedicated demo account. Local is the obvious first choice but local Supabase in this project rejects HS256 and has blocked scripted sign in before, so treat a working local login as something to verify, not assume. Order of preference:

1. A Vercel preview deployment pointed at the production Supabase project, signed in as the demo account.
2. Production, signed in as the demo account.
3. Local `npm run dev -w apps/web`, only if sign in actually works.

### Authentication

`scripts/auth.mjs` opens a **headed** browser once, waits for a human to sign in as the demo account, then saves `storageState` to `.auth/demo.json`. Every subsequent capture loads that state and never touches a login form.

`.auth/demo.json` contains a live session token. It must be in `.gitignore`, and `doctor.mjs` must fail loudly if it is ever tracked by git. Do not put credentials in `.env`, do not print the token, do not let an agent type a password into the login form. A human signs in, once, by hand.

### The reset guard (read this twice)

`reset.mjs` deletes inboxes so the "add an inbox" shot starts from zero. That is a destructive operation running against production data. It must refuse to run unless **all** of these hold:

- `DEMO_WORKSPACE_ID` is set and matches the active workspace returned by the session.
- The signed in account's email equals `DEMO_ACCOUNT_EMAIL`.
- That workspace has never had more than a handful of inboxes, all on `.example` or the known throwaway demo domain.
- `--yes` was passed explicitly.

If any check fails, exit non zero and print which one. An agent must never be able to point this at a customer workspace by editing one environment variable. Bake the checks into the script, not the docs.

### Recording

```js
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 2,
  recordVideo: { dir: 'captures/raw', size: { width: 1920, height: 1080 } },
  colorScheme: 'dark',
  reducedMotion: 'no-preference',   // we want the product's real animations
  locale: 'en-US',
  timezoneId: 'Europe/Oslo',
});
```

Launch Chromium with `--force-color-profile=srgb --disable-lcd-text --hide-scrollbars` so colours and text rendering are stable across machines.

### Shot recipes

A shot is a module exporting `id`, `description`, and `async run(page, t)`. The `t` helper is the timeline recorder, and it is the whole point:

```js
export const id = 'add-inbox';
export const description = 'Open the connect modal, choose generic IMAP, enter an app password, connect.';

export async function run(page, t) {
  await page.goto(`${process.env.DEMO_BASE_URL}/dashboard/inboxes`);
  await t.settle();                                  // wait for network idle + a beat

  await t.click(page.getByRole('button', { name: /connect (an )?inbox/i }),
                { note: 'Open the connect modal' });

  // The modal is a two step machine: step 1 provider grid, step 2 credentials.
  await t.click(page.getByRole('radiogroup').getByRole('radio', { name: /imap/i }),
                { note: 'Choose generic IMAP' });
  await t.click(page.getByRole('button', { name: /connect|continue/i }));

  await t.type(page.getByPlaceholder('you@example.com'), 'ada@demo.example',
               { delay: 55, note: 'Address' });
  await t.type(page.getByPlaceholder('imap.example.com'), 'imap.fastmail.com', { delay: 45 });
  await t.type(page.locator('input[type="password"]').first(), process.env.DEMO_IMAP_PASS,
               { delay: 40, mask: true, note: 'An app password, never the login password' });

  await t.click(page.getByRole('button', { name: /connect inbox/i }),
                { note: 'Submit' });
  await t.waitFor(page.getByText(/ada@demo\.example/), { note: 'Inbox appears in the list' });
  await t.dwell(2.0);                                 // let the viewer read the result
}
```

What `t` must record, per action, into `captures/add-inbox.timeline.json`:

```json
{
  "shot": "add-inbox",
  "recordedAt": "2026-08-31T14:02:11Z",
  "baseUrl": "https://...",
  "durationMs": 34120,
  "viewport": { "width": 1920, "height": 1080 },
  "events": [
    { "t": 3.44, "kind": "click", "note": "Open the connect modal",
      "rect": { "x": 1204, "y": 188, "width": 168, "height": 40 } },
    { "t": 11.40, "kind": "type", "note": "An app password, never the login password",
      "rect": { "x": 640, "y": 512, "width": 420, "height": 44 }, "masked": true }
  ]
}
```

`rect` comes from `locator.boundingBox()` immediately before the action. Timestamps are milliseconds since `recordVideo` started, which you get by taking one `performance.now()` reading at context creation and subtracting.

Non negotiable capture behaviours:

- **Type, do not fill.** `page.fill()` teleports text into a field and looks fake. Use per character delay in the 40 to 60 ms range.
- **Dwell after every meaningful action.** A demo that moves at machine speed is unreadable. Bake explicit pauses into the recipe and record them.
- **Mask secrets.** The app password must be a real working credential for a throwaway mailbox, and the timeline must mark that event `masked: true` so no downstream artifact can print it. Verify visually that the field renders as dots.
- **Never film a real inbox.** Use the throwaway mailbox seeded by the existing `scripts/demo/demo-mailbox.js` (see section 10). Every fixture address is on a `.example` domain, which RFC 2606 reserves so it can never be registered by anyone.

---

## 6. Stage two: synthetic scenes

### The chat scene, and the two rules that constrain it

**Rule one: do not rebuild another company's product UI.** The natural instinct is to make the chat scene look exactly like Claude Desktop. Do not. Presenting a pixel copy of another company's interface in our marketing material misrepresents whose product is whose. Build a neutral assistant surface in our own type and colours, and label it generically ("your AI assistant"), not with a vendor's name and mark. If a specific client must be named, name it in the voiceover as a fact ("works with Claude, Cursor and any MCP client") rather than by imitating its chrome.

**Rule two: the transcript must be real.** `scripts/transcript.mjs` executes the actual tool calls against the real MCP endpoint and writes what actually came back:

```json
{
  "id": "add-inbox-then-chat",
  "verifiedAt": "2026-08-31T14:20:03Z",
  "endpoint": "https://mcpemails.com/api/mcp",
  "turns": [
    { "role": "user", "text": "What came in on the new inbox this morning?" },
    { "role": "tool", "name": "inbox_list", "args": {},
      "ok": true, "summary": "1 inbox: ada@demo.example" },
    { "role": "tool", "name": "email_read", "args": { "action": "search", "limit": 5 },
      "ok": true, "summary": "5 messages" },
    { "role": "assistant",
      "text": "Three need you today: an invoice past due, a customer escalating, and a contract to sign. The other nine are notifications." }
  ]
}
```

`render.mjs` must **refuse** to render a chat scene when the transcript has `ok: false` on any turn, or when `verifiedAt` is older than 14 days. This is not bureaucracy. A production audit on 2026-08-19 found `email_compose` had 0 successes and 29 errors across 14 days, and `email_organize`, `draft`, `folder` and `schedule` had never been called at all. Zero calls and zero failures look identical in a dashboard and very different on camera. The refusal is what stops an agent from cheerfully animating a feature that does not work.

Reuse the existing `scripts/demo/verify-demo-calls.js` (section 10) as the starting point. It already speaks the JSON-RPC and SSE shapes this endpoint uses, including pulling the payload out of a `data:` line.

### snapcn

[snapcn](https://snapcn.dev/) is a shadcn style registry of 28 Remotion components built specifically for showing software. MIT, source copied into your project, no runtime dependency added. Components are themed through a `theme` prop using inline styles, precisely because CSS custom properties do not survive a Remotion render.

Install from inside `tools/video-studio`:

```bash
npx shadcn@latest add @snapcn/answer-stream @snapcn/prompt-send @snapcn/terminal-simulator @snapcn/word-captions
```

The ones that matter here:

| Component | Use |
|---|---|
| `prompt-send` | The user typing a question and sending it |
| `answer-stream` | The assistant's reply streaming in token by token |
| `prompt-zoom` | Pushing in on the prompt for emphasis |
| `terminal-simulator` | The `claude mcp add` install beat, if a storyboard wants one |
| `laptop-frame` | Framing a capture inside a device |
| `word-captions`, `karaoke-captions` | Burned in captions synced to the voiceover |
| `text-reveal`, `type-morph` | Titles and outro |

Treat these as owned source. Read each file after installing it and adjust to `src/theme.ts`. Do not add snapcn as a dependency, and do not `npm update` it.

Note the maturity: the repo was created in July 2026 and is small. That is fine for copy-paste source, and is a reason not to depend on it as a package.

### The Capture scene

`src/scenes/Capture.tsx` is where the pipeline earns its keep. It takes the `.webm` and the `.timeline.json` and produces something that looks directed:

- `<OffthreadVideo>` for the recording. Use `OffthreadVideo`, not `<Video>`, for frame accurate rendering.
- **Auto zoom.** For each timeline event, interpolate the scale and translation of the video toward that event's `rect` over roughly 0.4 s, hold while the action happens, and ease back out. Cap scale around 1.8 so a 1080p source does not turn to mush. This single feature is most of the difference between a screen recording and a product video.
- **Cursor.** Draw it from the event log: position interpolated between event rects, a soft click ripple on `kind: "click"`, a caret on `kind: "type"`. Playwright records no cursor, so if you skip this the video has an invisible protagonist.
- **Callouts.** Rendered from the storyboard's `callouts`, anchored near the relevant `rect`, never covering the thing they describe.
- **Clip and speed** from the storyboard, so a re-cut needs no re-record.

---

## 7. Stage three: render, and the output contract

```bash
npm run render -- --storyboard add-inbox-then-chat
```

Produces, in `out/`:

```
out/add-inbox-then-chat.mp4     H.264 / AAC, 1920x1080, yuv420p
out/add-inbox-then-chat.jpg     poster, first meaningful frame
out/add-inbox-then-chat.vtt     WebVTT captions
out/add-inbox-then-chat.json    manifest: duration, scene boundaries, checksums,
                                source capture ids, transcript verifiedAt
```

The poster comes from `remotion still` at a frame the storyboard names, not from a guess:

```bash
npx remotion still src/index.ts add-inbox-then-chat out/poster.jpg --frame=120
```

Captions: generate the voiceover with a TTS service into `assets/vo/`, then use `@remotion/install-whisper-cpp` for word level timings and `@remotion/captions` to turn those into both the burned in captions and the `.vtt`. Encode `yuv420p` or Safari will refuse the file.

Every script must end by printing a single line of JSON to stdout summarising what it did, so a calling agent can parse the result instead of scraping prose.

---

## 8. Verification: closing the loop an agent cannot close by itself

An agent can write Remotion code and confirm the render exited 0. It **cannot** judge whether the motion is any good. A single frame is checkable exactly like a screenshot, because it is one. Pacing, easing, whether an entrance lands, continuity across a cut: those exist only across frames and there is no automated check for them. Build the tool so it is honest about that line.

`npm run verify -- --storyboard <id>` does two things.

**Mechanical checks, which the agent may assert:**

```bash
# Black frames, usually a scene that failed to mount
ffmpeg -i out/x.mp4 -vf "blackdetect=d=0.4:pix_th=0.10" -f null - 2>&1 | grep blackdetect

# Frozen segments, usually a capture that stalled
ffmpeg -i out/x.mp4 -vf "freezedetect=n=-60dB:d=2" -f null - 2>&1 | grep freeze

# Streams present and correct
ffprobe -v error -show_entries stream=codec_type,codec_name,width,height,pix_fmt \
        -of default=nw=1 out/x.mp4
```

Plus: total duration within the storyboard's budget, no scene under 1.5 s, captions file non empty and its last cue inside the duration, transcript `verifiedAt` fresh, no `ok: false` turn, no masked field rendered legibly.

**A contact sheet, which the agent reads with vision:**

```bash
# One still at every scene boundary and every callout, tiled into a grid
ffmpeg -i out/x.mp4 -vf "fps=1/2,scale=480:-1,tile=5x4" -frames:v 1 out/sheet.png
```

Better than a fixed interval: have `verify.mjs` read the manifest's scene boundaries and extract a frame at the start, middle and end of each scene plus each callout `at`, then tile those. The agent opens `out/sheet.png`, checks layout, typography, contrast, whether the zoom framed the right control, and whether any text is clipped. That closes most of the loop.

**What the agent must then say.** After verify passes, report exactly what was checked and state plainly that motion, pacing and timing were not verified and need a human pass. An agent must not claim the video "looks good". It has not seen it move.

---

## 9. Publishing is out of scope for v1

The tool's contract ends at `out/`. It does not write to `apps/web`. Shipping a cut is a deliberate human step.

The web side is now prepared for it, on branch `feat/demo-video-tooling` (two commits, cherry picked onto current `main`, build verified). That branch adds:

- `apps/web/components/marketing/DemoVideo.jsx`, a player gated behind `DEMO_VIDEO_AVAILABLE`, which is `false`. Until the flag flips, `HomeClient` keeps rendering the old `DashboardPreview`, so the branch is safe to merge and deploy well ahead of any recording.
- The `proxy.ts` matcher exclusion for `mp4|webm|mov|m4v|ogg|vtt` (plus `avif|ico`). Without it a `<video>` issues many ranged requests and each one runs `updateSession()` and a Supabase auth round trip, then answers with cookies the CDN refuses to cache.
- A `/demo/:path*` immutable cache header in **`apps/web/next.config.js`**. The original commit put this in the repo root `vercel.json`, which Vercel never loads because the Root Directory is `apps/web`, so it would have been a silent no-op. It was ported during the cherry pick.
- Home page copy for the demo section in all five locales.

Two things that constrain the eventual cut:

- **`immutable` means a re-cut must ship under a new filename.** Overwriting `demo.mp4` in place strands every previous visitor on the old file for up to a year. Name outputs with a content hash.
- The production CSP sets no `media-src`, so it falls back to `default-src 'self'`. The video must be same origin. No third party host will load.

Note also that the committed copy currently promises a specific video ("Three minutes, one real inbox", "a live Fastmail account, a Gmail account, and a second IMAP inbox"). Whatever this tool produces must match that claim, or the copy must be changed alongside it. Do not ship a cut that contradicts its own caption.

---

## 10. Prior work to reuse, not redo

In `scripts/demo/` on branch `feat/demo-video-tooling`:

- **`demo-mailbox.js`** seeds a throwaway IMAP mailbox with 14 fixture messages, all on `.example` domains. The fixture set is deliberately shaped: three that plainly need a human, a cluster of noise that plainly does not, and two genuinely ambiguous, because a triage demo where every call is obvious proves nothing. Commands: `seed`, `list`, `purge`. `purge` is the between takes reset for mail state, the counterpart to `reset.mjs` for workspace state.
- **`verify-demo-calls.js`** rehearses every MCP call a video depends on against the real server. This is the direct ancestor of `transcript.mjs`. It already handles the JSON-RPC over SSE response shape and distinguishes protocol errors from tool errors.
- **`README.md`** documents the serving constraints and the audit table. Read it.

Call these by relative path from `tools/video-studio/`, or copy what you need. Do not modify them in place.

---

## 11. Build order, with acceptance criteria

Each phase must be finished completely before the next begins, and each ends with a runnable command.

**Phase 0: skeleton and isolation.** `package.json`, `.gitignore`, `doctor.mjs`, a Remotion project via `npm create video@latest` with the blank template. Install the official Remotion agent skills: `npx skills add remotion-dev/skills` (12 first party skills including `remotion-best-practices`, `remotion-markup`, `remotion-render`, `remotion-captions`).
*Done when:* `npm run doctor` passes, and the section 2 isolation acceptance test is clean.

**Phase 1: render a storyboard with synthetic scenes only.** Schema, validator, `Storyboard.tsx`, `Title`, `Outro`, snapcn installed and themed.
*Done when:* a two scene storyboard renders to a correct mp4 and the manifest is written.

**Phase 2: verification.** `verify.mjs`, mechanical checks, contact sheet.
*Done when:* deliberately breaking a scene (make it render black) causes `verify` to fail with a precise message.

**Phase 3: capture.** `auth.mjs`, `reset.mjs` with all four guards, `capture.mjs`, the timeline recorder, the `add-inbox` shot.
*Done when:* `npm run capture -- --shot add-inbox` produces a `.webm` and a `.timeline.json` whose event rects match what is on screen, and `reset.mjs` refuses to run with a wrong `DEMO_WORKSPACE_ID`.

**Phase 4: the Capture scene.** `OffthreadVideo`, cursor, auto zoom, callouts, clip and speed.
*Done when:* the contact sheet shows the zoom framing the correct control at each event.

**Phase 5: chat and transcript.** `transcript.mjs`, the freshness and `ok` refusal, `Chat.tsx` on `prompt-send` and `answer-stream`.
*Done when:* a stale or failing transcript blocks the render with a clear message.

**Phase 6: voiceover and captions.** TTS into `assets/vo/`, whisper timings, `.vtt` plus burned in captions.
*Done when:* the full `add-inbox-then-chat` storyboard renders end to end and passes verify.

---

## 12. AGENTS.md: what to put in it

`AGENTS.md` is the file a future agent reads instead of this one. Keep it under 200 lines. It must contain, and nothing else:

1. The five commands, in order, with exact syntax.
2. The complete scene type reference: every `type`, every prop, every default, with one example each.
3. The list of available shots with a one line description of what each captures.
4. The guard rails, stated as prohibitions: never point `reset` at a non demo workspace, never film a real inbox, never copy another vendor's UI, never claim a capability the transcript does not prove, never write outside `out/`, never run bare `npx` in this directory.
5. The verification contract: what `verify` proves, and the sentence about motion needing a human pass.
6. House style: no em dashes anywhere in on screen text, captions or voiceover copy. Use commas, colons, or full stops.

The five commands should be:

```bash
npm run doctor
npm run capture    -- --shot add-inbox
npm run transcript -- --storyboard add-inbox-then-chat
npm run render     -- --storyboard add-inbox-then-chat
npm run verify     -- --storyboard add-inbox-then-chat
```

If a future agent needs more than these five plus one JSON file to make a video, the tool has failed at its actual job.

---

## 13. Reference

- Remotion 4.0.519. Free for individuals and companies up to three people, commercial use allowed, so free for this project today. A company licence starts at $100/mo if headcount reaches four. https://www.remotion.pro/license
- Remotion agent skills: https://github.com/remotion-dev/skills and https://www.remotion.dev/docs/ai/skills
- Remotion docs serve raw markdown: append `.md` to any docs URL, or send `Accept: text/markdown`.
- snapcn: https://snapcn.dev/ (MIT, 28 components, shadcn CLI install)
- Playwright 1.62.1. Video recording records no cursor.
- ffmpeg 8.1.1 is installed at `/opt/homebrew/bin/ffmpeg`. `vhs` is not installed; `brew install vhs` if a terminal scene ever needs real terminal capture rather than the snapcn simulator.
- Local Node is 22.22.2, Vercel runs 24.x. Remotion declares no engine constraint.
