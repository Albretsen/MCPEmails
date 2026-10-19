import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CONSUMER_BRAND_FAMILIES, CONSUMER_EMAIL_DOMAINS } from '@/lib/segment/consumer-domains.mjs';
import { SSO_CONNECTION_STATUSES, SSO_DEFAULT_ROLES } from './types.ts';
import { SSO_VERIFICATION_TXT_PREFIX } from './domains.ts';

// The database refuses consumer domains with its own copy of the list. If the
// two drift, the form accepts a domain the database refuses (or the reverse).

const here = path.dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  path.resolve(here, '../../../../../supabase/migrations/20261019140000_sso_connections.sql'),
  'utf8',
);

const consumerFunction = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.sso_is_consumer_domain'),
  migration.indexOf('REVOKE ALL ON FUNCTION public.sso_is_consumer_domain'),
);

test('the SQL consumer domain list is the app list, in the same order', () => {
  const array = consumerFunction.match(/ARRAY\[([\s\S]*?)\]::text\[\]/);
  assert.ok(array, 'ARRAY[...]::text[] literal not found');
  const sqlDomains = [...array[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(sqlDomains, [...CONSUMER_EMAIL_DOMAINS]);
});

test('the SQL brand-family regex has the app families plus proton', () => {
  const regex = consumerFunction.match(/p_domain ~ '\^\(([a-z|]+)\)\\\./);
  assert.ok(regex, 'brand-family regex not found');
  assert.deepEqual(regex[1].split('|'), [...CONSUMER_BRAND_FAMILIES, 'proton', 'protonmail']);
});

test('enum CHECKs match the TypeScript unions', () => {
  const quoted = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');
  assert.ok(migration.includes(`CHECK (status IN (${quoted(SSO_CONNECTION_STATUSES)}))`));
  assert.ok(migration.includes(`CHECK (default_role IN (${quoted(SSO_DEFAULT_ROLES)}))`));
});

test('the documented TXT record prefix is the one the lib checks', () => {
  assert.ok(migration.includes(`${SSO_VERIFICATION_TXT_PREFIX}<verification_token>`));
});

test('the new-user trigger skips SSO users and handle_new_user() is left alone', () => {
  assert.match(migration, /CREATE OR REPLACE TRIGGER on_auth_user_created[\s\S]*?WHEN \(COALESCE\(NEW\.raw_app_meta_data->>'provider', ''\) NOT LIKE 'sso:%'\)[\s\S]*?EXECUTE FUNCTION public\.handle_new_user\(\);/);
  assert.match(migration, /CREATE OR REPLACE TRIGGER on_auth_sso_user_created[\s\S]*?WHEN \(NEW\.raw_app_meta_data->>'provider' LIKE 'sso:%'\)[\s\S]*?EXECUTE FUNCTION public\.handle_new_sso_user\(\);/);
  // Other open work redefines handle_new_user(); a copy here would race it.
  assert.equal(/FUNCTION public\.handle_new_user\(\)\s*RETURNS/.test(migration), false);
});

test('nothing in the migration writes workspace_members', () => {
  assert.equal(/(INSERT INTO|UPDATE|DELETE FROM)\s+public\.workspace_members/i.test(migration), false);
});
