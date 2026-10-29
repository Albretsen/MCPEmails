import test from 'node:test';
import assert from 'node:assert/strict';
import type * as net from 'net';
import { MailRelayTargetRefusedError, MailRelayUnavailableError, type MailRelayConfig } from './mail-relay.ts';
import {
  detectWithRelay,
  isOriginRefusalText,
  RELAY_REGISTRY_TIMEOUT_MS,
  refreshLearnedRelayHosts,
  relayRouteForHost,
  resetRelayFallbackCacheForTests,
  shouldTryRelayAfter,
} from './relay-fallback.ts';
import type { TransportCandidate } from './transport-autodetect.ts';

const RELAY: MailRelayConfig = { host: '203.0.113.7', port: 3128, authorization: null };

type Result = { ok: boolean; code?: string; phase?: string; detail?: string | null };

/** A stand-in for the service-role client: records rpc calls, serves a learned list. */
function fakeDb(options: { learned?: Array<{ host: string; protocol: string }>; accept?: boolean } = {}) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return { data: fn === 'learn_mail_relay_host' ? options.accept ?? true : null, error: null };
    },
    from: () => ({
      select: () => ({
        or: async () => ({ data: options.learned ?? [], error: null }),
      }),
    }),
  };
  return { db: db as never, calls };
}

/** Attempts answered from a script keyed by "direct:<port>" / "relay:<port>". */
function scripted(script: Record<string, Result | 'relay_down'>) {
  const seen: string[] = [];
  const attempt = async (candidate: TransportCandidate, _timeoutMs: number, tunnel?: () => Promise<net.Socket>) => {
    const key = `${tunnel ? 'relay' : 'direct'}:${candidate.port}`;
    seen.push(key);
    if (tunnel) {
      try {
        await tunnel();
      } catch {
        return { ok: false, code: 'TLS_HANDSHAKE_FAILED', phase: 'tls' };
      }
    }
    const answer = script[key] ?? { ok: false, code: 'CONNECTION_TIMEOUT', phase: 'tcp' };
    return answer === 'relay_down' ? { ok: false, code: 'TLS_HANDSHAKE_FAILED', phase: 'tls' } : answer;
  };
  return { attempt, seen };
}

const tunnelOk = async () => ({}) as net.Socket;
const tunnelDown = async () => {
  throw new MailRelayUnavailableError('Relay connection failed: ECONNREFUSED');
};

test('a timeout, a refused connection and a greeting refusal earn a relay retry', () => {
  assert.equal(shouldTryRelayAfter({ code: 'CONNECTION_TIMEOUT', phase: 'tcp' }), true);
  assert.equal(shouldTryRelayAfter({ code: 'CONNECTION_TIMEOUT', phase: 'authentication' }), true);
  assert.equal(shouldTryRelayAfter({ code: 'CONNECTION_REFUSED', phase: 'tcp' }), true);
  assert.equal(
    shouldTryRelayAfter({ code: 'SMTP_PROTOCOL_ERROR', phase: 'greeting', detail: '550 Service refused. OFR_99' }),
    true
  );
});

test('a wrong password, a bad certificate and an unknown name never do', () => {
  assert.equal(
    shouldTryRelayAfter({ code: 'AUTH_FAILED', phase: 'authentication', detail: 'NO [AUTHENTICATIONFAILED] Authentication failed.' }, 'password_rejected'),
    false
  );
  assert.equal(shouldTryRelayAfter({ code: 'TLS_HANDSHAKE_FAILED', phase: 'tls' }), false);
  assert.equal(shouldTryRelayAfter({ code: 'HOST_NOT_FOUND', phase: 'tcp' }), false);
  assert.equal(shouldTryRelayAfter({ code: 'SMTP_PROTOCOL_ERROR', phase: 'authentication' }), false);
});

test('a login refusal that blames our address does', () => {
  assert.equal(shouldTryRelayAfter({ code: 'AUTH_FAILED', detail: 'NO [ALERT] Authentication failed.' }, 'provider_refused_signin'), true);
  assert.equal(
    shouldTryRelayAfter({ code: 'AUTH_FAILED', detail: '535 5.7.0 Authentication disabled due to threshold limitation' }, 'password_rejected'),
    true
  );
});

