import test from 'node:test';
import assert from 'node:assert/strict';
import type * as net from 'net';
import { probeProviderRefusal } from './relay-probe.ts';
import { MailRelayUnavailableError, type NamedMailRelay } from './mail-relay.ts';
import type { ImapCredential } from './validate-imap.ts';
import type { SmtpCredential } from './validate-smtp.ts';

const input = {
  email: 'nom@orange.fr',
  password: 'abcde-fghij-klmno-pqrst',
  imapHost: 'imap.orange.fr',
  imapPort: 993,
  smtpHost: 'smtp.orange.fr',
  smtpPort: 465,
  smtpSecurity: 'tls' as const,
  smtpPinnedAddress: '203.0.113.50',
};
const FR: NamedMailRelay = { id: 'fr', config: { host: '203.0.113.1', port: 3128, authorization: null } };
const DE: NamedMailRelay = { id: 'de', config: { host: '203.0.113.2', port: 3128, authorization: null } };
const ALERT = 'NO [ALERT] Authentication failed.';
const fakeSocket = {} as net.Socket;

type Answer = { ok: true } | { ok: false; code: string; detail?: string };

/**
 * A fake mail provider that decides by where the login came from. Every login
 * is logged in order, as `protocol via relay-host (mechanism)`.
 */
function harness(answer: (login: { protocol: 'imap' | 'smtp'; via: string; mechanism?: string }) => Answer) {
  const logins: string[] = [];
  const run = async (protocol: 'imap' | 'smtp', cred: ImapCredential | SmtpCredential) => {
    // The fake tunnel hands back a socket tagged with the relay it came from.
    let via = 'direct';
    if (cred.tunnel) {
      try {
        via = ((await cred.tunnel()) as unknown as { relay: string }).relay;
      } catch {
        return { ok: false as const, code: 'TLS_HANDSHAKE_FAILED' };
      }
    }
    const mechanism = 'mechanism' in cred ? cred.mechanism : undefined;
    logins.push(`${protocol} via ${via}${mechanism ? ` (${mechanism})` : ''}`);
    return answer({ protocol, via, mechanism });
  };
  return {
    logins,
    deps: {
      validateImap: (cred: ImapCredential) => run('imap', cred),
      validateSmtp: (cred: SmtpCredential) => run('smtp', cred),
      openTunnel: async (config: { host: string }) =>
        ({ relay: config.host === FR.config.host ? 'fr' : 'de' }) as unknown as net.Socket,
    },
  };
}

test('a provider that only objects to our address is answered in one attempt', async () => {
  // Refuses AWS (direct), accepts anything else.
  const h = harness(({ via }) => (via === 'direct' ? { ok: false, code: 'AUTH_FAILED', detail: '535 5.7.0 refused' } : { ok: true }));
  const result = await probeProviderRefusal(input, { relays: [FR, DE], ...h.deps });
  assert.equal(result.summary, 'imap_fr=accepted imap_de=accepted smtp_direct=refused smtp_de=accepted');
  assert.equal(result.steps.smtp_direct?.detail, '535 5.7.0 refused');
  // A relay got in, so the login method is not in question and is not tried.
  assert.equal(result.steps.imap_login, undefined);
  // One login at a time, in a fixed order.
  assert.deepEqual(h.logins, ['imap via fr', 'imap via de', 'smtp via direct', 'smtp via de']);
});

test('France accepted and Germany refused is told apart', async () => {
  const h = harness(({ via }) => (via === 'fr' ? { ok: true } : { ok: false, code: 'AUTH_FAILED', detail: ALERT }));
  const result = await probeProviderRefusal(input, { relays: [FR, DE], ...h.deps });
  assert.equal(result.summary, 'imap_fr=accepted imap_de=refused smtp_direct=refused smtp_de=refused');
  assert.equal(result.steps.imap_de?.detail, ALERT);
});

test('when no address gets in, the login method is tried once, from France', async () => {
  const h = harness(({ protocol, mechanism }) =>
    protocol === 'imap' && mechanism !== 'LOGIN' ? { ok: false, code: 'AUTH_FAILED', detail: ALERT } : { ok: true }
  );
  const result = await probeProviderRefusal(input, { relays: [FR, DE], ...h.deps });
  assert.equal(result.summary, 'imap_fr=refused imap_de=refused imap_login=accepted smtp_direct=accepted smtp_de=accepted');
  assert.deepEqual(h.logins, ['imap via fr', 'imap via de', 'imap via fr (LOGIN)', 'smtp via direct', 'smtp via de']);
});

