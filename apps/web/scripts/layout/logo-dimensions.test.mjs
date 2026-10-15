// Every logo <img> reserves its box before the image arrives.
// Run: npm run test:logo-dimensions
//
// The logos are SVGs with a viewBox and no size of their own, sized in CSS by
// height alone. Until the file has loaded such an <img> has no aspect ratio,
// so it is 0 px wide, and whatever sits next to it (the nav links, the mobile
// menu button) jumps sideways by the logo's width when it arrives. A `width`
// and `height` attribute pair gives the browser the ratio up front.
//
// The attributes are only a ratio hint here, never the rendered size:
//
//   - `width="280"` is also a presentational hint for the CSS width, so on its
//     own it would make a logo with `height: 28px` render 280 px wide and
//     squashed. Each logo therefore also needs `width: auto` from CSS, which
//     this checks, so the rendered size stays what the stylesheet says.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Files whose logo <img> is deliberately not checked.
const EXEMPT = new Map([
  // Being restructured on another branch at the time of writing, so not edited
  // here. Its logo still gets its ratio, from the `aspect-ratio` in the CSS
  // rule checked below, which applies to every img.logo-light / img.logo-dark.
  ['components/dashboard/Sidebar.jsx', 'covered by the CSS aspect-ratio rule'],
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|jsx|ts|tsx)$/.test(name) && !/\.test\.[a-z]+$/.test(name)) out.push(full);
  }
  return out;
}

function viewBoxRatio(file) {
  const svg = readFileSync(path.join(webRoot, 'public', file), 'utf8');
  const box = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  assert.ok(box, `${file} has no viewBox`);
  assert.doesNotMatch(/<svg[^>]*>/.exec(svg)[0], /\s(width|height)=/, `${file} now has its own size; revisit this test`);
  return Number(box[1]) / Number(box[2]);
}

/** Every <img> whose src is one of the logo files: { file, src, tag }. */
function logoImages() {
  const found = [];
  for (const dir of ['app', 'components']) {
    for (const file of walk(path.join(webRoot, dir))) {
      const rel = path.relative(webRoot, file).split(path.sep).join('/');
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/<img\b[^>]*?src="\/(logo-(?:wordmark|mark)(?:-dark)?\.svg)"[^>]*?\/?>/g)) {
        found.push({ file: rel, src: match[1], tag: match[0] });
      }
    }
  }
  return found;
}

const number = (tag, name) => {
  const match = new RegExp(`\\s${name}=(?:"(\\d+)"|\\{(\\d+)\\})`).exec(tag);
  return match ? Number(match[1] ?? match[2]) : null;
};

const images = logoImages();

test('the scan finds the logo images', () => {
  const files = new Set(images.map((image) => image.file));
  assert.ok(images.length >= 30, `only ${images.length} logo <img> tags found`);
  for (const expected of ['components/marketing/Sections.jsx', 'components/auth/SignupApp.jsx', 'components/auth/LoginApp.jsx', 'app/not-found.js', 'app/error.js']) {
    assert.ok(files.has(expected), `${expected} was not scanned`);
  }
});

test('every logo <img> carries width and height attributes in the SVG\'s own aspect ratio', () => {
  const problems = [];
  for (const image of images) {
    if (EXEMPT.has(image.file)) continue;
    const width = number(image.tag, 'width');
    const height = number(image.tag, 'height');
    if (width === null || height === null) {
      problems.push(`${image.file}: <img src="/${image.src}"> has no width/height`);
      continue;
    }
    const ratio = viewBoxRatio(image.src);
    if (Math.abs(width / height - ratio) > 1e-9) {
      problems.push(`${image.file}: /${image.src} is ${width}x${height}, but its viewBox ratio is ${ratio}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('the exemptions are real files that still contain a logo', () => {
  for (const file of EXEMPT.keys()) {
    assert.ok(images.some((image) => image.file === file), `${file} no longer has a logo <img>; remove it from EXEMPT`);
  }
});

function rule(css, selector) {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1].split(',').map((s) => s.trim()).includes(selector)) {
      return Object.fromEntries(match[2].split(';').map((d) => d.split(':').map((s) => s.trim())).filter((d) => d.length === 2));
    }
  }
  return null;
}

test('CSS keeps the rendered width automatic, so the attributes act as a ratio and nothing else', () => {
  const theme = readFileSync(path.join(webRoot, 'styles/theme.css'), 'utf8');
  for (const selector of ['img.logo-light', 'img.logo-dark']) {
    const declarations = rule(theme, selector);
    assert.ok(declarations, `styles/theme.css has no rule for ${selector}`);
    assert.equal(declarations.width, 'auto', selector);
    // Also covers a wordmark <img> that has no attributes (the exempt sidebar).
    assert.equal(declarations['aspect-ratio'], 'auto 280 / 48', selector);
  }
  assert.equal(viewBoxRatio('logo-wordmark.svg'), 280 / 48);
  assert.equal(viewBoxRatio('logo-wordmark-dark.svg'), 280 / 48);

  // The footer mark has no class of its own; its sizing rule carries the width.
  const marketing = readFileSync(path.join(webRoot, 'styles/marketing.css'), 'utf8');
  assert.equal(rule(marketing, '.footer .brand-cell img')?.width, 'auto');
});

test('every wordmark <img> has one of the two classes the CSS rule targets', () => {
  for (const image of images.filter((i) => i.src.startsWith('logo-wordmark'))) {
    const expected = image.src === 'logo-wordmark.svg' ? 'logo-light' : 'logo-dark';
    assert.match(image.tag, new RegExp(`className="${expected}"`), `${image.file}: ${image.tag}`);
  }
});
