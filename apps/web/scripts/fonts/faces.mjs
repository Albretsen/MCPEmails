// Reading font declarations out of CSS and source, for the font suites.
//
// "Which faces does the site make available" has three possible sources, and
// these helpers read all of them so the same assertions hold whichever is in
// use:
//
//   1. a Google Fonts `@import url(".../css2?family=...")` in a stylesheet,
//      whose query string names every family, weight and style it will serve;
//   2. `next/font/google` calls, whose options name the same things, or the
//      `@font-face` rules those calls compile to in the built CSS;
//   3. hand-written `@font-face` rules for self-hosted files (fonts/*.css),
//      which is what the app uses today.
//
// A face is { family, weight, style }. Weights are kept as strings because a
// variable font declares a RANGE ("100 900"), and a range is not the same
// thing as the discrete weights the site asks for today: with a range,
// `font-weight: 650` renders at 650, with discrete faces it snaps to 700.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const unquote = (value) => value.trim().replace(/^(['"])(.*)\1$/, '$2');

/** `Geist:wght@300;400` style family specs from a css2 URL -> faces. */
export function facesFromGoogleUrl(url) {
  const query = new URL(url).searchParams;
  const faces = [];
  for (const spec of query.getAll('family')) {
    const [name, axes] = spec.split(':');
    const family = name.replace(/\+/g, ' ');
    if (!axes) {
      faces.push({ family, weight: '400', style: 'normal' });
      continue;
    }
    const [axisList, valueList] = axes.split('@');
    const axisNames = axisList.split(',');
    for (const tuple of valueList.split(';')) {
      const values = tuple.split(',');
      const get = (axis) => values[axisNames.indexOf(axis)];
      const weight = axisNames.includes('wght') ? get('wght').replaceAll('..', ' ') : '400';
      const style = axisNames.includes('ital') && get('ital') === '1' ? 'italic' : 'normal';
      faces.push({ family, weight, style });
    }
  }
  return { faces, display: query.get('display') ?? 'auto' };
}

/** Every Google Fonts css2 URL a stylesheet imports. */
export function googleImportUrls(css) {
  // The URL itself contains `;` (between weights), so it ends at the closing
  // quote or parenthesis, never at a semicolon.
  return [...css.matchAll(/@import\s+(?:url\()?\s*["']?(https:\/\/fonts\.googleapis\.com\/css2\?[^"')\s]+)/g)].map((m) => m[1]);
}

/** `@font-face` rules in a stylesheet (minified or not). */
export function fontFaceRules(css) {
  const rules = [];
  for (const match of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const rule = {};
    for (const declaration of match[1].split(';')) {
      const colon = declaration.indexOf(':');
      if (colon === -1) continue;
      rule[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
    }
    rules.push({
      family: unquote(rule['font-family'] ?? ''),
      weight: rule['font-weight'] ?? '400',
      style: rule['font-style'] ?? 'normal',
      display: rule['font-display'] ?? 'auto',
      unicodeRange: rule['unicode-range'] ?? 'U+0-10FFFF',
      src: rule.src ?? '',
    });
  }
  return rules;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** next/font/google calls in one source file -> faces. */
export function facesFromNextFontSource(source) {
  const imported = /import\s*\{([^}]*)\}\s*from\s*['"]next\/font\/google['"]/.exec(source);
  if (!imported) return [];
  const out = [];
  for (const raw of imported[1].split(',')) {
    const name = raw.trim().split(/\s+as\s+/)[0];
    if (!name) continue;
    for (const call of source.matchAll(new RegExp(`\\b${name}\\s*\\(\\s*(\\{[\\s\\S]*?\\})\\s*\\)`, 'g'))) {
      // The options are a plain object literal by next/font's own rule (it
      // must be statically analysable), so evaluating it is safe and exact.
      const options = new Function(`return (${call[1]});`)();
      const family = name.replace(/_/g, ' ');
      const weights = options.weight === undefined || options.weight === 'variable' ? ['variable'] : [].concat(options.weight);
      const styles = options.style === undefined ? ['normal'] : [].concat(options.style);
      for (const weight of weights) for (const style of styles) out.push({ family, weight: String(weight), style });
      out.push({ family, option: 'display', value: options.display ?? 'swap' });
    }
  }
  return out;
}

/**
 * The faces the SOURCE declares, from whichever mechanism it uses, and the
 * font-display each mechanism asks for.
 */
export function declaredFaces(webRoot) {
  const faces = [];
  const displays = [];
  const sources = [];
  for (const file of walk(path.join(webRoot, 'styles')).filter((f) => f.endsWith('.css'))) {
    for (const url of googleImportUrls(readFileSync(file, 'utf8'))) {
      const parsed = facesFromGoogleUrl(url);
      faces.push(...parsed.faces);
      displays.push(parsed.display);
      sources.push(`@import in ${path.relative(webRoot, file)}`);
    }
  }
  // Hand-written @font-face rules for self-hosted files (fonts/fonts.css).
  const fontsDir = path.join(webRoot, 'fonts');
  if (existsSync(fontsDir)) {
    for (const file of walk(fontsDir).filter((f) => f.endsWith('.css'))) {
      const rules = fontFaceRules(readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''));
      if (rules.length === 0) continue;
      sources.push(`@font-face in ${path.relative(webRoot, file)}`);
      for (const rule of rules) {
        faces.push({ family: rule.family, weight: rule.weight, style: rule.style });
        displays.push(rule.display);
      }
    }
  }
  for (const dir of ['app', 'components', 'src']) {
    for (const file of walk(path.join(webRoot, dir)).filter((f) => /\.(js|jsx|ts|tsx|mjs)$/.test(f))) {
      const found = facesFromNextFontSource(readFileSync(file, 'utf8'));
      if (found.length === 0) continue;
      sources.push(`next/font/google in ${path.relative(webRoot, file)}`);
      for (const entry of found) {
        if (entry.option === 'display') displays.push(entry.value);
        else faces.push(entry);
      }
    }
  }
  return { faces, displays, sources };
}

/** { family: ['400 normal', ...] } sorted, for comparison. */
export function matrix(faces) {
  const out = {};
  for (const { family, weight, style } of faces) {
    (out[family] ??= new Set()).add(`${weight} ${style}`);
  }
  return Object.fromEntries(Object.keys(out).sort().map((family) => [family, [...out[family]].sort()]));
}

/** Custom properties declared anywhere in a stylesheet: name -> [values]. */
export function customProperties(css) {
  const out = {};
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of withoutComments.matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;}]+)[;}]/g)) {
    (out[match[1]] ??= []).push(match[2].trim());
  }
  return out;
}

