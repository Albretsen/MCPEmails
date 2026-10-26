// The onboarding inbox step's provider detection and connect routing (WP-E).
// Run with: npm run test:onboarding-inbox
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  connectRequestFor,
  detectFromAddress,
  detectionForChoice,
  isCompleteAddress,
  kindFromProviderSlug,
  panelLinks,
  type InboxDetection,
} from './inbox-detect.ts';
import { detectInboxDomain } from './inbox-detect-server.ts';
import type { AutodiscoverDeps, MxRecord, SrvRecord } from '../email-providers/autodiscover.ts';

const STRATO_ISPDB = `<?xml version="1.0"?>
<clientConfig version="1.1"><emailProvider id="strato.de">
<displayName>Strato</displayName>
<incomingServer type="imap"><hostname>imap.strato.de</hostname><port>993</port><socketType>SSL</socketType></incomingServer>
<outgoingServer type="smtp"><hostname>smtp.strato.de</hostname><port>465</port><socketType>SSL</socketType></outgoingServer>
</emailProvider></clientConfig>`;

function deps(input: { mx?: MxRecord[]; srv?: Record<string, SrvRecord[]>; ispdb?: Record<string, string> } = {}) {
  const asked: string[] = [];
  const mxCalls: string[] = [];
  const d: AutodiscoverDeps = {
    resolveSrv: async (name) => input.srv?.[name] ?? [],
    resolveMx: async (name) => { mxCalls.push(name); return input.mx ?? []; },
    fetchIspdb: async (url) => { asked.push(url); const key = url.split('/').pop() ?? ''; return input.ispdb?.[decodeURIComponent(key)] ?? null; },
  };
  return { d, asked, mxCalls };
}

test('the address must be complete before anything is detected', () => {
  assert.equal(isCompleteAddress('me@'), false);
  assert.equal(isCompleteAddress('me@gmail'), false);
  assert.equal(isCompleteAddress('me@gmail.'), false);
  assert.equal(isCompleteAddress('me@gmail.com'), true);
  assert.equal(detectFromAddress('me@gmail.'), null);
});

test('consumer domains are detected in the browser from the table', () => {
  assert.equal(detectFromAddress('a@gmail.com')?.kind, 'gmail');
  assert.equal(detectFromAddress('a@googlemail.com')?.kind, 'gmail');
  assert.equal(detectFromAddress('a@me.com')?.kind, 'icloud');
  assert.equal(detectFromAddress('a@yahoo.com')?.kind, 'yahoo');
  assert.equal(detectFromAddress('a@yahoo.es')?.kind, 'yahoo', 'country variants not in the table');
  assert.equal(detectFromAddress('a@yahoo.es')?.settings?.imapHost, 'imap.mail.yahoo.com');
  assert.equal(detectFromAddress('a@aol.com')?.kind, 'aol');
  assert.equal(detectFromAddress('a@gmx.de')?.kind, 'gmx');
  assert.equal(detectFromAddress('a@web.de')?.kind, 'web_de');
  assert.equal(detectFromAddress('a@hotmail.no')?.kind, 'outlook');
  assert.equal(detectFromAddress('a@outlook.com')?.kind, 'outlook');
  assert.equal(detectFromAddress('a@proton.me')?.kind, 'proton');
  assert.equal(detectFromAddress('a@gmail.com')?.customDomain, false);
});

test('a custom domain is not guessed in the browser', () => {
  assert.equal(detectFromAddress('hello@some-company.example.org'), null);
});

test('server: Microsoft 365 from the MX', async () => {
  const { d } = deps({ mx: [{ exchange: 'contoso-com.mail.protection.outlook.com', priority: 0 }] });
  const found = await detectInboxDomain('contoso.com', d);
  assert.equal(found.kind, 'microsoft365');
  assert.equal(found.settings, null);
});

test('server: Google Workspace from the MX, with Gmail servers', async () => {
  const { d } = deps({ mx: [{ exchange: 'aspmx.l.google.com', priority: 1 }] });
  const found = await detectInboxDomain('acme-firm.com', d);
  assert.equal(found.kind, 'google_workspace');
  assert.equal(found.customDomain, true);
  assert.equal(found.settings?.imapHost, 'imap.gmail.com');
});

test('server: a Strato domain through the ISPDB on the MX base domain', async () => {
  const { d, asked, mxCalls } = deps({ mx: [{ exchange: 'smtpin.rzone.de', priority: 5 }], ispdb: { 'rzone.de': STRATO_ISPDB } });
  const found = await detectInboxDomain('baeckerei-muster.de', d);
  assert.equal(found.kind, 'imap');
  assert.equal(found.source, 'ispdb_mx');
  assert.equal(found.label, 'Strato');
  assert.equal(found.settings?.imapHost, 'imap.strato.de');
  assert.ok(asked.some((u) => u.endsWith('/rzone.de')), asked.join(','));
  assert.equal(mxCalls.length, 1, 'one MX lookup shared with autodiscover');
});

