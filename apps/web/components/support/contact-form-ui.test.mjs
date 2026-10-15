// ---------------------------------------------------------------------------
// /help contact form, rendered for real.
//
// Run with: npm run test:support-contact-form-ui
//
// The real ContactForm with the real English copy, and `fetch` stubbed so each
// POST lands in this file. Covers the two shapes (signed out asks for an
// address; signed in shows it read-only and lists what will be attached), the
// exact JSON body the ticket API receives, an error code mapped to its line,
// and the reference on success.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

installDom();

const { default: ContactForm } = await import('./ContactForm.jsx');
const { default: en } = await import('../../src/lib/support/help-content/en.json', { with: { type: 'json' } });

const CONTEXT = {
  workspace_id: 'ws-0001',
  plan: 'free',
  mailboxes: [{ provider: 'imap', service: 'yahoo', host: 'imap.mail.yahoo.com', status: 'error', last_error_code: 'auth_failed' }],
  from: 'connect-modal',
  provider: 'yahoo',
  code: 'auth_failed',
};

/** What the stubbed fetch received, and what it answers next. */
let calls = [];
let reply = { status: 201, body: { ok: true, ref: 'MCPE-1001' } };

function stubFetch(t) {
  const previous = globalThis.fetch;
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
    if (reply === 'throw') throw new TypeError('network down');
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body };
  };
  t.after(() => { globalThis.fetch = previous; });
}

async function render(t, props = {}) {
  stubFetch(t);
  const view = await mount(createElement(ContactForm, { copy: en, formToken: 'tok.abc', ...props }));
  t.after(() => view.unmount());
  return view;
}

/** Types into a controlled field the way React expects (native setter, then an input event). */
async function typeInto(el, value) {
  await flush(() => {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

async function fillAndSend(container, { email } = {}) {
  if (email !== undefined) await typeInto(container.querySelector('#help-email'), email);
  await typeInto(container.querySelector('#help-subject'), 'Yahoo will not connect');
  await typeInto(container.querySelector('#help-message'), 'It says the password is wrong.');
  await flush(() => container.querySelector('button[type="submit"]').click());
}

test('signed out: an email field, no attach disclosure', async (t) => {
  const { container } = await render(t);
  assert.equal(container.querySelector('#help-email') === null, false);
  assert.equal(container.querySelector('#help-email').maxLength, 254);
  assert.equal(container.querySelector('details.help-attach') === null, true);
  assert.equal(container.querySelector('#contact') === null, false);
});

test('fields carry the API caps and the honeypot is out of reach', async (t) => {
  const { container } = await render(t);
  assert.equal(container.querySelector('#help-subject').maxLength, 150);
  assert.equal(container.querySelector('#help-message').maxLength, 5000);
  const hp = container.querySelector('input[name="website"]');
  assert.equal(hp.tabIndex, -1);
  assert.equal(hp.getAttribute('autocomplete'), 'off');
  assert.equal(hp.parentElement.getAttribute('aria-hidden'), 'true');
  assert.equal(container.querySelectorAll('#help-category option').length, 6);
});

test('signed in: no email field, the address read-only, and the attach disclosure', async (t) => {
  const { container } = await render(t, { signedInEmail: 'staff@example.com', context: CONTEXT });
  assert.equal(container.querySelector('#help-email') === null, true);
  assert.equal(container.querySelector('[data-signed-in-email]').textContent, 'staff@example.com');
  const details = container.querySelector('details.help-attach');
  assert.equal(details === null, false);
  const text = details.textContent;
  assert.equal(text.includes(en.attach.summary), true);
  assert.equal(text.includes('ws-0001'), true);
  assert.equal(text.includes('imap.mail.yahoo.com'), true);
  assert.equal(text.includes('auth_failed'), true);
  assert.equal(text.includes(en.attach.never), true);
});

test('submit (signed out) posts the exact JSON, honeypot empty, token included', async (t) => {
  reply = { status: 201, body: { ok: true, ref: 'MCPE-1001' } };
  const { container } = await render(t, {
    initialCategory: 'connect',
    meta: { from: 'connect-modal', provider: 'yahoo', code: null },
  });
  await fillAndSend(container, { email: 'person@example.com' });
  await waitFor(() => calls.length === 1, { message: 'the POST' });
  const { url, method, body } = calls[0];
  assert.equal(url, '/api/support/tickets');
  assert.equal(method, 'POST');
  assert.equal(JSON.stringify(body), JSON.stringify({
    category: 'connect',
    subject: 'Yahoo will not connect',
    message: 'It says the password is wrong.',
    website: '',
    formToken: 'tok.abc',
    email: 'person@example.com',
    from: 'connect-modal',
    provider: 'yahoo',
  }));
});

test('submit (signed in) sends no email: the server takes it from the session', async (t) => {
  reply = { status: 201, body: { ok: true, ref: 'MCPE-1002' } };
  const { container } = await render(t, { signedInEmail: 'staff@example.com', context: CONTEXT });
  await fillAndSend(container);
  await waitFor(() => calls.length === 1, { message: 'the POST' });
  assert.equal('email' in calls[0].body, false);
  assert.equal(calls[0].body.formToken, 'tok.abc');
});

test('an error code renders its mapped line and the form stays', async (t) => {
  reply = { status: 429, body: { ok: false, error: 'rate_limited' } };
  const { container } = await render(t);
  await fillAndSend(container, { email: 'person@example.com' });
  const line = await waitFor(() => container.querySelector('.help-error'), { message: 'the error line' });
  assert.equal(line.textContent, en.errors.rate_limited);
  assert.equal(line.getAttribute('data-error-code'), 'rate_limited');
  assert.equal(container.querySelector('form') === null, false);
  assert.equal(container.querySelector('button[type="submit"]').disabled, false);
});

test('a network failure reads as the network line', async (t) => {
  reply = 'throw';
  const { container } = await render(t);
  await fillAndSend(container, { email: 'person@example.com' });
  const line = await waitFor(() => container.querySelector('.help-error'), { message: 'the error line' });
  assert.equal(line.textContent, en.errors.network);
});

test('an empty subject is caught before any request', async (t) => {
  const { container } = await render(t);
  await typeInto(container.querySelector('#help-email'), 'person@example.com');
  await typeInto(container.querySelector('#help-message'), 'Body');
  await flush(() => container.querySelector('button[type="submit"]').click());
  assert.equal(calls.length, 0);
  assert.equal(container.querySelector('.help-error').textContent, en.errors.subject_required);
});

test('success replaces the form with the reference', async (t) => {
  reply = { status: 201, body: { ok: true, ref: 'MCPE-1001' } };
  const { container } = await render(t);
  await fillAndSend(container, { email: 'person@example.com' });
  const ok = await waitFor(() => container.querySelector('.help-success'), { message: 'the success line' });
  assert.equal(ok.textContent.includes('MCPE-1001'), true);
  assert.equal(container.querySelector('form') === null, true);
});

test('a silent drop (ref null) shows the generic success', async (t) => {
  reply = { status: 200, body: { ok: true, ref: null } };
  const { container } = await render(t);
  await fillAndSend(container, { email: 'person@example.com' });
  const ok = await waitFor(() => container.querySelector('.help-success'), { message: 'the success line' });
  assert.equal(ok.textContent, en.success.noRef);
});
