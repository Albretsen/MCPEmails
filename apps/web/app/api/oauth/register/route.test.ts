// ---------------------------------------------------------------------------
// POST /api/oauth/register (RFC 7591 dynamic client registration), through the
// exported handler.
//
// Stubbed: the service-role Supabase client (records inserts), the rate
// limiter, and DNS (so an https redirect resolves to a fixed public address
// without leaving the process). The redirect validation and the impersonation
// flag run for real.
//
// Run: npm run test:oauth-register (from apps/web).
// Attacker hosts use reserved example domains only.
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const nodeMock = mock as unknown as {
  module: (
    specifier: string,
    options: { namedExports?: Record<string, unknown>; defaultExport?: unknown },
  ) => void;
};

type Row = Record<string, unknown>;
const inserts: Record<string, Row[]> = {};

function fakeServiceClient() {
  return {
    from(table: string) {
      return {
        insert: (row: Row) => {
          (inserts[table] ??= []).push(row);
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };
}

const PUBLIC_V4 = ['203.0.113.10'];
const dnsStub = {
  resolve4: async () => PUBLIC_V4,
  resolve6: async () => {
    throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
  },
};

nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: fakeServiceClient } });
nodeMock.module('@/lib/rate-limit', { namedExports: { checkRateLimit: async () => false } });
nodeMock.module('node:dns/promises', { defaultExport: dnsStub, namedExports: dnsStub });

const { POST } = await import('./route.ts');

function register(body: unknown) {
  return POST(
    new Request('https://mcpemails.test/api/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7' },
      body: JSON.stringify(body),
    }) as never,
  );
}

test.beforeEach(() => {
  for (const k of Object.keys(inserts)) delete inserts[k];
});

for (const uri of [
  "javascript:fetch('/api/api-keys',{method:'POST'})//",
  'JaVaScRiPt:alert(1)',
  ' javascript:alert(1)',
  'vbscript:msgbox(1)',
  'data:text/html,<script>alert(1)</script>',
  'file:///etc/passwd',
  'blob:https://mcpemails.com/0b7c2a1e',
  'about:blank',
  'microsoft-edge:https://attacker.example/cb',
  'x-safari-https://attacker.example/cb',
  'googlechromes://attacker.example/cb',
  'intent://attacker.example/cb#Intent;scheme=https;end',
  'web+mcp:https://attacker.example/cb',
]) {
  test(`refuses redirect_uri ${JSON.stringify(uri)} and stores nothing`, async () => {
    const res = await register({ client_name: 'x', redirect_uris: ['https://app.example/cb', uri] });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'invalid_redirect_uri');
    assert.equal(inserts.oauth_clients, undefined, 'no client row written');
  });
}

test('LEGIT: Claude on claude.ai registers, no impersonation flag', async () => {
  const res = await register({
    client_name: 'Claude',
    client_uri: 'https://claude.ai',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.match(body.client_id, /^dyn_[0-9a-f]{24}$/);
  assert.equal(body.client_name, 'Claude');
  assert.equal(inserts.oauth_clients.length, 1);
  assert.deepEqual(inserts.oauth_clients[0].redirect_uris, ['https://claude.ai/api/mcp/auth_callback']);
  const meta = inserts.auth_logs[0].metadata as Row;
  assert.equal(meta.name_imitates_vendor, undefined);
});

test('LEGIT: ChatGPT on chatgpt.com, Cursor on cursor://, VS Code on loopback all register', async () => {
  for (const [client_name, uri] of [
    ['ChatGPT', 'https://chatgpt.com/connector/oauth/abc_123'],
    ['Cursor', 'cursor://anysphere.cursor-mcp/oauth/callback'],
    ['Visual Studio Code', 'http://127.0.0.1:33418/'],
    ['Claude Code', 'http://localhost:54212/callback'],
    ['Windsurf', 'windsurf://codeium.windsurf/oauth'],
    ['Visual Studio Code - Insiders', 'vscode-insiders://vscode.github-authentication/did-authenticate'],
  ]) {
    const res = await register({ client_name, redirect_uris: [uri] });
    assert.equal(res.status, 201, `${client_name} ${uri}`);
    const meta = inserts.auth_logs.at(-1)!.metadata as Row;
    assert.equal(meta.name_imitates_vendor, undefined, client_name);
  }
});

test('an impersonating name with a foreign web redirect is registered but flagged in the audit log', async () => {
  const res = await register({
    client_name: 'Claude',
    client_uri: 'anthropic.com',
    redirect_uris: ['https://claude-connect.example/cb'],
  });
  assert.equal(res.status, 201);
  const meta = inserts.auth_logs[0].metadata as Row;
  assert.equal(meta.name_imitates_vendor, 'Claude (Anthropic)');
});

test('plain http off loopback is still refused', async () => {
  const res = await register({ client_name: 'x', redirect_uris: ['http://app.example/cb'] });
  assert.equal(res.status, 400);
});
