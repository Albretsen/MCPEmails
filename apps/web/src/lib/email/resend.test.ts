// The Resend factory (src/lib/email/resend.ts) and the staging switches in
// src/lib/env/app-env.ts. Production must get the untouched client; anything
// else may only mail EMAIL_RECIPIENT_ALLOWLIST, and a fully filtered send must
// answer like an accepted one so dispatcher bookkeeping is unchanged.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

type Sent = { kind: 'one' | 'batch'; payload: unknown; options: unknown };
const sent: Sent[] = [];

class FakeResend {
  key: string;
  emails = {
    send: async (payload: unknown, options?: unknown) => {
      sent.push({ kind: 'one', payload, options });
      return { data: { id: 'real-1' }, error: null, headers: null };
    },
  };
  batch = {
    send: async (payloads: unknown[], options?: unknown) => {
      sent.push({ kind: 'batch', payload: payloads, options });
      return { data: { data: payloads.map((_, i) => ({ id: `real-${i}` })) }, error: null, headers: null };
    },
  };
  constructor(key: string) {
    this.key = key;
  }
}

mock.module('resend', { namedExports: { Resend: FakeResend } });

const { createResend, filterRecipients, isPlausibleAddress, INVALID_RECIPIENT_ID_PREFIX, SKIPPED_ID_PREFIX } = await import('./resend.ts');
const { appEnv, isAllowlistedAddress, mayUseThisDeployment, recipientAllowlist } = await import('../env/app-env.ts');

const STAGING = { APP_ENV: 'staging', EMAIL_RECIPIENT_ALLOWLIST: 'owner@example.com, @tests.example' };

test('APP_ENV defaults to production; only exact values switch it', () => {
  assert.equal(appEnv({}), 'production');
  assert.equal(appEnv({ APP_ENV: '' }), 'production');
  assert.equal(appEnv({ APP_ENV: 'prod' }), 'production');
  assert.equal(appEnv({ APP_ENV: 'Staging' }), 'staging');
  assert.equal(appEnv({ NEXT_PUBLIC_APP_ENV: 'staging' }), 'staging');
  assert.equal(appEnv({ APP_ENV: 'development' }), 'development');
});

test('allowlist matches exact addresses and whole @domains, nothing looser', () => {
  const list = recipientAllowlist(STAGING);
  assert.deepEqual(list, ['owner@example.com', '@tests.example']);
  assert.equal(isAllowlistedAddress('Owner@Example.com', list), true);
  assert.equal(isAllowlistedAddress('Owner <owner@example.com>', list), true);
  assert.equal(isAllowlistedAddress('a@tests.example', list), true);
  assert.equal(isAllowlistedAddress('a@sub.tests.example', list), false);
  assert.equal(isAllowlistedAddress('other@example.com', list), false);
  assert.equal(isAllowlistedAddress('a@tests.example.evil.com', list), false);
  assert.equal(isAllowlistedAddress('', list), false);
  assert.equal(isAllowlistedAddress(null, list), false);
});

test('sign-in gate: everyone in production, only the allowlist in staging', () => {
  assert.equal(mayUseThisDeployment('anyone@gmail.com', {}), true);
  assert.equal(mayUseThisDeployment(undefined, {}), true);
  assert.equal(mayUseThisDeployment('anyone@gmail.com', STAGING), false);
  assert.equal(mayUseThisDeployment('owner@example.com', STAGING), true);
  assert.equal(mayUseThisDeployment('owner@example.com', { APP_ENV: 'staging' }), false);
});

test('production returns the plain client and sends to anyone', async () => {
  sent.length = 0;
  const client = createResend('re_key', {}) as unknown as FakeResend;
  assert.ok(client instanceof FakeResend);
  const result = await client.emails.send({ from: 'a@b.c', to: 'customer@gmail.com', subject: 's' });
  assert.equal(result.data?.id, 'real-1');
  assert.deepEqual((sent[0].payload as { to: string }).to, 'customer@gmail.com');
});

test('staging drops non-allowlisted to/cc/bcc and sends to the rest', async () => {
  sent.length = 0;
  const client = createResend('re_key', STAGING);
  const result = await client.emails.send(
    {
      from: 'x@staging.example',
      to: ['owner@example.com', 'customer@gmail.com'],
      cc: 'cc@gmail.com',
      bcc: ['qa@tests.example'],
      subject: 's',
      text: 't',
    },
    { idempotencyKey: 'k1' },
  );
  assert.equal(result.data?.id, 'real-1');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].payload, {
    from: 'x@staging.example',
    to: ['owner@example.com'],
    cc: [],
    bcc: ['qa@tests.example'],
    subject: 's',
    text: 't',
  });
  assert.deepEqual(sent[0].options, { idempotencyKey: 'k1' });
});

test('staging with no allowlisted recipient skips the send and reports success', async () => {
  sent.length = 0;
  const client = createResend('re_key', STAGING);
  const result = await client.emails.send({ from: 'x@y.z', to: 'customer@gmail.com', cc: 'owner@example.com', subject: 's', text: 't' });
  assert.equal(sent.length, 0, 'cc alone never carries a send');
  assert.equal(result.error, null);
  assert.ok(result.data?.id.startsWith(SKIPPED_ID_PREFIX));
});

test('an empty allowlist in staging sends nothing at all', async () => {
  sent.length = 0;
  const client = createResend('re_key', { APP_ENV: 'staging' });
  await client.emails.send({ from: 'x@y.z', to: 'owner@example.com', subject: 's', text: 't' });
  assert.equal(sent.length, 0);
});