test('origin refusal text: the measured cases match, the ordinary refusals do not', () => {
  for (const text of [
    'NO [ALERT] Authentication failed.',
    '550 [ACR04] Amazon AWS IP 44.195.26.28 may not use this server.',
    '550 [ACR07] Server IP 2a01:4f8::1 may not use this server. Please contact your hosting/cloud/RDP service provider',
    '535 5.7.0 Authentication disabled due to threshold limitation',
    '550 Service refused, please try later. OFR105_103',
    '554 5.7.1 Client host rejected: listed at zen.spamhaus.org',
  ]) {
    assert.equal(isOriginRefusalText(text), true, text);
  }
  for (const text of [
    'NO [AUTHENTICATIONFAILED] Authentication failed.',
    '535 5.7.8 Error: authentication failed:',
    'NO [ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)',
    'NO [ALERT] You are yet to enable IMAP for your account. Please contact your administrator (Failure)',
    '550 The mail server could not deliver mail to x@sis.uz. The account or domain may not exist, they may be blacklisted, or missing the proper dns entries.',
    '',
    null,
  ]) {
    assert.equal(isOriginRefusalText(text), false, String(text));
  }
});

test('a host that works directly never touches the relay', async () => {
  resetRelayFallbackCacheForTests();
  const { db, calls } = fakeDb();
  const { attempt, seen } = scripted({ 'direct:993': { ok: true } });
  const out = await detectWithRelay<Result>({
    protocol: 'imap', host: 'imap.example.net', requested: { port: 993, security: 'tls' },
    relay: RELAY, db, authReasonOf: () => null, attempt, openTunnel: tunnelOk,
  });
  assert.equal(out.detection.result.ok, true);
  assert.equal(out.route, null);
  assert.deepEqual(seen, ['direct:993']);
  assert.equal(calls.length, 0);
});

test('Telstra: every direct submission port times out, the relay works on 587, the host is learned', async () => {
  resetRelayFallbackCacheForTests();
  const { db, calls } = fakeDb();
  const { attempt, seen } = scripted({ 'relay:587': { ok: true } });
  const out = await detectWithRelay<Result>({
    protocol: 'smtp', host: 'smtp.telstra.com', requested: { port: 465, security: 'tls' },
    relay: RELAY, db, authReasonOf: () => null, attempt, openTunnel: tunnelOk,
  });
  assert.equal(out.detection.result.ok, true);
  assert.equal(out.route, 'fallback');
  // Stored on the transport the relay carries, not the 465 that was asked for.
  assert.deepEqual([out.detection.candidate.port, out.detection.candidate.security], [587, 'starttls']);
  assert.equal(out.detection.adjusted, true);
  assert.equal(seen.at(-1), 'relay:587');
  assert.deepEqual(
    calls.map((call) => call.fn),
    ['record_mail_relay_use', 'learn_mail_relay_host']
  );
  assert.equal(calls[0].args.p_outcome, 'ok');
  assert.equal(calls[0].args.p_route, 'fallback');
  assert.equal(calls[1].args.p_host, 'smtp.telstra.com');
  assert.equal(calls[1].args.p_protocol, 'smtp');
  assert.equal(relayRouteForHost('smtp.telstra.com', 'smtp'), 'learned');
});

test('a refused learning does not relay the host in this process', async () => {
  resetRelayFallbackCacheForTests();
  const { db } = fakeDb({ accept: false });
  const { attempt } = scripted({ 'relay:993': { ok: true } });
  await detectWithRelay<Result>({
    protocol: 'imap', host: 'imap.mail.yahoo.com', requested: { port: 993, security: 'tls' },
    relay: RELAY, db, authReasonOf: () => null, attempt, openTunnel: tunnelOk,
  });
  assert.equal(relayRouteForHost('imap.mail.yahoo.com', 'imap'), null);
});

test('a wrong password is reported as it is, with no relay attempt', async () => {
  resetRelayFallbackCacheForTests();
  const { db, calls } = fakeDb();
  const refused = { ok: false, code: 'AUTH_FAILED', phase: 'authentication', detail: 'NO [AUTHENTICATIONFAILED] Authentication failed.' };
  const { attempt, seen } = scripted({ 'direct:993': refused });
  const out = await detectWithRelay<Result>({
    protocol: 'imap', host: 'imap.example.net', requested: { port: 993, security: 'tls' },
    relay: RELAY, db, authReasonOf: () => 'password_rejected', attempt, openTunnel: tunnelOk,
  });
  assert.equal(out.detection.result.code, 'AUTH_FAILED');
  assert.equal(out.route, null);
  assert.deepEqual(seen, ['direct:993']);
  assert.equal(calls.length, 0);
});