test('server: nothing found is the manual form', async () => {
  const { d } = deps();
  const found = await detectInboxDomain('nothing-here.org', d);
  assert.deepEqual([found.kind, found.source, found.settings], ['imap', 'none', null]);
});

test('server: refuses names that are not public mail domains', async () => {
  const { d, mxCalls } = deps();
  const found = await detectInboxDomain('localhost', d);
  assert.equal(found.source, 'none');
  assert.equal(mxCalls.length, 0);
});

test('server: a consumer domain never touches DNS', async () => {
  const { d, mxCalls } = deps();
  assert.equal((await detectInboxDomain('icloud.com', d)).kind, 'icloud');
  assert.equal(mxCalls.length, 0);
});

test('?provider= slugs preselect a panel', () => {
  assert.equal(kindFromProviderSlug('gmail'), 'gmail');
  assert.equal(kindFromProviderSlug('google-workspace'), 'google_workspace');
  assert.equal(kindFromProviderSlug('office365'), 'microsoft365');
  assert.equal(kindFromProviderSlug('strato'), null);
  assert.equal(kindFromProviderSlug(null), null);
});

test('branded addresses use the app-password route, custom domains the IMAP route', () => {
  const gmail = detectFromAddress('me@gmail.com') as InboxDetection;
  assert.deepEqual(connectRequestFor({ detection: gmail, email: 'Me@Gmail.com', password: 'abcd' })?.body, {
    service: 'gmail', email: 'me@gmail.com', appPassword: 'abcd',
  });
  assert.equal(connectRequestFor({ detection: gmail, email: 'me@gmail.com', password: 'x' })?.endpoint, '/api/inboxes/app-password');

  const workspace = detectionForChoice('gmail', 'me@acme-firm.com', null);
  const viaImap = connectRequestFor({ detection: workspace, email: 'me@acme-firm.com', password: 'x' });
  assert.equal(viaImap?.endpoint, '/api/inboxes/imap');
  assert.equal(viaImap?.body.imapHost, 'imap.gmail.com');
  assert.equal(viaImap?.body.mode, 'both');

  const fastmail = detectFromAddress('me@fastmail.com') as InboxDetection;
  assert.equal(connectRequestFor({ detection: fastmail, email: 'me@fastmail.com', password: 'x' })?.endpoint, '/api/inboxes/fastmail-app-password');

  const gmx = detectFromAddress('me@gmx.de') as InboxDetection;
  assert.equal(connectRequestFor({ detection: gmx, email: 'me@gmx.de', password: 'x' })?.endpoint, '/api/inboxes/imap');
});

test('reading only always goes to the IMAP route with mode imap and no SMTP', () => {
  const gmail = detectFromAddress('me@gmail.com') as InboxDetection;
  const req = connectRequestFor({ detection: gmail, email: 'me@gmail.com', password: 'x', readOnly: true });
  assert.equal(req?.endpoint, '/api/inboxes/imap');
  assert.equal(req?.body.mode, 'imap');
  assert.equal(req?.body.smtpHost, undefined);
});

test('Microsoft, Proton and an unknown domain without servers have nothing to submit', () => {
  const outlook = detectFromAddress('me@outlook.com') as InboxDetection;
  assert.equal(connectRequestFor({ detection: outlook, email: 'me@outlook.com', password: 'x' }), null);
  const none: InboxDetection = { kind: 'imap', label: null, source: 'none', settings: null, customDomain: true };
  assert.equal(connectRequestFor({ detection: none, email: 'me@x.org', password: 'x' }), null);
  const manual = connectRequestFor({
    detection: none, email: 'me@x.org', password: 'x',
    manual: { imapHost: ' Mail.X.org ', imapPort: 143, smtpHost: 'mail.x.org', smtpPort: 587, username: 'me' },
  });
  assert.deepEqual(
    [manual?.body.imapHost, manual?.body.imapSecurity, manual?.body.smtpSecurity, manual?.body.username],
    ['mail.x.org', 'starttls', 'starttls', 'me'],
  );
});

test('Google links pick the right account with authuser', () => {
  const links = panelLinks('gmail', 'Me@Gmail.com');
  assert.equal(links.app_passwords, 'https://myaccount.google.com/apppasswords?authuser=me%40gmail.com');
  assert.ok(links.two_step?.startsWith('https://myaccount.google.com/signinoptions/two-step-verification?authuser='));
  assert.equal(panelLinks('gmail', 'me@').app_passwords, 'https://myaccount.google.com/apppasswords');
  assert.equal(panelLinks('icloud', 'a@icloud.com').app_passwords, 'https://account.apple.com/account/manage');
  assert.equal(panelLinks('aol', 'a@aol.com').app_passwords, 'https://login.aol.com/myaccount/security/app-password');
  assert.ok(panelLinks('gmx', 'a@gmx.de').imap_setting);
  assert.deepEqual(panelLinks('outlook', 'a@outlook.com'), {});
});
