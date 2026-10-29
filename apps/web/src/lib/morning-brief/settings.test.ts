import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMorningBriefInput, normalizeVipEntry, splitVipText, isValidTimeZone } from './settings.ts';

const INBOX = '22222222-2222-4222-8222-222222222222';
const GOOD = { enabled: true, hour: 7, timezone: 'Europe/Oslo', locale: 'nb', inbox_id: INBOX, vip_senders: ['Boss@Example.com', '@vip.example', 'vip.example'] };

test('a full valid body normalises VIPs and keeps the rest', () => {
  const r = normalizeMorningBriefInput(GOOD);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.value, { ...GOOD, vip_senders: ['boss@example.com', 'vip.example'] });
});

test('every field is checked', () => {
  const bad: Array<[Record<string, unknown>, string]> = [
    [{ ...GOOD, enabled: 'yes' }, 'invalid_enabled'],
    [{ ...GOOD, hour: 24 }, 'invalid_hour'],
    [{ ...GOOD, hour: -1 }, 'invalid_hour'],
    [{ ...GOOD, hour: 7.5 }, 'invalid_hour'],
    [{ ...GOOD, hour: '7' }, 'invalid_hour'],
    [{ ...GOOD, timezone: 'Mars/Olympus' }, 'invalid_timezone'],
    [{ ...GOOD, timezone: '' }, 'invalid_timezone'],
    [{ ...GOOD, locale: 'zh' }, 'invalid_locale'],
    [{ ...GOOD, inbox_id: 'not-a-uuid' }, 'invalid_inbox'],
    [{ ...GOOD, inbox_id: null }, 'inbox_required'],
    [{ ...GOOD, vip_senders: 'boss@example.com' }, 'invalid_vip'],
    [{ ...GOOD, vip_senders: ['not valid'] }, 'invalid_vip'],
    [{ ...GOOD, vip_senders: Array.from({ length: 51 }, (_, i) => `a${i}@example.com`) }, 'too_many_vips'],
  ];
  for (const [body, error] of bad) {
    const r = normalizeMorningBriefInput(body);
    assert.equal(r.ok, false, JSON.stringify(body));
    if (!r.ok) assert.equal(r.error, error, JSON.stringify(body));
  }
  for (const body of [null, [], 'x', 5]) assert.equal(normalizeMorningBriefInput(body).ok, false);
});

test('turned off, no inbox is fine', () => {
  const r = normalizeMorningBriefInput({ ...GOOD, enabled: false, inbox_id: null });
  assert.equal(r.ok, true);
});

test('VIP helpers', () => {
  assert.equal(normalizeVipEntry('@Example.com'), 'example.com');
  assert.equal(normalizeVipEntry('a@b'), null);
  assert.deepEqual(splitVipText('a@x.com, b.org\n\n c@y.net;d.io'), ['a@x.com', 'b.org', 'c@y.net', 'd.io']);
  assert.equal(isValidTimeZone('America/New_York'), true);
  assert.equal(isValidTimeZone('nope'), false);
});
