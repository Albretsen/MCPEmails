// Format check, failure mapping, support ticket, Outlook return, subject
// decoding and STATUS parsing for the onboarding inbox step (WP-E).
// Run with: npm run test:onboarding-inbox
import test from 'node:test';
import assert from 'node:assert/strict';
import { appPasswordFormatWarning, passwordForSubmit, takesAppPassword } from './app-password-format.ts';
import { describeConnectFailure, failureCodeOf } from './connect-failure.ts';
import { buildConnectHelpTicket } from './connect-help.ts';
import { onboardingReturnCookieValue, onboardingReturnLocation, onboardingReturnTarget } from './outlook-return.ts';
import { decodeMimeWords } from '../email/mime-words.ts';
import { parseStatusResponse } from '../email/imap.ts';
import { mxBaseDomain, isMicrosoft365Mx } from '../email-providers/autodiscover.ts';

test('format warning: a normal password on an app-password provider', () => {
  assert.equal(appPasswordFormatWarning('gmail', 'Sommer2024!'), 'account_password');
  assert.equal(appPasswordFormatWarning('google_workspace', 'Hunter2'), 'account_password');
  assert.equal(appPasswordFormatWarning('icloud', 'abcd-efgh-ijkl-mnop'), null, 'Apple hyphens are fine');
  assert.equal(appPasswordFormatWarning('gmail', 'abcd efgh ijkl mnop'), null, 'spaces are fine');
  assert.equal(appPasswordFormatWarning('yahoo', 'abcdefghijklmn'), 'wrong_length');
  assert.equal(appPasswordFormatWarning('aol', 'abcdefghijklmnop'), null);
  assert.equal(appPasswordFormatWarning('gmail', ''), null, 'nothing typed, nothing said');
});

test('format warning: providers without a fixed format say nothing', () => {
  for (const kind of ['imap', 'gmx', 'web_de', 'zoho', 'outlook'] as const) {
    assert.equal(appPasswordFormatWarning(kind, 'Sommer2024!'), null, kind);
  }
  assert.equal(takesAppPassword('gmail'), true);
  assert.equal(takesAppPassword('imap'), false);
});

test('what is submitted: spaces stripped from app passwords only', () => {
  assert.equal(passwordForSubmit('gmail', ' abcd efgh ijkl mnop\n'), 'abcdefghijklmnop');
  assert.equal(passwordForSubmit('imap', '  pass word  '), 'pass word');
});

test('failure: the classifier reason picks the message, the fix row the links', () => {
  const f = describeConnectFailure({
    result: { ok: false, status: 422, data: { error_code: 'auth_failed', auth_reason: 'account_password_used', phase: 'authentication' } },
    kind: 'gmail',
    providerLabel: 'Gmail',
    email: 'me@gmail.com',
  });
  assert.equal(f.message, 'reason.account_password_used');
  assert.equal(f.passwordProblem, true);
  assert.equal(f.offerReadOnly, false);
  assert.deepEqual(f.links.map((l) => l.kind), ['twoStep', 'appPasswords']);
});

test('failure: sending refused after reading worked offers reading only', () => {
  const f = describeConnectFailure({
    result: { ok: false, status: 422, data: { error_code: 'auth_failed', auth_reason: 'password_rejected', phase: 'smtp_authentication', imap_ok: true } },
    kind: 'imap',
    customDomain: true,
    email: 'me@x.org',
    imapHost: 'mail.x.org',
    smtpHost: 'smtp.x.org',
  });
  assert.equal(f.message, 'smtpRejected');
  assert.equal(f.offerReadOnly, true);
  assert.equal(f.passwordProblem, false);
});

test('failure: codes outside the mailbox get their own message', () => {
  const at = (data: Record<string, unknown>, status = 422) => describeConnectFailure({ result: { ok: false, status, data }, kind: 'imap' }).message;
  assert.equal(at({}, 401), 'sessionExpired');
  assert.equal(at({ error_code: 'inbox_limit_reached' }, 402), 'limit');
  assert.equal(at({ error_code: 'microsoft_account_use_outlook' }), 'useMicrosoft');
  assert.equal(at({ error_code: 'host_not_found', phase: 'tcp' }), 'hostNotFound');
  assert.equal(at({ error_code: 'connection_timeout', phase: 'tcp' }), 'unreachable');
  assert.equal(at({ error_code: 'tls_handshake_failed', phase: 'tls' }), 'tls');
  assert.equal(describeConnectFailure({ result: { network: true }, kind: 'gmail' }).message, 'network');
  assert.equal(failureCodeOf(503, {}), 'save_failed');
});

test('failure: an unknown reason falls back to a rejected password', () => {
  const f = describeConnectFailure({ result: { ok: false, status: 422, data: { error_code: 'auth_failed', auth_reason: 'brand_new' } }, kind: 'yahoo' });
  assert.equal(f.message, 'reason.password_rejected');
});

