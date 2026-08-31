/**
 * The timeline recorder: the `t` handed to every shot recipe.
 *
 * This is the reason the pipeline works. Playwright's recordVideo produces a
 * silent, cursorless film of a page changing by itself. Every wrapper here
 * records WHERE and WHEN the interaction happened, in the same coordinate
 * space as the video, so the compositor can draw the cursor, push in on the
 * control and hang a callout beside it. None of that is possible after the
 * fact, and all of it is free at record time.
 *
 * Two behaviours are enforced here rather than left to each recipe:
 *
 *   Type, do not fill. page.fill() teleports a whole string into a field. On
 *   camera it reads as a cut, or as a bug. Every text entry goes character by
 *   character at a human cadence.
 *
 *   Dwell after everything. Machine-speed interaction is unreadable. Each
 *   action leaves a beat behind it, and the beat is recorded so the editor
 *   knows the pause was intentional rather than a stall.
 */

const DEFAULT_TYPE_DELAY = 50;
const DEFAULT_DWELL = 0.55;

export class Recorder {
  /**
   * @param {import('playwright').Page} page
   * @param {number} startedAt performance.now() at context creation, which is
   *   when Playwright started writing video frames.
   */
  constructor(page, startedAt, { onLog } = {}) {
    this.page = page;
    this.startedAt = startedAt;
    this.events = [];
    this.onLog = onLog ?? (() => {});
  }

  /** Seconds since the recording started, to the millisecond. */
  now() {
    return Math.round(performance.now() - this.startedAt) / 1000;
  }

  async rectOf(locator) {
    try {
      const box = await locator.boundingBox({ timeout: 5000 });
      if (!box) return undefined;
      // Round: sub-pixel boxes make the zoom target jitter between takes for
      // no visible benefit.
      return {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      };
    } catch {
      return undefined;
    }
  }

  push(event) {
    this.events.push(event);
    const where = event.rect ? ` @${event.rect.x},${event.rect.y}` : '';
    this.onLog(`  ${event.t.toFixed(2)}s  ${event.kind}${where}${event.note ? `  ${event.note}` : ''}`);
    return event;
  }

  async goto(url) {
    const t = this.now();
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    this.push({ t, kind: 'navigate', note: url });
    await this.settle();
  }

  /**
   * Wait for the page to stop moving. networkidle alone is not enough: the
   * dashboard hydrates and then animates, and cutting into a half-animated
   * panel looks like a dropped frame.
   */
  async settle(extraSeconds = 0.6) {
    try {
      await this.page.waitForLoadState('networkidle', { timeout: 15000 });
    } catch {
      // A long-poll or an open stream keeps the page from ever reaching
      // networkidle. Not a failure: fall through to the fixed beat.
    }
    await this.page.waitForTimeout(extraSeconds * 1000);
  }

  async click(locator, { note, dwell = DEFAULT_DWELL } = {}) {
    await locator.waitFor({ state: 'visible', timeout: 20000 });
    await locator.scrollIntoViewIfNeeded();
    // The box is read IMMEDIATELY before the click. Reading it earlier risks a
    // layout shift moving the control out from under the recorded rect, and a
    // cursor pointing at empty space is worse than no cursor.
    const rect = await this.rectOf(locator);
    const t = this.now();
    await locator.click();
    this.push({ t, kind: 'click', note, rect });
    await this.page.waitForTimeout(dwell * 1000);
    return rect;
  }

  /**
   * Type into a field, character by character.
   *
   * `mask: true` marks the event so nothing downstream can print the value.
   * The value itself is never stored in the timeline, masked or not: the
   * timeline is a build artifact and build artifacts get pasted into issues.
   */
  async type(locator, text, { delay = DEFAULT_TYPE_DELAY, note, mask = false, dwell = 0.4 } = {}) {
    await locator.waitFor({ state: 'visible', timeout: 20000 });
    await locator.scrollIntoViewIfNeeded();
    const rect = await this.rectOf(locator);
    const t = this.now();

    await locator.click();
    await locator.pressSequentially(text, { delay });

    const event = this.push({
      t,
      kind: 'type',
      note,
      rect,
      masked: mask || undefined,
      duration: Math.round(performance.now() - this.startedAt) / 1000 - t,
    });

    if (mask) {
      // Belt and braces: prove the field is not rendering the value in clear
      // text before the frame goes anywhere. A password box that lost its
      // type=password is a leak, and it is invisible in a log.
      const type = await locator.getAttribute('type');
      if (type !== 'password') {
        throw new Error(
          `Refusing to continue: typed a masked value into a field whose type is "${type}", not "password". ` +
          'The recording would show the credential in clear text.',
        );
      }
    }

    await this.page.waitForTimeout(dwell * 1000);
    return event;
  }

  /** Wait for something to appear, and record where it appeared. */
  async waitFor(locator, { note, timeout = 30000, dwell = 0.3 } = {}) {
    await locator.waitFor({ state: 'visible', timeout });
    const rect = await this.rectOf(locator);
    this.push({ t: this.now(), kind: 'wait', note, rect });
    await this.page.waitForTimeout(dwell * 1000);
    return rect;
  }

  /** A deliberate pause, so the viewer can read what just happened. */
  async dwell(seconds, note) {
    this.push({ t: this.now(), kind: 'dwell', note });
    await this.page.waitForTimeout(seconds * 1000);
  }

  toTimeline({ shot, baseUrl, viewport }) {
    return {
      shot,
      recordedAt: new Date().toISOString(),
      baseUrl,
      durationMs: Math.round(performance.now() - this.startedAt),
      viewport,
      events: this.events,
    };
  }
}
