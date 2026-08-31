/**
 * Shared plumbing for every script in this tool.
 *
 * The one rule worth stating: every script ends by printing a SINGLE line of
 * JSON to stdout, prefixed with RESULT_PREFIX. A calling agent parses that line
 * instead of scraping prose out of the human-readable log above it. Human log
 * goes to stderr, machine result goes to stdout.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const paths = {
  root: ROOT,
  captures: resolve(ROOT, 'captures'),
  capturesRaw: resolve(ROOT, 'captures', 'raw'),
  out: resolve(ROOT, 'out'),
  shots: resolve(ROOT, 'shots'),
  storyboards: resolve(ROOT, 'storyboards'),
  transcripts: resolve(ROOT, 'transcripts'),
  assets: resolve(ROOT, 'assets'),
  vo: resolve(ROOT, 'assets', 'vo'),
  auth: resolve(ROOT, '.auth'),
  authState: resolve(ROOT, '.auth', 'demo.json'),
  entry: resolve(ROOT, 'src', 'index.ts'),
};

export const RESULT_PREFIX = 'VIDEO_STUDIO_RESULT ';

/** Human-readable progress. Goes to stderr so stdout stays parseable. */
export function log(...args) {
  process.stderr.write(args.join(' ') + '\n');
}

export function heading(text) {
  log('\n' + text);
  log('-'.repeat(text.length));
}

/** The single machine-readable line. Call exactly once, last. */
export function emit(result) {
  process.stdout.write(RESULT_PREFIX + JSON.stringify(result) + '\n');
}

/** Fail with a machine-readable line as well as a message, then exit non-zero. */
export function fail(script, message, extra = {}) {
  log('\nERROR: ' + message);
  emit({ ok: false, script, error: message, ...extra });
  process.exit(1);
}

/**
 * Minimal argv parser. Supports `--key value`, `--key=value` and bare `--flag`.
 * Deliberately not a dependency: the surface is five scripts with four options
 * between them.
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const body = a.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      out[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[body] = next;
      i++;
    } else {
      out[body] = true;
    }
  }
  return out;
}

/**
 * Load .env into process.env without overwriting anything already set, so an
 * inline `FOO=bar npm run ...` still wins. No dependency: the file format we
 * need is KEY=VALUE with optional quotes and # comments.
 */
export function loadEnv(file = resolve(ROOT, '.env')) {
  if (!existsSync(file)) return {};
  const loaded = {};
  for (const rawLine of readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    loaded[key] = value;
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return loaded;
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Redact anything that looks like a credential before it can reach a log. */
export function redact(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/\b(mcpe_(?:live|test)_)[A-Za-z0-9_-]+/g, '$1***')
    .replace(/\b(Bearer\s+)\S+/gi, '$1***')
    .replace(/\b(sb[a-z]?_[A-Za-z0-9_-]{8,})/g, 'sb_***')
    .replace(/(eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_.-]+/g, 'jwt_***');
}

export const seconds = (ms) => Math.round(ms) / 1000;
