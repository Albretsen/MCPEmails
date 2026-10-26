import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTROL_VARIANT,
  INTERNAL_VARIANT,
  ONBOARDING_STEPS,
  STEP_FUNNEL_CATEGORY,
  hasReusableInbox,
  initialStep,
  isOnboardingStep,
  nextStep,
  normalizeVariant,
  previousStep,
} from './flow.ts';
import { onboardingEntryPath } from './entry.ts';

test('steps run in plan order and each has a funnel category', () => {
  assert.deepEqual([...ONBOARDING_STEPS], ['inbox', 'add_to_ai', 'first_prompt', 'wait', 'it_works']);
  for (const step of ONBOARDING_STEPS) assert.equal(STEP_FUNNEL_CATEGORY[step], `step_${step}`);
  assert.equal(nextStep('inbox'), 'add_to_ai');
  assert.equal(nextStep('it_works'), null);
  assert.equal(previousStep('inbox'), null);
  assert.equal(previousStep('wait'), 'first_prompt');
  assert.equal(isOnboardingStep('wait'), true);
  assert.equal(isOnboardingStep('dashboard'), false);
});

test('initialStep resumes from the furthest server signal', () => {
  assert.equal(initialStep(null), 'inbox');
  assert.equal(initialStep({ inboxes: { count: 0, sinceReset: 0 } }), 'inbox');
  assert.equal(initialStep({ inboxes: { count: 1, sinceReset: 1 } }), 'add_to_ai');
  assert.equal(initialStep({ inboxes: { count: 1, sinceReset: 1 }, credential: { sinceReset: true } }), 'first_prompt');
  assert.equal(initialStep({ handshake: { at: '2026-10-26T10:00:00Z' } }), 'wait');
  assert.equal(initialStep({ handshake: { at: '2026-10-26T10:00:00Z' }, firstCall: { at: '2026-10-26T10:01:00Z' } }), 'it_works');
  // A call with no new handshake (claude.ai reuses its session) is past the prompt.
  assert.equal(initialStep({ handshake: { at: null }, anyCall: { at: '2026-10-26T10:00:00Z' } }), 'wait');
});

test('"Use <address>" survives a reload (WP-Z m3)', () => {
  const chosen = { inboxes: { count: 1, sinceReset: 0, chosenAt: '2026-10-26T10:00:00Z' }, credential: { sinceReset: false } };
  assert.equal(initialStep(chosen), 'add_to_ai');
  assert.equal(hasReusableInbox(chosen), false);
  assert.equal(initialStep({ ...chosen, credential: { sinceReset: true } }), 'first_prompt');
});

test('after a reset an old inbox is offered for reuse, not skipped past', () => {
  const afterReset = { inboxes: { count: 1, sinceReset: 0 }, credential: { sinceReset: false } };
  assert.equal(initialStep(afterReset), 'inbox');
  assert.equal(hasReusableInbox(afterReset), true);
  assert.equal(hasReusableInbox({ inboxes: { count: 1, sinceReset: 1 } }), false);
  assert.equal(hasReusableInbox({ inboxes: { count: 0, sinceReset: 0 } }), false);
  assert.equal(hasReusableInbox(null), false);
});

test('variants normalise to the control on anything malformed', () => {
  assert.deepEqual(CONTROL_VARIANT, { flow: 'control', convert: 'off' });
  assert.deepEqual(INTERNAL_VARIANT, { flow: 'new', convert: 'on' });
  assert.deepEqual(normalizeVariant({ flow: 'new', convert: 'on' }), { flow: 'new', convert: 'on' });
  assert.deepEqual(normalizeVariant({ flow: 'NEW', convert: true }), { flow: 'control', convert: 'off' });
  assert.deepEqual(normalizeVariant(null), { flow: 'control', convert: 'off' });
});

test('only a first-run dashboard destination is sent to /onboarding, hints kept', () => {
  assert.equal(onboardingEntryPath('/dashboard?firstrun=1'), '/onboarding');
  assert.equal(
    onboardingEntryPath('/dashboard?firstrun=1&provider=gmail&client=claude&signup_method=google&x=1'),
    '/onboarding?provider=gmail&client=claude&signup_method=google',
  );
  assert.equal(onboardingEntryPath('/dashboard'), null);
  assert.equal(onboardingEntryPath('/dashboard/inboxes?firstrun=1'), null);
  assert.equal(onboardingEntryPath('/invite/abc'), null);
  assert.equal(onboardingEntryPath('/api/stripe/checkout/start?plan=pro'), null);
  assert.equal(onboardingEntryPath('//evil.example/dashboard?firstrun=1'), null);
  assert.equal(onboardingEntryPath(null), null);
});
