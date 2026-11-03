// A refused Resend send must reach the owner: createResend reports every error
// answer or throw (src/lib/email/resend-failure-alert.ts), the system-notify
// template renders it, and every lifecycle send sets a reply-to so moving the
// From to a sending-only subdomain cannot bounce replies.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

let nextAnswer: () => Promise<unknown> = async () => ({ data: { id: 'ok' }, error: null, headers: null });

class FakeResend {
  emails = { send: async () => nextAnswer() };
  batch = { send: async () => nextAnswer() };
}

mock.module('resend', { namedExports: { Resend: FakeResend } });

const { createResend } = await import('./resend.ts');
const { fromDomain, maskAddresses, shouldAlert } = await import('./resend-failure-alert.ts');
const { renderEmailSendFailedEmail } = await import('../../../../../supabase/functions/system-notify/email-send-failed.ts');

type Failure = Parameters<typeof shouldAlert>[0];

function collector() {
  const reports: Failure[] = [];
  return { reports, report: async (f: Failure) => void reports.push(f) };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('an unverified-domain answer is reported and passed back unchanged', async () => {
  const { reports, report } = collector();
  const refusal = { name: 'validation_error', statusCode: 403, message: 'The updates.mcpemails.com domain is not verified.' };
  nextAnswer = async () => ({ data: null, error: refusal, headers: null });
  const client = createResend('re_key', {}, report);
  const result = await client.emails.send({ from: 'Asgeir <asgeir@updates.mcpemails.com>', to: 'c@gmail.com', subject: 's', text: 't' });
  await tick();
  assert.deepEqual(result.error, refusal);
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0], { kind: 'one', from: 'updates.mcpemails.com', count: 1, name: 'validation_error', statusCode: 403, message: refusal.message });
});

test('a thrown send is reported and still throws', async () => {
  const { reports, report } = collector();
  nextAnswer = async () => {
    throw new Error('fetch failed');
  };
  const client = createResend('re_key', {}, report);
  await assert.rejects(client.emails.send({ from: 'a@mcpemails.com', to: 'c@gmail.com', subject: 's', text: 't' }), /fetch failed/);
  await tick();
  assert.equal(reports[0].name, 'Error');
  assert.equal(reports[0].from, 'mcpemails.com');
});

test('a refused batch is reported with its size, in staging too', async () => {
  const { reports, report } = collector();
  nextAnswer = async () => ({ data: null, error: { name: 'daily_quota_exceeded', statusCode: 429, message: 'quota' }, headers: null });
  const client = createResend('re_key', { APP_ENV: 'staging', EMAIL_RECIPIENT_ALLOWLIST: '@tests.example' }, report);
  const emails = [1, 2].map((i) => ({ from: 'x@staging.mcpemails.com', to: `p${i}@tests.example`, subject: 's', text: 't' }));
  await client.batch.send(emails);
  await tick();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].kind, 'batch');
  assert.equal(reports[0].count, 2);
});

test('a successful send reports nothing', async () => {
  const { reports, report } = collector();
  nextAnswer = async () => ({ data: { id: 'ok' }, error: null, headers: null });
  await createResend('re_key', {}, report).emails.send({ from: 'a@mcpemails.com', to: 'c@gmail.com', subject: 's', text: 't' });
  await tick();
  assert.equal(reports.length, 0);
});

test('a reporter that throws never breaks the send', async () => {
  nextAnswer = async () => ({ data: null, error: { name: 'validation_error', message: 'x' }, headers: null });
  const client = createResend('re_key', {}, async () => {
    throw new Error('alert down');
  });
  const result = await client.emails.send({ from: 'a@mcpemails.com', to: 'c@gmail.com', subject: 's', text: 't' });
  await tick();
  assert.equal(result.error?.message, 'x');
});

test('addresses are masked to their domain; From domains parse', () => {
  assert.equal(maskAddresses('Invalid `to` field: jane.doe@gmail.com, <x@y.no>'), 'Invalid `to` field: *@gmail.com, <*@y.no>');
  assert.equal(fromDomain('Asgeir Albretsen <asgeir@updates.mcpemails.com>'), 'updates.mcpemails.com');
  assert.equal(fromDomain('hello@MCPEmails.com'), 'mcpemails.com');
  assert.equal(fromDomain(undefined), null);
});

test('alerts: one per sender + error per hour, never for a rate limit', () => {
  const seen = new Map<string, number>();
  const f: Failure = { kind: 'one', from: 'mcpemails.com', name: 'validation_error', statusCode: 403, message: 'm', count: 1 };
  assert.equal(shouldAlert(f, 0, seen), true);
  assert.equal(shouldAlert(f, 30 * 60_000, seen), false);
  assert.equal(shouldAlert({ ...f, from: 'updates.mcpemails.com' }, 30 * 60_000, seen), true);
  assert.equal(shouldAlert(f, 61 * 60_000, seen), true);
  assert.equal(shouldAlert({ ...f, name: 'rate_limit_exceeded' }, 0, new Map()), false);
});

test('the system-notify email names the domain, error and environment', () => {
  const email = renderEmailSendFailedEmail({
    from_domain: 'updates.mcpemails.com',
    error_name: 'validation_error',
    status_code: 403,
    message: 'The updates.mcpemails.com domain is not verified.',
    kind: 'one',
    count: 1,
    app_env: 'staging',
  });
  assert.equal(email.subject, 'Resend refused mail from updates.mcpemails.com: validation_error [staging]');
  assert.match(email.body, /status 403/);
  assert.match(email.body, /not verified/);
});

test('every lifecycle send sets a reply-to next to its From', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.test\./.test(name)) {
        const lines = readFileSync(full, 'utf8').split('\n');
        lines.forEach((line, i) => {
          if (!/from: lifecycleFrom\(\)/.test(line)) return;
          const near = lines.slice(Math.max(0, i - 3), i + 4).join('\n');
          if (!/replyTo/.test(near)) offenders.push(`${path.relative(root, full)}:${i + 1}`);
        });
      }
    }
  };
  for (const dir of ['app', 'src', 'scripts']) walk(path.join(root, dir));
  assert.deepEqual(offenders, [], 'add replyTo: lifecycleReplyTo() so replies never go to a sending-only domain');
});
