import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IMAP_PRESETS,
  isBrandedImapService,
  portForSecurity,
  securityForPort,
  normalizeAppPassword,
  ZOHO_REGIONS,
  zohoHosts,
  zohoSettingsFromHost,
} from './imap-presets.ts';

test('security and port stay paired on the standard ports', () => {
  assert.equal(portForSecurity('imap', 'tls'), 993);
  assert.equal(portForSecurity('imap', 'starttls'), 143);
  assert.equal(portForSecurity('smtp', 'tls'), 465);
  assert.equal(portForSecurity('smtp', 'starttls'), 587);

  assert.equal(securityForPort('imap', 993), 'tls');
  assert.equal(securityForPort('imap', 143), 'starttls');
  assert.equal(securityForPort('smtp', 465), 'tls');
  assert.equal(securityForPort('smtp', 587), 'starttls');
});

test('a non-standard port implies nothing, so the user choice stands', () => {
  // Returning a default here would silently overwrite a deliberate setting on
  // hosts that serve IMAP somewhere unusual.
  assert.equal(securityForPort('imap', 1993), null);
  assert.equal(securityForPort('smtp', 2525), null);
  // The two protocols must not borrow each other's ports: 465 is SMTP's
  // implicit-TLS port and carries no meaning for IMAP.
  assert.equal(securityForPort('imap', 465), null);
  assert.equal(securityForPort('smtp', 993), null);
});

test('SMTP port 25 is STARTTLS, because the form can now offer it', () => {
  // 25 is the third port host-guard allows for SMTP and the port select now
  // lists it. Returning null would leave the security mode wherever it was,
  // which for a form defaulting to implicit TLS is a certain handshake
  // failure. transport-autodetect already pairs the two the same way.
  assert.equal(securityForPort('smtp', 25), 'starttls');
  // IMAP has no third port, and 25 means nothing there.
  assert.equal(securityForPort('imap', 25), null);
});

test('app passwords survive the ways they get copied', () => {
  // Google displays four space-separated blocks.
  assert.equal(normalizeAppPassword('abcd efgh ijkl mnop'), 'abcdefghijklmnop');
  // Trailing newline from a copy, non-breaking space from a rendered page,
  // and a zero-width space from a PDF or a password manager.
  assert.equal(normalizeAppPassword('abcdefgh\n'), 'abcdefgh');
  assert.equal(normalizeAppPassword('abcd efgh'), 'abcdefgh');
  assert.equal(normalizeAppPassword('abcd​efgh﻿'), 'abcdefgh');
  assert.equal(normalizeAppPassword('\tabcd efgh '), 'abcdefgh');
});

test('hyphens are preserved because Apple app-specific passwords contain them', () => {
  assert.equal(normalizeAppPassword('abcd-efgh-ijkl-mnop'), 'abcd-efgh-ijkl-mnop');
});

test('normalization leaves an already-clean credential untouched', () => {
  assert.equal(normalizeAppPassword('xkcd1234correct'), 'xkcd1234correct');
  assert.equal(normalizeAppPassword(''), '');
});

test('Gmail is a branded IMAP service on its documented transports', () => {
  // The whole point of the app-password path is that it never touches OAuth,
  // so it has to be reachable as a branded service: `isBrandedImapService` is
  // the connect route's gate, and a false here answers 422 "Unsupported
  // provider" for every Gmail connection.
  assert.equal(isBrandedImapService('gmail'), true);

  const gmail = IMAP_PRESETS.gmail;
  assert.equal(gmail.imapHost, 'imap.gmail.com');
  assert.equal(gmail.imapPort, 993);
  assert.equal(gmail.smtpHost, 'smtp.gmail.com');
  assert.equal(gmail.smtpPort, 465);
  assert.equal(gmail.smtpSecurity, 'tls');
  // 587/STARTTLS is Google's other documented submission transport. It is not
  // configured here on purpose: transport-autodetect retries it on its own
  // when 465 never yields a session, and pinning it would give up implicit
  // TLS for every account to serve the networks that block 465.
  assert.equal(portForSecurity('smtp', 'starttls'), 587);
});

test('every branded preset pairs its port with its security mode', () => {
  for (const preset of Object.values(IMAP_PRESETS)) {
    assert.equal(preset.imapPort, portForSecurity('imap', 'tls'), preset.service);
    assert.equal(preset.smtpPort, portForSecurity('smtp', preset.smtpSecurity), preset.service);
  }
});

test('a stored Zoho host reads back as the region and account type that produced it', () => {
  // The reconnect form has nothing but imap_host to work from. Every pair the
  // forward mapping can emit has to come back out of it, or a reconnect
  // resubmits the wrong data center and the route's upsert rewrites the host.
  for (const region of ZOHO_REGIONS) {
    for (const accountType of ['personal', 'organization'] as const) {
      const hosts = zohoHosts(region.value, accountType);
      assert.deepEqual(
        zohoSettingsFromHost(hosts.imapHost),
        { region: region.value, accountType },
        hosts.imapHost
      );
      // The SMTP host of the same pair carries the same two answers: the
      // prefixes differ (smtp/smtppro), the data-center suffix does not.
      assert.deepEqual(
        zohoSettingsFromHost(hosts.smtpHost),
        { region: region.value, accountType },
        hosts.smtpHost
      );
    }
  }
});

test('the EU custom-domain case, which is the bug this exists for', () => {
  assert.deepEqual(zohoSettingsFromHost('imappro.zoho.eu'), { region: 'eu', accountType: 'organization' });
  // Not the same mailbox: same data center, free/personal class.
  assert.deepEqual(zohoSettingsFromHost('imap.zoho.eu'), { region: 'eu', accountType: 'personal' });
  // Canada's data center does not follow the `zoho.<tld>` shape, so it is the
  // one most likely to be missed by a prefix/suffix rule written by hand.
  assert.deepEqual(zohoSettingsFromHost('imappro.zohocloud.ca'), { region: 'ca', accountType: 'organization' });
});

test('an unknown host is null, never a default', () => {
  // Answering "personal on .com" here would be exactly the bug: a confident
  // wrong answer that overwrites a correct stored host.
  assert.equal(zohoSettingsFromHost('imap.gmail.com'), null);
  assert.equal(zohoSettingsFromHost('mail.example.com'), null);
  // A data center Zoho adds after this build must also be null, not a guess.
  assert.equal(zohoSettingsFromHost('imap.zoho.sa'), null);
  assert.equal(zohoSettingsFromHost(''), null);
  assert.equal(zohoSettingsFromHost(null), null);
  assert.equal(zohoSettingsFromHost(undefined), null);
});

test('stored hosts are matched case-insensitively and whitespace-tolerantly', () => {
  // imap_host is written lowercased by the connect routes, but rows predate
  // that and a reconnect must not be defeated by a capital letter.
  assert.deepEqual(zohoSettingsFromHost('  IMAPPRO.Zoho.EU '), { region: 'eu', accountType: 'organization' });
});
