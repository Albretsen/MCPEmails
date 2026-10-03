import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DEVICES, deviceClass, deviceClassFromHeaders, sanitizedDevice } from './acquisition-device.mjs';

// Real User-Agent strings, as the browsers send them.
const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1',
  ipod: 'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1',
  androidChromePhone: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  androidFirefoxPhone: 'Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0',
  androidSamsungPhone: 'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  androidChromeTablet: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  androidFirefoxTablet: 'Mozilla/5.0 (Android 14; Tablet; rv:127.0) Gecko/127.0 Firefox/127.0',
  kindleSilk: 'Mozilla/5.0 (Linux; Android 11; KFTRWI) AppleWebKit/537.36 (KHTML, like Gecko) Silk/124.3.1 like Chrome/124.0.6367.179 Safari/537.36',
  ipadSafari: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  // iPadOS Safari in its default "desktop site" mode. Identical to a Mac.
  ipadAsMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  windowsChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  windowsEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  windowsFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
  linuxChrome: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  chromeOs: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  oldIeTabletPc: 'Mozilla/5.0 (compatible; MSIE 10.0; Windows NT 6.2; Trident/6.0; Tablet PC 2.0)',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  googlebotPhone: 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  slackbot: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
  headless: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36',
};

test('the User-Agent alone: phones, tablets, desktops, and everything that is not a browser', () => {
  const table = [
    ['iphoneSafari', 'mobile'],
    ['iphoneChrome', 'mobile'],
    ['ipod', 'mobile'],
    ['androidChromePhone', 'mobile'],
    ['androidFirefoxPhone', 'mobile'],
    ['androidSamsungPhone', 'mobile'],
    ['androidChromeTablet', 'tablet'],
    ['androidFirefoxTablet', 'tablet'],
    ['kindleSilk', 'tablet'],
    ['ipadSafari', 'tablet'],
    ['macSafari', 'desktop'],
    ['macChrome', 'desktop'],
    ['windowsChrome', 'desktop'],
    ['windowsEdge', 'desktop'],
    ['windowsFirefox', 'desktop'],
    ['linuxFirefox', 'desktop'],
    ['linuxChrome', 'desktop'],
    ['chromeOs', 'desktop'],
    ['oldIeTabletPc', 'desktop'],
    ['googlebot', null],
    ['googlebotPhone', null],
    ['slackbot', null],
    ['headless', null],
  ];
  // Every fixture is in the table, so adding one without an expectation fails.
  assert.deepEqual(table.map(([name]) => name).sort(), Object.keys(UA).filter((k) => k !== 'ipadAsMac').sort());
  for (const [name, expected] of table) {
    assert.equal(deviceClass(UA[name]), expected, name);
  }
});

test('server-side and script agents are unknown, never desktop', () => {
  for (const ua of [
    // What auth.sessions holds for every Google and GitHub signup.
    'node',
    'undici',
    'curl/8.7.1',
    'python-requests/2.32.3',
    'Go-http-client/2.0',
    'axios/1.7.2',
    'okhttp/4.12.0',
    'PostmanRuntime/7.39.0',
    '',
    '   ',
    null,
    undefined,
    42,
    {},
  ]) {
    assert.equal(deviceClass(ua), null, JSON.stringify(ua));
  }
});

// The limit is real and is stated in the module: no request header separates
// an iPad in desktop-site mode from a Mac. This pins that it is counted as
// desktop on purpose, so nobody "fixes" it with a guess.
test('iPadOS Safari in desktop-site mode is indistinguishable from a Mac and counts as desktop', () => {
  assert.equal(UA.ipadAsMac, UA.macSafari);
  assert.equal(deviceClass(UA.ipadAsMac), 'desktop');
});

test('the Sec-CH-UA-Mobile hint wins over the User-Agent when it is present', () => {
  // An Android phone asking for the desktop site: Linux desktop UA, but ?1.
  assert.equal(deviceClass(UA.linuxChrome, '?1'), 'mobile');
  assert.equal(deviceClass(UA.androidChromePhone, '?1'), 'mobile');
  // Android that says it is not a phone is a tablet, even if the UA has Mobile.
  assert.equal(deviceClass(UA.androidChromeTablet, '?0'), 'tablet');
  assert.equal(deviceClass(UA.androidChromePhone, '?0'), 'tablet');
  assert.equal(deviceClass(UA.windowsChrome, '?0'), 'desktop');
  assert.equal(deviceClass(UA.macChrome, '?0'), 'desktop');
  assert.equal(deviceClass(UA.chromeOs, '?0'), 'desktop');
});

test('a hint that is not ?1 or ?0 is ignored and the User-Agent decides', () => {
  for (const hint of ['', '1', 'true', '?2', 'mobile', null, undefined, 1]) {
    assert.equal(deviceClass(UA.iphoneSafari, hint), 'mobile', String(hint));
    assert.equal(deviceClass(UA.windowsFirefox, hint), 'desktop', String(hint));
  }
});

test('a hint cannot turn a non-browser or a crawler into a device', () => {
  assert.equal(deviceClass('node', '?1'), null);
  assert.equal(deviceClass('', '?1'), null);
  assert.equal(deviceClass('curl/8.7.1', '?0'), null);
  assert.equal(deviceClass(UA.googlebotPhone, '?1'), null);
});

test('deviceClassFromHeaders reads the two headers of a Fetch request', () => {
  assert.equal(deviceClassFromHeaders(new Headers({ 'User-Agent': UA.iphoneSafari })), 'mobile');
  assert.equal(deviceClassFromHeaders(new Headers({ 'User-Agent': UA.ipadSafari })), 'tablet');
  assert.equal(
    deviceClassFromHeaders(new Headers({ 'User-Agent': UA.linuxChrome, 'Sec-CH-UA-Mobile': '?1' })),
    'mobile',
  );
  assert.equal(
    deviceClassFromHeaders(new Headers({ 'User-Agent': UA.windowsChrome, 'Sec-CH-UA-Mobile': '?0' })),
    'desktop',
  );
  assert.equal(deviceClassFromHeaders(new Headers({ 'User-Agent': 'node' })), null);
  assert.equal(deviceClassFromHeaders(new Headers()), null);
  assert.equal(deviceClassFromHeaders(null), null);
});

test('every result is one of the three stored words or null, and never the string it was given', () => {
  for (const ua of Object.values(UA)) {
    const result = deviceClass(ua);
    assert.ok(result === null || DEVICES.has(result), ua);
  }
});

test('sanitizedDevice keeps the three words and drops everything else', () => {
  for (const word of ['mobile', 'tablet', 'desktop']) assert.equal(sanitizedDevice(word), word);
  for (const junk of ['Mobile', 'phone', 'unknown', '', ' mobile', UA.iphoneSafari, null, undefined, 1, {}, ['mobile']]) {
    assert.equal(sanitizedDevice(junk), null, JSON.stringify(junk));
  }
});

// A word this file emits that the database has not been taught fails the
// CHECK, and the write is then lost for every signup of that class.
test('the stored words match the CHECK constraint in the migration, member by member', () => {
  const sql = readFileSync(
    fileURLToPath(new URL('../../../../supabase/migrations/20261002100000_acquisition_device.sql', import.meta.url)),
    'utf8',
  );
  const list = sql.match(/acquisition_device IN \(([^)]+)\)/);
  assert.ok(list, 'the CHECK list was not found');
  const allowed = [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(allowed.sort(), [...DEVICES].sort());
});
