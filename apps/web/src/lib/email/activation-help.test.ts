/**
 * Tests for the activation help emails: every eligibility rule, the holdout,
 * once-only, suppression, locale fallback, and every E1 body key.
 *
 * NOTHING HERE TOUCHES A NETWORK OR SENDS MAIL. The store is in memory and
 * enforces the ledger's real keys the way ON CONFLICT DO NOTHING does; the
 * sender records what it was handed.
 *
 * Run:
 *   node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
 *     src/lib/email/activation-help.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeInstallHref, getInstallAction } from '../clients/install-links.mjs';
import { MCP_URL } from '../clients/mcp-url.mjs';

process.env.NEXT_PUBLIC_APP_URL = 'https://mcpemails.test';
delete process.env.RESEND_API_KEY;

const help = await import('@/lib/email/activation-help');
const templates = await import('@/lib/email/activation-help-templates');
const { POSTAL_ADDRESS_LINE } = await import('@/lib/email/legal');
const { hashUnit } = await import('@/lib/experiments/bucketing');

type Ctx = import('@/lib/email/activation-help').CandidateContext;
type ConnectionRow = import('@/lib/email/activation-help').ConnectionRow;
type ClaimRow = import('@/lib/email/activation-help').ClaimRow;
type OutgoingEmail = import('@/lib/email/activation-help').OutgoingEmail;
type Decision = import('@/lib/email/activation-help').Decision;

const { decide, connectionHelpKey, isHoldout, runActivationHelp, TEMPLATES } = help;

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = new Date('2026-11-10T12:00:00.000Z');
const ago = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();
const START = new Date('2026-11-01T00:00:00.000Z');
const CONFIG = { startAt: START };
const USER = '00000000-0000-4000-8000-0000000000aa';
const TOKEN = '11111111-2222-4333-8444-555555555555';

/** Workspace ids on each side of the holdout line, found rather than assumed. */
function findWorkspace(holdout: boolean, from = 0): string {
  for (let i = from; i < 10_000; i += 1) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    if (isHoldout(id) === holdout) return id;
  }
  throw new Error('no workspace id found');
}
const WS = findWorkspace(false);
const WS_HOLDOUT = findWorkspace(true);

function failure(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    outcome: 'failure',
    occurredAt: ago(2 * HOUR),
    category: 'yahoo',
    errorCategory: 'auth_failed',
    phase: 'authentication',
    authReason: 'account_password_used',
    ...overrides,
  };
}

function success(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    outcome: 'success',
    occurredAt: ago(5 * HOUR),
    category: 'gmail',
    errorCategory: null,
    phase: null,
    authReason: null,
    ...overrides,
  };
}

function ctx(
  overrides: Partial<Ctx> = {},
  workspace: Partial<NonNullable<Ctx['workspace']>> = {},
  owner: Partial<NonNullable<Ctx['owner']>> = {},
): Ctx {
  return {
    workspaceId: WS,
    workspace: {
      ownerId: USER,
      createdAt: ago(24 * HOUR),
      deletedAt: null,
      acquisitionLocale: 'en',
      onboardingClient: null,
      firstInboxConnectedAt: null,
      firstCredentialCreatedAt: null,
      firstToolUsedAt: null,
      ...workspace,
    },
    owner: {
      id: USER,
      email: 'owner@example.test',
      unsubscribedAt: null,
      unsubscribedCategories: [],
      unsubscribeToken: TOKEN,
      ...owner,
    },
    accountState: 'live',
    internal: false,
    connections: [failure()],
    firstLiveInboxAt: null,
    liveInboxCount: 0,
    calledEvent: false,
    credentialEvent: false,
    latestClientSelected: null,
    failureHost: null,
    ledger: [],
    ...overrides,
  };
}

/** A connected-but-idle workspace, 5 hours after its first connection. */
function idle(overrides: Partial<Ctx> = {}, workspace: Partial<NonNullable<Ctx['workspace']>> = {}): Ctx {
  return ctx(
    { connections: [success()], liveInboxCount: 1, firstLiveInboxAt: ago(5 * HOUR), ...overrides },
    { firstInboxConnectedAt: ago(5 * HOUR), ...workspace },
  );
}

function expectSkip(d: Decision, reason: string) {
  assert.equal(d.kind, 'skip', JSON.stringify(d));
  if (d.kind === 'skip') assert.equal(d.reason, reason);
}

