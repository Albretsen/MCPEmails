import test from 'node:test';
import assert from 'node:assert/strict';
import type * as net from 'net';
import { probeImapThroughRelay } from './relay-probe.ts';
import { MailRelayUnavailableError } from './mail-relay.ts';
import type { ImapCredential, ImapValidationResult } from './validate-imap.ts';

const input = { host: 'imap.orange.fr', port: 993, email: 'nom@orange.fr', password: 'abcde-fghij-klmno-pqrst' };
const config = { host: '203.0.113.7', port: 3128, authorization: null };
const fakeSocket = {} as net.Socket;

function authFailed(detail: string): ImapValidationResult {
  return { ok: false, code: 'AUTH_FAILED', message: 'x', phase: 'authentication', detail };
}

/** A validator that opens the tunnel the way the real one does, then answers. */
function validatorReturning(result: ImapValidationResult) {
  const seen: ImapCredential[] = [];
  const validate = async (cred: ImapCredential): Promise<ImapValidationResult> => {
    seen.push(cred);
    try {
      await cred.tunnel?.();
    } catch {
      return { ok: false, code: 'IMAP_PROTOCOL_ERROR', message: 'x', phase: 'tls' };
    }
    return result;
  };
  return { validate, seen };
}

test('no relay configured is its own outcome and attempts nothing', async () => {
  const { validate, seen } = validatorReturning({ ok: true, phase: 'authentication' });
  const result = await probeImapThroughRelay(input, { config: null, validate });
  assert.deepEqual(result, { outcome: 'not_configured', detail: null });
  assert.equal(seen.length, 0);
});

test('a login the relay gets through means the provider objects to our address', async () => {
  const { validate, seen } = validatorReturning({ ok: true, phase: 'authentication' });
  const targets: string[] = [];
  const result = await probeImapThroughRelay(input, {
    config,
    validate,
    openTunnel: async (_config, host, port) => { targets.push(`${host}:${port}`); return fakeSocket; },
  });
  assert.deepEqual(result, { outcome: 'accepted', detail: null });
  // The same credential, over implicit TLS, to the same host, through the tunnel.
  assert.equal(seen[0].security, 'tls');
  assert.equal(seen[0].password, input.password);
  assert.deepEqual(targets, ['imap.orange.fr:993']);
});

test('the same refusal through the relay is told apart from a different one', async () => {
  const openTunnel = async () => fakeSocket;
  const same = await probeImapThroughRelay(input, {
    config, openTunnel, validate: validatorReturning(authFailed('NO [ALERT] Authentication failed.')).validate,
  });
  assert.deepEqual(same, { outcome: 'refused_same', detail: 'NO [ALERT] Authentication failed.' });
  const other = await probeImapThroughRelay(input, {
    config, openTunnel, validate: validatorReturning(authFailed('NO [AUTHENTICATIONFAILED] Authentication failed.')).validate,
  });
  assert.equal(other.outcome, 'refused_other');
  assert.equal(other.detail, 'NO [AUTHENTICATIONFAILED] Authentication failed.');
});

test('a relay that cannot carry the connection is not blamed on the mail host', async () => {
  const result = await probeImapThroughRelay(input, {
    config,
    validate: validatorReturning({ ok: true, phase: 'authentication' }).validate,
    openTunnel: async () => { throw new MailRelayUnavailableError('Relay refused the tunnel (403).'); },
  });
  assert.deepEqual(result, { outcome: 'unavailable', detail: null });
});

test('a check that dies before the login is answered is inconclusive', async () => {
  const openTunnel = async () => fakeSocket;
  const timedOut = await probeImapThroughRelay(input, {
    config, openTunnel,
    validate: async () => ({ ok: false, code: 'CONNECTION_TIMEOUT', message: 'x', phase: 'greeting' }),
  });
  assert.deepEqual(timedOut, { outcome: 'inconclusive', detail: null });
  const threw = await probeImapThroughRelay(input, {
    config, openTunnel,
    validate: async () => { throw new Error('boom'); },
  });
  assert.deepEqual(threw, { outcome: 'inconclusive', detail: null });
});
