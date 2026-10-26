import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NO_CALL_HELP_MS,
  NO_HANDSHAKE_HELP_MS,
  ONBOARDING_KEY_SCOPES,
  RECONNECT_HELP_MS,
  addToAiDone,
  canDraftWith,
  clientKind,
  configSnippet,
  curlFirstCall,
  docsPath,
  failureKey,
  helpTiers,
  isPhone,
  ladderState,
  openClientHref,
  promptKeys,
  successKey,
  usesApiKey,
  visibleFailure,
} from './connect-steps.mjs';
import { ACCESS_PRESETS } from '../oauth/consent-presets.ts';
import {
  assistEvent,
  helpStepsEmail,
  morningBriefEmail,
  onboardingText,
  setupLinkEmail,
  tomorrowAtEight,
  validTimeZone,
} from './assist.ts';

const T0 = Date.parse('2026-10-26T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

test('the auto-created key uses the Standard consent preset', () => {
  const standard = ACCESS_PRESETS.find((p) => p.id === 'standard');
  assert.deepEqual([...ONBOARDING_KEY_SCOPES].sort(), [...(standard?.scopes ?? [])].sort());
});

test('client kinds pick the prompt wording', () => {
  assert.equal(clientKind('chatgpt'), 'chatgpt');
  assert.equal(clientKind('claude'), 'chat');
  assert.equal(clientKind('raycast'), 'chat');
  assert.equal(clientKind('cursor'), 'code');
  assert.equal(clientKind('claude_code'), 'code');
  assert.equal(clientKind('curl'), 'api');
  assert.ok(usesApiKey('cline') && usesApiKey('jetbrains') && usesApiKey('curl'));
  assert.ok(!usesApiKey('claude') && !usesApiKey('cursor'));
});

test('prompts: ChatGPT and Claude say "Using MCPEmails,", coding clients name the tools, read-only keys never get a draft prompt', () => {
  const chat = promptKeys('chatgpt');
  assert.equal(chat.replyRadar, 'prompts.replyRadar.chat');
  assert.equal(chat.draftReplies, 'prompts.draftReplies.drafts');
  assert.ok(onboardingText('en', chat.replyRadar!).startsWith('Using MCPEmails,'));
  const code = promptKeys('cursor');
  assert.ok(onboardingText('en', code.replyRadar!).startsWith('Use the MCPEmails tools to'));
  assert.equal(code.draftReplies, null);
  const readOnly = promptKeys('claude', { canDraft: false });
  assert.equal(readOnly.draftReplies, 'prompts.draftReplies.readOnly');
  assert.ok(!/draft/i.test(onboardingText('en', readOnly.draftReplies!)));
  assert.deepEqual(promptKeys('curl'), { replyRadar: null, draftReplies: null, morningBrief: null });
  assert.equal(canDraftWith(['read:email', 'search:email']), false);
  assert.equal(canDraftWith(['read:email', 'manage:drafts']), true);
  assert.equal(canDraftWith(null), true);
  for (const key of ['prompts.replyRadar.chat', 'prompts.draftReplies.drafts', 'prompts.morningBrief.chat']) {
    assert.match(onboardingText('en', key), /Don't (send|change)/, key);
  }
});

test('the ladder: waiting, then connected and asking, then works', () => {
  assert.deepEqual(ladderState(null), { rung: 0, connected: false, works: false });
  assert.deepEqual(ladderState({ handshake: { at: iso(T0) } }), { rung: 2, connected: true, works: false });
  assert.deepEqual(ladderState({ handshake: { at: null }, firstCall: { at: iso(T0) } }), { rung: 3, connected: true, works: true });
});

test('timed help opens at 90 s without a handshake, 60 s after a handshake, and 10 min overall', () => {
  const start = T0;
  const none = { handshake: { at: null }, firstCall: { at: null } };
  assert.deepEqual(helpTiers(none, { waitStartedAtMs: start, nowMs: start + NO_HANDSHAKE_HELP_MS - 1 }), []);
  assert.deepEqual(helpTiers(none, { waitStartedAtMs: start, nowMs: start + NO_HANDSHAKE_HELP_MS }), ['no_handshake']);
  const shook = { handshake: { at: iso(start + 30_000) }, firstCall: { at: null } };
  assert.deepEqual(helpTiers(shook, { waitStartedAtMs: start, nowMs: start + 30_000 + NO_CALL_HELP_MS - 1 }), []);
  assert.deepEqual(helpTiers(shook, { waitStartedAtMs: start, nowMs: start + 30_000 + NO_CALL_HELP_MS }), ['no_call']);
  // A handshake from before the wait started counts from the wait start.
  const old = { handshake: { at: iso(start - 3_600_000) }, firstCall: { at: null } };
  assert.deepEqual(helpTiers(old, { waitStartedAtMs: start, nowMs: start + 10_000 }), []);
  assert.deepEqual(helpTiers(none, { waitStartedAtMs: start, nowMs: start + RECONNECT_HELP_MS }), ['no_handshake', 'reconnect']);
  assert.deepEqual(helpTiers({ ...shook, firstCall: { at: iso(start + 40_000) } }, { waitStartedAtMs: start, nowMs: start + RECONNECT_HELP_MS }), []);
});

test('a failed call shows in plain words until a success follows it', () => {
  const failure = { at: iso(T0 + 5_000), tool: 'email_search', code: 'search_timeout' };
  assert.equal(visibleFailure({ lastFailure: failure }, T0)?.code, 'search_timeout');
  assert.equal(visibleFailure({ lastFailure: failure, firstCall: { at: iso(T0 + 9_000) } }, T0), null);
  assert.equal(visibleFailure({ lastFailure: { ...failure, at: iso(T0 - 600_000) } }, T0), null);
  assert.equal(failureKey('search_timeout'), 'failure.timeout');
  assert.equal(failureKey('auth_failed'), 'failure.auth');
  assert.equal(failureKey('-32004'), 'failure.scope');
  assert.equal(failureKey('something_new'), 'failure.generic');
});

test('success names what happened', () => {
  assert.equal(successKey('email_read'), 'steps.it_works.success.read');
  assert.equal(successKey('email_search'), 'steps.it_works.success.search');
  assert.equal(successKey('draft_reply'), 'steps.it_works.success.draft');
  assert.equal(successKey('email_move'), 'steps.it_works.success.organize');
  assert.equal(successKey(null), 'steps.it_works.success.generic');
  assert.equal(onboardingText('en', successKey('email_read'), { client: 'Claude' }), 'Claude just read your inbox.');
});

test('add to AI moves on only for signals newer than the step', () => {
  const opened = T0;
  const grant = { credential: { sinceReset: true, latestAt: iso(T0 + 1000) }, handshake: { at: null } };
  assert.equal(addToAiDone(grant, { client: 'claude', openedAtMs: opened }), true);
  assert.equal(addToAiDone({ credential: { sinceReset: true, latestAt: iso(T0 - 1000) }, handshake: { at: null } }, { client: 'claude', openedAtMs: opened }), false);
  // An API-key client's own new key is not "connected"; its handshake is.
  assert.equal(addToAiDone(grant, { client: 'cline', openedAtMs: opened }), false);
  assert.equal(addToAiDone({ handshake: { at: iso(T0 + 1000) } }, { client: 'cline', openedAtMs: opened }), true);
});

test('links, configs and the curl request point at the given URL', () => {
  const url = 'https://mcpemails.com/api/mcp';
  assert.equal(openClientHref('claude'), 'https://claude.ai/new');
  assert.equal(openClientHref('cursor'), null);
  assert.equal(docsPath('claude_code'), '/docs/claude-code');
  assert.equal(docsPath('gemini'), '/docs/gemini-cli');
  assert.equal(JSON.parse(configSnippet('windsurf', url)!.text).mcpServers.mcpemails.serverUrl, url);
  assert.equal(JSON.parse(configSnippet('zed', url)!.text).context_servers.mcpemails.url, url);
  assert.equal(configSnippet('raycast', url), null);
  const curl = curlFirstCall(url, 'mcpe_abc');
  const target = new URL(curl.split(/\s+/)[3]);
  assert.equal(target.host, 'mcpemails.com');
  assert.equal(target.pathname, '/api/mcp');
  assert.ok(curl.includes('Bearer mcpe_abc') && curl.includes('"email_read"'));
  assert.ok(isPhone('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'));
  assert.ok(!isPhone('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15'));
});

test('tomorrow at 8 is 08:00 local the next day, across DST', () => {
  // 2026-10-26 12:00 UTC: Oslo is UTC+1 (DST ended 10-25), New York UTC-4.
  assert.equal(tomorrowAtEight(T0, 'Europe/Oslo').toISOString(), '2026-10-27T07:00:00.000Z');
  assert.equal(tomorrowAtEight(T0, 'America/New_York').toISOString(), '2026-10-27T12:00:00.000Z');
  assert.equal(tomorrowAtEight(T0, 'UTC').toISOString(), '2026-10-27T08:00:00.000Z');
  // 21:00 on the 26th in Tokyo: tomorrow 08:00 JST is 23:00 UTC the same day.
  assert.equal(tomorrowAtEight(T0, 'Asia/Tokyo').toISOString(), '2026-10-26T23:00:00.000Z');
  // 01:00 on the 27th in Tokyo: tomorrow is the 28th there.
  assert.equal(tomorrowAtEight(Date.parse('2026-10-26T16:00:00Z'), 'Asia/Tokyo').toISOString(), '2026-10-27T23:00:00.000Z');
  // The night before New York's DST end (2026-11-01).
  assert.equal(tomorrowAtEight(Date.parse('2026-10-31T20:00:00Z'), 'America/New_York').toISOString(), '2026-11-01T13:00:00.000Z');
  assert.equal(validTimeZone('Not/AZone'), null);
  assert.equal(validTimeZone('Europe/Oslo'), 'Europe/Oslo');
});

test('assist events accept only the closed lists', () => {
  assert.deepEqual(assistEvent({ event: 'help_shown', tier: 'no_call' }), { stage: 'onboarding_help_shown', category: 'help_no_call' });
  assert.deepEqual(assistEvent({ event: 'prompt_copied', prompt: 'morning_brief' }), { stage: 'onboarding_prompt_copied', category: 'prompt_morning_brief' });
  assert.deepEqual(assistEvent({ event: 'open_client_clicked', client: 'claude' }), { stage: 'onboarding_open_client_clicked', category: 'claude' });
  assert.deepEqual(assistEvent({ event: 'handshake_seen', client: 'nope' }), { stage: 'onboarding_handshake_seen', category: 'unknown' });
  assert.equal(assistEvent({ event: 'help_shown', tier: 'drop table' }), null);
  assert.equal(assistEvent({ event: 'open_client_clicked', client: 'evil' }), null);
  assert.equal(assistEvent({ event: 'other' }), null);
});

test('service emails: the right link, the prompt, the client, every locale', () => {
  const app = 'https://mcpemails.com';
  const link = setupLinkEmail('en', 'cursor', app);
  const resume = new URL(link.text.split('\n').find((line) => line.startsWith('https://')) ?? '');
  assert.equal(resume.host, 'mcpemails.com');
  assert.equal(resume.pathname, '/onboarding');
  assert.equal(resume.searchParams.get('step'), 'add_to_ai');
  assert.equal(resume.searchParams.get('client'), 'cursor');
  assert.ok(link.text.includes('Cursor'));
  const help = helpStepsEmail('nb', 'claude', app);
  assert.ok(help.subject.includes('Claude'));
  const guide = help.text.split('\n').filter((line) => line.startsWith('https://')).map((line) => new URL(line));
  assert.ok(guide.some((u) => u.host === 'mcpemails.com' && u.pathname === '/docs/claude'));
  const morning = morningBriefEmail('de', 'chatgpt');
  assert.ok(morning.text.includes('MCPEmails'));
  assert.notEqual(morning.subject, morningBriefEmail('en', 'chatgpt').subject);
  for (const locale of ['en', 'de', 'fr', 'es', 'nb', 'zh'] as const) {
    for (const mail of [setupLinkEmail(locale, 'claude', app), helpStepsEmail(locale, 'vscode', app), morningBriefEmail(locale, 'claude')]) {
      assert.ok(!mail.text.includes('{'), `${locale}: every placeholder filled`);
      assert.ok(!mail.text.includes('—'), `${locale}: no em dash`);
      assert.ok(!/\$\d/.test(mail.text), `${locale}: never a price`);
    }
  }
  // HTML escapes what it interpolates.
  assert.ok(!setupLinkEmail('en', 'claude', 'https://x.test/"><script>').html.includes('<script>'));
});
