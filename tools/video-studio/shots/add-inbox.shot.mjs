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

  // Hold on the empty list for a moment. The shot only reads as "adding an
  // inbox" if the viewer sees there was not one a second ago.
  await t.dwell(1.4, 'Empty inbox list');

  await t.click(page.getByRole('button', { name: /connect inbox/i }).first(), {
    note: 'Open the connect modal',
  });

  // Step 1: the provider grid.
  const providers = page.getByRole('radiogroup');
  await t.click(providers.getByRole('radio', { name: /IMAP \/ SMTP/i }).first(), {
    note: 'Choose generic IMAP, which works with any mailbox',
  });

  await t.click(page.getByRole('button', { name: /enter credentials/i }).first(), {
    note: 'Continue to credentials',
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
