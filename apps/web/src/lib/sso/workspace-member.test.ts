import test from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import { addWorkspaceMemberVia } from './workspace-member.ts';
import { clientIpFromHeaders, recordSsoAuditVia } from './audit.ts';

function fakeService(rpcError: { code?: string; message: string } | null, insertError: { message: string } | null = null) {
  const calls: Array<{ fn: string; args: unknown; self: unknown }> = [];
  const inserts: Array<{ table: string; row: unknown }> = [];
  const service = {
    rpc(fn: string, args: unknown) {
      calls.push({ fn, args, self: this });
      return Promise.resolve({ data: null, error: rpcError });
    },
    from(table: string) {
      return {
        insert: (row: unknown) => {
          inserts.push({ table, row });
          return Promise.resolve({ error: insertError });
        },
      };
    },
  };
  return { service: service as unknown as SupabaseClient<Database>, raw: service, calls, inserts };
}

const ARGS = { workspaceId: 'ws-1', userId: 'user-1', role: 'member' as const, source: 'sso' as const };

test('calls the team-tier contract with its exact argument names, bound to the client', async () => {
  const { service, raw, calls } = fakeService(null);
  assert.deepEqual(await addWorkspaceMemberVia(service)(ARGS), { ok: true });
  assert.deepEqual(calls.map(({ fn, args }) => ({ fn, args })), [{
    fn: 'add_workspace_member',
    args: { p_workspace_id: 'ws-1', p_user_id: 'user-1', p_role: 'member', p_source: 'sso' },
  }]);
  assert.equal(calls[0].self, raw);
});

test('a missing function reads as contract_missing', async () => {
  for (const code of ['PGRST202', '42883']) {
    const { service } = fakeService({ code, message: 'Could not find the function' });
    const result = await addWorkspaceMemberVia(service)(ARGS);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'contract_missing', code);
  }
});

test('any other error is a refusal (seat cap, deleted workspace)', async () => {
  const { service } = fakeService({ code: 'P0001', message: 'seat limit reached' });
  assert.deepEqual(await addWorkspaceMemberVia(service)(ARGS), { ok: false, reason: 'refused', message: 'seat limit reached' });
});

test('audit rows go to activity_log with no api key, no inbox and no address', async () => {
  const { service, inserts } = fakeService(null);
  await recordSsoAuditVia(service)({
    workspaceId: 'ws-1', event: 'sso.jit_join', status: 'error', errorCode: 'contract_missing',
    ipAddress: '203.0.113.7', userAgent: 'ua',
  });
  assert.deepEqual(inserts, [{
    table: 'activity_log',
    row: {
      workspace_id: 'ws-1', tool_name: 'sso.jit_join', status: 'error', error_code: 'contract_missing',
      ip_address: '203.0.113.7', user_agent: 'ua',
    },
  }]);
});

test('a failed audit insert never throws', async () => {
  const { service } = fakeService(null, { message: 'partition missing' });
  await recordSsoAuditVia(service)({ workspaceId: 'ws-1', event: 'sso.sign_in', status: 'success' });
});

test('client IP: first forwarded hop, garbage dropped', () => {
  assert.equal(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })), '203.0.113.7');
  assert.equal(clientIpFromHeaders(new Headers({ 'x-real-ip': '2001:db8::1' })), '2001:db8::1');
  assert.equal(clientIpFromHeaders(new Headers({ 'x-forwarded-for': 'not an ip' })), null);
  assert.equal(clientIpFromHeaders(new Headers()), null);
});