// ---------------------------------------------------------------------------
// E1 triggers and timing
// ---------------------------------------------------------------------------

test('E1: latest failure, no success after, 2h old -> send connection_help', () => {
  const d = decide(ctx(), NOW, CONFIG);
  assert.equal(d.kind, 'send');
  if (d.kind === 'send') {
    assert.equal(d.email, 'connection_help');
    assert.equal(d.content.email, 'connection_help');
  }
});

test('E1: failure under 60 minutes old waits until the hour is up', () => {
  const d = decide(ctx({ connections: [failure({ occurredAt: ago(59 * MIN) })] }), NOW, CONFIG);
  assert.equal(d.kind, 'wait');
  if (d.kind === 'wait') assert.equal(d.dueAt, new Date(NOW.getTime() + MIN).toISOString());
  assert.equal(decide(ctx({ connections: [failure({ occurredAt: ago(60 * MIN) })] }), NOW, CONFIG).kind, 'send');
});

test('E1: failure 48 hours old or more is too late', () => {
  expectSkip(decide(ctx({ connections: [failure({ occurredAt: ago(48 * HOUR) })] }), NOW, CONFIG), 'too_late');
  assert.equal(decide(ctx({ connections: [failure({ occurredAt: ago(47 * HOUR) })] }), NOW, CONFIG).kind, 'send');
});

test('E1: a success after the last failure means no connection_help', () => {
  const d = decide(
    ctx({ connections: [failure({ occurredAt: ago(6 * HOUR) }), success({ occurredAt: ago(4 * HOUR) })] }),
    NOW,
    CONFIG,
  );
  assert.notEqual(d.kind === 'send' || d.kind === 'holdout' ? d.email : null, 'connection_help');
});

test('E1: the latest failure is the one that counts, earlier failures do not reset the clock', () => {
  const d = decide(
    ctx({ connections: [failure({ occurredAt: ago(30 * HOUR) }), failure({ occurredAt: ago(20 * MIN) })] }),
    NOW,
    CONFIG,
  );
  assert.equal(d.kind, 'wait');
});

test('E1: a live inbox means the person is connected, so no connection_help', () => {
  const d = decide(ctx({ liveInboxCount: 1, firstLiveInboxAt: ago(30 * HOUR) }), NOW, CONFIG);
  assert.ok(!(d.kind === 'send' && d.email === 'connection_help'));
});

test('a started row with no result does not trigger anything', () => {
  expectSkip(
    decide(ctx({ connections: [{ ...failure(), outcome: 'started' }] }), NOW, CONFIG),
    'not_triggered',
  );
});

// ---------------------------------------------------------------------------
// E2 triggers and timing
// ---------------------------------------------------------------------------

test('E2: connected 5h ago, no call -> send first_call_help', () => {
  const d = decide(idle(), NOW, CONFIG);
  assert.equal(d.kind, 'send');
  if (d.kind === 'send') assert.equal(d.email, 'first_call_help');
});

test('E2: waits until 3 hours after the FIRST connection', () => {
  const d = decide(
    idle({ connections: [success({ occurredAt: ago(2 * HOUR) })], firstLiveInboxAt: ago(2 * HOUR) }, { firstInboxConnectedAt: ago(2 * HOUR) }),
    NOW,
    CONFIG,
  );
  assert.equal(d.kind, 'wait');
  if (d.kind === 'wait') assert.equal(d.dueAt, new Date(NOW.getTime() + HOUR).toISOString());
});

test('E2: 72 hours after the first connection is too late, even with a newer success', () => {
  const d = decide(
    idle({ connections: [success({ occurredAt: ago(80 * HOUR) }), success({ occurredAt: ago(4 * HOUR) })] }, { firstInboxConnectedAt: ago(80 * HOUR) }),
    NOW,
    CONFIG,
  );
  expectSkip(d, 'too_late');
});

test('E2: a live inbox with no success row still counts as connected', () => {
  const d = decide(idle({ connections: [] }, { firstInboxConnectedAt: null }), NOW, CONFIG);
  assert.equal(d.kind, 'send');
});

