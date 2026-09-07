#!/usr/bin/env node
/**
 * Push GROWTH_INTERNAL_EMAILS into public.internal_accounts.
 *
 * WHY THIS EXISTS. "Which accounts are ours" used to be knowable only inside
 * the Next.js app, which reads the list from its environment. The signup
 * notification email is a Supabase edge function and albretsen.no is a
 * different site; neither can see that variable, so both counted our own ten
 * accounts as customers. The list now lives in the database, where every
 * caller can reach it, and this script is the one way it gets there.
 *
 * A HUMAN STILL EDITS ONE PLACE: the env var. This script is a mirror, and it
 * mirrors exactly -- an address dropped from the env var is DELETED from the
 * table, because a list that only ever grows would keep excluding an account
 * long after we stopped operating it, and the excluded row is invisible.
 *
 * Plus-tagged variants are matched by the SQL predicate itself, so listing
 * `you+test@gmail.com` beside `you@gmail.com` is not just unnecessary, it is
 * misleading about how the matching works. The script refuses them.
 *
 * Usage, from the repo root:
 *   node scripts/sync-internal-accounts.mjs           # show the diff, change nothing
 *   node scripts/sync-internal-accounts.mjs --apply   # write it
 *
 * Reads apps/web/.env.local for GROWTH_INTERNAL_EMAILS, NEXT_PUBLIC_SUPABASE_URL
 * and SUPABASE_SERVICE_ROLE_KEY unless they are already in the environment,
 * so that pointing it at production is a deliberate act.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apply = process.argv.includes('--apply');

/** Env wins; the file fills the gaps. Never overwrites something already set. */
function loadEnvFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    if (process.env[key] === undefined) {
      process.env[key] = value.trim().replace(/^["']|["']$/g, '');
    }
  }
}

loadEnvFile(resolve(repoRoot, 'apps/web/.env.local'));

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const wanted = [
  ...new Set(
    (process.env.GROWTH_INTERNAL_EMAILS ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  ),
].sort();

const tagged = wanted.filter((email) => email.includes('+'));
if (tagged.length > 0) {
  console.error(
    `Refusing to sync: ${tagged.join(', ')} carries a plus tag.\n` +
      'The SQL predicate strips tags itself, so list the untagged address only.',
  );
  process.exit(1);
}
if (wanted.length === 0) {
  console.error('Refusing to sync: GROWTH_INTERNAL_EMAILS is empty, which would clear the table.');
  process.exit(1);
}

async function rest(path, init = {}) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status} ${await response.text()}`);
  }
  // A PostgREST write answers 201/204 with an EMPTY body unless it was asked
  // for a representation, so the status alone does not say whether there is
  // JSON to parse: the first --apply run inserted both rows correctly and then
  // died reading the 201 back as `Unexpected end of JSON input`.
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}

const existing = (await rest('internal_accounts?select=email')).map((row) => row.email).sort();
const toAdd = wanted.filter((email) => !existing.includes(email));
const toRemove = existing.filter((email) => !wanted.includes(email));

for (const email of toAdd) console.log(`+ ${email}`);
for (const email of toRemove) console.log(`- ${email}`);
if (toAdd.length === 0 && toRemove.length === 0) console.log('Already in sync.');

if (!apply) {
  if (toAdd.length > 0 || toRemove.length > 0) console.log('\nDry run. Re-run with --apply to write.');
  process.exit(0);
}

if (toAdd.length > 0) {
  await rest('internal_accounts', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(toAdd.map((email) => ({ email, note: 'synced from GROWTH_INTERNAL_EMAILS' }))),
  });
}
if (toRemove.length > 0) {
  const list = toRemove.map((email) => `"${email}"`).join(',');
  await rest(`internal_accounts?email=in.(${encodeURIComponent(list)})`, { method: 'DELETE' });
}

const [scoreboard] = await rest('rpc/signup_scoreboard', { method: 'POST', body: '{}' });
console.log(
  `\nSigned up: ${scoreboard.total} (${scoreboard.internal_excluded} internal accounts excluded, ` +
    `${scoreboard.last_7d} in the last 7 days).`,
);
