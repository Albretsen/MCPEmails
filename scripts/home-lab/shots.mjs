#!/usr/bin/env node
// Homepage Lab screenshots through the DevTools protocol (headless Chrome's
// --window-size cannot go below about 500 px, so phone shots need emulation).
// For each variant: a first-screen and a full-page shot at 1440 px (desktop)
// and 390 px (phone, mobile emulation), saved as WebP into
// apps/web/components/home-lab/vNN/screens/ (v00 into home-lab/screens/).
// The lab picker and the STAGING ribbon are hidden in the shots.
//
// Usage (from the repo root, server running):
//   node scripts/home-lab/shots.mjs --base http://localhost:3221 v00 v01 ... v10
// Run it from apps/web or the root; it resolves sharp from apps/web.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sharp = createRequire(path.join(root, 'apps/web/package.json'))('sharp');
const args = process.argv.slice(2);
const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'http://localhost:3221';
const ids = args.filter((a, i) => /^v\d\d$/.test(a) && args[i - 1] !== '--base');
const MAX_H = 14000; // tallest full-page capture, in CSS px

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = path.join(root, 'home-lab/work/shots-chrome');
rmSync(profile, { recursive: true, force: true });
const port = 9340;
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

let ws;
for (let i = 0; i < 60 && !ws; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch {}
  if (!ws) await sleep(250);
}
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((r) => { const i = ++seq; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send('Page.enable');
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });

for (const id of ids) {
  const dir = id === 'v00' ? path.join(root, 'home-lab/screens') : path.join(root, `apps/web/components/home-lab/${id}/screens`);
  mkdirSync(dir, { recursive: true });
  for (const [label, width, height, mobile] of [['desktop', 1440, 900, false], ['mobile', 390, 844, true]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
    await send('Page.navigate', { url: `${base}/?home=${id}` });
    await sleep(6000);
    await evaluate(`(() => { const s = document.createElement('style'); s.textContent = '[data-home-lab-picker], [aria-label="Staging environment"], nextjs-portal { display: none !important; } * { content-visibility: visible !important; }'; document.head.appendChild(s); })()`);
    // Scroll through once so lazy media loads, then back to the top.
    const full = Math.min(await evaluate('document.documentElement.scrollHeight'), MAX_H);
    for (let y = 0; y < full; y += 600) { await evaluate(`scrollTo(0, ${y})`); await sleep(80); }
    await evaluate('scrollTo(0, 0)');
    await sleep(1500);
    const sw = await evaluate('document.documentElement.scrollWidth');
    if (sw > width) console.log(`${id} ${label}: horizontal overflow ${sw}px > ${width}px`);
    const fold = await send('Page.captureScreenshot', { format: 'png' });
    await sharp(Buffer.from(fold.result.data, 'base64')).resize({ width: mobile ? 390 : 1440 }).webp({ quality: 72 }).toFile(path.join(dir, `${label}-fold.webp`));
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: full, scale: 1 } });
    await sharp(Buffer.from(shot.result.data, 'base64'), { limitInputPixels: false })
      .resize({ width: mobile ? 390 : 720 })
      .webp({ quality: 60 })
      .toFile(path.join(dir, `${label}-full.webp`));
    console.log(`${id} ${label}: ${full}px tall${full === MAX_H ? ' (capped)' : ''}`);
  }
}
ws.close();
chrome.kill();