test('a tool call (event or workspace marker) ends both emails', () => {
  expectSkip(decide(idle({ calledEvent: true }), NOW, CONFIG), 'already_called');
  expectSkip(decide(idle({}, { firstToolUsedAt: ago(HOUR) }), NOW, CONFIG), 'already_called');
  expectSkip(decide(ctx({ calledEvent: true }), NOW, CONFIG), 'already_called');
});

// ---------------------------------------------------------------------------
// Who never gets one
// ---------------------------------------------------------------------------

test('skips: missing or deleted workspace, missing owner, deleted account, internal', () => {
  expectSkip(decide(ctx({ workspace: null }), NOW, CONFIG), 'workspace_missing');
  expectSkip(decide(ctx({}, { deletedAt: ago(HOUR) }), NOW, CONFIG), 'workspace_deleted');
  expectSkip(decide(ctx({ owner: null }), NOW, CONFIG), 'owner_missing');
  expectSkip(decide(ctx({}, { ownerId: 'someone-else' }), NOW, CONFIG), 'owner_missing');
  expectSkip(decide(ctx({ accountState: 'deleted' }), NOW, CONFIG), 'account_deleted');
  expectSkip(decide(ctx({ accountState: 'unknown' }), NOW, CONFIG), 'account_unknown');
  expectSkip(decide(ctx({ internal: true }), NOW, CONFIG), 'internal');
});

test('skips: no start date configured, or workspace created before it', () => {
  expectSkip(decide(ctx(), NOW, { startAt: null }), 'no_start_at');
  expectSkip(decide(ctx(), NOW, { startAt: new Date('nope') }), 'no_start_at');
  expectSkip(decide(ctx({}, { createdAt: '2026-10-31T23:59:59.000Z' }), NOW, CONFIG), 'before_start');
  assert.equal(decide(ctx({}, { createdAt: START.toISOString() }), NOW, CONFIG).kind, 'send');
});

test('suppression: global unsubscribe, lifecycle category, no token, bad address', () => {
  expectSkip(decide(ctx({}, {}, { unsubscribedAt: ago(HOUR) }), NOW, CONFIG), 'unsubscribed');
  expectSkip(decide(ctx({}, {}, { unsubscribedCategories: ['lifecycle'] }), NOW, CONFIG), 'unsubscribed_lifecycle');
  // Another category does not stop a lifecycle email.
  assert.equal(decide(ctx({}, {}, { unsubscribedCategories: ['research'] }), NOW, CONFIG).kind, 'send');
  expectSkip(decide(ctx({}, {}, { unsubscribeToken: null }), NOW, CONFIG), 'no_unsubscribe_token');
  expectSkip(decide(ctx({}, {}, { email: 'not an address' }), NOW, CONFIG), 'unusable_email');
});

test('no marketing consent is needed: these are service emails', () => {
  // CandidateContext has no consent field at all; an ordinary owner is eligible.
  assert.equal(decide(ctx(), NOW, CONFIG).kind, 'send');
});

// ---------------------------------------------------------------------------
// Once only
// ---------------------------------------------------------------------------

test('once ever: any ledger row for the template (sent, failed, claimed, holdout) stops it', () => {
  for (const status of ['sent', 'failed', 'claimed', 'holdout']) {
    expectSkip(decide(ctx({ ledger: [{ template: TEMPLATES.connection_help, status }] }), NOW, CONFIG), 'already_sent');
    expectSkip(decide(idle({ ledger: [{ template: TEMPLATES.first_call_help, status }] }), NOW, CONFIG), 'already_sent');
  }
  // E1 having gone out does not block E2.
  assert.equal(decide(idle({ ledger: [{ template: TEMPLATES.connection_help, status: 'sent' }] }), NOW, CONFIG).kind, 'send');
});

// ---------------------------------------------------------------------------
// Holdout
// ---------------------------------------------------------------------------

test('holdout: deterministic, about 20%, and uses hashUnit with its own key', () => {
  let held = 0;
  const n = 5000;
  for (let i = 0; i < n; i += 1) {
    const id = `ws-${i}`;
    assert.equal(isHoldout(id), isHoldout(id));
    assert.equal(isHoldout(id), hashUnit(id, help.HOLDOUT_KEY) < 0.2);
    if (isHoldout(id)) held += 1;
  }
  assert.ok(held / n > 0.17 && held / n < 0.23, `holdout share ${held / n}`);
});

