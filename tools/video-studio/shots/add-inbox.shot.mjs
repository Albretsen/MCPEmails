/**
 * Shot: connect a generic IMAP mailbox, from an empty inbox list to a
 * connected one.
 *
 * This is the beat that has to be REAL. The product asks sceptics for mailbox
 * credentials, so a drawn version of a connect flow is worse than no video:
 * anyone who has used the product would spot it, and anyone who has not would
 * be right to assume the worst. Everything here is the actual dashboard.
 *
 * Selectors are grounded in apps/web/components/dashboard/ConnectModal.jsx and
 * apps/web/messages/en/dashboardChrome.json rather than guessed. Two that are
 * easy to get wrong:
 *
 *   - The step-1 button is "Enter credentials", NOT "Connect" or "Continue".
 *     connectLabel() only says "Connect with Google"/"Connect with Microsoft"
 *     for the OAuth providers.
 *   - The generic IMAP tile is labelled "IMAP / SMTP", and it is a
 *     role="radio" inside a role="radiogroup", not a button.
 *
 * Preconditions:
 *   npm run reset -- --yes     so the list starts empty
 *   DEMO_IMAP_* set to the throwaway mailbox seeded by scripts/demo/demo-mailbox.js
 */

export const id = 'add-inbox';
export const description =
  'Open the connect modal, choose generic IMAP, enter host and an app password, connect.';

export async function run(page, t, { baseUrl }) {
  await t.goto(`${baseUrl}/dashboard/inboxes`);

  // Wait for the list to actually paint before holding on it. Measured twice
  // on 2026-09-01: this dashboard first paints 3.9s after the navigation, and
  // `goto` returns well before that, so without this the 1.4s dwell below was
  // spent on a blank page and the capture reached the modal 0.07s after the
  // empty list appeared. The beat this shot exists for was being recorded and
  // then thrown away.
  //
  // `settle` and not `waitFor`: settle pushes no timeline event, so it adds no
  // cursor and no zoom anchor. A `waitFor` here would anchor a push-in on the
  // Connect button a beat before the click that already anchors one.
  await t.settle();

  // Hold on the empty list for a moment. The shot only reads as "adding an
  // inbox" if the viewer sees there was not one a second ago.
  await t.dwell(1.4, 'Empty inbox list');

  // Longer dwells than the 0.55s default through the opening beats. At the
  // default these three clicks land 0.6s apart, which is faster than a viewer
  // can follow a modal opening, a grid appearing, and a tile being selected.
  // The recording is the pacing: slowing the whole scene down afterwards
  // stretches the typing too, which already reads at the right speed.
  //
  // The CENTRE button, not the one in the header. This page has two "Connect
  // inbox" buttons: one top-right and one in the empty-state card. `.first()`
  // took the header one, which sits in the top-right corner, so the auto zoom
  // framed that corner and the modal then opened centre-screen and was cut off
  // by the edge of the frame. Anchoring on the empty state's button puts the
  // push-in where the modal is about to appear, and the shot stays framed
  // through the transition. Scoped to `.empty` rather than `.nth(1)` so it
  // cannot silently pick the wrong one if the header changes.
  const connect = page.locator('.empty').getByRole('button', { name: /connect inbox/i }).first();

  // A real hover, held, before the click. The drawn cursor rests on a control
  // before pressing it (HOVER_BEFORE_CLICK in Capture.tsx), and without this
  // the button underneath it would be sitting in its resting state the whole
  // time, so the pause read as the video stalling rather than as pointing at
  // something. `page.hover` and not `t.hover`: a hover is not an action that
  // needs a timeline anchor, and the click on the next line supplies one.
  await connect.hover();
  await t.dwell(1.0, 'Hover the connect button');

  await t.click(connect, {
    note: 'Open the connect modal',
    dwell: 1.5,
  });

  // Step 1: the provider grid.
  const providers = page.getByRole('radiogroup');
  await t.click(providers.getByRole('radio', { name: /IMAP \/ SMTP/i }).first(), {
    note: 'Choose generic IMAP, which works with any mailbox',
    dwell: 1.6,
  });

  await t.click(page.getByRole('button', { name: /enter credentials/i }).first(), {
    note: 'Continue to credentials',
    dwell: 1.1,
  });

  // Step 2: the credential form.
  await t.type(page.getByPlaceholder('you@example.com'), process.env.DEMO_IMAP_USER, {
    delay: 55,
    note: 'The mailbox address',
  });

  await t.type(page.getByPlaceholder('imap.example.com'), process.env.DEMO_IMAP_HOST, {
    delay: 45,
    note: 'IMAP host',
  });

  // The SMTP host field is prefilled from the IMAP host on some providers, so
  // only type into it when it is actually empty. Typing over a prefilled value
  // produces a doubled string on camera.
  const smtp = page.getByPlaceholder('smtp.example.com');
  if (await smtp.count()) {
    const existing = await smtp.inputValue();
    if (!existing) {
      await t.type(smtp, process.env.DEMO_SMTP_HOST ?? process.env.DEMO_IMAP_HOST, {
        delay: 45,
        note: 'SMTP host',
      });
    }
  }

  // The recorder refuses to continue if this field is not type=password, so a
  // regression that unmasked it can never reach a frame.
  await t.type(page.locator('input[type="password"]').first(), process.env.DEMO_IMAP_PASS, {
    delay: 40,
    mask: true,
    note: 'An app password, never your login password',
  });

  await t.click(page.getByRole('button', { name: /^connect inbox$/i }).last(), {
    note: 'Connect',
  });

  // The server actually opens an IMAP session here, so this is a real wait on
  // a real connection, not a scripted pause.
  await t.waitFor(page.getByText(process.env.DEMO_IMAP_USER, { exact: false }).first(), {
    note: 'Connected, and listed',
    timeout: 60000,
  });

  await t.dwell(2.2, 'Let the result land');
}
