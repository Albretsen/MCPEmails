import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PROVIDERS } from './providers.mjs';
import { releasedProviders } from './release.mjs';
import {
  datasetRows, datasetStats, datasetJson, datasetCsv, FIELD_DOCS,
} from './provider-dataset.mjs';

const APP = 'https://mcpemails.com';
const rows = datasetRows();

test('one row per released provider that answered the probe over IMAP', () => {
  const expected = releasedProviders().filter((p) => p.evidence?.reachable && p.imap);
  assert.equal(rows.length, expected.length);
  assert.ok(rows.length > 50, `only ${rows.length} rows`);
  const released = new Set(releasedProviders().map((p) => p.slug));
  for (const r of rows) assert.ok(released.has(r.slug), `${r.slug} is not released`);
});

test('rows carry exactly the documented fields, in order', () => {
  const keys = FIELD_DOCS.map((f) => f.key);
  for (const r of rows) assert.deepEqual(Object.keys(r), keys);
});

test('fields a pre-login probe gets wrong, and raw banners, are never published', () => {
  const json = JSON.stringify(datasetJson(APP));
  for (const bad of ['"move"', '"idle"', '"uidplus"', '"specialUse"', '"banner"']) {
    assert.ok(!json.includes(bad), `${bad} leaked into the dataset`);
  }
});

test('no IP address appears anywhere in the probe data or the dataset', () => {
  const ipv4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
  const ipv6 = /\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){4,7}\b/i;
  const source = readFileSync(new URL('./providers.mjs', import.meta.url), 'utf8');
  for (const p of PROVIDERS) {
    const banner = p.evidence?.banner ?? '';
    assert.ok(!ipv6.test(banner), `${p.slug} banner carries an IPv6 address`);
  }
  assert.ok(!source.includes('2001:4643'), 'the prober address is back in providers.mjs');
  const out = JSON.stringify(datasetJson(APP)) + datasetCsv(APP);
  assert.ok(!ipv6.test(out), 'IPv6 address in the dataset');
  assert.ok(!ipv4.test(out), 'IPv4 address in the dataset');
});

test('SMTP auth on a STARTTLS port with nothing advertised is null, never an empty list', () => {
  for (const r of rows) {
    if (r.smtpAuth) assert.ok(r.smtpAuth.length > 0, `${r.slug} smtpAuth is []`);
  }
  const icloud = rows.find((r) => r.slug === 'icloud');
  assert.equal(icloud.smtpSecurity, 'starttls');
  assert.equal(icloud.smtpAuth, null);
});

test('headline numbers are computed from the rows', () => {
  const s = datasetStats(rows);
  assert.equal(s.providers, rows.length);
  assert.equal(s.noSaslIr, rows.filter((r) => r.saslIr === false).length);
  assert.ok(s.sizeMin <= s.sizeMedian && s.sizeMedian <= s.sizeMax);
  assert.match(s.probedOn, /^\d{4}-\d{2}-\d{2}$/);
});

test('CSV has a header plus one line per row, and absolute page URLs', () => {
  const lines = datasetCsv(APP).trimEnd().split('\n');
  assert.equal(lines[0], FIELD_DOCS.map((f) => f.key).join(','));
  assert.equal(lines.length, rows.length + 1);
  assert.ok(lines.slice(1).every((l) => l.includes(`${APP}/connect/`)));
});
