# Prompt: cut the MCP Emails product demo video

Paste everything below the line into a fresh agent session in this repo.

---

You are cutting the product demo video for MCP Emails. A working video pipeline
already exists in this repo. Use it. Do not build another one, and do not reach
for an external video tool.

## Start here, in this order

1. `cd tools/video-studio && cat AGENTS.md`. That is the contract: the commands,
   every scene type with its props, and the guard rails. Read it before you plan
   anything.
2. `npm run demo`. One command, no setup, no account. It records the public site
   and cuts a throwaway 15 second video. Run it first, so you know the pipeline
   works on this machine before you design a frame. Open `out/demo.mp4` and
   `out/demo.sheet.png` and look at them.
3. Only then start on the real cut.

A new video costs one JSON file in `storyboards/` plus three commands. If you
find yourself writing React, stop and check whether an existing scene type does
the job.

## The one job of this video

Make a sceptical developer believe two things, in under 90 seconds:

1. An AI agent can act on their **real** mailbox, not a toy one.
2. Connecting one takes about a minute, with no OAuth review queue.

That is the whole brief. Everything that does not serve those two beliefs is
cut.

## Know the product before you script it

Do not trust this section, and do not write a single line of voiceover from
memory. Verify each claim against the code and the live service:

- MCP Emails is an MCP server. It gives any MCP client (Claude Desktop, Claude
  Code, Cursor, and others) read and write access to real mailboxes over
  IMAP/SMTP, plus Gmail OAuth. It is not an email client and has no chat UI of
  its own.
- Read `apps/web/messages/en/` and the pricing code for the current plans,
  inbox limits and prices. Quote nothing from memory.
- Check `supabase/functions/mcp-server/` for the actual tool surface. The tools
  are grouped by resource and take an `action` argument.
- **Outlook is built but gated behind "Coming soon".** Do not show it, name it,
  or imply it.
- Run `npm run transcript -- --storyboard <id>` to execute the calls you intend
  to film against the real server. Whatever it records is what you are allowed
  to show. This is enforced: `render` refuses a chat scene whose transcript has
  any failed call, or one older than 14 days.

The enforcement exists because of a real incident. A production audit found
`email_compose` with 0 successes and 29 errors over 14 days, and four tools that
had never been called at all. Zero calls and zero failures look identical in a
dashboard and very different on camera. If a gate blocks you, the answer is to
cut the beat or fix the call, never to edit the transcript.

## Structure

Target **75 seconds**, hard ceiling 90. Completion drops sharply past 60, and a
demo that tries to cover the product covers none of it. One workflow, end to
end.

| Beat | Length | What it does |
|---|---|---|
| Hook | 0-6s | The problem, stated cold. No logo, no company intro, no "introducing". |
| The connect | 6-40s | Real capture of connecting a mailbox. This is the proof beat. |
| The payoff | 40-65s | An agent doing something useful with that mailbox. |
| Close | 65-75s | One claim, one CTA, done. |

Rules that come from how these actually perform:

- **Lead with the pain, not the product.** The first six seconds decide whether
  the rest is watched. "Your agent can write you an email. It cannot read the
  one your customer just sent." is a hook. "MCP Emails is a platform for..." is
  not.
- **One workflow, followed all the way through.** Connect a mailbox, then use
  it. Do not tour the dashboard, do not show settings, do not show the pricing
  page.
- **Cut faster than feels comfortable.** The most common failure is lingering.
  A cut that loses a little detail beats one that loses the viewer. Use `speed`
  on a capture scene and trim dead air with `clip`.
- **Direct the eye.** The pipeline draws a cursor and pushes in on whatever
  control is being used, automatically, from the recorded event log. Add a
  `callout` only where a viewer would otherwise miss something, at most two in
  the whole cut.
- **One CTA.** `mcpemails.com`. Not three links.

## The proof beat is not optional, and it is not drawn

Connecting a mailbox must be a real capture of the real dashboard. This product
asks strangers for mailbox credentials; a drawn or mocked connect flow is the
one thing that would confirm every suspicion a sceptic already has.

`shots/add-inbox.shot.mjs` already exists and does this. It needs:

- `cd tools/video-studio && npm run auth` first. Run it from the tool directory,
  never the repo root: nothing was added to the root `package.json`, so from the
  root you get `Missing script: "auth"`.

  It opens a headed browser and waits for a **human** to sign in. It cannot and
  must not sign in by itself. Ask the user to do it, and ask them to set the
  demo account's theme to match your storyboard while they are there.

  It wants the **mcpemails.com dashboard login**, which is a different
  credential from the Migadu app password that `DEMO_IMAP_PASS` holds. Say which
  one you are asking for.
- A throwaway mailbox. `scripts/demo/demo-mailbox.js` on branch
  `claude/brave-jackson-8180c8` seeds one with 14 fixture messages, every
  address on a `.example` domain, which RFC 2606 reserves so it can never belong
  to a real person.
- `npm run reset -- --yes` to empty the demo workspace so the list starts at
  zero. Read its guards before you run it; it disconnects inboxes on a live
  deployment.

**Never film a real inbox.** Not yours, not a customer's.

## The payoff beat, and the trap in it

MCP Emails has no chat surface. The agent side is a `chat` scene, drawn. Two
rules:

1. **Do not reproduce another company's interface.** The instinct is to make it
   look like Claude Desktop. Do not. It misrepresents whose product is whose and
   it dates the moment they restyle. The existing `Chat` scene is deliberately
   neutral: our type, our colours, a generic label. Keep it that way. If you
   must name a client, the voiceover says it as a fact.
2. **Show the tool calls.** They are the evidence that the model is reaching
   real mail rather than inventing it. The scene already renders each call's
   real name, arguments and result from the verified transcript.

Pick a payoff that is genuinely useful and genuinely works. Triage across a
messy inbox is the strongest candidate: the fixture set was built so that three
messages plainly need a human, a cluster plainly does not, and two are
deliberately ambiguous, because a triage demo where every call is obvious proves
nothing.

## Voiceover and captions

Write the script first, then time the cut to it, not the other way round. Under
200 words for 75 seconds. No em dashes anywhere in on-screen text, captions or
voiceover copy; the validator rejects them.

For timing, generate a scratch voiceover locally:

```bash
say -v Samantha -o /tmp/vo.aiff "your script here"
ffmpeg -y -i /tmp/vo.aiff -codec:a libmp3lame -b:a 128k assets/vo/<id>.mp3
```

Then set `"captions": true` and render. Word timings come from whisper, and the
same timings drive both the burned-in captions and the sidecar `.vtt`.

A synthetic scratch voice is fine for cutting and wrong for shipping. Say so
when you hand off: a real voice, or a deliberate decision to ship without one,
is the user's call.

## Definition of done

- `npm run verify -- --storyboard <id>` passes with zero failures.
- You have opened `out/<id>.sheet.png` and actually looked at every frame:
  layout, typography, contrast, whether the zoom framed the right control,
  whether any text is clipped.
- Total length is 90 seconds or less.
- Every claim in the voiceover traces to something you verified.
- Nothing was written outside `out/`. Publishing to the site is a separate human
  step and is out of scope.

## How to report it

Say what you checked and what you did not. `verify` runs mechanical checks and
samples still frames; **it cannot check motion.** Pacing, easing, whether an
entrance lands, and continuity across a cut exist only across frames and nothing
in the pipeline samples them. Do not say the video "looks good", because you
have not seen it move. State plainly that motion and pacing need a human pass,
and hand over the file.

If a beat you wanted turns out to be unfilmable, say which one and why, and
deliver the rest. Do not quietly substitute something weaker.