test('a relay that is down leaves the direct failure as the answer, and is counted', async () => {
  resetRelayFallbackCacheForTests();
  const { db, calls } = fakeDb();
  const { attempt } = scripted({});
  const out = await detectWithRelay<Result>({
    protocol: 'imap', host: 'mail.allsimple.net', requested: { port: 993, security: 'tls' },
    relay: RELAY, db, authReasonOf: () => null, attempt, openTunnel: tunnelDown,
  });
  assert.equal(out.detection.result.code, 'CONNECTION_TIMEOUT');
  assert.equal(out.route, null);
  assert.deepEqual(calls.map((call) => [call.fn, call.args.p_outcome]), [['record_mail_relay_use', 'relay_down']]);
});

test('an IP-literal host gets no relay retry: the relay filter refuses it', async () => {
  resetRelayFallbackCacheForTests();
  const { db, calls } = fakeDb();
  const { attempt, seen } = scripted({});
  const out = await detectWithRelay<Result>({
    protocol: 'imap', host: '203.0.113.9', requested: { port: 993, security: 'tls' },
    relay: RELAY, db, authReasonOf: () => null, attempt, openTunnel: tunnelOk,
  });
  assert.equal(out.detection.result.code, 'CONNECTION_TIMEOUT');
  assert.equal(seen.some((key) => key.startsWith('relay:')), false);
  assert.equal(calls.length, 0);
});

test('a relay that refuses the one target (403) is counted as the host, not the relay, failing', async () => {
  resetRelayFallbackCacheForTests();
  const { db, calls } = fakeDb();
  const { attempt } = scripted({});
  await detectWithRelay<Result>({
    protocol: 'imap', host: 'mail.allsimple.net', requested: { port: 993, security: 'tls' },
    relay: RELAY, db, authReasonOf: () => null, attempt,
    openTunnel: async () => {
      throw new MailRelayTargetRefusedError('Relay refused the tunnel (403).');
    },
  });
  assert.deepEqual(calls.map((call) => [call.fn, call.args.p_outcome]), [['record_mail_relay_use', 'host_refused']]);
});

test('a database that never answers costs a bounded wait, not the route', async () => {
  resetRelayFallbackCacheForTests();
  const never = new Promise<never>(() => {});
  const db = {
    rpc: () => never,
    from: () => ({ select: () => ({ or: () => never }) }),
  } as never;
  const startedMs = Date.now();
  await refreshLearnedRelayHosts(db);
  const { attempt } = scripted({ 'relay:993': { ok: true } });
  const out = await detectWithRelay<Result>({
    protocol: 'imap', host: 'mail.allsimple.net', requested: { port: 993, security: 'tls' },
    relay: RELAY, db, authReasonOf: () => null, attempt, openTunnel: tunnelOk,
  });
  assert.equal(out.detection.result.ok, true, 'the mailbox still connects');
  // One list read, one count, one learn: each capped.
  assert.ok(Date.now() - startedMs < 3 * RELAY_REGISTRY_TIMEOUT_MS + 1_000, `took ${Date.now() - startedMs}ms`);
});

test('through the relay the server refused the password: that is the truer answer', async () => {
  resetRelayFallbackCacheForTests();
  const { db, calls } = fakeDb();
  const { attempt } = scripted({
    'relay:587': { ok: false, code: 'AUTH_FAILED', phase: 'authentication', detail: '535 5.7.8 bad' },
  });
  const out = await detectWithRelay<Result>({
    protocol: 'smtp', host: 'smtp.telstra.com', requested: { port: 587, security: 'starttls' },
    relay: RELAY, db, authReasonOf: () => null, attempt, openTunnel: tunnelOk,
  });
  assert.equal(out.detection.result.code, 'AUTH_FAILED');
  assert.equal(out.route, 'fallback');
  assert.deepEqual(calls.map((call) => [call.fn, call.args.p_outcome]), [['record_mail_relay_use', 'host_refused']]);
});

