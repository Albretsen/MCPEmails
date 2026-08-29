import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TRANSPORT_ATTEMPTS,
  PROTOCOL_BUDGET_MS,
  attemptTimeoutMs,
  detectTransport,
  isTransportFailure,
  shouldTryNextTransport,
  transportPlan,
} from './transport-autodetect.ts';

test('only failures that never established a session are retried', () => {
  // The port was wrong, the handshake did not happen, or what came back was not
  // the protocol. None of these reached the point of presenting a credential.
  assert.equal(isTransportFailure('CONNECTION_REFUSED'), true);
  assert.equal(isTransportFailure('CONNECTION_TIMEOUT'), true);
  assert.equal(isTransportFailure('TLS_HANDSHAKE_FAILED'), true);
  assert.equal(isTransportFailure('IMAP_PROTOCOL_ERROR'), true);
  assert.equal(isTransportFailure('SMTP_PROTOCOL_ERROR'), true);
});

test('a rejected credential is never retried on another transport', () => {
  // This is the whole safety property. The server spoke the protocol and said
  // no, so every retry would be another failed login against the provider's
  // lockout counter and would end the same way.
  assert.equal(isTransportFailure('AUTH_FAILED'), false);
  // The server reached AUTH and refused the mechanism, which no port fixes.
  assert.equal(isTransportFailure('AUTH_MECHANISM_UNSUPPORTED'), false);
  // DNS has no answer, so every port fails identically.
  assert.equal(isTransportFailure('HOST_NOT_FOUND'), false);
  assert.equal(isTransportFailure(undefined), false);
  assert.equal(isTransportFailure(null), false);
  assert.equal(isTransportFailure(''), false);
});

test('the requested transport is always tried first and always present', () => {
  const standard = transportPlan('imap', { port: 993, security: 'tls' });
  assert.deepEqual(standard, [
    { port: 993, security: 'tls', requested: true },
    { port: 143, security: 'starttls', requested: false },
  ]);

  // A deliberate non-standard port must not be replaced by a guess: hosts that
  // serve IMAP somewhere unusual exist, and the user typed it for a reason.
  const custom = transportPlan('imap', { port: 1993, security: 'tls' });
  assert.equal(custom[0].port, 1993);
  assert.equal(custom[0].requested, true);
  assert.deepEqual(custom.map((c) => c.port), [1993, 993, 143]);
});

test('a requested transport is not duplicated among the alternatives', () => {
  const plan = transportPlan('smtp', { port: 587, security: 'starttls' });
  assert.deepEqual(plan.map((c) => `${c.port}/${c.security}`), ['587/starttls', '465/tls', '25/starttls']);
  assert.equal(plan.filter((c) => c.port === 587).length, 1);
});

test('a plan never exceeds the attempt ceiling', () => {
  for (const protocol of ['imap', 'smtp'] as const) {
    for (const port of [25, 143, 465, 587, 993, 2525]) {
      const plan = transportPlan(protocol, { port, security: 'tls' });
      assert.ok(plan.length <= MAX_TRANSPORT_ATTEMPTS, `${protocol}:${port} planned ${plan.length}`);
      assert.equal(plan[0].requested, true);
    }
  }
});

test('the wall-clock budget stops a retry that could not finish inside it', () => {
  const base = { code: 'CONNECTION_TIMEOUT', attemptsMade: 1, candidatesRemaining: 1 };
  // 10s spent, a 6s retry: 16s fits inside the 20s budget.
  assert.equal(shouldTryNextTransport({ ...base, elapsedMs: 10_000 }), true);
  // 15s spent: the retry would end at 21s, past the budget, so it never starts.
  assert.equal(shouldTryNextTransport({ ...base, elapsedMs: 15_000 }), false);
  assert.equal(shouldTryNextTransport({ ...base, elapsedMs: 0, budgetMs: 5_000 }), false);
});

test('the loop stops when candidates or attempts run out', () => {
  assert.equal(
    shouldTryNextTransport({ code: 'CONNECTION_TIMEOUT', attemptsMade: 1, candidatesRemaining: 0, elapsedMs: 0 }),
    false
  );
  assert.equal(
    shouldTryNextTransport({ code: 'CONNECTION_TIMEOUT', attemptsMade: MAX_TRANSPORT_ATTEMPTS, candidatesRemaining: 5, elapsedMs: 0 }),
    false
  );
});

