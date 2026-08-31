#!/usr/bin/env node
/**
 * Refuse to start, legibly, when the dependencies are not installed.
 *
 * This runs as an npm `pre<script>` hook, in its own process, BEFORE the real
 * script is loaded. That matters: ESM resolves every static import before any
 * module body executes, so a check placed inside render.mjs could never run,
 * because `import { bundle } from '@remotion/bundler'` throws first. A separate
 * process is the only place the check can win the race.
 *
 * Without it, a fresh `git pull` followed by any command produced a raw
 * ERR_MODULE_NOT_FOUND stack trace naming an internal file, which tells you
 * nothing about the fact that you simply have not run `npm install` yet.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { emit, log, ROOT } from './common.mjs';

const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const required = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
];

const missing = required.filter((name) => !existsSync(resolve(ROOT, 'node_modules', name)));

if (missing.length === 0) process.exit(0);

const everything = missing.length === required.length;

log('');
log(everything
  ? 'Dependencies are not installed yet.'
  : `Some dependencies are missing: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? `, and ${missing.length - 6} more` : ''}.`);
log('');
log('This tool has its own package, separate from the rest of the repo, so a');
log('root npm install never touches it. Run this once, from here:');
log('');
log('  npm install');
log('');
log('Then re-run what you were running. `npm run demo` needs nothing else.');

emit({
  ok: false,
  script: 'require-install',
  error: everything
    ? 'Dependencies not installed. Run: npm install (from tools/video-studio)'
    : `Missing packages: ${missing.join(', ')}. Run: npm install (from tools/video-studio)`,
  missing,
  fix: 'npm install',
});

process.exit(1);
