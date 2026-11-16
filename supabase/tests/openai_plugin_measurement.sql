-- ============================================================
-- OpenAI plugin measurement (20261116120000_openai_plugin_measurement.sql)
-- ============================================================
-- Proves:
--   1. openai_client_family names every OpenAI handshake name seen in
--      production, and settles codex-mcp-client by the key name (the same
--      cases as client-label.test.ts).
--   2. growth_client_family no longer files `openai-mcp (ChatGPT)` or Codex
--      under 'other'.
--   3. openai_plugin_daily counts a ChatGPT signup, an OpenAI OAuth install
--      and an OpenAI call with its error, and returns one row per day.
--   4. The three RPCs are service role only.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(22);

-- ── 1. openai_client_family ────────────────────────────────────────────────
SELECT is(public.openai_client_family('openai-mcp', NULL), 'chatgpt', 'openai-mcp is ChatGPT');
SELECT is(public.openai_client_family('openai-mcp (ChatGPT)', NULL), 'chatgpt', 'openai-mcp (ChatGPT) is ChatGPT');
SELECT is(public.openai_client_family('openai-mcp (Codex)', NULL), 'codex', 'openai-mcp (Codex) is Codex');
SELECT is(public.openai_client_family('Codex', NULL), 'codex', 'Codex is Codex');
SELECT is(public.openai_client_family('codex-config-check', NULL), 'codex', 'codex-config-check is Codex');
SELECT is(public.openai_client_family('codex-mcp-client', 'OAuth: ChatGPT'), 'chatgpt', 'codex-mcp-client on a ChatGPT OAuth key is ChatGPT');
SELECT is(public.openai_client_family('codex-mcp-client', 'OAuth: Codex'), 'codex', 'codex-mcp-client on a Codex OAuth key is Codex');
SELECT is(public.openai_client_family('codex-mcp-client', 'My laptop key'), 'codex', 'codex-mcp-client on a pasted key is Codex');
SELECT is(public.openai_client_family(NULL, 'OAuth: chatgpt.com (2)'), 'chatgpt', 'an OpenAI OAuth key name alone is enough');
SELECT is(public.openai_client_family('claude-ai', 'OAuth: Claude'), NULL, 'Claude is not OpenAI');

-- ── 2. growth_client_family ────────────────────────────────────────────────
SELECT is(public.growth_client_family('openai-mcp (ChatGPT)'), 'chatgpt', 'growth family: openai-mcp (ChatGPT)');
SELECT is(public.growth_client_family('Codex'), 'codex', 'growth family: Codex');
SELECT is(public.growth_client_family('claude-code'), 'claude_code', 'growth family: Claude Code unchanged');
SELECT is(public.growth_client_family('cursor-vscode'), 'other', 'growth family: others unchanged');

-- ── 3. The daily read-out ──────────────────────────────────────────────────
INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('9f000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'openai-plugin@rls-test.invalid', 'x', now(), now(), now(),
   '{"provider":"email","providers":["email"]}', '{}');

CREATE TEMP TABLE o_ids ON COMMIT DROP AS
SELECT (SELECT id FROM public.workspaces WHERE owner_id = '9f000000-0000-0000-0000-000000000001') AS ws;
GRANT SELECT ON o_ids TO anon, authenticated, service_role;

UPDATE public.workspaces SET acquisition_source = 'chatgpt_directory' WHERE id = (SELECT ws FROM o_ids);

INSERT INTO public.api_keys (id, workspace_id, created_by, name, key_prefix, key_hash, scopes)
VALUES ('9f0000b0-0000-0000-0000-000000000001', (SELECT ws FROM o_ids),
        '9f000000-0000-0000-0000-000000000001', 'OAuth: ChatGPT', 'mcpe_test', 'openai-plugin-hash', '{manage:drafts}');

INSERT INTO public.activity_log (workspace_id, api_key_id, tool_name, status, error_code) VALUES
  ((SELECT ws FROM o_ids), '9f0000b0-0000-0000-0000-000000000001', 'email_read', 'success', NULL),
  ((SELECT ws FROM o_ids), '9f0000b0-0000-0000-0000-000000000001', 'email_read', 'error', NULL);

SET LOCAL ROLE service_role;

SELECT is((SELECT count(*)::int FROM public.openai_plugin_daily(7)), 7, '[rpc] one row per day');
SELECT ok((SELECT chatgpt_signups FROM public.openai_plugin_daily(1)) >= 1, '[rpc] a ChatGPT directory signup counts');
SELECT ok((SELECT installs FROM public.openai_plugin_daily(1)) >= 1, '[rpc] an OpenAI OAuth key counts as an install');
SELECT ok((SELECT openai_errors FROM public.openai_plugin_daily(1)) >= 1
          AND (SELECT openai_calls FROM public.openai_plugin_daily(1)) >= 2, '[rpc] OpenAI calls and errors count');
SELECT ok((SELECT openai_active FROM public.openai_plugin_window(now() - interval '1 hour', now() + interval '1 hour')) >= 1,
          '[rpc] the window counts the OpenAI workspace');

RESET ROLE;

-- ── 4. Grants ──────────────────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO
  '{"sub":"9f000000-0000-0000-0000-000000000001","role":"authenticated"}';
SELECT throws_ok($$SELECT * FROM public.openai_plugin_daily(7)$$, '42501', NULL, '[grant] authenticated cannot call openai_plugin_daily');
SELECT throws_ok($$SELECT * FROM public.openai_plugin_window(now() - interval '1 day', now())$$, '42501', NULL, '[grant] authenticated cannot call openai_plugin_window');
SELECT throws_ok($$SELECT * FROM public.openai_api_keys()$$, '42501', NULL, '[grant] authenticated cannot call openai_api_keys');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
