// Structural checks for /best-email-mcp-servers (src/lib/compare/email-mcp-servers.mjs).
//
// The page makes dated claims about named companies. These tests keep the
// dating honest (every source has a URL and an ISO read date, and the page's
// "read on" date is the oldest of them) and keep two classes of claim off the
// page for good: a numeric tool count, and the region picker we never had.
// Staleness (how old a read date may get) is deliberately not checked here: a
// date-based failure in CI would block unrelated production deploys.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from './email-mcp-servers.mjs';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function isRealIsoDate(s) {
  if (!ISO.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Every string anywhere in the module's exports, so no copy escapes a check. */
function allStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => allStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => allStrings(v, out));
  return out;
}

const copy = allStrings(Object.fromEntries(Object.entries(C).filter(([, v]) => typeof v !== 'function')));

test('every source has an https url and a real ISO checkedOn date', () => {
  assert.ok(C.SOURCES.items.length > 0);
  for (const s of C.SOURCES.items) {
    assert.equal(typeof s.label, 'string', JSON.stringify(s));
    assert.ok(s.label.length > 0, JSON.stringify(s));
    assert.match(s.url, /^https:\/\/[^\s]+$/, `bad url: ${s.url}`);
    assert.ok(isRealIsoDate(s.checkedOn), `bad checkedOn for ${s.url}: ${s.checkedOn}`);
  }
});

test('source urls are unique', () => {
  const urls = C.SOURCES.items.map((s) => s.url);
  assert.equal(new Set(urls).size, urls.length);
});

test('CHECKED_ON is the oldest source date, and no source postdates the page', () => {
  const dates = C.SOURCES.items.map((s) => s.checkedOn).sort();
  assert.equal(C.CHECKED_ON_ISO, dates[0]);
  assert.equal(C.CHECKED_ON, C.formatDate(dates[0]));
  assert.ok(dates[dates.length - 1] <= C.PAGE_UPDATED, 'a source was read after PAGE_UPDATED');
});

test('page dates are ISO and published is not after modified', () => {
  assert.ok(isRealIsoDate(C.PAGE_UPDATED));
  assert.ok(isRealIsoDate(C.DATE_PUBLISHED));
  assert.ok(C.DATE_PUBLISHED <= C.PAGE_UPDATED);
});

test('formatDate renders day, month name and year without a timezone shift', () => {
  assert.equal(C.formatDate('2026-10-20'), '20 October 2026');
  assert.equal(C.formatDate('2026-01-01'), '1 January 2026');
});

test('no numeric tool count anywhere in the comparison copy', () => {
  const numberWords = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty';
  const count = new RegExp(`\\b(\\d[\\d,]*\\+?|${numberWords})(\\s+[\\w-]+)?\\s+tools\\b`, 'i');
  for (const s of copy) assert.doesNotMatch(s, count, `tool count in: ${s}`);
});

test('our own copy never claims a region choice and never writes the brand as one word', () => {
  for (const s of copy) {
    assert.doesNotMatch(s, /EU or US/i, s);
    assert.doesNotMatch(s, /picked at signup|region at signup/i, s);
    // "mcpemails" may appear in a URL, never as the product name.
    assert.doesNotMatch(s.replace(/https?:\/\/\S+/g, ''), /\bmcpemails\b/i, s);
  }
});

test('every entry lists weaknesses, ranks are 1..n in order, and exactly one is ours', () => {
  C.entries.forEach((e, i) => {
    assert.equal(e.rank, i + 1);
    assert.ok(e.cons.length > 0, `${e.name} has no cons`);
  });
  assert.equal(C.entries.filter((e) => e.us).length, 1);
});

test('every table row fills every column', () => {
  for (const row of C.rows) {
    for (const col of C.columns) {
      assert.notEqual(row[col.key], undefined, `${row.label} missing ${col.key}`);
    }
  }
});

test('the lineup names the hosted apps AI answers recommend', () => {
  const names = C.entries.map((e) => e.name);
  for (const n of ['MCP Emails', 'Mailbox MCP', 'anymailmcp', 'MailMCP', 'Mailopoly']) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
});
