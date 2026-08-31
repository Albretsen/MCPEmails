# Video Studio

Produce a finished product video from one command, by capturing the real
product and compositing it with synthetic scenes.

```
  REAL SOFTWARE                SYNTHETIC                  COMPOSITE
  Playwright drives      +     Remotion scenes      ->    Remotion render
  the live dashboard,          built in our own           reads one storyboard
  recording video AND          type and colours           JSON, emits mp4 +
  a structured event                                      poster + captions
  timeline
       |                            |                          |
   captures/*.webm              src/scenes/*.tsx            out/*.mp4
   captures/*.timeline.json     transcripts/*.json          out/*.jpg
                                                            out/*.vtt
```

Capture emits **two** artifacts, and the second is the point: a timeline of
every action with timestamps and element bounding boxes. Playwright's video
records no cursor at all, so drawing one downstream from that log is not a
flourish, it is the only way the result looks like a product video rather than
a test artifact. The same boxes drive the auto zoom and anchor the callouts.

**Agents: read [AGENTS.md](AGENTS.md), not this file.** It has the commands, the
full scene reference, and the guard rails.

## Make a test video

```bash
cd tools/video-studio
npm install      # once. This package is separate from the repo's own.
npm run demo
```

`npm install` is not optional and a root `npm install` does not cover it: this
directory is outside the repo's workspace glob on purpose. Every command checks
and tells you if you have skipped it.

That is the whole thing. It records the public marketing site, composites it
with a title and an outro, renders, verifies, and prints where the file is.
No `.env`, no sign in, no mailbox, no account. The first run also downloads
Chromium, about 95 MB.

Result: `out/demo.mp4`, plus a poster and a contact sheet. Re-recording is
automatic once the capture is a day old; `npm run demo -- --fresh` forces it.

## Setup for a real cut

```bash
cp .env.example .env      # then fill it in
npm run doctor
```

`npm run auth` opens a headed browser and waits for you to sign in as the demo
account by hand. Nothing here will ever type a password for you.

## Making a video

```bash
npm run capture    -- --shot add-inbox
npm run transcript -- --storyboard add-inbox-then-chat
npm run render     -- --storyboard add-inbox-then-chat
npm run verify     -- --storyboard add-inbox-then-chat
```

A new video is a new `storyboards/<id>.json` plus those commands. Writing React
is reserved for genuinely new scene types.

## Isolation

This directory is deliberately outside the repo's npm workspace
(`workspaces: ["apps/*"]`) and outside the Vercel root directory
(`apps/web`). It has its own `node_modules` and its own React, imports nothing
from `apps/web`, and adds nothing to the root `package.json`. Brand values are
copied as literal strings into `src/theme.ts`, both to keep that line and
because Remotion renders in a headless browser where the app's CSS custom
properties do not exist.

`npm run doctor` checks all of this, plus that no session token or media file
has leaked into git.

## Two things it will refuse to do

**Render a chat scene it cannot evidence.** Transcripts are produced by running
the calls against the real MCP server. A transcript with any failed tool call,
or one older than 14 days, blocks the render. This exists because a production
audit found `email_compose` with 0 successes and 29 errors over 14 days, and
four other tools with no calls at all: zero calls and zero failures look
identical in a dashboard and very different on camera.

**Reset a workspace that is not the demo workspace.** `npm run reset` checks the
active workspace id, the signed-in account, that every address is on a safe
domain, that there are no more than four of them, and that `--yes` was passed.
Any one failing aborts without disconnecting anything.

## Verification

`npm run verify` runs mechanical checks and writes a contact sheet. It does not
and cannot check motion: pacing, easing and continuity exist only across frames.
A human watches the cut before it ships.

## Publishing

Out of scope. The tool's contract ends at `out/`. See
[DEVELOPMENT-GUIDE.md](DEVELOPMENT-GUIDE.md) section 9 for what the web side
still needs before a video can be served from the marketing site.