test('a learned host goes through the relay first, and falls back to direct when the relay is down', async () => {
  resetRelayFallbackCacheForTests();
  const { db } = fakeDb({ learned: [{ host: 'smtp.telstra.com', protocol: 'smtp' }] });
  await refreshLearnedRelayHosts(db, 1_000_000);
  assert.equal(relayRouteForHost('smtp.telstra.com', 'smtp'), 'learned');
  assert.equal(relayRouteForHost('smtp.telstra.com', 'imap'), null);

  const first = scripted({ 'relay:587': { ok: true } });
  const viaRelay = await detectWithRelay<Result>({
    protocol: 'smtp', host: 'smtp.telstra.com', requested: { port: 465, security: 'tls' },
    relay: RELAY, db, authReasonOf: () => null, attempt: first.attempt, openTunnel: tunnelOk,
  });
  assert.equal(viaRelay.route, 'learned');
  assert.deepEqual(first.seen, ['relay:587']);

  const second = scripted({ 'direct:465': { ok: true } });
  const direct = await detectWithRelay<Result>({
    protocol: 'smtp', host: 'smtp.telstra.com', requested: { port: 465, security: 'tls' },
    relay: RELAY, db, authReasonOf: () => null, attempt: second.attempt, openTunnel: tunnelDown,
  });
  assert.equal(direct.route, null);
  assert.equal(direct.detection.result.ok, true);
  assert.deepEqual(second.seen, ['relay:587', 'direct:465']);
});

test('a relay-only host is never dialled directly, even when the relay is down', async () => {
  resetRelayFallbackCacheForTests();
  const { db } = fakeDb();
  const { attempt, seen } = scripted({ 'direct:993': { ok: true } });
  const out = await detectWithRelay<Result>({
    protocol: 'imap', host: 'imap.orange.fr', requested: { port: 993, security: 'tls' },
    relay: RELAY, db, authReasonOf: () => null, attempt, openTunnel: tunnelDown,
  });
  assert.equal(out.route, 'listed');
  assert.equal(out.detection.result.ok, false);
  assert.deepEqual(seen, ['relay:993']);
});

test('no relay configured: the connect form behaves exactly as before', async () => {
  resetRelayFallbackCacheForTests();
  const { db, calls } = fakeDb();
  const { attempt, seen } = scripted({});
  const out = await detectWithRelay<Result>({
    protocol: 'imap', host: 'imap.orange.fr', requested: { port: 993, security: 'tls' },
    relay: null, db, authReasonOf: () => null, attempt, openTunnel: tunnelOk,
  });
  assert.equal(out.route, null);
  assert.ok(seen.every((key) => key.startsWith('direct:')));
  assert.equal(calls.length, 0);
  assert.equal(out.relayAlsoFailed, undefined, 'never claimed when the relay was not tried');
});

// ── relayAlsoFailed: what the connect panel's "does not accept connections
// from our servers" sentence rests on ────────────────────────────────────────

test('direct and relayed attempts both unanswered: the direct failure, flagged relayAlsoFailed', async () => {
  resetRelayFallbackCacheForTests();
  const { db } = fakeDb();
  const { attempt } = scripted({});
  const out = await detectWithRelay<Result>({
    protocol: 'imap', host: 'mail.school.example', requested: { port: 993, security: 'tls' },
    relay: RELAY, db, authReasonOf: () => null, attempt, openTunnel: tunnelOk,
  });
  assert.equal(out.route, null);
  assert.equal(out.detection.result.code, 'CONNECTION_TIMEOUT');
  assert.equal(out.relayAlsoFailed, true);
});

test('a relay that is down is not the host refusing us: no relayAlsoFailed', async () => {
  resetRelayFallbackCacheForTests();
  const { db } = fakeDb();
  const { attempt } = scripted({});
  const out = await detectWithRelay<Result>({
    protocol: 'imap', host: 'mail.school.example', requested: { port: 993, security: 'tls' },
    relay: RELAY, db, authReasonOf: () => null, attempt, openTunnel: tunnelDown,
  });
  assert.equal(out.route, null);
  assert.equal(out.relayAlsoFailed, undefined);
});

test('a relayed attempt that worked is never flagged', async () => {
  resetRelayFallbackCacheForTests();
  const { db } = fakeDb();
  const { attempt } = scripted({ 'relay:993': { ok: true } });
  const out = await detectWithRelay<Result>({
    protocol: 'imap', host: 'mail.allsimple.net', requested: { port: 993, security: 'tls' },
    relay: RELAY, db, authReasonOf: () => null, attempt, openTunnel: tunnelOk,
  });
  assert.equal(out.detection.result.ok, true);
  assert.equal(out.relayAlsoFailed, undefined);
});