/** Splits a font-family value into its families, quotes removed. */
export function familyList(value) {
  return value.split(',').map((part) => unquote(part)).filter(Boolean);
}

/** Resolves `var(--x)` / `var(--x, fallback)` in a font-family value against single-valued custom properties. */
export function resolveFamilies(value, properties) {
  let current = value;
  for (let depth = 0; depth < 8 && /var\(/.test(current); depth += 1) {
    current = current.replace(/var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([^()]*))?\)/g, (whole, name, fallback) => {
      const values = properties[name];
      if (!values) return fallback ?? whole;
      if (values.length !== 1) throw new Error(`${name} is declared ${values.length} times; cannot resolve it statically`);
      return values[0];
    });
  }
  return familyList(current);
}

/** The declarations of the first rule whose selector list contains `selector` exactly. */
export function ruleDeclarations(css, selector) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(',').map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    const out = {};
    for (const declaration of match[2].split(';')) {
      const colon = declaration.indexOf(':');
      if (colon !== -1) out[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
    }
    return out;
  }
  return null;
}

/** unicode-range value -> sorted, merged [start, end] intervals. */
export function unicodeIntervals(ranges) {
  const intervals = [];
  for (const range of ranges) {
    for (const part of range.split(',')) {
      const m = /U\+([0-9A-Fa-f?]+)(?:-([0-9A-Fa-f]+))?/.exec(part.trim());
      if (!m) continue;
      const start = parseInt(m[1].replace(/\?/g, '0'), 16);
      const end = m[2] ? parseInt(m[2], 16) : parseInt(m[1].replace(/\?/g, 'F'), 16);
      intervals.push([start, end]);
    }
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of intervals) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** Code points in `wanted` that `have` does not cover, as intervals. */
export function uncovered(wanted, have) {
  const missing = [];
  for (const [start, end] of wanted) {
    let cursor = start;
    for (const [hs, he] of have) {
      if (he < cursor) continue;
      if (hs > end) break;
      if (hs > cursor) missing.push([cursor, hs - 1]);
      cursor = Math.max(cursor, he + 1);
      if (cursor > end) break;
    }
    if (cursor <= end) missing.push([cursor, end]);
  }
  return missing;
}