test('holdout: an eligible workspace in the holdout gets kind holdout, an ineligible one is still skipped', () => {
  const d = decide(ctx({ workspaceId: WS_HOLDOUT }), NOW, CONFIG);
  assert.equal(d.kind, 'holdout');
  expectSkip(decide(ctx({ workspaceId: WS_HOLDOUT }, {}, { unsubscribedAt: ago(HOUR) }), NOW, CONFIG), 'unsubscribed');
});

// ---------------------------------------------------------------------------
// Locale
// ---------------------------------------------------------------------------

test('locale: from acquisition_locale, region tags folded, unknown and null fall back to en', () => {
  const loc = (value: string | null) => {
    const d = decide(ctx({}, { acquisitionLocale: value }), NOW, CONFIG);
    return d.kind === 'send' ? d.locale : null;
  };
  assert.equal(loc('fr'), 'fr');
  assert.equal(loc('de-AT'), 'de');
  assert.equal(loc('nb'), 'nb');
  assert.equal(loc('no'), 'nb');
  assert.equal(loc('zh'), 'zh');
  assert.equal(loc('es'), 'es');
  assert.equal(loc('pt'), 'en');
  assert.equal(loc(null), 'en');
});

// ---------------------------------------------------------------------------
// E1 content keys
// ---------------------------------------------------------------------------

test('E1 keys: every class in the fix table maps to its body', () => {
  const key = (row: Partial<ConnectionRow>, host: string | null = null) => connectionHelpKey(failure(row), host);

  assert.equal(key({ category: 'gmail', authReason: 'account_password_used' }).content.key, 'gmail_app_password');
  assert.equal(key({ category: 'gmail', authReason: 'app_password_required' }).content.key, 'gmail_app_password');
  assert.equal(key({ category: 'generic_imap', authReason: 'password_rejected' }, 'imap.gmail.com').content.key, 'gmail_app_password');

  const yahoo = key({ category: 'yahoo', authReason: 'account_password_used' });
  assert.equal(yahoo.content.key, 'yahoo_app_password');
  assert.equal(yahoo.content.label, 'Yahoo');
  assert.equal(yahoo.content.providerLink, templates.PROVIDER_LINKS.yahooAppPasswords);
  assert.equal(key({ category: 'yahoo', authReason: 'app_password_required' }).content.key, 'yahoo_app_password');

  const aol = key({ category: 'generic_imap', authReason: 'password_rejected' }, 'imap.aol.com');
  assert.equal(aol.content.key, 'yahoo_app_password');
  assert.equal(aol.content.label, 'AOL');
  assert.equal(aol.content.providerLink, templates.PROVIDER_LINKS.aolAppPasswords);

  assert.equal(key({ category: 'icloud', authReason: 'account_password_used' }).content.key, 'icloud_app_password');

  const ionos = key({ category: 'generic_imap', authReason: 'password_rejected' }, 'imap.ionos.de');
  assert.equal(ionos.content.key, 'known_host');
  assert.equal(ionos.content.label, 'IONOS');
  assert.equal(ionos.slug, 'ionos');
  assert.equal(key({ category: 'generic_imap', authReason: 'password_rejected' }, 'secureimap.t-online.de').content.label, 'T-Online');
  assert.equal(key({ category: 'generic_imap', authReason: 'password_rejected' }, 'imap.mail.ru').content.label, 'Mail.ru');

  const yandex = key({ category: 'yandex', authReason: 'imap_disabled' });
  assert.equal(yandex.content.key, 'imap_disabled');
  assert.equal(yandex.content.label, 'Yandex');
  assert.equal(key({ category: 'zoho', authReason: 'imap_disabled' }).content.label, 'Zoho');

  const outlook = key({ category: 'outlook', errorCategory: 'provider_denied', authReason: null, phase: 'authorization' });
  assert.equal(outlook.content.key, 'consent_cancelled');
  assert.equal(outlook.content.label, 'Microsoft');
  assert.equal(key({ category: 'gmail', errorCategory: 'provider_denied', authReason: null }).content.label, 'Google');

  const o365 = key({ category: 'generic_imap', authReason: 'password_rejected' }, 'outlook.office365.com');
  assert.equal(o365.content.key, 'office365_basic_auth');
  assert.equal(o365.slug, 'office365');

  for (const phase of ['tcp', 'greeting', 'smtp_tcp']) {
    assert.equal(key({ category: 'generic_imap', errorCategory: 'validation_failed', phase, authReason: null }).content.key, 'server_unreachable');
  }

  assert.equal(key({ category: 'generic_imap', phase: 'smtp_authentication', authReason: 'password_rejected' }).content.key, 'smtp_rejected');

  const unknownHost = key({ category: 'generic_imap', authReason: 'password_rejected' }, 'mail.some-school.example');
  assert.equal(unknownHost.content.key, 'generic_password');
  assert.equal(unknownHost.content.label, null);
  // No host in the log: keyed on the provider category alone.
  assert.equal(key({ category: 'generic_imap', authReason: 'account_password_used' }, null).content.key, 'generic_password');

  assert.equal(key({ category: 'generic_imap', errorCategory: 'validation_failed', phase: 'tls', authReason: null }).content.key, 'generic');
  assert.equal(key({ category: 'outlook', errorCategory: 'unknown', authReason: null }).content.key, 'generic');
});