test('the same credential and the pinned address go where they should', async () => {
  const seenImap: ImapCredential[] = [];
  const seenSmtp: SmtpCredential[] = [];
  const targets: string[] = [];
  await probeProviderRefusal(input, {
    relays: [FR, DE],
    validateImap: async (cred) => { seenImap.push(cred); await cred.tunnel?.(); return { ok: true }; },
    validateSmtp: async (cred) => { seenSmtp.push(cred); await cred.tunnel?.(); return { ok: true }; },
    openTunnel: async (_config, host, port) => { targets.push(`${host}:${port}`); return fakeSocket; },
  });
  assert.equal(seenImap[0].password, input.password);
  assert.equal(seenImap[0].security, 'tls');
  // Direct SMTP dials the address the host guard approved, on the user's port.
  assert.equal(seenSmtp[0].pinnedAddress, '203.0.113.50');
  assert.equal(seenSmtp[0].tunnel, undefined);
  assert.equal(seenSmtp[0].port, 465);
  // The relay is asked by name, on the one submission port its host lets out.
  assert.equal(seenSmtp[1].pinnedAddress, undefined);
  assert.equal(seenSmtp[1].port, 587);
  assert.equal(seenSmtp[1].security, 'starttls');
  assert.deepEqual(targets, ['imap.orange.fr:993', 'imap.orange.fr:993', 'smtp.orange.fr:587']);
});

test('a missing relay is its own outcome, and the rest still runs', async () => {
  const h = harness(() => ({ ok: false, code: 'AUTH_FAILED', detail: ALERT }));
  const onlyGermany = await probeProviderRefusal(input, { relays: [DE], ...h.deps });
  assert.equal(onlyGermany.summary, 'imap_fr=not_configured imap_de=refused imap_login=refused smtp_direct=refused smtp_de=refused');
  const none = await probeProviderRefusal(input, { relays: [], ...harness(() => ({ ok: true })).deps });
  assert.equal(none.summary, 'imap_fr=not_configured imap_de=not_configured smtp_direct=accepted smtp_de=not_configured');
});

test('a relay that cannot carry the connection is not blamed on the mail host', async () => {
  const result = await probeProviderRefusal(input, {
    relays: [FR],
    validateImap: async (cred) => {
      try { await cred.tunnel?.(); } catch { return { ok: false, code: 'TLS_HANDSHAKE_FAILED' }; }
      return { ok: true };
    },
    validateSmtp: async () => ({ ok: true }),
    openTunnel: async () => { throw new MailRelayUnavailableError('Relay refused the tunnel (403).'); },
  });
  assert.equal(result.steps.imap_fr?.outcome, 'unavailable');
});

test('a check that dies before the login is answered is inconclusive, and never throws', async () => {
  const result = await probeProviderRefusal(input, {
    relays: [FR],
    validateImap: async () => ({ ok: false, code: 'CONNECTION_TIMEOUT' }),
    validateSmtp: async () => { throw new Error('boom'); },
    openTunnel: async () => fakeSocket,
  });
  assert.equal(result.summary, 'imap_fr=inconclusive imap_de=not_configured imap_login=inconclusive smtp_direct=inconclusive smtp_de=not_configured');
});

test('an address turned away at the greeting is blocked, not a refused login', async () => {
  const greeting = '550 550 smtp.orange.fr Service refuse. Service refused. OFR_99';
  const result = await probeProviderRefusal(input, {
    relays: [DE],
    validateImap: async () => ({ ok: true }),
    validateSmtp: async (cred) => (cred.tunnel ? { ok: false, code: 'SMTP_PROTOCOL_ERROR', detail: greeting } : { ok: true }),
    openTunnel: async () => fakeSocket,
  });
  assert.deepEqual(result.steps.smtp_de, { outcome: 'blocked', detail: greeting });
  assert.equal(result.steps.smtp_direct?.outcome, 'accepted');
});
