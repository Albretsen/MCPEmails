#!/usr/bin/env node
// ---------------------------------------------------------------------------
// `npm run dev:staging`: `next dev` against the staging project, with the
// variables from apps/web/.env.staging.local (gitignored; copy
// .env.staging.example and fill it in).
//
// WHY A LAUNCHER AND NOT `next dev` WITH AN ENV FILE. Next also loads
// .env.local, and here that file points at PRODUCTION. Next only fills a
// variable that is still undefined, so any name the staging file leaves out
// would quietly take its production value (a live Stripe key, the production
// service-role key). This launcher sets every name found in Next's own env
// files to an empty string unless the staging file sets it, so nothing from
// them can reach the staging dev server.
//
// It refuses to start when the staging file is missing, when it points
// NEXT_PUBLIC_SUPABASE_URL at the production project, or when it does not say
// APP_ENV=staging.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGING_FILE = path.join(webRoot, '.env.staging.local');
const PROD_SUPABASE_REF = 'swvaxorwumispmjaaszb';
const NEXT_ENV_FILES = ['.env.development.local', '.env.local', '.env.development', '.env'];

/** Minimal dotenv: KEY=value lines, optional quotes, # comments. */
function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    out[m[1]] = value;
  }
  return out;
}

function fail(message) {
  console.error(`dev:staging: ${message}`);
  process.exit(1);
}

if (!existsSync(STAGING_FILE)) {
  fail('apps/web/.env.staging.local is missing. Copy .env.staging.example and fill in the staging values.');
}
const staging = parseEnv(readFileSync(STAGING_FILE, 'utf8'));

if (staging.APP_ENV !== 'staging') fail('.env.staging.local must set APP_ENV=staging.');
if ((staging.NEXT_PUBLIC_SUPABASE_URL ?? '').includes(PROD_SUPABASE_REF)) {
  fail('.env.staging.local points NEXT_PUBLIC_SUPABASE_URL at the production project.');
}

const env = { ...process.env };
for (const file of NEXT_ENV_FILES) {
  const full = path.join(webRoot, file);
  if (!existsSync(full)) continue;
  for (const key of Object.keys(parseEnv(readFileSync(full, 'utf8')))) {
    if (!(key in staging)) env[key] = '';
  }
}
Object.assign(env, staging, { NEXT_PUBLIC_APP_ENV: staging.NEXT_PUBLIC_APP_ENV || 'staging' });

const child = spawn('next', ['dev', ...process.argv.slice(2)], { cwd: webRoot, env, stdio: 'inherit', shell: true });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
