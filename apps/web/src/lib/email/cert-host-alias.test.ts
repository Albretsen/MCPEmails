import test from 'node:test';
import assert from 'node:assert/strict';
import {
  certificateNames,
  certFromNameMismatch,
  certNameMessage,
  displayCertHost,
  findCertHostAlias,
  type CertAliasDeps,
} from './cert-host-alias.ts';
import { connectFix, connectFailureContext } from './auth-failure-help.ts';

const IP = '185.135.91.43';
const shared = { subject: { CN: 's28.kylos.pl' }, subjectaltname: 'DNS:s28.kylos.pl' };
const wildcard = { subject: { CN: '*.fsi.pl' }, subjectaltname: 'DNS:*.fsi.pl, DNS:fsi.pl' };

function deps(over: Partial<{ cname: Record<string, string>; ptr: string[]; a: Record<string, string[]> }>): CertAliasDeps {
  return {
    resolveCname: async (host) => (over.cname?.[host] ? [over.cname[host]] : []),
    reverse: async () => over.ptr ?? [],
    lookup: async (host) => over.a?.[host] ?? [],
  };
}

test('certificateNames: SANs then CN, lower-cased, deduplicated', () => {
  assert.deepEqual(certificateNames({ subject: { CN: 'Mail.Example.com' }, subjectaltname: 'DNS:mail.example.com, IP Address:1.2.3.4, DNS:*.example.com' }), ['mail.example.com', '*.example.com']);
  assert.deepEqual(certificateNames(null), []);
});

test('displayCertHost prefers a plain name over a wildcard', () => {
  assert.equal(displayCertHost(['*.fsi.pl', 'fsi.pl']), 'fsi.pl');
  assert.equal(displayCertHost(['*.fsi.pl']), '*.fsi.pl');
  assert.equal(displayCertHost([]), null);
});

test('shared host: the certificate name on the same IP is used (the corak.pl case)', async () => {
  const alias = await findCertHostAlias({ host: 'mail.corak.pl', address: IP, cert: shared }, deps({ a: { 's28.kylos.pl': [IP] } }));
  assert.equal(alias, 's28.kylos.pl');
});

test('wildcard certificate: the CNAME target is used (the cracowtours case)', async () => {
  const alias = await findCertHostAlias(
    { host: 'mail.cracowtours.pl', address: '10.9.8.7', cert: wildcard },
    deps({ cname: { 'mail.cracowtours.pl': 'a65.fsi.pl.' }, a: { 'a65.fsi.pl': ['10.9.8.7'] } }),
  );
  assert.equal(alias, 'a65.fsi.pl');
});

test('wildcard certificate: reverse DNS is used when there is no CNAME', async () => {
  const alias = await findCertHostAlias({ host: 'mail.x.pl', address: '10.9.8.7', cert: wildcard }, deps({ ptr: ['a12.fsi.pl'], a: { 'a12.fsi.pl': ['10.9.8.7'] } }));
  assert.equal(alias, 'a12.fsi.pl');
});

test('a certificate name on a different machine is never used', async () => {
  const alias = await findCertHostAlias({ host: 'mail.corak.pl', address: IP, cert: shared }, deps({ a: { 's28.kylos.pl': ['203.0.113.9'] } }));
  assert.equal(alias, null);
});

test('a CNAME the certificate does not cover is never used', async () => {
  const alias = await findCertHostAlias(
    { host: 'mail.x.pl', address: IP, cert: shared },
    deps({ cname: { 'mail.x.pl': 'other.host.pl' }, a: { 'other.host.pl': [IP] } }),
  );
  assert.equal(alias, null);
});

test('no dialled address or no certificate: nothing', async () => {
  assert.equal(await findCertHostAlias({ host: 'mail.corak.pl', address: null, cert: shared }, deps({ a: { 's28.kylos.pl': [IP] } })), null);
  assert.equal(await findCertHostAlias({ host: 'mail.corak.pl', address: IP, cert: null }, deps({})), null);
});

test('DNS failures are a miss, not a throw', async () => {
  const failing: CertAliasDeps = {
    resolveCname: async () => { throw new Error('ENODATA'); },
    reverse: async () => { throw new Error('ENOTFOUND'); },
    lookup: async () => { throw new Error('ENOTFOUND'); },
  };
  assert.equal(await findCertHostAlias({ host: 'mail.corak.pl', address: IP, cert: shared }, failing), null);
});

test('certFromNameMismatch reads only Node’s name-mismatch error', () => {
  assert.equal(certFromNameMismatch({ code: 'ERR_TLS_CERT_ALTNAME_INVALID', cert: shared }), shared);
  assert.equal(certFromNameMismatch({ code: 'CERT_HAS_EXPIRED', cert: shared }), null);
  assert.equal(certFromNameMismatch(null), null);
});

test('certNameMessage names both hosts', () => {
  assert.match(certNameMessage('mail.corak.pl', shared), /s28\.kylos\.pl, not mail\.corak\.pl/);
});

test('failure context carries cert_host, and the fix panel says what the certificate is for', () => {
  const ctx = connectFailureContext({ host: 'mail.x.pl', phase: 'tls', certHost: '*.fsi.pl' });
  assert.equal(ctx.cert_host, '*.fsi.pl');
  assert.equal(connectFailureContext({ host: 'mail.x.pl', phase: 'tls', certHost: 'bad host<' }).cert_host, undefined);
  const fix = connectFix({ card: 'generic', errorCode: 'tls_handshake_failed', phase: 'tls', host: 'mail.x.pl', certHost: '*.fsi.pl' });
  assert.equal(fix?.row, 'tls_cert_name');
  assert.deepEqual(fix?.steps.map((s) => s.key), ['connect.fix.certName.for', 'connect.fix.certName.next']);
  assert.deepEqual(fix?.steps[0].values, { certHost: '*.fsi.pl', host: 'mail.x.pl' });
  // Without a certificate host the old TLS row is unchanged.
  assert.equal(connectFix({ card: 'generic', errorCode: 'tls_handshake_failed', phase: 'tls', host: 'mail.x.pl' })?.row, 'tls');
});
