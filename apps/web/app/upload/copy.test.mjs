// Copy and link parsing for /upload (app/upload/copy.mjs, target.mjs).
// Run: npm run test:upload
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UPLOAD_COPY, UPLOAD_LOCALES, uploadCopy, uploadLocale, humanBytes } from './copy.mjs';
import { parseUploadFragment } from './target.mjs';

const ORIGIN = 'https://abc.supabase.co';
const PUT = `${ORIGIN}/storage/v1/object/upload/sign/attachment-uploads/ws/id?token=tok`;
const b64url = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hash = (put, extra = {}) => '#' + new URLSearchParams({ t: b64url(put), n: 'Q3 report.pdf', ...extra }).toString();

test('every locale carries exactly the English keys, none empty', () => {
  const keys = Object.keys(UPLOAD_COPY.en).sort();
  assert.deepEqual(Object.keys(UPLOAD_COPY).sort(), [...UPLOAD_LOCALES].sort());
  for (const locale of UPLOAD_LOCALES) {
    assert.deepEqual(Object.keys(UPLOAD_COPY[locale]).sort(), keys, locale);
    for (const key of keys) assert.ok(UPLOAD_COPY[locale][key].trim().length > 0, `${locale}.${key}`);
  }
});

test('no em dashes, angle brackets or curly quotes; placeholders kept', () => {
  for (const locale of UPLOAD_LOCALES) {
    for (const [key, value] of Object.entries(UPLOAD_COPY[locale])) {
      const where = `${locale}.${key}`;
      assert.doesNotMatch(value, /—/, where);
      assert.doesNotMatch(value, /[<>]/, where);
      assert.doesNotMatch(value, /[‘’“”]/, where);
      for (const ph of UPLOAD_COPY.en[key].match(/\{[a-z]+\}/g) ?? []) assert.ok(value.includes(ph), `${where} ${ph}`);
    }
  }
});

test('language from Accept-Language, English otherwise', () => {
  assert.equal(uploadLocale('nb-NO,en;q=0.5'), 'nb');
  assert.equal(uploadLocale('de-AT'), 'de');
  assert.equal(uploadLocale('it-IT'), 'en');
  assert.equal(uploadCopy('xx'), UPLOAD_COPY.en);
  assert.equal(humanBytes(1536), '1.5 KB');
});

test('the fragment yields the signed URL, name, size and expiry', () => {
  const parsed = parseUploadFragment(hash(PUT, { s: '12', e: '2026-11-19T12:00:00.000Z' }), ORIGIN);
  assert.deepEqual(parsed, { putUrl: PUT, filename: 'Q3 report.pdf', size: 12, expiresAt: '2026-11-19T12:00:00.000Z' });
  assert.equal(parseUploadFragment(hash(PUT), ORIGIN).size, null);
});

test('only a signed upload URL in our project\'s attachment bucket is accepted', () => {
  assert.equal(parseUploadFragment('', ORIGIN), null);
  assert.equal(parseUploadFragment('#t=%%%', ORIGIN), null);
  assert.equal(parseUploadFragment(hash('https://evil.example/storage/v1/object/upload/sign/attachment-uploads/x?token=t'), ORIGIN), null);
  assert.equal(parseUploadFragment(hash('http://abc.supabase.co/storage/v1/object/upload/sign/attachment-uploads/x?token=t'), ORIGIN), null);
  assert.equal(parseUploadFragment(hash(`${ORIGIN}/storage/v1/object/upload/sign/signature-assets/x?token=t`), ORIGIN), null);
  assert.equal(parseUploadFragment(hash(`${ORIGIN}/storage/v1/object/upload/sign/attachment-uploads/x`), ORIGIN), null);
  assert.equal(parseUploadFragment(hash('https://user:pw@abc.supabase.co/storage/v1/object/upload/sign/attachment-uploads/x?token=t'), ORIGIN), null);
  assert.equal(parseUploadFragment(hash(PUT), 'https://other.supabase.co'), null);
});