test('staging batch keeps positions: skipped emails get ids in place', async () => {
  sent.length = 0;
  const client = createResend('re_key', STAGING);
  const result = await client.batch.send([
    { from: 'x@y.z', to: 'customer@gmail.com', subject: '1', text: '1' },
    { from: 'x@y.z', to: 'owner@example.com', subject: '2', text: '2' },
    { from: 'x@y.z', to: 'b@tests.example', subject: '3', text: '3' },
  ]);
  assert.equal(sent.length, 1);
  assert.deepEqual((sent[0].payload as { subject: string }[]).map((p) => p.subject), ['2', '3']);
  const ids = result.data?.data.map((d) => d.id) ?? [];
  assert.equal(ids.length, 3);
  assert.ok(ids[0].startsWith(SKIPPED_ID_PREFIX));
  assert.deepEqual(ids.slice(1), ['real-0', 'real-1']);

  sent.length = 0;
  const none = await client.batch.send([{ from: 'x@y.z', to: 'customer@gmail.com', subject: '1', text: '1' }]);
  assert.equal(sent.length, 0);
  assert.equal(none.error, null);
  assert.ok(none.data?.data[0].id.startsWith(SKIPPED_ID_PREFIX));
});

test('filterRecipients leaves cc/bcc absent when the payload had none', () => {
  assert.deepEqual(filterRecipients({ to: 'owner@example.com' }, ['owner@example.com']), { to: ['owner@example.com'] });
  assert.equal(filterRecipients({ to: 'x@gmail.com' }, ['owner@example.com']), null);
});

// The factory only protects staging if nothing goes around it.
test('isPlausibleAddress refuses typo endings, keeps real addresses', () => {
  for (const ok of [
    'a@me.com',
    'First Last <a.b+tag@mail.example.co.uk>',
    'a@tests.example',
    'a@xn--bcher-kva.xn--p1ai',
    '  a@gmail.com  ',
  ]) assert.equal(isPlausibleAddress(ok), true, ok);
  for (const bad of ['a@me.com.x', 'a@localhost', 'a@me.c', 'a@me..com', 'a@-me.com', 'me.com', 'a b@me.com', '', null, 'Name <a@me.com.x>']) {
    assert.equal(isPlausibleAddress(bad), false, String(bad));
  }
});

test('production: an invalid only recipient never reaches Resend and never alerts', async () => {
  sent.length = 0;
  const reports: unknown[] = [];
  const client = createResend('re_key', {}, async (f) => void reports.push(f)) as unknown as FakeResend;
  const result = (await client.emails.send({ from: 'a@b.co', to: 'typo@me.com.x', subject: 's' })) as {
    data: unknown;
    error: { name: string; message: string } | null;
  };
  assert.equal(sent.length, 0);
  assert.equal(result.data, null);
  assert.equal(result.error?.name, 'invalid_recipient');
  assert.match(result.error!.message, /^[a-z0-9_.:\- ]+$/i);
  await new Promise((r) => setImmediate(r));
  assert.equal(reports.length, 0);
});

test('production: invalid cc is dropped, the rest is sent', async () => {
  sent.length = 0;
  const client = createResend('re_key', {}) as unknown as FakeResend;
  await client.emails.send({ from: 'a@b.co', to: ['ok@gmail.com', 'bad@me.com.x'], cc: 'bad@x', subject: 's' });
  assert.deepEqual(sent[0].payload, { from: 'a@b.co', to: ['ok@gmail.com'], cc: [], subject: 's' });
});

test('production batch keeps positions when one email has an invalid recipient', async () => {
  sent.length = 0;
  const client = createResend('re_key', {}) as unknown as FakeResend;
  const result = (await client.batch.send([
    { from: 'a@b.co', to: 'one@gmail.com', subject: '1' },
    { from: 'a@b.co', to: 'two@me.com.x', subject: '2' },
    { from: 'a@b.co', to: 'three@gmail.com', subject: '3' },
  ])) as { data: { data: Array<{ id: string }> } };
  assert.equal((sent[0].payload as unknown[]).length, 2);
  const ids = result.data.data.map((d) => d.id);
  assert.equal(ids[0], 'real-0');
  assert.ok(ids[1].startsWith(INVALID_RECIPIENT_ID_PREFIX));
  assert.equal(ids[2], 'real-1');
});

test('no file in apps/web constructs a Resend client outside the factory', () => {
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const factory = path.join(webRoot, 'src/lib/email/resend.ts');
  const skip = new Set(['node_modules', '.next', '.next-compat', '.vercel', 'public']);
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(m?[jt]sx?)$/.test(name) || /\.test\.[mc]?[jt]sx?$/.test(name) || full === factory) continue;
      if (/new\s+Resend\s*\(/.test(readFileSync(full, 'utf8'))) offenders.push(path.relative(webRoot, full));
    }
  };
  for (const top of ['app', 'components', 'src', 'scripts', 'proxy.ts', 'next.config.js']) {
    const full = path.join(webRoot, top);
    if (statSync(full).isDirectory()) walk(full);
    else if (/new\s+Resend\s*\(/.test(readFileSync(full, 'utf8'))) offenders.push(top);
  }
  assert.deepEqual(offenders, [], 'use createResend() from src/lib/email/resend.ts');
});