test('support ticket: closed-list facts only, never a password', () => {
  const ticket = buildConnectHelpTicket({
    provider: 'gmail', code: 'auth_failed', reason: 'account_password_used', phase: 'authentication',
    host: 'imap.gmail.com', attempts: 2, password: 'secret-value', appPassword: 'secret-value',
  });
  assert.ok(ticket);
  assert.equal(ticket.category, 'connect');
  assert.equal(ticket.from, 'onboarding');
  assert.equal(JSON.stringify(ticket).includes('secret-value'), false);
  assert.ok(ticket.message.includes('Auth reason: account_password_used'));
  assert.ok(ticket.message.includes('Server: imap.gmail.com'));
  assert.equal(buildConnectHelpTicket({ provider: 'not-a-panel', code: 'auth_failed' }), null);
  assert.equal(buildConnectHelpTicket({ provider: 'gmail', code: 'Bad Code!' }), null);
  const odd = buildConnectHelpTicket({ provider: 'imap', code: 'x', host: 'http://evil/', reason: 'nope', phase: 'zz' });
  assert.ok(odd && !odd.message.includes('evil') && !odd.message.includes('nope') && !odd.message.includes('Phase'));
});

test('Outlook return: dashboard redirects become onboarding ones', () => {
  const app = 'https://mcpemails.com';
  assert.equal(onboardingReturnLocation(`${app}/dashboard?onboarding_client=claude&connected=outlook`, app), `${app}/onboarding?connected=outlook`);
  assert.equal(onboardingReturnLocation(`${app}/dashboard?error=admin_consent_required`, app), `${app}/onboarding?outlook_error=admin_consent_required`);
  assert.equal(onboardingReturnLocation(`${app}/outlook/admin-consent/result?status=approved`, app), null);
  assert.equal(onboardingReturnLocation('https://evil.example/dashboard?connected=outlook', app), null);
  assert.equal(onboardingReturnLocation(`${app}/dashboard?error=%3Cscript%3E`, app), null);
  assert.equal(onboardingReturnLocation(null, app), null);
});

test('Outlook return: a consent-screen start goes back to the same /authorize URL', () => {
  const app = 'https://mcpemails.com';
  const consent = '/authorize?client_id=https%3A%2F%2Fclaude.ai%2Fx&state=s&code_challenge=c';
  const cookie = onboardingReturnCookieValue(consent);
  assert.equal(onboardingReturnTarget(cookie), consent);
  assert.equal(
    onboardingReturnLocation(`${app}/dashboard?connected=outlook`, app, onboardingReturnTarget(cookie)),
    `${app}/authorize?client_id=https%3A%2F%2Fclaude.ai%2Fx&state=s&code_challenge=c&connected=outlook`,
  );
  assert.equal(
    onboardingReturnLocation(`${app}/dashboard?error=outlook_cancelled`, app, onboardingReturnTarget(cookie)),
    `${app}/authorize?client_id=https%3A%2F%2Fclaude.ai%2Fx&state=s&code_challenge=c&outlook_error=outlook_cancelled`,
  );
  // Anything but an /authorize path is ignored: plain onboarding return.
  for (const bad of ['https://evil.example/authorize?x=1', '//evil.example/authorize?x', '/dashboard?x=1', '/authorizex?y', null, 'x'.repeat(4000)]) {
    assert.equal(onboardingReturnCookieValue(bad), '1', String(bad).slice(0, 40));
  }
  assert.equal(onboardingReturnTarget('1'), '/onboarding');
  assert.equal(onboardingReturnTarget('a:%2F%2Fevil.example%2Fauthorize%3Fx'), '/onboarding');
  assert.equal(onboardingReturnTarget('a:%E0%A4%A'), '/onboarding');
});

test('RFC 2047 subjects are decoded for the proof card', () => {
  assert.equal(decodeMimeWords('=?UTF-8?B?SMOpbGxv?='), 'Héllo');
  assert.equal(decodeMimeWords('=?iso-8859-1?Q?Gr=FC=DFe_aus_Berlin?='), 'Grüße aus Berlin');
  assert.equal(decodeMimeWords('=?UTF-8?Q?a?= =?UTF-8?Q?b?= c'), 'ab c');
  assert.equal(decodeMimeWords('Plain subject'), 'Plain subject');
  assert.equal(decodeMimeWords('=?bogus-charset?B?SGk=?='), '=?bogus-charset?B?SGk=?=');
});

test('STATUS responses are parsed', () => {
  assert.deepEqual(parseStatusResponse(['* STATUS INBOX (MESSAGES 231 UIDNEXT 4429)']), { MESSAGES: 231, UIDNEXT: 4429 });
  assert.deepEqual(parseStatusResponse(['* STATUS "My (box)" (MESSAGES 3)']), { MESSAGES: 3 });
  assert.deepEqual(parseStatusResponse(['* OK nothing']), {});
});

test('MX base domain and Microsoft 365 MX', () => {
  assert.equal(mxBaseDomain('smtpin.rzone.de'), 'rzone.de');
  assert.equal(mxBaseDomain('mailpod12-cph3.one.com.'), 'one.com');
  assert.equal(mxBaseDomain('mx1.example.co.uk'), 'example.co.uk');
  assert.equal(mxBaseDomain('127.0.0.1'), null);
  assert.equal(isMicrosoft365Mx('contoso-com.mail.protection.outlook.com'), true);
  assert.equal(isMicrosoft365Mx('aspmx.l.google.com'), false);
});
