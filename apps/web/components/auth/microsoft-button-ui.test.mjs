// ---------------------------------------------------------------------------
// "Sign in with Microsoft" ships dark behind NEXT_PUBLIC_MICROSOFT_SIGN_IN_ENABLED.
//
// Run with: npm run test:microsoft-button-ui
//
// The Supabase azure provider is disabled in production, so the button must
// not appear on /login or /signup until the owner turns the flag on. Google
// and GitHub stay exactly where they were.
// ---------------------------------------------------------------------------

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount } from '../../scripts/test-dom.mjs';

const window = installDom();

mock.module(new URL('../../scripts/test-stubs/supabase-client.mjs', import.meta.url).href, {
  namedExports: {
    createClient: () => ({
      auth: {
        signUp: async () => ({ data: { user: null, session: null }, error: null }),
        getUser: async () => ({ data: { user: null }, error: null }),
      },
    }),
  },
});
const { NextIntlClientProvider } = await import('next-intl');
const { SignupApp } = await import('./SignupApp.jsx');
const { LoginApp } = await import('./LoginApp.jsx');
const auth = (await import('../../messages/en/auth.json', { with: { type: 'json' } })).default;

window._virtualConsole?.removeAllListeners?.('jsdomError');

async function buttonLabels(t, Component, flag) {
  const previous = process.env.NEXT_PUBLIC_MICROSOFT_SIGN_IN_ENABLED;
  if (flag === undefined) delete process.env.NEXT_PUBLIC_MICROSOFT_SIGN_IN_ENABLED;
  else process.env.NEXT_PUBLIC_MICROSOFT_SIGN_IN_ENABLED = flag;
  const view = await mount(
    createElement(NextIntlClientProvider, { locale: 'en', messages: { auth } }, createElement(Component, {})),
  );
  t.after(async () => {
    await view.unmount();
    if (previous === undefined) delete process.env.NEXT_PUBLIC_MICROSOFT_SIGN_IN_ENABLED;
    else process.env.NEXT_PUBLIC_MICROSOFT_SIGN_IN_ENABLED = previous;
  });
  return [...view.container.querySelectorAll('button')].map((b) => b.textContent.trim());
}

for (const [name, Component] of [['login', LoginApp], ['signup', SignupApp]]) {
  test(`${name}: no Microsoft button when the flag is unset`, async (t) => {
    const labels = await buttonLabels(t, Component, undefined);
    assert.equal(labels.includes(auth.shared.signInWithMicrosoft), false);
    assert.equal(labels.some((l) => l.includes('Google')), true, 'Google is still there');
    assert.equal(labels.some((l) => l.includes('GitHub')), true, 'GitHub is still there');
  });

  test(`${name}: no Microsoft button for any value but "true"`, async (t) => {
    const labels = await buttonLabels(t, Component, '1');
    assert.equal(labels.includes(auth.shared.signInWithMicrosoft), false);
  });

  test(`${name}: the Microsoft button appears with the flag on`, async (t) => {
    const labels = await buttonLabels(t, Component, 'true');
    assert.equal(labels.includes(auth.shared.signInWithMicrosoft), true);
  });
}