test('retries get a shorter socket timeout than the requested transport', () => {
  // The first attempt is the one most likely to be right, so it keeps the
  // original generous timeout; a guess runs while the user is already waiting.
  assert.ok(attemptTimeoutMs(0) > attemptTimeoutMs(1));
  assert.ok(attemptTimeoutMs(0) + attemptTimeoutMs(1) <= PROTOCOL_BUDGET_MS);
});

/** A fake validator that answers from a script keyed by "port/security". */
function scriptedAttempt(script: Record<string, { ok: boolean; code?: string }>) {
  const tried: string[] = [];
  return {
    tried,
    attempt: async (candidate: { port: number; security: string }) => {
      const key = `${candidate.port}/${candidate.security}`;
      tried.push(key);
      return script[key] ?? { ok: false, code: 'CONNECTION_TIMEOUT' };
    },
  };
}

test('a wrong transport is corrected without the user being asked', async () => {
  // The reported production case: the user submitted 993/implicit-TLS at a host
  // that only offers STARTTLS on 143.
  const { tried, attempt } = scriptedAttempt({
    '993/tls': { ok: false, code: 'CONNECTION_TIMEOUT' },
    '143/starttls': { ok: true },
  });
  const outcome = await detectTransport(
    transportPlan('imap', { port: 993, security: 'tls' }),
    attempt,
    { now: () => 0 }
  );

  assert.equal(outcome.result.ok, true);
  assert.deepEqual(tried, ['993/tls', '143/starttls']);
  // What gets persisted is the transport that worked, not the one submitted.
  assert.equal(outcome.candidate.port, 143);
  assert.equal(outcome.candidate.security, 'starttls');
  assert.equal(outcome.adjusted, true);
});

test('a rejected password ends the run at one attempt', async () => {
  const { tried, attempt } = scriptedAttempt({
    '993/tls': { ok: false, code: 'AUTH_FAILED' },
    '143/starttls': { ok: true },
  });
  const outcome = await detectTransport(
    transportPlan('imap', { port: 993, security: 'tls' }),
    attempt,
    { now: () => 0 }
  );

  // 143 must never be dialled: the server on 993 spoke IMAP and refused the
  // login, so a second and third login attempt would only risk a lockout.
  assert.deepEqual(tried, ['993/tls']);
  assert.equal(outcome.attempts, 1);
  assert.equal(outcome.result.ok, false);
  assert.equal(outcome.adjusted, false);
});

test('an unresolvable host is not dialled three times', async () => {
  const { tried, attempt } = scriptedAttempt({
    '993/tls': { ok: false, code: 'HOST_NOT_FOUND' },
  });
  await detectTransport(transportPlan('imap', { port: 993, security: 'tls' }), attempt, { now: () => 0 });
  assert.deepEqual(tried, ['993/tls']);
});

test('SMTP walks 465, 587 then 25 and stops at the first that answers', async () => {
  const { tried, attempt } = scriptedAttempt({
    '465/tls': { ok: false, code: 'CONNECTION_TIMEOUT' },
    // Exchange: nothing on 465, STARTTLS submission on 587.
    '587/starttls': { ok: true },
  });
  const outcome = await detectTransport(
    transportPlan('smtp', { port: 465, security: 'tls' }),
    attempt,
    { now: () => 0 }
  );
  assert.deepEqual(tried, ['465/tls', '587/starttls']);
  assert.equal(outcome.candidate.port, 587);
});

test('a run that exhausts every transport reports the last failure, not a success', async () => {
  const { tried, attempt } = scriptedAttempt({});
  const outcome = await detectTransport(
    transportPlan('smtp', { port: 465, security: 'tls' }),
    attempt,
    { now: () => 0 }
  );
  assert.equal(outcome.result.ok, false);
  assert.equal(outcome.attempts, MAX_TRANSPORT_ATTEMPTS);
  assert.equal(tried.length, MAX_TRANSPORT_ATTEMPTS);
  assert.equal(outcome.adjusted, false);
});

test('a real clock cannot push the run past its budget', async () => {
  // Every attempt "takes" its full timeout, so the only thing that can stop the
  // run before the attempt ceiling is the budget.
  let clock = 0;
  const tried: string[] = [];
  const outcome = await detectTransport(
    transportPlan('smtp', { port: 465, security: 'tls' }),
    async (candidate, timeoutMs) => {
      tried.push(`${candidate.port}`);
      clock += timeoutMs;
      return { ok: false, code: 'CONNECTION_TIMEOUT' };
    },
    { now: () => clock }
  );
  assert.ok(clock <= PROTOCOL_BUDGET_MS, `spent ${clock}ms of a ${PROTOCOL_BUDGET_MS}ms budget`);
  assert.equal(outcome.result.ok, false);
});