test('E1 keys: the host is only used for generic IMAP rows', () => {
  // A Yahoo card failure with a stale gmail host in the log stays Yahoo.
  assert.equal(connectionHelpKey(failure({ category: 'yahoo' }), 'imap.gmail.com').content.key, 'yahoo_app_password');
});

test('E1 CTA links back to the connect step with the provider preselected', () => {
  const c = ctx({ connections: [failure({ category: 'generic_imap', authReason: 'password_rejected' })], failureHost: 'imap.ionos.com' });
  const d = decide(c, NOW, CONFIG);
  assert.equal(d.kind, 'send');
  if (d.kind === 'send') assert.equal(help.ctaUrlFor(c, d), 'https://mcpemails.test/dashboard/inboxes?provider=ionos');
  const g = ctx({ connections: [failure({ category: 'generic_imap', errorCategory: 'validation_failed', phase: 'tcp', authReason: null })] });
  const dg = decide(g, NOW, CONFIG);
  if (dg.kind === 'send') assert.equal(help.ctaUrlFor(g, dg), 'https://mcpemails.test/dashboard/inboxes');
});

// ---------------------------------------------------------------------------
// E2 content
// ---------------------------------------------------------------------------

test('E2 content: credential decides linked vs not, client from onboarding_client then client_selected', () => {
  const content = (c: Ctx) => {
    const d = decide(c, NOW, CONFIG);
    assert.equal(d.kind, 'send');
    return d.kind === 'send' && d.content.email === 'first_call_help' ? d.content : null;
  };
  assert.deepEqual(content(idle()), { email: 'first_call_help', state: 'not_linked', client: 'other' });
  assert.deepEqual(content(idle({}, { onboardingClient: 'chatgpt' })), { email: 'first_call_help', state: 'not_linked', client: 'chatgpt' });
  assert.deepEqual(content(idle({ latestClientSelected: 'claude' })), { email: 'first_call_help', state: 'not_linked', client: 'claude' });
  assert.deepEqual(content(idle({ credentialEvent: true, latestClientSelected: 'cursor' })), { email: 'first_call_help', state: 'linked_no_call', client: 'other' });
  assert.deepEqual(content(idle({}, { firstCredentialCreatedAt: ago(HOUR), onboardingClient: 'claude' })), { email: 'first_call_help', state: 'linked_no_call', client: 'claude' });
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const BANNED = [/\u2014/, /\$\s?\d/, /€\s?\d/, /\bupgrade\b/i, /\bpersonal plan\b/i, /\bpro plan\b/i, /\bfree plan\b/i, /pricing/i, /</];

function allBodies() {
  const out: Array<{ locale: string; name: string; composed: NonNullable<ReturnType<typeof templates.composeActivationHelp>> }> = [];
  for (const locale of templates.ACTIVATION_HELP_LOCALES) {
    for (const key of templates.CONNECTION_HELP_KEYS) {
      const composed = templates.composeActivationHelp({
        content: { email: 'connection_help', key, label: 'Yahoo', providerLink: templates.PROVIDER_LINKS.yahooAppPasswords },
        locale,
        ctaUrl: 'https://mcpemails.test/dashboard/inboxes',
        unsubscribeToken: TOKEN,
      });
      assert.ok(composed, `${locale}/${key}`);
      out.push({ locale, name: key, composed: composed! });
    }
    for (const state of templates.FIRST_CALL_STATES) {
      for (const client of ['chatgpt', 'claude', 'other'] as const) {
        const composed = templates.composeActivationHelp({
          content: { email: 'first_call_help', state, client },
          locale,
          ctaUrl: 'https://mcpemails.test/dashboard',
          unsubscribeToken: TOKEN,
        });
        assert.ok(composed);
        out.push({ locale, name: `${state}:${client}`, composed: composed! });
      }
    }
  }
  return out;
}

test('templates: every body in every locale has the footer, the opt-out and no banned wording', () => {
  for (const { locale, name, composed } of allBodies()) {
    const where = `${locale}/${name}`;
    assert.ok(composed.text.includes(POSTAL_ADDRESS_LINE), where);
    assert.ok(composed.html.includes(POSTAL_ADDRESS_LINE.replace(/&/g, '&amp;')), where);
    assert.ok(composed.unsubscribeUrl.includes(`token=${TOKEN}`) && composed.unsubscribeUrl.includes('c=lifecycle'), where);
    assert.equal(composed.headers['List-Unsubscribe'], `<${composed.unsubscribeUrl}>`);
    assert.equal(composed.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.ok(composed.text.includes('Asgeir'), where);
    for (const re of BANNED) {
      assert.ok(!re.test(composed.text), `${where} text matches ${re}`);
      assert.ok(!re.test(composed.subject), `${where} subject matches ${re}`);
    }
    assert.ok(!/MCP Emails|mcpemails\b(?!\.)/.test(composed.text.replace(/https:\/\/\S+/g, '')), `${where} brand spelling`);
  }
});

test('templates: one link per email, back into the product or (Claude not linked) the Claude install', () => {
  for (const { locale, name, composed } of allBodies()) {
    const productLinks = composed.text.match(/https:\/\/mcpemails\.test\/dashboard\S*/g) ?? [];
    const installLinks = composed.text.match(/https:\/\/claude\.ai\/customize\/connectors\S*/g) ?? [];
    assert.equal(productLinks.length + installLinks.length, 1, `${locale}/${name}`);
  }
});

test('templates: Claude not linked gets the prefilled claude.ai dialog as its button, others the dashboard', () => {
  for (const locale of templates.ACTIVATION_HELP_LOCALES) {
    const claude = templates.composeActivationHelp({
      content: { email: 'first_call_help', state: 'not_linked', client: 'claude' },
      locale,
      ctaUrl: 'https://mcpemails.test/dashboard',
      unsubscribeToken: TOKEN,
    })!;
    const href = claudeInstallHref(MCP_URL);
    assert.ok(claude.text.includes(href), locale);
    assert.ok(claude.html.includes(href.replace(/&/g, '&amp;')), locale);
    assert.ok(!claude.text.includes('mcpemails.test/dashboard'), locale);
    assert.ok(claude.text.includes(getInstallAction('claude', { locale })!.note!), locale);
  }
  for (const content of [
    { email: 'first_call_help', state: 'not_linked', client: 'chatgpt' },
    { email: 'first_call_help', state: 'not_linked', client: 'other' },
    { email: 'first_call_help', state: 'linked_no_call', client: 'claude' },
  ] as const) {
    const composed = templates.composeActivationHelp({ content, locale: 'en', ctaUrl: 'https://mcpemails.test/dashboard', unsubscribeToken: TOKEN })!;
    assert.doesNotMatch(composed.text, /: https:\/\/claude\.ai\//, `${content.client}/${content.state}`);
    assert.match(composed.text, /^Open the dashboard: https:\/\/mcpemails\.test\/dashboard$/m, `${content.client}/${content.state}`);
  }
});

test('templates: no token, no email', () => {
  const base = { content: { email: 'first_call_help' as const, state: 'not_linked' as const, client: 'other' as const }, locale: 'en' as const, ctaUrl: 'https://mcpemails.test/dashboard' };
  assert.equal(templates.composeActivationHelp({ ...base, unsubscribeToken: null }), null);
  assert.equal(templates.composeActivationHelp({ ...base, unsubscribeToken: '  ' }), null);
});

test('templates: E1 uses the provider page link, E2 carries the starter prompt', () => {
  const e1 = templates.composeActivationHelp({
    content: { email: 'connection_help', key: 'yahoo_app_password', label: 'Yahoo', providerLink: templates.PROVIDER_LINKS.yahooAppPasswords },
    locale: 'en',
    ctaUrl: 'https://mcpemails.test/dashboard/inboxes?provider=yahoo',
    unsubscribeToken: TOKEN,
  })!;
  assert.equal(e1.subject, 'Your Yahoo connection to MCPEmails');
  assert.ok(e1.text.includes(templates.PROVIDER_LINKS.yahooAppPasswords));
  const e2 = templates.composeActivationHelp({
    content: { email: 'first_call_help', state: 'linked_no_call', client: 'chatgpt' },
    locale: 'en',
    ctaUrl: 'https://mcpemails.test/dashboard',
    unsubscribeToken: TOKEN,
  })!;
  assert.ok(e2.text.includes('Summarize my unread email from today.'));
  assert.ok(e2.text.includes('In ChatGPT'));
  const fr = templates.composeActivationHelp({
    content: { email: 'first_call_help', state: 'not_linked', client: 'claude' },
    locale: 'fr',
    ctaUrl: 'https://mcpemails.test/dashboard',
    unsubscribeToken: TOKEN,
  })!;
  assert.ok(fr.html.includes('lang="fr"'));
  assert.ok(fr.text.includes(templates.starterPrompt('fr')));
});

test('helpLocale: junk to en', () => {
  assert.equal(templates.helpLocale(undefined), 'en');
  assert.equal(templates.helpLocale(42), 'en');
  assert.equal(templates.helpLocale('ZH-cn'), 'zh');
});

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

class MemoryStore {
  contexts = new Map<string, Ctx>();
  rows: Array<ClaimRow & { finished?: string }> = [];
  suppressed = new Set<string>();
  account: 'live' | 'deleted' | 'unknown' = 'live';
  claims = 0;

  constructor(list: Ctx[]) {
    for (const c of list) this.contexts.set(c.workspaceId, c);
  }
  async listCandidateIds() {
    return [...this.contexts.keys()];
  }
  async loadContexts(ids: string[]) {
    return ids
      .map((id) => this.contexts.get(id))
      .filter((c): c is Ctx => Boolean(c))
      .map((c) => ({
        ...c,
        accountState: null,
        ledger: this.rows.filter((r) => r.workspaceId === c.workspaceId).map((r) => ({ template: TEMPLATES[r.email], status: r.finished ?? r.status })),
      }));
  }
  async accountState() {
    return this.account;
  }
  async isSuppressed(userId: string) {
    return this.suppressed.has(userId);
  }
  async claim(row: ClaimRow) {
    this.claims += 1;
    if (this.rows.some((r) => r.workspaceId === row.workspaceId && r.email === row.email)) return false;
    this.rows.push({ ...row });
    return true;
  }
  async finish(key: { workspaceId: string; email: string }, outcome: { status: string }) {
    const row = this.rows.find((r) => r.workspaceId === key.workspaceId && r.email === key.email && r.status === 'claimed');
    if (row) row.finished = outcome.status;
  }
}

function recorder() {
  const sent: OutgoingEmail[] = [];
  return { sent, send: async (e: OutgoingEmail) => { sent.push(e); return { ok: true as const, id: 'msg_1' }; } };
}

test('run, dry run: decides and reports, writes nothing, sends nothing', async () => {
  const store = new MemoryStore([ctx(), idle({ workspaceId: findWorkspace(false, 500) }), ctx({ workspaceId: WS_HOLDOUT })]);
  const r = recorder();
  const report = await runActivationHelp({ store, mode: 'dry_run', config: CONFIG, now: NOW, send: r.send });
  assert.equal(r.sent.length, 0);
  assert.equal(store.rows.length, 0);
  assert.equal(store.claims, 0);
  assert.equal(report.wouldSend.connection_help, 1);
  assert.equal(report.wouldSend.first_call_help, 1);
  assert.equal(report.wouldHoldOut.connection_help, 1);
  for (const e of report.entries) assert.match(e.workspace, /^[0-9a-f]{12}$/);
});

test('run, send: sends once, records sent, and a second run sends nothing', async () => {
  const store = new MemoryStore([ctx()]);
  const r = recorder();
  const first = await runActivationHelp({ store, mode: 'send', config: CONFIG, now: NOW, send: r.send });
  assert.equal(first.sent, 1);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].to, 'owner@example.test');
  assert.equal(r.sent[0].idempotencyKey, `${TEMPLATES.connection_help}-${WS}`);
  assert.equal(store.rows[0].finished, 'sent');
  const second = await runActivationHelp({ store, mode: 'send', config: CONFIG, now: new Date(NOW.getTime() + HOUR), send: r.send });
  assert.equal(second.sent, 0);
  assert.equal(r.sent.length, 1);
  assert.equal(second.skipped.already_sent, 1);
});

test('run, send: holdout writes a holdout row and sends nothing, then never again', async () => {
  const store = new MemoryStore([ctx({ workspaceId: WS_HOLDOUT })]);
  const r = recorder();
  const report = await runActivationHelp({ store, mode: 'send', config: CONFIG, now: NOW, send: r.send });
  assert.equal(report.heldOut, 1);
  assert.equal(r.sent.length, 0);
  assert.equal(store.rows[0].status, 'holdout');
  const again = await runActivationHelp({ store, mode: 'send', config: CONFIG, now: NOW, send: r.send });
  assert.equal(again.heldOut, 0);
  assert.equal(again.skipped.already_sent, 1);
});

test('run, send: the fresh opt-out read right before sending stops it', async () => {
  const store = new MemoryStore([ctx()]);
  store.suppressed.add(USER);
  const r = recorder();
  const report = await runActivationHelp({ store, mode: 'send', config: CONFIG, now: NOW, send: r.send });
  assert.equal(r.sent.length, 0);
  assert.equal(store.rows.length, 0);
  assert.equal(report.skipped.unsubscribed, 1);
});

test('run, send: a deleted or unreadable account is never emailed or held out', async () => {
  for (const state of ['deleted', 'unknown'] as const) {
    const store = new MemoryStore([ctx(), ctx({ workspaceId: WS_HOLDOUT })]);
    store.account = state;
    const r = recorder();
    await runActivationHelp({ store, mode: 'send', config: CONFIG, now: NOW, send: r.send });
    assert.equal(r.sent.length, 0);
    assert.equal(store.rows.length, 0);
  }
});

test('run, send: a failed send is recorded and not retried', async () => {
  const store = new MemoryStore([ctx()]);
  let calls = 0;
  const send = async () => {
    calls += 1;
    return { ok: false as const, reason: 'provider_down' };
  };
  const first = await runActivationHelp({ store, mode: 'send', config: CONFIG, now: NOW, send });
  assert.equal(first.failed, 1);
  assert.equal(store.rows[0].finished, 'failed');
  await runActivationHelp({ store, mode: 'send', config: CONFIG, now: NOW, send });
  assert.equal(calls, 1);
});

test('run: no start date means no candidates are even read', async () => {
  const store = new MemoryStore([ctx()]);
  let listed = false;
  store.listCandidateIds = async () => {
    listed = true;
    return [];
  };
  const report = await runActivationHelp({ store, mode: 'send', config: { startAt: null }, now: NOW, send: recorder().send });
  assert.equal(listed, false);
  assert.equal(report.sent, 0);
});

// ---------------------------------------------------------------------------
// Switches
// ---------------------------------------------------------------------------

test('switches: off by default, dry run by default, start date parsed strictly', () => {
  assert.equal(help.activationHelpMode({}), 'off');
  assert.equal(help.activationHelpMode({ ACTIVATION_HELP_ENABLED: 'yes' }), 'off');
  assert.equal(help.activationHelpMode({ ACTIVATION_HELP_ENABLED: 'on' }), 'dry_run');
  assert.equal(help.activationHelpMode({ ACTIVATION_HELP_ENABLED: 'on', ACTIVATION_HELP_DRY_RUN: 'true' }), 'dry_run');
  assert.equal(help.activationHelpMode({ ACTIVATION_HELP_ENABLED: 'on', ACTIVATION_HELP_DRY_RUN: 'false' }), 'send');
  assert.equal(help.activationHelpStartAt({}), null);
  assert.equal(help.activationHelpStartAt({ ACTIVATION_HELP_START_AT: 'soon' }), null);
  assert.equal(help.activationHelpStartAt({ ACTIVATION_HELP_START_AT: '2026-11-01' })?.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(help.activationHelpMaxPerRun({ ACTIVATION_HELP_MAX_PER_RUN: '500' }), 100);
});
