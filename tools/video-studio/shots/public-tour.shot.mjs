/**
 * Shot: a short tour of the public marketing site.
 *
 * This shot exists mainly as the tool's own end-to-end test. It needs no
 * session and no mailbox, so it can be run on any machine to prove that the
 * recorder, the video file, the bounding boxes, the cursor, the auto zoom and
 * the callouts all still work together, without going near a demo account or a
 * throwaway inbox.
 *
 * It is filmable too: every page it touches is public marketing copy. But the
 * product beat is add-inbox, and this is not a substitute for it.
 */

/** Public pages only, so this shot never needs the saved demo session. */
export const requiresSession = false;

export const id = 'public-tour';
export const description =
  'Public marketing pages only: home, pricing, docs. No session, no mailbox. Doubles as the pipeline self-test.';

export async function run(page, t, { baseUrl }) {
  await t.goto(baseUrl);
  await t.dwell(1.2, 'Land on the home page');

  // Cookie and consent banners are declined, never accepted, and are dismissed
  // before the tour rather than left to drift through frame.
  const decline = page.getByRole('button', { name: /decline|reject|only necessary/i }).first();
  if (await decline.count().catch(() => 0)) {
    await t.click(decline, { note: 'Decline non-essential cookies' });
  }

  await t.click(page.getByRole('link', { name: /^pricing$/i }).first(), {
    note: 'Pricing',
  });
  await t.settle();
  await t.dwell(1.6, 'Read the plans');

  const docs = page.getByRole('link', { name: /^docs$/i }).first();
  if (await docs.count().catch(() => 0)) {
    await t.click(docs, { note: 'Docs' });
    await t.settle();
    await t.dwell(1.4, 'Read the docs index');
  }

  await t.dwell(1.0, 'Hold');
}
