import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SSO_REQUIRED_REASON,
  isSsoRequiredError,
  ssoSignInRequired,
  type SsoEnforcementRpc,
} from './enforcement.ts';

// Only reserved example domains.

function fakeRpc(result: { data: unknown; error: { message: string } | null } | Error) {
  const calls: Array<{ fn: string; args: unknown }> = [];
  const rpc: SsoEnforcementRpc = (fn, args) => {
    calls.push({ fn, args });
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  };
  return { rpc, calls };
}

test('an enforced address is reported, normalised before the lookup', async () => {
  const { rpc, calls } = fakeRpc({ data: true, error: null });
  assert.equal(await ssoSignInRequired(rpc, ' Staff@Enforced-SSO.Example '), true);
  assert.deepEqual(calls, [{ fn: 'sso_sign_in_required', args: { p_email: 'staff@enforced-sso.example' } }]);
});

test('a domain that is not enforced is not reported', async () => {
  const { rpc } = fakeRpc({ data: false, error: null });
  assert.equal(await ssoSignInRequired(rpc, 'staff@open-sso.example'), false);
});

test('only a literal true counts', async () => {
  for (const data of [null, 'true', 1, {}]) {
    const { rpc } = fakeRpc({ data, error: null });
    assert.equal(await ssoSignInRequired(rpc, 'staff@enforced-sso.example'), false, JSON.stringify(data));
  }
});

test('consumer, invalid and missing addresses never reach the database', async () => {
  const { rpc, calls } = fakeRpc({ data: true, error: null });
  assert.equal(await ssoSignInRequired(rpc, 'person@gmail.com'), false);
  assert.equal(await ssoSignInRequired(rpc, 'not an email'), false);
  assert.equal(await ssoSignInRequired(rpc, undefined), false);
  assert.equal(await ssoSignInRequired(rpc, ''), false);
  assert.equal(calls.length, 0);
});

test('a lookup error fails open (the auth hook still enforces)', async () => {
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal(await ssoSignInRequired(fakeRpc({ data: true, error: { message: 'boom' } }).rpc, 'staff@enforced-sso.example'), false);
    assert.equal(await ssoSignInRequired(fakeRpc(new Error('network')).rpc, 'staff@enforced-sso.example'), false);
  } finally {
    console.error = original;
  }
});

test('the hook refusal is recognised from supabase-js errors and reason strings', () => {
  assert.equal(SSO_REQUIRED_REASON, 'sso_required');
  assert.equal(isSsoRequiredError({ message: 'sso_required' }), true);
  assert.equal(isSsoRequiredError({ message: 'Error running hook URI: sso_required' }), true);
  assert.equal(isSsoRequiredError('sso_required'), true);
  assert.equal(isSsoRequiredError({ message: 'Invalid login credentials' }), false);
  assert.equal(isSsoRequiredError({ message: 'microsoft_email_unverified' }), false);
  assert.equal(isSsoRequiredError(null), false);
  assert.equal(isSsoRequiredError({}), false);
});
