'use client';

import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useTranslations } from 'next-intl';
import { Icon, Btn, ProviderLogo } from '../Primitives';
import { trackProductEvent } from '@/lib/analytics.mjs';
import { useInboxPaywallView } from '@/lib/analytics/use-inbox-paywall.mjs';
import { OAUTH_VERIFICATION_PENDING } from '@/lib/oauth/verification-status';
import { checkoutStartHref } from '@/lib/billing/upgrade-intent.mjs';
import { inboxCapOffer } from '@/lib/billing/inbox-cap-offer.mjs';
import UpgradeIntervalChoice, {
  annualOfferForPlan,
  upgradeCtaLabel,
} from './UpgradeIntervalChoice';
import { planDisplayName } from './Pages';
import {
  IMAP_PRESETS,
  GENERIC_IMAP_DEFAULTS,
  isBrandedImapService,
  ZOHO_REGIONS,
  DEFAULT_ZOHO_REGION,
  DEFAULT_ZOHO_ACCOUNT_TYPE,
  zohoSettingsFromHost,
  portForSecurity,
  securityForPort,
  normalizeAppPassword,
} from '@/lib/email-providers/imap-presets';
// The server's port allowlist, imported rather than restated. It lives in its
// own module because host-guard.ts, where the policy is enforced, depends on
// node:dns and cannot be pulled into a client bundle.
import { ALLOWED_MAIL_PORTS, allowedMailPorts } from '@/lib/email/mail-ports';
import { useToast } from './Toast';
import { emailDomain, prefillFromDomain } from '@/lib/email-providers/host-presets';
import {
  identifyAppPasswordProvider,
  checkAppPasswordShape,
} from '@/lib/email-providers/app-password';

/**
 * Zoho serves personal (@zohomail.com) and organization (paid custom-domain)
 * mailboxes on different hosts (imap.zoho vs imappro.zoho), so the user must
 * tell us which they have. Sent to the connect route as `zohoAccountType`.
 * Labels resolve through dashboardChrome so they translate.
 */
const ZOHO_ACCOUNT_TYPES = [
  { value: 'personal', labelKey: 'connect.zohoPersonal' },
  { value: 'organization', labelKey: 'connect.zohoOrganization' },
];

/** Per-provider guidance key in dashboardChrome. */
const HINT_KEYS = {
  generic: 'connect.hintGeneric',
  gmail: 'connect.hintGmail',
  icloud: 'connect.hintIcloud',
  yahoo: 'connect.hintYahoo',
  zoho: 'connect.hintZoho',
  yandex: 'connect.hintYandex',
  fastmail: 'connect.hintFastmail',
};

/**
 * Where the credential is actually generated, and what one looks like, now
 * comes from `lib/email-providers/app-password` rather than from a table here.
 *
 * The links themselves are unchanged (deep links to the generator, not to a
 * help article: the shortest route to the right page is the thing most likely
 * to change the outcome). What changed is who can reach them. This table was
 * keyed by the logo the user clicked, so the generic IMAP form -- the largest
 * failure bucket by far, 156 rejected logins across 38 workspaces -- got
 * nothing at all, even for an address that plainly says @yahoo.com. The policy
 * lookup answers from the address and the mail host too, so the guidance no
 * longer depends on which door the user came through.
 */

/** Per-provider "what it is called and where it lives" copy, in dashboardChrome. */
const APP_PASSWORD_STEP_KEYS = {
  gmail: 'connect.appPasswordStepsGmail',
  icloud: 'connect.appPasswordStepsIcloud',
  yahoo: 'connect.appPasswordStepsYahoo',
  zoho: 'connect.appPasswordStepsZoho',
  yandex: 'connect.appPasswordStepsYandex',
  fastmail: 'connect.appPasswordStepsFastmail',
};

/**
 * A rejected login is 72.9% of every connection failure, and it is not one
 * failure: it is at least four, with four different fixes. The routes classify
 * which one it was (see lib/email/auth-failure.ts) and send back a reason; each
 * reason gets its own headline and its own next step, instead of one sentence
 * about checking the password that is wrong advice in three of the four cases.
 *
 * `app_password_length` is decided in the browser before anything is sent,
 * because a half-pasted token is visible without asking a mail server to reject
 * it. It is ALSO a server reason now. The browser's rule speaks once per value
 * (see `shapeWarnedFor`), so the second Connect on the same truncated string
 * goes to the server, and the server used to fold both shape problems into
 * `account_password_used`: one string, two clicks, two contradictory stories.
 * lib/email/auth-failure.ts keeps the two apart, so both clicks now say the
 * same thing about the same value.
 */
const AUTH_REASON_HEADLINE_KEYS = {
  imap_disabled: 'connect.errorAuthImapDisabled',
  app_password_required: 'connect.errorAuthAppPassword',
  account_password_used: 'connect.errorAuthAccountPassword',
  app_password_length: 'connect.errorAuthAppPasswordLength',
  login_username_required: 'connect.errorAuthLoginName',
};

/** The one thing to do next, per reason. Sits in "What to check". */
const AUTH_REASON_DETAIL_KEYS = {
  imap_disabled: 'connect.imapDisabledDetail',
  app_password_required: 'connect.appPasswordRequiredDetail',
  account_password_used: 'connect.appPasswordAccountDetail',
  app_password_length: 'connect.appPasswordLengthDetail',
  login_username_required: 'connect.loginNameDetail',
};

/**
 * One short sentence per failure, chosen by the route's `error_code`.
 *
 * The routes answer with three-line paragraphs of troubleshooting prose, which
 * is genuinely useful text that nobody reads when it is the first thing on
 * screen after a failed submit. The headline below leads instead, and the
 * route's own message moves behind the "What to check" disclosure.
 */
const ERROR_HEADLINE_KEYS = {
  auth_failed: 'connect.errorAuthShort',
  auth_mechanism_unsupported: 'connect.errorAuthMechanismShort',
  connection_refused: 'connect.errorUnreachableShort',
  connection_timeout: 'connect.errorTimeoutShort',
  tls_handshake_failed: 'connect.errorSecurityShort',
  // Both protocol errors share a headline: from the user's side they are the
  // same event, a server that answered with something we could not parse. The
  // route's own message, which names the protocol, sits in the disclosure.
  imap_protocol_error: 'connect.errorProtocolShort',
  smtp_protocol_error: 'connect.errorProtocolShort',
  // A name that does not resolve. Kept out of TRANSPORT_ERROR_CODES below: no
  // port or security mode can fix a hostname that does not exist, so opening
  // Advanced settings would point at the wrong field.
  host_not_found: 'connect.errorHostNotFoundShort',
  login_already_connected: 'connect.errorLoginTakenShort',
  // ── The SSRF guard's own refusals (lib/email/host-guard.ts) ──────────────
  // All three were reaching the user as "Connection failed. Please try again."
  // with the guard's actual sentence folded behind a disclosure that stayed
  // shut, which is the worst possible reading of a refusal that never touched a
  // mail server at all.
  port_not_allowed: 'connect.errorPortNotAllowedShort',
  host_not_allowed: 'connect.errorHostNotAllowedShort',
  host_invalid: 'connect.errorHostInvalidShort',
  // ── Refusals from before the mail server is ever contacted ───────────────
  // A viewer of somebody else's workspace (lib/workspace/roles.ts). No port,
  // password or hostname can fix it, and the generic headline sent people
  // round the loop of retyping a credential that was never the problem.
  insufficient_role: 'connect.errorInsufficientRoleShort',
  // 401 from any of the three connect routes. The dominant real-world case is
  // a modal that has been open long enough for the session to lapse, and it
  // reads as a broken mail server unless it is named. The alert grows a sign-in
  // link for this one code; see SESSION_EXPIRED_CODE below.
  session_expired: 'connect.errorSessionExpiredShort',
  workspace_not_found: 'connect.errorWorkspaceNotFoundShort',
  // 422 from the two app-password routes when the token is under 8 characters.
  // The client's own shape rule catches most of these first, but it speaks only
  // once per value, and a provider we have no shape rule for reaches the server.
  app_password_too_short: 'connect.errorAppPasswordTooShortShort',
  password_required: 'connect.errorPasswordRequired',
  // The upsert failed after both logins succeeded. The credential is right and
  // retyping it is pointless, so the headline says what actually happened.
  save_failed: 'connect.errorSaveFailedShort',
};

/**
 * The one code whose fix is not in this modal at all.
 *
 * An expired session is repaired by signing in again, so the alert carries the
 * app's normal re-auth affordance (/login?redirect=, the same shape the
 * dashboard's own server-side guard and the invite screen use) rather than
 * leaving the user to work out that the mailbox was never the problem.
 */
const SESSION_EXPIRED_CODE = 'session_expired';

/**
 * The app's ordinary "sign in and come back here" link.
 *
 * `/login?redirect=<path>` is what the dashboard's own server-side guard, the
 * approvals page and the invite screen all use, and app/(auth)/login/page.js
 * only honours a value that begins with a single slash, so the current path is
 * passed through verbatim and nothing else is invented. A whole-document
 * anchor rather than a router push: the destination is behind the auth
 * boundary, and the session that would have carried a client navigation is the
 * thing that just expired.
 */
function signInHref() {
  if (typeof window === 'undefined') return '/login';
  const here = window.location.pathname + window.location.search;
  return here.startsWith('/') && !here.startsWith('//')
    ? `/login?redirect=${encodeURIComponent(here)}`
    : '/login';
}

/**
 * The failure code for a response that carried none.
 *
 * Three routes answer with a bare `{ error }` on several paths, and every one
 * of them used to arrive here as `connection_failed`: an expired session, a
 * workspace lookup that found nothing, and a save that failed AFTER both logins
 * succeeded all read to the user as a mail server that would not answer. They
 * do carry codes now, but the status is the more durable signal (it cannot be
 * dropped by an older deployment of a route, and this modal ships separately
 * from them), so the status decides whenever a code is missing.
 *
 * 422 stays generic on purpose: the route's own sentence is the specific thing
 * to say there, and it is now shown rather than hidden.
 */
function failureCode(status, data) {
  const code = typeof data?.error_code === 'string' ? data.error_code.trim() : '';
  if (code) return code;
  if (status === 401) return SESSION_EXPIRED_CODE;
  if (status === 403) return 'workspace_not_found';
  if (status >= 500) return 'save_failed';
  return 'connection_failed';
}

/**
 * Failures whose fix is a transport setting. When one of these comes back the
 * Advanced settings section is opened, because that is where the security mode
 * lives and the security mode is the half of the fix that is not already on
 * screen. The other half, the port, now sits beside its host on the form
 * itself, so these failures put the whole fix in view rather than half of it.
 */
const TRANSPORT_ERROR_CODES = new Set([
  'connection_refused',
  'connection_timeout',
  'tls_handshake_failed',
  // A malformed IMAP greeting is almost always plaintext against 993 or
  // implicit TLS against 143, so the fix is a port or a security mode and the
  // section holding both has to be open.
  'imap_protocol_error',
  'smtp_protocol_error',
  'auth_mechanism_unsupported',
  // A port the server will not dial. The fix is the port field, which is on the
  // form itself now, but the security select beside it moves with the port and
  // has to be visible while the user changes one: picking 143 with implicit TLS
  // still selected is the next failure. This code was absent entirely, so the
  // one refusal that is unambiguously about a transport setting was the one
  // that opened nothing.
  'port_not_allowed',
]);

/**
 * Split a host field into a host and, when present, the port the user typed
 * into it.
 *
 * People copy their provider's documented settings verbatim, and providers
 * document them as `imap.example.com:993`. They also paste whole URLs. Both
 * used to be submitted as a hostname, which resolves to nothing and fails in
 * the `tcp` phase with an error about the host being unreachable, several
 * steps away from the actual mistake.
 *
 * A single trailing `:<digits>` is a port. Anything with more colons is a bare
 * IPv6 literal and is left alone; a bracketed literal (`[::1]:993`) is
 * unwrapped explicitly.
 *
 * Whatever happens, the returned `host` is a hostname on its own: no scheme,
 * no userinfo, and never a colon or a port glued to the end. The server now
 * rejects those outright (lib/email/host-guard.ts treats `:`, `@` and `/` as
 * smuggling characters and refuses the request), so splitting here is what
 * turns a pasted `imap.example.com:993` into a working connection instead of a
 * 422 the user has to decode.
 *
 * `portError` is `'range'` when the user typed something in port position that
 * is not a usable port (0, or above 65535). The digits are dropped from the
 * host either way; the flag is what lets the caller say why.
 *
 * @returns {{ host: string, port: number|null, portError: 'range'|null }}
 */
export function splitHostPort(raw) {
  let value = String(raw ?? '').trim();
  if (!value) return { host: '', port: null, portError: null };
  // imaps:// imap:// https:// ssl:// ...
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  // Anything after the authority is a path, query or fragment.
  value = value.split(/[/?#]/)[0];
  // user@host, which a pasted URL can carry.
  const at = value.lastIndexOf('@');
  if (at >= 0) value = value.slice(at + 1);

  // `[::1]`, `[::1]:993`, and the half-typed `[::1]:`.
  const bracketed = value.match(/^\[([^\]]+)\](?::(\d*))?$/);
  if (bracketed) {
    if (!bracketed[2]) return { host: bracketed[1], port: null, portError: null };
    const port = Number(bracketed[2]);
    if (!port || port > 65535) return { host: bracketed[1], port: null, portError: 'range' };
    return { host: bracketed[1], port, portError: null };
  }

  // A lone trailing colon is a port the user has not finished typing: they
  // typed `host.com:` and tabbed away. Drop it silently and say nothing; there
  // is no mistake to report yet, only an unfinished one.
  const trailingColon = value.match(/^([^:]+):$/);
  if (trailingColon) return { host: trailingColon[1], port: null, portError: null };

  // Unbounded digits, not `\d{1,5}`: a six-digit port has to be recognised as a
  // port in order to be reported as an impossible one. Capping the pattern at
  // five is what used to leave `imap.example.com:99999` glued together.
  const match = value.match(/^([^:]+):(\d+)$/);
  if (!match) return { host: value, port: null, portError: null };
  const port = Number(match[2]);
  if (!port || port > 65535) return { host: match[1], port: null, portError: 'range' };
  return { host: match[1], port, portError: null };
}

/**
 * The port field: a choice among the ports the server will actually dial.
 *
 * It was a free `<input type="number">`, and `connect.errorPortRange` promised
 * 1 to 65535 to match it. The server has never accepted that: ALLOWED_MAIL_PORTS
 * is imap {143, 993} and smtp {25, 465, 587}, and anything else is refused by
 * guardMailHost with `port_not_allowed` before a socket is opened. So someone
 * who typed 2525 or 1993 passed every check the browser made, waited out a full
 * IMAP-then-SMTP verification, and was answered with a code this modal had no
 * headline for. The list here is imported from that same allowlist rather than
 * restated, so the promise and the policy cannot drift apart again.
 *
 * The options are the allowlist, plus the current value when it is not in it.
 * That extra entry never invents a port: it only mirrors a value the form
 * already holds, which is how a reconnect of a row stored on a non-standard
 * port still shows the number it is about to submit rather than an empty box.
 *
 * `disabled` rather than `readOnly` because a select has no readOnly: the
 * attribute exists on the element but does nothing. Reconnect locks it either
 * way, and a disabled control is what the security selects beside it already
 * use for the same reason.
 */
function PortSelect({ id, protocol, value, onChange, disabled, inputRef, invalid, describedBy }) {
  const current = Number(value);
  const options = allowedMailPorts(protocol);
  if (Number.isFinite(current) && current > 0 && !options.includes(current)) {
    options.push(current);
    options.sort((a, b) => a - b);
  }
  return (
    <select
      id={id}
      ref={inputRef}
      className="input"
      value={String(value)}
      onChange={e => onChange(e.target.value)}
      disabled={disabled}
      // A port is not optional and the form will not submit without one, so the
      // control says so rather than leaving it to the failure message.
      required
      aria-required="true"
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
    >
      {options.map(port => (
        <option key={port} value={String(port)}>{port}</option>
      ))}
    </select>
  );
}

/**
 * ConnectModal.jsx: inbox connection modal.
 *
 * Step 1: Provider selection.
 *   - Gmail / iCloud / Yahoo / Zoho / Yandex → app password (in-modal step 2),
 *     using the host presets from lib/email-providers/imap-presets. Gmail also
 *     offers Google sign-in as a secondary route to the OAuth initiation route.
 *   - Outlook → clicking "Connect" navigates to the server-side OAuth
 *     initiation route, which redirects to the provider's consent screen.
 *   - Fastmail → OAuth (route) or app password (in-modal step 2).
 *   - IMAP / SMTP (generic) → in-modal step 2 with host/port fields.
 *
 * Step 2: Credentials form.
 *   App-password providers submit { email, appPassword } (plus host/port for the
 *   generic connector) to the matching connect route, which validates against
 *   the IMAP server before persisting. On success, onConnect updates the parent's
 *   optimistic inbox list.
 */

/** Provider cards shown in step 1. `subKey` resolves a dashboardChrome key. */
const PROVIDERS = [
  // IMAP leads. It is the path that works with every mailbox, it is the only
  // one no first-party connector covers, and it is the one that does not send
  // the user out to a third-party consent screen to complete.
  { k: 'generic', label: 'IMAP / SMTP', subKey: 'connect.subGeneric', logoKind: 'imap' },
  // Branded IMAP presets (app password) — IMAP underneath, host/port prefilled.
  // Gmail is one of these now and is first among them: an app password is the
  // default way to connect a Google mailbox here, and Google sign-in is the
  // secondary option offered underneath the grid. There is deliberately ONE
  // Gmail card rather than two, because "Gmail" and "Gmail (OAuth)" side by
  // side is a question about our infrastructure that the user cannot answer.
  ...Object.values(IMAP_PRESETS).map(p => ({
    k: p.service,
    label: p.label,
    subKey: 'connect.subAppPassword',
    logoKind: p.logoKind,
  })),
  // `fastmail`, not `imap`. Fastmail connects over IMAP underneath, which is
  // what the generic logo was standing in for, but the card above it in the
  // same grid is literally called "IMAP / SMTP" and wears that exact mark, so
  // the two chips were visually identical and the brand the user came looking
  // for was the one thing missing from its own card. Primitives.jsx has carried
  // a real `fastmail` mark all along.
  { k: 'fastmail', label: 'Fastmail', subKey: 'connect.subFastmail',    logoKind: 'fastmail' },
  // Outlook is temporarily unavailable (Microsoft connector not live yet) —
  // shown LAST, greyed out / non-selectable with a "coming soon" flag until it ships.
  { k: 'outlook',  label: 'Outlook',  subKey: 'connect.subOutlook',     logoKind: 'outlook', disabled: true },
];

/**
 * The props that tell a browser and a password manager that this is NOT a
 * sign-in form for mcpemails.com.
 *
 * It looked exactly like one: a real `<form>` on the same origin as /login,
 * with `autoComplete="email"` on the address and `autoComplete="current-password"`
 * on the secret. Chrome, Safari and 1Password all read that pair as "sign in to
 * this site" and offer the saved mcpemails.com password. A user who accepts it
 * has just sent their account password to their MAIL provider, and that is not
 * a hypothetical failure mode: it is `account_password_used`, the largest
 * classified sub-case of auth_failed (see lib/email/auth-failure.ts), and the
 * one the shape rule in this file exists to catch after the fact.
 *
 * The code already knew this was dangerous. The reconnect path locks its fields
 * for exactly this reason, with a comment saying so, and it was fixing the
 * narrower half of the problem: a locked field cannot be autofilled, but every
 * FIRST connection was still being offered the wrong credential.
 *
 * STEERING, NOT SILENCE. Two things, and deliberately not the four this
 * started with:
 *  - `autoComplete="off"`, which Chrome honours on a field it has not already
 *    decided is a login field;
 *  - a `name` that does not read as one, which is the signal the heuristics
 *    fall back on when the attribute is ignored ("password", "email" and
 *    "username" are the names that trip them).
 *
 * It also carried `data-1p-ignore`, `data-lpignore` and `data-form-type="other"`,
 * the documented per-manager opt-outs for 1Password, LastPass and Dashlane.
 * Those are a different instrument. The two above say "this is not the login
 * for mcpemails.com"; those three say "offer nothing here at all", and the
 * thing they stopped offering was the credential the user actually needed. A
 * Gmail, iCloud, Yahoo or AOL app password is sixteen random characters that
 * nobody holds in their head. It lives in the same manager, and for one day it
 * could not be filled from it.
 *
 * That day is measurable. Of the workspaces that began a connection, 90.4%
 * (103/114) reached a connected mailbox in the week before this shipped and
 * 68.8% (11/16) in the day after. The gap survives standardising for which
 * providers people chose (Mantel-Haenszel z = -2.27, p = 0.023), and it is the
 * same size on the branded cards as on the generic form, which is what rules
 * out the autodiscovery that landed in the same commit and points here: this
 * object is on `cm-password`, and `cm-password` is every path. 19 of the 29
 * failures were `auth_failed` at the authentication phase, which is what not
 * being able to produce a credential looks like from the server.
 *
 * The original diagnosis was right and is kept. `account_password_used` is a
 * real failure and this form did invite it. But the cure has to leave the user
 * able to reach their own mail password, so it steers the heuristics instead of
 * shutting the manager off.
 *
 * The reveal toggle and the select-on-focus-after-rejection behaviour are
 * untouched: nothing here changes what the field IS, only who offers to fill it.
 */
const NOT_A_LOGIN_FIELD = {
  autoComplete: 'off',
};

/**
 * The clip that keeps the three announcers below out of the layout.
 *
 * They have to be in the document from the moment the dialog opens, because a
 * live region that is INSERTED together with its first text is announced
 * unreliably: several screen readers only watch regions they were already
 * observing when the mutation happened. That was the state of every notice in
 * this modal (the prefill note, the moved-port note, the error alert), all of
 * them conditionally rendered.
 *
 * Always-mounting them where they are visible is not an option: an empty span
 * in a `.field` still collects the column's 6px gap, so every form would grow
 * blank strips for messages that are not there. So the visible notices stay
 * exactly as they were, plain text with no role, and the announcing is done by
 * these three, which are 1px, clipped, and never draw anything.
 *
 * `clip` as well as `clipPath`: the deprecated property is still what older
 * assistive technology honours, and both together are the pattern that keeps
 * the text readable to a screen reader while removing it from the page. Not
 * `display: none` or `visibility: hidden`, which remove it from the
 * accessibility tree along with the layout.
 */
const SR_ONLY = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
  border: 0,
};

/** Everything the focus trap treats as a stop inside the dialog. */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The server-side route that initiates the OAuth flow for each provider. */
const OAUTH_ROUTES = {
  gmail: '/auth/gmail',
  outlook: '/auth/outlook',
};

/**
 * ConnectModal: inbox connection modal.
 *
 * When `atInboxLimit` is true the modal shows the upgrade offer instead of the
 * provider picker. This is the product's single moment of value: the person is
 * standing in front of the modal trying to add a second mailbox, which is
 * exactly what Pro sells. So the panel names what they were doing, states the
 * price, and goes straight to Stripe Checkout rather than dumping them on a
 * pricing page to start over.
 *
 * The panel never appears for a workspace whose cap is unlimited, which covers
 * paid plans, comped accounts, and the grandfathered pre-repricing cohort:
 * App.jsx computes `atInboxLimit` as false whenever maxInboxes is null.
 *
 * The same panel is shown when a connect route answers 402
 * `inbox_limit_reached`, which covers the cases the prop cannot see: the cap
 * reached in another tab or on another device since this page loaded. In that
 * case the counts and the upgrade URL come from the response body.
 *
 * @param {boolean} atInboxLimit - True when the workspace is at its inbox cap.
 * @param {string}  planName     - Customer-facing plan name ("Free"/"Pro"/"Team").
 *                                 Never the internal slug.
 * @param {number}  inboxCount   - Inboxes connected right now.
 * @param {number|null} maxInboxes - The plan's cap, or null for unlimited.
 * @param {object|null} stripePrices - Live Stripe amounts per plan, plus which
 *   intervals have a configured price ID. Absent means the panel sells monthly
 *   only, which is what it did before the interval choice existed: an interval
 *   is never offered on a guess about whether it can be bought.
 */
export function ConnectModal({
  onClose,
  onConnect,
  atInboxLimit = false,
  planName = 'Free',
  inboxCount = null,
  maxInboxes = null,
  stripePrices = null,
  reconnect = null,
}) {
  const tr = useTranslations('dashboardChrome');
  // The toast lives in ToastProvider, above this modal in App.jsx, so it
  // survives the modal being closed. That is what makes it safe to let someone
  // walk away from a verification that is still running: see `deliverOutcome`.
  const { toast } = useToast();
  // Reconnect mode: re-open the form this inbox was created with, identity
  // pre-filled and locked, so only the password is re-entered. Map the stored
  // service back to a modal provider: 'generic' (or a missing service) → the
  // generic IMAP form; a branded service (gmail/fastmail/icloud/yahoo/zoho/
  // yandex) → that provider. This is what stops a generic IMAP inbox from
  // being sent to the Fastmail form, and stops the browser autofilling another
  // saved login into a blank field.
  const isReconnect = reconnect != null;
  const reconnectProvider = isReconnect
    ? (reconnect.service && reconnect.service !== 'generic' ? reconnect.service : 'generic')
    : null;
  const [provider, setProvider] = useState(reconnectProvider ?? 'generic');
  const [step, setStep] = useState(isReconnect ? 2 : 1);
  const [form, setForm] = useState(() => ({
    email: reconnect?.address ?? '',
    username: reconnect?.username ?? '',
    password: '',
    imapHost: reconnect?.imapHost ?? '',
    imapPort: reconnect?.imapPort ?? GENERIC_IMAP_DEFAULTS.imapPort,
    smtpHost: reconnect?.smtpHost ?? '',
    smtpPort: reconnect?.smtpPort ?? GENERIC_IMAP_DEFAULTS.smtpPort,
    imapSecurity: reconnect?.imapSecurity ?? (reconnect?.imapPort === 143 ? 'starttls' : 'tls'),
    smtpSecurity: reconnect?.smtpSecurity ?? (reconnect?.smtpPort === 587 ? 'starttls' : 'tls'),
  }));
  /**
   * Zoho's data center and account class, recovered from the stored host on a
   * reconnect.
   *
   * These two selects decide the hostname (see zohoHosts in imap-presets), and
   * they were the only identity fields in this form that a reconnect neither
   * seeded nor locked: they came up as the global data center and a personal
   * mailbox no matter what the row said. For the mailbox that motivated this,
   * a Zoho EU custom-domain account stored on imappro.zoho.eu, that meant the
   * reconnect resubmitted imap.zoho.com and a personal account type, which
   * cannot authenticate. Worse, had it authenticated, the connect route's
   * upsert writes imap_host unconditionally, so a successful reconnect would
   * have replaced a correct host with a wrong one.
   *
   * `zohoSettingsFromHost` is the exact inverse of `zohoHosts`, and it returns
   * null rather than guessing for a host it does not recognise, so an unknown
   * host falls back to the same defaults a fresh connect starts from.
   */
  const reconnectZoho = isReconnect ? zohoSettingsFromHost(reconnect?.imapHost) : null;
  const [zohoRegion, setZohoRegion] = useState(reconnectZoho?.region ?? DEFAULT_ZOHO_REGION);
  const [zohoAccountType, setZohoAccountType] = useState(
    reconnectZoho?.accountType ?? DEFAULT_ZOHO_ACCOUNT_TYPE
  );
  // Optional login override for Yandex 360 custom-domain accounts whose IMAP
  // login differs from the email address. Blank → authenticate with the email.
  // On a reconnect of a Yandex inbox, seed it with the stored login.
  const [yandexLogin, setYandexLogin] = useState(
    isReconnect && reconnectProvider === 'yandex' ? (reconnect.username ?? '') : ''
  );
  const [yandexAccountType, setYandexAccountType] = useState('personal');
  const [lastFailure, setLastFailure] = useState({ code: null, count: 0 });
  // Set when a connect route answers 402 inbox_limit_reached. The client-side
  // `atInboxLimit` prop is computed from the inbox list this page loaded with,
  // so it goes stale whenever the cap is reached in another tab, on another
  // device, or by a plan change mid-session. The server is the authority; when
  // it says the cap is hit, the modal switches to the same upgrade panel the
  // prop would have shown, rather than printing the route's unlocalised
  // fallback sentence as a form error.
  const [serverLimit, setServerLimit] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);
  /**
   * The fields the last failed submit was actually about.
   *
   * The alert at the bottom of the body was the only trace a rejected submit
   * left: no field carried `aria-invalid`, none pointed at the message, and
   * focus stayed wherever it was. "IMAP and SMTP host are required" is a
   * perfectly clear sentence in a form with five text boxes and no indication
   * of which two it means.
   *
   * A list rather than a single key because one message can be about two
   * fields at once (both hosts, both ports). The first entry is the one focus
   * goes to.
   */
  const [invalidFields, setInvalidFields] = useState([]);
  /**
   * A counter bumped by every error we put on screen, including a repeat of the
   * one already there.
   *
   * Two identical rejections produce identical text, and a live region whose
   * content does not change announces nothing. This is the value that makes the
   * announce-and-scroll effect run for the second one; see `announce` for the
   * clear-then-rewrite it drives.
   */
  const [errorSeq, setErrorSeq] = useState(0);
  const bumpErrorSeq = () => setErrorSeq(n => n + 1);
  /**
   * What the three persistent announcers are saying right now.
   *
   * One channel per kind of notice rather than one shared region, because they
   * coexist: a detected provider, a port lifted out of a host, and a rejected
   * submit can all be true at the same moment, and writing them into one region
   * would make each new one silence the last.
   */
  const [live, setLive] = useState({ detect: '', port: '', portError: '', error: '' });
  const liveFrames = useRef({ detect: 0, port: 0, portError: 0, error: 0 });
  const liveSettle = useRef({ detect: 0, port: 0, portError: 0, error: 0 });
  // The long-form troubleshooting text that used to lead the alert. It is kept,
  // but behind a disclosure, so the first thing the user reads is one sentence.
  const [errorDetail, setErrorDetail] = useState(null);
  const [errorDetailOpen, setErrorDetailOpen] = useState(false);
  // A rejected password is replaced far more often than it is edited, so after
  // a failure the field is focused with its contents selected: the next
  // keystroke overwrites it.
  const passwordRef = useRef(null);
  /**
   * The error alert, so it can be scrolled to when it appears.
   *
   * The alert renders at the bottom of a form that is taller than the modal
   * body, and the submit button lives in the fixed footer. So pressing Connect
   * on a long form (Advanced settings open, or simply a small window) set an
   * error 300px below the fold and, from the user's side, did nothing at all.
   * That is the same dead end the retry numbers describe, and it is worse for
   * the pre-submit shape warning, which has no request and therefore not even a
   * spinner to show that the click registered.
   */
  const errorAlertRef = useRef(null);
  // Armed only by a rejected credential, and spent by the first focus that
  // follows. Selecting on EVERY focus meant that clicking back into the field
  // to fix one character of a 16-character app password destroyed the value on
  // the next keystroke, which is unrecoverable when the field is dots.
  const selectPasswordOnFocus = useRef(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  // Whether the secondary Gmail route (Google sign-in) is expanded. Closed by
  // default: it is the option the app-password default exists to move traffic
  // away from, and the walkthrough of Google's unverified-app screens inside
  // it is three paragraphs that nobody taking the default has to read.
  const [gmailOauthOpen, setGmailOauthOpen] = useState(false);
  const [appPwHelpOpen, setAppPwHelpOpen] = useState(false);
  // Set when the address the user typed identified a known mail provider and we
  // filled the server fields in for them. Shape:
  // { label, requiresAppPassword, appPasswordHelpUrl }.
  const [hostPrefill, setHostPrefill] = useState(null);
  // Which of the credential situations the last rejection was, from the route's
  // `auth_reason` (or decided here, before submitting, for a password that
  // cannot be this provider's app password). Null whenever the last failure was
  // not about a credential at all.
  const [authReason, setAuthReason] = useState(null);
  /**
   * True when the LAST failure was a 401.
   *
   * Its own flag rather than a read of `lastFailure.code`, which survives
   * deliberately: `lastFailure` is the repeat counter, so it has to outlive one
   * rejection to notice the same code twice. Keying the sign-in link off it
   * meant a 401 followed by a dropped connection printed "Network error" with
   * a "Sign in again" link underneath it, which is the wrong instruction. This
   * flag is cleared by `showError` alongside `authReason`, so it belongs to
   * exactly one rejection.
   */
  const [sessionExpired, setSessionExpired] = useState(false);
  // The exact secret we have already warned about the shape of.
  //
  // The shape rule is evidence, not a gate. It is right often enough to be
  // worth saying before a doomed request is sent and a failed login is counted
  // against the account, but a provider can change its format tomorrow, and a
  // client-side rule that cannot be overridden would then lock out every user
  // of that provider. So it speaks once and then gets out of the way: pressing
  // Connect a second time on the same value submits it.
  const shapeWarnedFor = useRef(null);

  /**
   * Advanced settings (generic IMAP only): ports, security modes and the
   * optional login username. Collapsed by default because they are noise for
   * nearly every mailbox, but NEVER collapsed over a value that differs from
   * the default. A reconnect carrying port 143, STARTTLS or a separate login
   * username opens the section on mount, so nothing the user is about to
   * submit is hidden from them.
   */
  const [advancedOpen, setAdvancedOpen] = useState(() => {
    const imapSecurity = reconnect?.imapSecurity ?? (reconnect?.imapPort === 143 ? 'starttls' : 'tls');
    const smtpSecurity = reconnect?.smtpSecurity ?? (reconnect?.smtpPort === 587 ? 'starttls' : 'tls');
    // A non-default PORT is deliberately not in this test any more. It used to
    // be, and it had to be, because the port field lived inside the panel and
    // a reconnect on 143 would otherwise have hidden the number it was about
    // to submit. The ports are now on the form itself, always visible, so
    // opening the panel for one would open it to point at a field that is not
    // in it. Only the two things still inside can force it open.
    return (
      imapSecurity !== 'tls' ||
      smtpSecurity !== GENERIC_IMAP_DEFAULTS.smtpSecurity ||
      Boolean(reconnect?.username)
    );
  });
  // Set when a port was lifted out of a host field, so the move is announced
  // rather than silently applied to a field that may be out of sight.
  // Shape: { protocol: 'imap' | 'smtp', port: number }.
  const [portNote, setPortNote] = useState(null);
  // Set when the digits in a host field could not be a port (0, or above
  // 65535). They are stripped off the host either way, so without this the
  // user would watch their text change with no explanation, and the submit
  // would quietly use the default port instead of the one they meant.
  // Shape: 'imap' | 'smtp' | null.
  const [portRangeError, setPortRangeError] = useState(null);
  // When the user clicks outside the modal (the scrim) after typing
  // credentials, show a discard confirmation instead of closing outright so
  // an accidental click doesn't wipe what they entered.
  const [confirmingClose, setConfirmingClose] = useState(false);

  /**
   * Whether this component is still on screen.
   *
   * A verification takes up to about 40 seconds of connecting (IMAP then SMTP,
   * PROTOCOL_BUDGET_MS of 20s each, in sequence), and the modal can be gone
   * before the answer arrives. Writing state after that is a React warning at
   * best and, in the failure path, a `showError` into a component that no
   * longer exists. Every post-await write goes through this flag, and the
   * outcome is delivered as a toast instead when it is false.
   */
  const mountedRef = useRef(true);
  /** True while the open discard confirmation is the one guarding a check. */
  const confirmOpenedDuringCheck = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  /**
   * Say something through one of the persistent announcers.
   *
   * Clear first, write on the next frame. Assistive technology announces a live
   * region when its CONTENT CHANGES, so writing the same string twice is
   * silence: the second identical rejection, the second "moved port 993" after
   * the user pastes the same host again. Emptying the region and filling it one
   * frame later is a change either way, which is the established fix and the
   * reason this is not a plain `setLive`.
   *
   * Timeouts, NOT requestAnimationFrame, and this is the whole reason the two
   * are not interchangeable here: a frame callback only runs while the page is
   * compositing. Measured in this app, a tab that is loaded and
   * `document.visibilityState === 'visible'` but not being painted never fired
   * one at all, so an rAF-based announcer sat silent with the text queued
   * behind a callback that would never run. A timeout is throttled in a
   * backgrounded tab; it is not withheld. (The same trap already cost this file
   * a smooth scroll; see the scroll effect below.)
   *
   * Both writes are deferred, the clear included, so that the effects that call
   * this schedule work rather than setting state in their own bodies.
   */
  const announce = (channel, text) => {
    if (typeof window === 'undefined') return;
    window.clearTimeout(liveFrames.current[channel]);
    window.clearTimeout(liveSettle.current[channel]);
    const next = text ? String(text) : '';
    liveFrames.current[channel] = window.setTimeout(() => {
      // The verification outlives this component (see `mountedRef`), so a timer
      // can land after the modal has gone.
      if (!mountedRef.current) return;
      // `flushSync`, and it is load-bearing. Two ordinary updates a task apart
      // are still free to be coalesced into one render, and measured here they
      // were: on roughly half the repeats the region went straight from the old
      // sentence to the identical new one with no mutation in between, which is
      // precisely the silence this whole arrangement exists to break. Forcing
      // the empty state to commit on its own makes the clear observable, so the
      // write that follows it is a change every time.
      flushSync(() => {
        setLive(prev => (prev[channel] === '' ? prev : { ...prev, [channel]: '' }));
      });
      if (!next) return;
      liveFrames.current[channel] = window.setTimeout(() => {
        if (!mountedRef.current) return;
        setLive(prev => ({ ...prev, [channel]: next }));
        // And empty it again once it has been spoken. A live region keeps
        // whatever was written into it, and everything written here is ALSO on
        // screen as ordinary text that the field it belongs to points at, so a
        // region left holding the sentence makes a screen reader read the whole
        // dialog with every notice in it twice. Four seconds is long past the
        // announcement and long before anyone reaches this part of the form.
        liveSettle.current[channel] = window.setTimeout(() => {
          if (!mountedRef.current) return;
          setLive(prev => (prev[channel] === next ? { ...prev, [channel]: '' } : prev));
        }, 4000);
      }, 0);
    }, 0);
  };

  useEffect(() => {
    const timers = liveFrames.current;
    const settle = liveSettle.current;
    return () => {
      Object.values(timers).forEach(id => window.clearTimeout(id));
      Object.values(settle).forEach(id => window.clearTimeout(id));
    };
  }, []);

  /**
   * The form controls, by name, so a rejected submit can put focus on the field
   * it is about.
   *
   * Keyed rather than one ref per input because the validation messages come in
   * lists ("IMAP and SMTP host are required" is about two of them) and the
   * caller wants "the first of these that exists", not five nullable refs.
   */
  const fieldRefs = useRef({});
  const bindField = key => node => { fieldRefs.current[key] = node; };
  const isInvalid = key => invalidFields.includes(key);
  /** aria-describedby, from however many ids happen to be on screen. */
  const describedBy = (...ids) => {
    const value = ids.filter(Boolean).join(' ');
    return value || undefined;
  };

  // The upgrade panel replaces the provider picker and the credentials form,
  // whether the cap was known up front (prop) or learned from a 402 (state).
  // The server's numbers win when present: they were counted at the moment of
  // the refusal, the prop's were counted at page load.
  const showLimitPanel = atInboxLimit || serverLimit !== null;

  // Record the panel being shown, once per modal-open. Both routes into it are
  // counted (the prop's up-front gate and the 402 fallback) because both put
  // the same price in front of the same user; the row itself does not separate
  // them, since the 402 path already leaves an `inbox_connection` /
  // `plan_limit` failure of its own to join against. A reconnect never reaches
  // the panel and is excluded at the source rather than relied on to be
  // impossible.
  useInboxPaywallView({ isReconnect, atInboxLimit, serverLimitReached: serverLimit !== null });

  const limitPlanName = serverLimit?.planName ?? planName;
  const limitInboxCount = serverLimit?.inboxCount ?? inboxCount;
  const limitMaxInboxes = serverLimit?.maxInboxes ?? maxInboxes;
  const limitUpgradeUrl = serverLimit?.upgradeUrl ?? '/pricing';

  // Which plan this panel should sell, and therefore which copy it carries.
  // The rule (cheapest plan that clears the cap that was hit) lives in
  // inboxCapOffer, shared verbatim with the cap notice on the Inboxes page, so
  // the two surfaces can never quote different plans for the same block.
  const upgradeCopy = inboxCapOffer(limitMaxInboxes);

  // MONTHLY, deliberately, and it stays monthly unless the person picks
  // otherwise. This panel used to have no interval at all and always bought
  // monthly, so anyone who ignores the new control is charged exactly what the
  // same click charged them before it existed. Defaulting to annual would turn
  // a $5 decision into a $48 one without the buyer changing anything they did.
  const [upgradeInterval, setUpgradeInterval] = useState('month');
  // Null whenever annual cannot be sold for this plan (no configured yearly
  // Stripe price, or no live prices on this surface at all), in which case the
  // control renders nothing and the CTA below stays the monthly one.
  const annual = annualOfferForPlan(stripePrices, upgradeCopy.plan);

  // ── Provider categories ─────────────────────────────────────────────────────

  const isPreset = isBrandedImapService(provider);
  const isGeneric = provider === 'generic';
  const preset = isPreset ? IMAP_PRESETS[provider] : null;
  /** True when "Connect" should open the in-modal credentials step. */
  // Fastmail connects via app password (IMAP/SMTP); Fastmail OAuth is partner-
  // gated and unsupported here, so it is not offered.
  const usesAppPassword =
    isPreset || isGeneric || provider === 'fastmail';

  /**
   * True once the user has set a port themselves, in any of the three ways
   * they can: typing in a port field, choosing a security mode (which moves
   * the port to the matching standard), or pasting a host with a port glued to
   * it. From that moment detection may still fill in a HOST, but it must never
   * touch a port or a security mode again.
   *
   * A ref rather than state because nothing renders from it and because the
   * value has to be readable inside a fetch callback that closed over an older
   * render.
   */
  const portsTouched = useRef(false);

  /**
   * The domain the last detection ran for, and a monotonic run id.
   *
   * Detection is asynchronous and the user keeps typing, so two answers can be
   * in flight for two different addresses. The run id is what makes the older
   * one a no-op instead of a value that lands half a second after the user has
   * moved on to a different domain.
   */
  const detectRunRef = useRef(0);
  const detectedDomainRef = useRef(null);
  /**
   * True when the last detection actually wrote the host fields, false when it
   * recognised the provider and left the user's own values alone.
   *
   * A ref, not state: it is set from inside the `setForm` updater in
   * `applyDiscovery` (the only place that can see whether the fields were
   * empty) and read back on the render that the accompanying `setHostPrefill`
   * causes, which React runs after that updater. Nothing renders from it on its
   * own, so it never needs to schedule a render of its own.
   */
  const discoveryFilledHostsRef = useRef(false);

  /**
   * Fill the server fields in from the address, when we can work out where the
   * mailbox lives.
   *
   * The generic form asks for two hostnames, two ports and two security modes,
   * and a user who does not have them in front of them has no way to produce
   * them except by guessing. The production record is exactly that: twelve
   * consecutive attempts against one host with the port and security mode
   * alternating between the two standard pairs. Every entry in the lookup table
   * is a provider that produced repeated failures like it.
   *
   * Only ever fills EMPTY fields, and the check is made inside the state
   * updater rather than against a captured render, because a network answer
   * arrives after the user has had time to type into them. A host the user
   * typed came from their provider's own documentation and is better than
   * anything we can derive by definition, and silently rewriting it would be
   * the same class of bug as a browser autofilling the wrong login.
   */
  const applyDiscovery = (match, run) => {
    // A stale answer: the address changed while this one was in flight.
    if (run !== detectRunRef.current) return;
    if (!match) { setHostPrefill(null); return; }
    // Recognising the provider and filling the fields are two different things,
    // and only the second one is unsafe to repeat. This used to return before
    // recording the match, so anyone who typed their host BEFORE their address
    // (which the tab order does not prevent) lost the provider guidance
    // entirely, on exactly the providers whose password rules are the problem.
    setHostPrefill({
      label: match.label,
      requiresAppPassword: match.requiresAppPassword,
      appPasswordHelpUrl: match.appPasswordHelpUrl,
      source: match.source ?? 'table',
    });
    setForm(prev => {
      const alreadyHasHosts = Boolean(prev.imapHost.trim() || prev.smtpHost.trim());
      // Whether the fields were actually written, recorded here because this is
      // the only place that sees the state the decision is made against. The
      // note above the form used to claim "the server settings below are filled
      // in for you" unconditionally, which is a lie for anyone who typed their
      // host before their address: nothing was filled, the sentence said it
      // was, and the next thing the user does is look for values that are not
      // there. Read back at render, which happens after this updater has run.
      discoveryFilledHostsRef.current = !alreadyHasHosts;
      if (alreadyHasHosts) return prev;
      const ports = portsTouched.current
        ? null
        : {
            imapPort: match.imapPort,
            imapSecurity: match.imapSecurity,
            smtpPort: match.smtpPort,
            smtpSecurity: match.smtpSecurity,
          };
      return { ...prev, imapHost: match.imapHost, smtpHost: match.smtpHost, ...ports };
    });
  };

  /**
   * Work out where the address's mail lives: table first, then the domain's own
   * DNS records through /api/inboxes/autodiscover.
   *
   * The table is consulted here, in the browser, before anything is sent. It
   * is the answer for every address on a provider's own domain, it is instant,
   * and asking a server for something the client already knows would put a
   * round trip in front of the common case for no gain. The request only goes
   * out for the case the table cannot serve, which is the one the whole
   * feature exists for: a custom domain whose mail is delegated somewhere we
   * would recognise if only we could see it. hello@mcpemails.com is that case
   * exactly, and its answer comes back from the domain's own SRV records.
   *
   * Never blocks, never raises, and shows nothing when DNS has nothing to say.
   * A user typing an address into a form does not need to be told that their
   * domain publishes no service records; they need the fields they were always
   * going to fill in themselves.
   */
  const detectMailSettings = (rawEmail) => {
    if (!isGeneric || isReconnect) return;
    const domain = emailDomain(String(rawEmail ?? '').trim());
    // Not an address yet, or a domain still being typed. `example.` and
    // `example` are both "keep going", not "no such provider".
    if (!domain || !domain.includes('.') || domain.endsWith('.')) return;
    if (detectedDomainRef.current === domain) return;
    detectedDomainRef.current = domain;
    const run = detectRunRef.current + 1;
    detectRunRef.current = run;

    const local = prefillFromDomain(domain);
    if (local) { applyDiscovery({ ...local, source: 'table' }, run); return; }

    fetch('/api/inboxes/autodiscover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The DOMAIN, not the address. Nothing in the lookup uses the local
      // part, so there is no reason for a mailbox name to travel to a route
      // whose whole job is to ask public DNS a question.
      body: JSON.stringify({ domain }),
    })
      .then(response => {
        // A refusal is not an answer about the domain. Forget that we asked, so
        // that a later blur on the same address can try again rather than the
        // domain being permanently marked as "already looked up" on the
        // strength of one 429 or one dropped connection.
        if (!response.ok) { detectedDomainRef.current = null; return null; }
        return response.json();
      })
      .then(data => { applyDiscovery(data?.found ? data.settings : null, run); })
      .catch(() => {
        /* detection is an assist, never a gate */
        detectedDomainRef.current = null;
      });
  };

  /**
   * Run detection while the user is still typing, not only when they leave the
   * field.
   *
   * Waiting for blur was the whole reason the old prefill so often did nothing:
   * the fields it fills sit directly below the address, so the natural next act
   * after typing an address is to look down at an empty IMAP host, not to tab.
   *
   * 500ms of stillness, and not one keystroke sooner. Reacting per character
   * would match half-typed domains, and on the network path it would be a DNS
   * query per keystroke. `detectMailSettings` also remembers the last domain it
   * ran for, so the blur handler and this timer cannot produce two lookups for
   * the same address.
   */
  useEffect(() => {
    if (!isGeneric || isReconnect || step !== 2) return undefined;
    const email = form.email;
    const timer = setTimeout(() => detectMailSettings(email), 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.email, isGeneric, isReconnect, step]);

  /**
   * Keep the transport security and the port consistent in the generic form.
   *
   * These two fields describe one decision, and letting them disagree is what
   * produced the two largest classes of generic IMAP failure in production:
   * STARTTLS left on port 993 stalls waiting for a greeting that a TLS-only
   * listener will never send (recorded as a timeout in the `greeting` phase),
   * and implicit TLS pointed at 143 fails the handshake. Changing the security
   * mode therefore moves the port to the matching standard, and typing a
   * standard port moves the security mode to match it. A non-standard port
   * implies nothing, so the user's explicit choice is left untouched.
   */
  const setSecurity = (protocol, security) => {
    // Choosing a security mode moves the port with it, so this counts as the
    // user having set the port. Detection must not move it back afterwards.
    portsTouched.current = true;
    setForm(prev => ({
      ...prev,
      [protocol === 'imap' ? 'imapSecurity' : 'smtpSecurity']: security,
      [protocol === 'imap' ? 'imapPort' : 'smtpPort']: portForSecurity(protocol, security),
    }));
  };

  const setPort = (protocol, value) => {
    // Every caller of this is the user: the port inputs, and the lift of a port
    // out of a pasted host. Either way the port is now theirs, and autodiscovery
    // is barred from touching it or its security mode from here on.
    portsTouched.current = true;
    // Any deliberate edit of a port field supersedes the "moved your port here"
    // note, which is only ever about the value that was just lifted for them.
    setPortNote(null);
    const implied = securityForPort(protocol, Number(value));
    setForm(prev => ({
      ...prev,
      [protocol === 'imap' ? 'imapPort' : 'smtpPort']: value,
      ...(implied ? { [protocol === 'imap' ? 'imapSecurity' : 'smtpSecurity']: implied } : {}),
    }));
  };

  /**
   * Lift a pasted port (or a pasted URL) out of a host field and into the
   * matching port field.
   *
   * Runs on blur rather than on every keystroke: reacting mid-typing would move
   * "9" into the port box while the user is still typing "993". It also runs
   * once more on submit, so a port typed into the host is never discarded even
   * if the field never lost focus.
   *
   * Returns the resolved { host, port } so the submit path can use the values
   * without waiting for a re-render.
   */
  const normalizeHostField = protocol => {
    const key = protocol === 'imap' ? 'imapHost' : 'smtpHost';
    const parsed = splitHostPort(form[key]);
    // A port lifted out of a host is rejected on the same rule the port select
    // offers and the same rule the server enforces: an impossible number (0, or
    // above 65535) or a possible one the mail guard will not dial. Pasting
    // `mail.example.com:2525` used to sail through every client-side check and
    // come back forty seconds later as an unexplained failure, because
    // `port_not_allowed` had no headline and no way to open the field.
    const portRejected =
      parsed.portError === 'range' ||
      (parsed.port !== null && !ALLOWED_MAIL_PORTS[protocol].has(parsed.port));
    const result = { ...parsed, portRejected };
    // Reconnect locks the server fields: nothing to rewrite, and the stored
    // host is the row's identity.
    if (isReconnect) return result;
    if (parsed.host !== form[key]) {
      setForm(prev => ({ ...prev, [key]: parsed.host }));
    }
    if (parsed.port !== null && !portRejected) {
      // Reuse the port setter so the security mode still follows a standard
      // port, exactly as if the value had been chosen in the port field.
      setPort(protocol, String(parsed.port));
      // No setAdvancedOpen here any more: the port field the value just moved
      // into is on screen, directly to the right of the host it came out of,
      // so the note below points at something the user can already see.
      setPortNote({ protocol, port: parsed.port });
    }
    // A port we cannot use is named on the spot, and named as the same thing
    // whichever way it was unusable: the user's question is "what may I put
    // here", and the answer is the five ports, not a distinction between "not a
    // number at all" and "a number we will not dial". The alternative is what
    // the field used to do: keep the digits on the hostname, hand the whole
    // string to DNS, and answer with "could not reach that server", which sends
    // the user hunting for a network fault that does not exist.
    if (portRejected) {
      setPortNote(null);
      setPortRangeError(protocol);
      // Pasting the same unusable host twice is the same sentence twice, and an
      // unchanged live region says nothing. The counter is what makes the
      // second one a change.
      bumpErrorSeq();
    } else if (portRangeError === protocol) {
      setPortRangeError(null);
    }
    return result;
  };

  /**
   * Replace the alert with a single sentence and no expandable detail.
   *
   * `fields` names the controls the sentence is about. They get `aria-invalid`
   * and a pointer at the message; everything else is cleared, so a host error
   * cannot leave the password box marked invalid from the attempt before.
   */
  const showError = (message, fields = []) => {
    setFormError(message);
    setInvalidFields(fields);
    if (message) bumpErrorSeq();
    setErrorDetail(null);
    setErrorDetailOpen(false);
    // The credential explanation belongs to one rejection. Leaving it behind
    // would attach "your normal password will not work here" to the next
    // failure, which may be a hostname.
    setAuthReason(null);
    setSessionExpired(false);
  };

  /**
   * Refuse a submit AT the field that caused it.
   *
   * Focus moves, which is the half that was missing. The alert renders at the
   * bottom of a body that is taller than the modal, so on a form with Advanced
   * settings open the whole feedback for a missing hostname was a sentence
   * below the fold and a cursor that had not moved. Scrolling the alert into
   * view (the effect further down) tells a sighted user that something
   * happened; only moving focus tells them, and a screen reader user, WHERE.
   */
  const failValidation = (message, fields) => {
    showError(message, fields);
    const target = fields
      .map(key => fieldRefs.current[key])
      .find(node => node && typeof node.focus === 'function');
    if (target) target.focus();
  };

  // ── Step 1: the provider radiogroup ────────────────────────────────────────

  /** Chip DOM nodes, so arrow keys can move focus as well as selection. */
  const chipRefs = useRef({});
  /** Outlook is not selectable yet, so it is not part of the arrow order. */
  const selectableProviders = PROVIDERS.filter(p => !p.disabled);

  const selectProviderAt = index => {
    const count = selectableProviders.length;
    const next = selectableProviders[((index % count) + count) % count];
    if (!next) return;
    setProvider(next.k);
    chipRefs.current[next.k]?.focus();
  };

  /**
   * Radiogroup keyboard behaviour. The group is one tab stop (see the roving
   * tabIndex below) and the arrows move within it, which is what a screen
   * reader user is told to expect the moment they hear "radio group". Space
   * has to be prevented too, or it selects the chip and scrolls the modal.
   */
  const handleChipKeyDown = (event, p) => {
    if (p.disabled) return;
    const current = selectableProviders.findIndex(item => item.k === provider);
    const from = current === -1 ? 0 : current;
    switch (event.key) {
      case 'Enter':
      case ' ':
        event.preventDefault();
        setProvider(p.k);
        break;
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        selectProviderAt(from + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        selectProviderAt(from - 1);
        break;
      case 'Home':
        event.preventDefault();
        selectProviderAt(0);
        break;
      case 'End':
        event.preventDefault();
        selectProviderAt(selectableProviders.length - 1);
        break;
      default:
        break;
    }
  };

  // ── Step 1: provider selected ──────────────────────────────────────────────

  /**
   * Record that a provider was chosen, before anything navigates away.
   *
   * Both ways out of step 1 go through here. Gmail now has two of them, and
   * the secondary one leaves no other trace: counting only the app-password
   * clicks would make the new default look better than it is precisely
   * because the people who rejected it are the ones who went missing.
   *
   * NOT awaited by any caller, and deliberately not `async` any more, so that
   * a caller cannot accidentally start awaiting it again. This function used
   * to await its own POST, and every route out of step 1 awaited this
   * function, which put a full round trip to /api/onboarding in front of a
   * state change that needs no server at all. Signed out that route answers
   * 401 in ~20ms; signed in it does getUser, resolves the active workspace,
   * writes two workspace columns and records a funnel row before it answers,
   * and that is the second the user spent watching a button they had already
   * pressed.
   *
   * `keepalive: true` is what makes it safe to fire and forget on the paths
   * that navigate away in the very next statement: the fetch spec lets a
   * keepalive request outlive the document that started it. Verified against
   * this app rather than taken on trust — the request reaches the route and is
   * logged there even when `window.location.href` is assigned on the next
   * line. The try/catch is still here because a rejected promise with no
   * handler is an unhandled rejection, which is noisier than the analytics row
   * is valuable.
   */
  const recordProviderSelected = (chosen) => {
    trackProductEvent('inbox_connect_started', { provider: chosen === 'generic' ? 'imap' : chosen });
    try {
      fetch('/api/onboarding', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'provider_selected', provider: chosen === 'generic' ? 'generic_imap' : chosen }),
        keepalive: true,
      }).catch(() => { /* the connection remains available if analytics is unavailable */ });
    } catch { /* the connection remains available if analytics is unavailable */ }
  };

  const handleConnect = () => {
    recordProviderSelected(provider);
    if (usesAppPassword) {
      // Synchronous, in the click's own task. Nothing about opening the
      // credentials form depends on an answer from the server.
      setStep(2);
      return;
    }
    // OAuth paths (Outlook, Fastmail OAuth) navigate to the server-side
    // initiation route. The page reloads after the provider redirects back.
    window.location.href = OAUTH_ROUTES[provider];
  };

  /** The secondary Gmail route: Google sign-in, unchanged, one click down. */
  const handleGmailOauth = () => {
    recordProviderSelected('gmail');
    // A whole-document navigation, not a router push: /auth/gmail is a server
    // route handler that answers with a redirect to Google's consent screen,
    // not a page this app renders.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = OAUTH_ROUTES.gmail;
  };

  // Gmail is absent on purpose: its primary button now opens the credentials
  // step like every other app-password provider. "Connect with Google" moved
  // to the secondary OAuth block, which is the only thing that still leaves
  // the app for a consent screen.
  const connectLabel = () => {
    if (provider === 'outlook') return tr('connect.connectWithMicrosoft');
    return tr('connect.enterCredentials');
  };

  /** Human label for the selected provider, used in step-2 copy. */
  const providerLabel = () => {
    if (provider === 'fastmail') return 'Fastmail';
    if (preset) return preset.label;
    if (isGeneric) return tr('connect.genericLabel');
    return tr('connect.providerInboxFallback');
  };

  /**
   * Where to send someone whose login was refused, and the name to call the
   * provider while doing it.
   *
   * The branded cards know this from the card that was clicked. The generic
   * form did not, so a Yahoo or iCloud mailbox connected through it got the
   * same "check your password" as everything else, when the actual answer is
   * that the account password cannot work at all and an app password has to be
   * generated first. The address is enough to know which of those it is.
   */
  /**
   * The provider this attempt is really against, whichever door the user came
   * through: the branded card they clicked, or, in the generic form, whatever
   * the address and the mail host identify. Recomputed each render rather than
   * stored, so it is right from the first character of a recognised domain
   * instead of only after the email field loses focus.
   */
  const activePolicy = identifyAppPasswordProvider({
    service: isGeneric ? null : provider,
    email: form.email,
    host: isGeneric ? form.imapHost : null,
  });
  const appPasswordUrl = activePolicy?.helpUrl ?? null;
  const appPasswordProvider = activePolicy?.label ?? providerLabel();
  /** Named guidance for the credential, when we know what this provider calls it. */
  const appPasswordStepsKey = activePolicy ? APP_PASSWORD_STEP_KEYS[activePolicy.provider] : null;
  /**
   * True when this mailbox takes a generated app password rather than the
   * account password. It is a property of the PROVIDER, not of which form the
   * user is standing in, so the generic form says "App password" too once the
   * address has identified one. Leaving the generic label and its "use your
   * mailbox password" hint in place there contradicted the provider guidance
   * printed directly underneath it.
   */
  const needsAppPassword = Boolean(activePolicy?.requiresAppPassword);

  // ── The notices, as text ───────────────────────────────────────────────────
  // Computed once, here, rather than inline in the JSX, because each of them is
  // needed twice: once for the span the user reads and once for the announcer
  // that reads it out. Two copies of the same conditional would be two chances
  // for the visible sentence and the spoken one to drift apart.

  /**
   * What the detection found, and whether it changed anything.
   *
   * Two sentences, not one. `prefill` only ever writes into EMPTY host fields
   * (see applyDiscovery), which is the right rule: a host the user typed came
   * out of their provider's own documentation and is better than anything we
   * can derive. But the note said "the server settings below are filled in for
   * you" either way, so someone who filled the host first was told their form
   * had been completed when it had not.
   */
  const hostPrefillNote = (() => {
    if (!isGeneric || !hostPrefill) return null;
    const filled = discoveryFilledHostsRef.current;
    if (!hostPrefill.label) {
      return tr(filled ? 'connect.hostDetectedNote' : 'connect.hostDetectedNoteKept');
    }
    const key = hostPrefill.source === 'table'
      ? (filled ? 'connect.hostPrefillNote' : 'connect.hostPrefillNoteKept')
      : (filled ? 'connect.hostDetectedProviderNote' : 'connect.hostDetectedProviderNoteKept');
    return tr(key, { provider: hostPrefill.label });
  })();

  /** The credential this detected provider actually takes, when it takes a special one. */
  const hostPrefillAppPasswordNote =
    isGeneric && hostPrefill?.requiresAppPassword && hostPrefill.label
      ? tr('connect.hostPrefillAppPassword', { provider: hostPrefill.label })
      : null;

  /** "Moved port 993 into the IMAP port field", for whichever field it was. */
  const portMovedNote = portNote
    ? tr('connect.portMovedNote', {
        port: String(portNote.port),
        protocol: portNote.protocol === 'imap' ? 'IMAP' : 'SMTP',
      })
    : null;

  const portRangeNote = portRangeError ? tr('connect.errorPortRange') : null;

  // ── Step 2: credentials submission ─────────────────────────────────────────

  const handleAppPasswordSubmit = async () => {
    showError(null);

    const email = form.email.trim().toLowerCase();
    // App-password providers issue tokens that never contain whitespace, but
    // they display them in groups and copy-paste readily drags in a stray
    // space, newline or non-breaking space. Those characters travel inside the
    // SASL token and come back as an ordinary credential rejection, so the user
    // is told to fix a password that was already right.
    //
    // The test is what the credential IS, not which form it was typed into. A
    // generic-form mailbox whose address identifies iCloud is being given an
    // Apple app-specific password, displayed in four groups, and stripping the
    // spaces out of it is as right there as on the branded card. A generic
    // mailbox we cannot identify keeps its whitespace: that value is a real
    // account password and a space in it may well be deliberate.
    const appPassword =
      isGeneric && !activePolicy?.requiresAppPassword
        ? form.password.trim()
        : normalizeAppPassword(form.password);

    if (!email || !email.includes('@')) {
      failValidation(tr('connect.errorEmailRequired'), ['email']);
      return;
    }
    if (!appPassword) {
      failValidation(tr('connect.errorPasswordRequired'), ['password']);
      return;
    }

    // Resolve the connect endpoint + body for the selected provider.
    let endpoint;
    let body;
    if (provider === 'fastmail') {
      endpoint = '/api/inboxes/fastmail-app-password';
      body = { email, appPassword };
    } else if (isPreset) {
      endpoint = '/api/inboxes/app-password';
      body = { service: provider, email, appPassword };
      if (provider === 'zoho') {
        body.region = zohoRegion;
        body.zohoAccountType = zohoAccountType;
      }
      if (provider === 'yandex') {
        // Optional login override for Yandex 360 custom-domain accounts. Only
        // sent when non-empty; blank authenticates with the email address.
        const login = yandexLogin.trim();
        if (login) body.loginUsername = login;
        body.yandexAccountType = yandexAccountType;
      }
    } else {
      // Generic IMAP/SMTP. Parse the host fields once more here: blur normally
      // does this, but a user who pastes and immediately clicks Connect (or
      // submits from the password field) never blurs the host, and the port
      // they typed must not be thrown away.
      const imapParsed = normalizeHostField('imap');
      const smtpParsed = normalizeHostField('smtp');
      // Digits that cannot be used as a port were just stripped off a host
      // field. Submitting anyway would connect on the default port, which is
      // not what the user asked for, so stop and say which ports are accepted.
      if (imapParsed.portRejected || smtpParsed.portRejected) {
        // The offending text is in the HOST box, which is where the digits were
        // typed and where they have just been stripped from, so that is the
        // field the message is about and the field focus goes to.
        failValidation(
          tr('connect.errorPortRange'),
          [imapParsed.portRejected ? 'imapHost' : null, smtpParsed.portRejected ? 'smtpHost' : null].filter(Boolean)
        );
        return;
      }
      const imapHost = imapParsed.host.toLowerCase();
      const smtpHost = smtpParsed.host.toLowerCase();
      const imapPort = Number(imapParsed.port ?? form.imapPort);
      const smtpPort = Number(smtpParsed.port ?? form.smtpPort);
      if (!imapHost || !smtpHost) {
        // "IMAP and SMTP host are required" names two fields, so both are
        // marked; focus goes to the first one that is actually empty rather
        // than always to the IMAP box, which would move the cursor away from
        // the field the user still has to fill.
        failValidation(
          tr('connect.errorHostRequired'),
          [!imapHost ? 'imapHost' : null, !smtpHost ? 'smtpHost' : null].filter(Boolean)
        );
        return;
      }
      if (!imapPort || !smtpPort) {
        failValidation(
          tr('connect.errorPortRequired'),
          [!imapPort ? 'imapPort' : null, !smtpPort ? 'smtpPort' : null].filter(Boolean)
        );
        return;
      }
      endpoint = '/api/inboxes/imap';
      // Optional: a login username distinct from the email address. Blank means
      // the server authenticates with the email address.
      const username = form.username.trim();
      // A port lifted out of a host field on this very click has not reached
      // `form` yet, so derive the security mode from the port that is actually
      // being submitted. Otherwise a pasted `imap.example.com:143` would be
      // sent with implicit TLS and fail the handshake.
      const imapSecurity = (imapParsed.port !== null ? securityForPort('imap', imapPort) : null) ?? form.imapSecurity;
      const smtpSecurity = (smtpParsed.port !== null ? securityForPort('smtp', smtpPort) : null) ?? form.smtpSecurity;
      body = { email, username, appPassword, imapHost, imapPort, smtpHost, smtpPort, imapSecurity, smtpSecurity };
    }

    // Last gate before the network call, and deliberately last: a missing host
    // or an impossible port is a structural problem with the form, and talking
    // about the password while one of those is outstanding points at the wrong
    // field.
    //
    // A secret that cannot be this provider's app password is worth naming
    // before the request rather than after it. The attempt would fail anyway,
    // but it would fail expensively: the provider counts it as a bad login, and
    // several of them lock the account after a handful. The recorded average is
    // 3.9 failed attempts per affected workspace and the worst case is 24.
    //
    // It speaks once. `shapeWarnedFor` remembers the value it objected to, so a
    // second Connect on the same string goes through and the rule can never be
    // the thing that stops a valid-but-unusual credential from connecting.
    const shape = checkAppPasswordShape(activePolicy, appPassword);
    if (shape.ok === false && shapeWarnedFor.current !== appPassword) {
      shapeWarnedFor.current = appPassword;
      const shapeReason = shape.problem === 'account_password' ? 'account_password_used' : 'app_password_length';
      setAuthReason(shapeReason);
      setFormError(tr(AUTH_REASON_HEADLINE_KEYS[shapeReason], { provider: appPasswordProvider }));
      // The objection is about one field and one value, so say which. Focus is
      // deliberately NOT stolen here: the whole point of this warning is that
      // the user may be right and we may be wrong, and the next act is either
      // pasting the rest of the token or pressing Connect again, neither of
      // which is helped by the caret jumping.
      setInvalidFields(['password']);
      bumpErrorSeq();
      setErrorDetail(tr('connect.appPasswordTryAnyway'));
      // Nothing else is on screen to explain this, and unlike a server
      // rejection the user has not yet been told anything, so the detail leads
      // rather than hiding behind a disclosure.
      setErrorDetailOpen(true);
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await response.json();

      if (!response.ok) {
        // A plan cap is not a credential problem. Rendering `data.error` here
        // would show the route's unlocalised English fallback, and the repeat
        // hint below would then tell the user to recheck their app password —
        // advice that cannot fix a refusal that never reached their mail
        // server. Switch to the upgrade panel instead, which is localised and
        // carries the offer. Only the numbers come from the response; the
        // sentences come from the message catalogue.
        if (data.error_code === 'inbox_limit_reached') {
          // Nothing below this point may touch state if the modal has gone:
          // the whole branch renders a panel that is no longer on screen.
          if (!mountedRef.current) {
            toast({ message: tr('app.inboxLimitReached', { plan: planName }), variant: 'warning' });
            return;
          }
          setLastFailure({ code: null, count: 0 });
          showError(null);
          setServerLimit({
            planName: typeof data.plan_name === 'string' ? data.plan_name : planName,
            inboxCount: typeof data.current_count === 'number' ? data.current_count : null,
            maxInboxes: typeof data.max_inboxes === 'number' ? data.max_inboxes : null,
            upgradeUrl: typeof data.upgrade_url === 'string' ? data.upgrade_url : '/pricing',
          });
          return;
        }
        // The status decides when the body carried no code; see failureCode.
        const code = failureCode(response.status, data);
        const count = lastFailure.code === code ? lastFailure.count + 1 : 1;

        // One sentence leads. The route's own paragraph is real diagnostic
        // detail, so it is kept, but folded into "What to check" underneath
        // together with the second-attempt advice.
        // A rejected login now says WHICH rejection it was. The routes classify
        // it (lib/email/auth-failure.ts) and send a reason; an older route, or
        // a reason this build does not know, falls back to the generic
        // credential headline exactly as before.
        const reason =
          code === 'auth_failed' && AUTH_REASON_HEADLINE_KEYS[data.auth_reason]
            ? data.auth_reason
            : null;
        const headline = reason
          ? tr(AUTH_REASON_HEADLINE_KEYS[reason], { provider: appPasswordProvider })
          : tr(ERROR_HEADLINE_KEYS[code] ?? 'connect.errorConnectionFailed');
        const details = [];
        // The route's own sentence is English-only (it is the validator's
        // message, not a catalogue key). When we have a classified reason the
        // disclosure already carries a localised sentence that says more, so
        // the untranslated one is dropped rather than stacked on top of it.
        if (!reason && typeof data.error === 'string' && data.error.trim()) details.push(data.error.trim());
        if (count >= 2) details.push(tr('connect.errorRepeatHint'));
        const detail = details.length > 0 ? details.join(' ') : null;

        // The modal is gone: the person closed it while this was in flight and
        // was told the answer would arrive as a notification. Deliver it, and
        // touch no state. Without this the failure path wrote into an unmounted
        // component and the user got nothing at all.
        if (!mountedRef.current) {
          toast({
            message: tr('connect.toastVerifyFailed', { email, reason: detail ? `${headline} ${detail}` : headline }),
            variant: 'error',
          });
          return;
        }

        setLastFailure({ code, count });
        setAuthReason(reason);
        setSessionExpired(code === SESSION_EXPIRED_CODE);
        setFormError(headline);
        // A rejected credential is about the password box; a login name the
        // server did not recognise is about the username box. Every other code
        // here is about the mailbox or the network rather than about a field on
        // this form, and marking one of them invalid would point at something
        // the user cannot fix by editing it.
        setInvalidFields(
          reason === 'login_username_required'
            ? ['username']
            : code === 'auth_failed'
              ? ['password']
              : []
        );
        bumpErrorSeq();
        setErrorDetail(detail);
        // Open on a classified credential failure: that is the case where the
        // next step and the link to the generator are the whole point, and
        // leaving them one click away is what left people retyping.
        //
        // And open whenever there is no classified reason but the route did
        // send a sentence. That covers every refusal decided before the mail
        // server was reached: a viewer's role, an expired session, a port the
        // guard will not dial. All of them arrived as a generic headline with
        // the one sentence that explains them folded behind a disclosure that
        // stayed shut, which is how "Workspace viewers cannot connect an inbox"
        // became "Connection failed. Please try again."
        setErrorDetailOpen(Boolean(reason) || Boolean(detail));

        // A transport failure is fixed by a port (already on screen) or by a
        // security mode (not), so open the section holding the second one.
        if (isGeneric && TRANSPORT_ERROR_CODES.has(code)) setAdvancedOpen(true);

        // A login name the server did not recognise is fixed in a different
        // field, and that field lives inside a collapsed section. Open it,
        // rather than selecting a password that may be perfectly good.
        if (reason === 'login_username_required' && isGeneric) {
          setAdvancedOpen(true);
          // The field does not exist yet: the panel holding it is only in the
          // DOM while it is open, and it is being opened by this very update.
          // A tick later it is mounted and can take focus. A timeout rather
          // than a frame, for the reason spelled out on `announce`.
          window.setTimeout(() => {
            if (!mountedRef.current) return;
            fieldRefs.current.username?.focus();
          }, 0);
          return;
        }

        // Otherwise: a rejected credential is almost always replaced wholesale
        // rather than edited, so hand the field back ready to overwrite. Only
        // for auth failures: stealing focus when the fix is a host or a port
        // would move the user away from the field they need.
        if (code === 'auth_failed' && passwordRef.current) {
          // Arm the one-shot select first: taking focus fires the focus
          // handler, which spends the flag, so the contents are selected
          // exactly once per rejection and never on an ordinary click-back.
          selectPasswordOnFocus.current = true;
          passwordRef.current.focus();
          passwordRef.current.select();
        }
        return;
      }

      // Success: notify the parent so it can update its optimistic inbox list.
      // Match the shape a page refresh renders from the DB, otherwise the row
      // visibly changes on reload. The list surfaces the brand for branded IMAP
      // (gmail/icloud/yahoo/zoho/yandex) and Fastmail, and 'imap' for the
      // generic connector; the label falls back to the address local-part when
      // there's no display name.
      const optimisticProvider = provider === 'generic' ? 'imap' : provider;
      const optimisticLabel = email.split('@')[0] || email;
      /**
       * The transport the mailbox is actually connected on.
       *
       * All three connect routes autodetect: they try what was asked for, then
       * the standard alternatives, and they persist WHAT WORKED rather than
       * what was submitted. They have always said so in the response, with a
       * comment on the generic one explaining that it exists "so the dashboard
       * can say so rather than silently disagreeing with the form the user is
       * still looking at", and the dashboard never read it. Someone who
       * submitted 993 implicit TLS and was connected on 143 STARTTLS closed a
       * form still showing 993 and was told only that it worked.
       *
       * Only forwarded when the route says something was changed. On the
       * ordinary path the numbers are the ones the user submitted, and reciting
       * them back is noise on top of a success.
       */
      const transport =
        data?.transport_adjusted === true
          ? {
              imapPort: data.imap_port,
              imapSecurity: data.imap_security,
              smtpPort: data.smtp_port,
              smtpSecurity: data.smtp_security,
            }
          : null;
      /**
       * How this mailbox was connected, for the `inbox_connected` event.
       *
       * The parent used to hard-code 'app_password' for every row that came out
       * of this modal, which is wrong for the generic IMAP connector, and the
       * generic connector is the largest bucket on the card. The modal is the
       * only place that knows which door was used, so it says.
       *
       * OAuth never arrives here: those providers navigate to a server route
       * and the event is recorded on the way back in App.jsx.
       */
      const connectionMethod = isGeneric ? 'imap' : 'app_password';
      // Called whether or not this modal is still mounted. The parent owns the
      // inbox list and the success toast, and it is still on screen either way:
      // a connection that succeeded after the user walked away is still a
      // connection, and the row has to appear.
      onConnect({
        provider: optimisticProvider,
        address: email,
        label: optimisticLabel,
        connectionMethod,
        transport,
      });
    } catch {
      // A dropped connection or an aborted request. Same rule as above: say so
      // where the user can see it, wherever that now is.
      if (mountedRef.current) {
        showError(tr('connect.errorNetwork'));
      } else {
        toast({
          message: tr('connect.toastVerifyFailed', { email, reason: tr('connect.errorNetwork') }),
          variant: 'error',
        });
      }
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  };

  const handleBackToProviders = () => {
    setStep(1);
    showError(null);
  };

  /**
   * True when the credentials step holds user-entered data that would be lost
   * on close. Ports have defaults and provider selection is trivially
   * re-chosen, so only the typed identity/secret fields count as "dirty".
   */
  const hasUnsavedInput = () =>
    step === 2 &&
    // The credentials form is no longer on screen once the upgrade panel
    // takes over, so there is nothing for a discard prompt to protect.
    !showLimitPanel &&
    Boolean(
      // `submitting` USED TO SUPPRESS this guard, which made the in-flight
      // state the one moment a stray Escape or scrim click closed the modal
      // with no question asked. That is the worst possible moment for it: a
      // verification runs for up to about 40 seconds, the answer was on its way,
      // and the person who dismissed the dialog by accident was never told what
      // happened. It now counts as unsaved input in its own right, so the same
      // confirmation stands in front of it, with copy that says what is at
      // stake (see `confirmingCloseDuringCheck` below).
      submitting ||
        form.email.trim() ||
        form.username.trim() ||
        form.password ||
        form.imapHost.trim() ||
        form.smtpHost.trim() ||
        yandexLogin.trim()
    );

  /**
   * True when the confirmation on screen is guarding a check that is still
   * running, rather than a form that is merely filled in.
   *
   * The two need different words. A filled-in form is losing typed text; an
   * in-flight check is losing an ANSWER, and the answer is not actually lost,
   * because the request outlives this component and reports through the toast
   * that lives above it. Saying so is what makes "Close anyway" a real choice
   * rather than a gamble.
   */
  const confirmingCloseDuringCheck = confirmingClose && submitting;

  /**
   * The one way out of this modal. Every close affordance goes through here:
   * the scrim, the header X and the Escape key all put the same typed
   * credentials at risk, so they all get the same discard confirmation. The X
   * used to call onClose directly, which threw away a filled-in form without
   * asking.
   */
  const requestClose = () => {
    if (hasUnsavedInput()) {
      // Remember whether this confirmation is guarding a running check, so the
      // effect below knows whether its premise can expire.
      confirmOpenedDuringCheck.current = submitting;
      // And remember what asked the question, so that dismissing it puts the
      // user back where they were. Three different controls open this prompt
      // (the header X, the footer's Cancel, the scrim) and all of them left
      // focus stranded on the parent dialog when it went away.
      const opener = document.activeElement;
      confirmOpenerRef.current =
        opener && dialogRef.current?.contains(opener) ? opener : null;
      setConfirmingClose(true);
      return;
    }
    onClose();
  };

  /**
   * Take the "Still checking" confirmation away once the check has answered.
   *
   * Its whole premise is "close now and you will not see the outcome here". A
   * check that lands while it is on screen removes that premise: the answer is
   * on the form directly behind the prompt, and leaving the prompt up would
   * leave the user choosing between waiting for something that has already
   * happened and discarding something they have not been shown. Only ever
   * dismisses a confirmation that was opened DURING a check; one opened over a
   * filled-in form is guarding typed text, which does not expire.
   */
  useEffect(() => {
    if (submitting || !confirmingClose || !confirmOpenedDuringCheck.current) return;
    confirmOpenedDuringCheck.current = false;
    setConfirmingClose(false);
  }, [submitting, confirmingClose]);

  /**
   * Speak the failure, and bring it into view.
   *
   * Both halves are keyed on `errorSeq`, which is bumped by every error we put
   * on screen including a repeat of the one already there. Two identical
   * rejections produce identical text, so without a value that changes each
   * time neither the announcement nor the scroll would happen for the second
   * one. The scroll was the workaround for the announcement not working at all;
   * it stays, because it is what a sighted user needs and the announcer does
   * nothing for them.
   *
   * The inline port refusal has a channel of its own rather than sharing this
   * one. It arrives on BLUR, with whatever alert the last submit left still on
   * screen, so a shared channel would keep announcing the stale sentence and
   * say nothing about the host that was just pasted. Skipped when the two carry
   * the same words, which is what a submit with a rejected port produces: one
   * refusal, said once.
   */
  useEffect(() => {
    announce('error', formError);
    announce('portError', portRangeNote && portRangeNote !== formError ? portRangeNote : '');
    if (!formError) return;
    // Instant, not smooth: a smooth scroll is silently dropped in a background
    // tab and is the wrong call for a message the user is waiting on anyway.
    errorAlertRef.current?.scrollIntoView({ block: 'nearest' });
  }, [formError, portRangeNote, errorSeq]);

  /**
   * Speak the two quiet notices: what the address was recognised as, and a port
   * that was lifted out of a host field.
   *
   * Polite, and on their own channels, because they are not refusals and they
   * coexist with each other and with an error. Both used to be `role="status"`
   * on a span that appears at the same instant as its text, which several
   * screen readers do not announce at all.
   */
  useEffect(() => {
    announce('detect', [hostPrefillNote, hostPrefillAppPasswordNote].filter(Boolean).join(' '));
  }, [hostPrefillNote, hostPrefillAppPasswordNote]);

  useEffect(() => {
    announce('port', portMovedNote);
  }, [portMovedNote]);

  // ── Dialog behaviour: focus restore, Escape, focus trap ────────────────────

  const dialogRef = useRef(null);
  const confirmRef = useRef(null);
  /** The element that opened the modal, so focus can be handed back to it. */
  const openerRef = useRef(null);
  /** The control inside this dialog that opened the discard confirmation. */
  const confirmOpenerRef = useRef(null);

  useEffect(() => {
    openerRef.current = document.activeElement;
    // Put focus inside the dialog. Step 2 autofocuses a field, so this only
    // does anything on the provider step, where focus would otherwise still be
    // on the page behind and Escape would never reach the handler below.
    const node = dialogRef.current;
    if (node && !node.contains(document.activeElement)) node.focus();
    return () => {
      const opener = openerRef.current;
      // Only restore to something still in the document: the trigger row can
      // be gone by the time we close (a successful connect re-renders it).
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
        opener.focus();
      }
    };
  }, []);

  /**
   * Move focus into the discard confirmation when it opens, and back out to
   * whatever opened it when it closes.
   *
   * The move IN was already here: without it the Tab trap would be guarding a
   * dialog that focus is not actually inside. The move OUT was not, so
   * dismissing the prompt left focus on a button that had just been removed
   * from the document, which browsers reset to `body`. From there the trap has
   * nothing to trap and the next Tab lands in the dashboard behind the modal.
   *
   * The restore runs from an effect rather than from the click handler because
   * the parent dialog is `inert` while the prompt is up: focusing a control
   * inside an inert subtree does nothing. By the time an effect runs, React has
   * committed the removal of the attribute.
   */
  useEffect(() => {
    if (confirmingClose) {
      const first = confirmRef.current?.querySelector('button');
      if (first) first.focus();
      return;
    }
    const opener = confirmOpenerRef.current;
    confirmOpenerRef.current = null;
    // Only back to something still in the document: the form behind the prompt
    // can have changed shape while it was up (a check that answered, Advanced
    // settings opened by the failure it answered with).
    if (opener && document.contains(opener) && typeof opener.focus === 'function') {
      opener.focus();
    }
  }, [confirmingClose]);

  /**
   * Escape closes (through the same discard guard), and Tab is confined to the
   * dialog. Without the trap a keyboard user tabs straight out of the modal
   * into the dashboard behind it, which is still fully interactive.
   *
   * The confirmation, when open, is the dialog that owns the keyboard: Escape
   * dismisses it back to the form rather than closing everything.
   */
  const handleDialogKeyDown = event => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (confirmingClose) {
        setConfirmingClose(false);
      } else {
        requestClose();
      }
      return;
    }
    if (event.key !== 'Tab') return;
    const container = confirmingClose ? confirmRef.current : dialogRef.current;
    if (!container) return;
    const items = Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR))
      .filter(el => el.offsetParent !== null || el === document.activeElement);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    // Backwards off the first stop wraps to the last. So does backwards from
    // the dialog container itself, which is where focus sits on open: without
    // this, one Shift+Tab on the provider step left the modal entirely.
    if (event.shiftKey && (active === first || !items.includes(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !container.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="scrim" onClick={requestClose} onKeyDown={handleDialogKeyDown}>
      <div
        className="modal"
        ref={dialogRef}
        onClick={e => e.stopPropagation()}
        style={{ width: 468 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cm-title"
        // Focus target on open, so the dialog is announced and Escape works
        // from the provider step, which autofocuses nothing.
        tabIndex={-1}
        /**
         * Out of reach entirely while the discard confirmation is up.
         *
         * Two `aria-modal="true"` dialogs were live at once. `aria-modal` is a
         * claim, not a mechanism: it asks assistive technology to ignore
         * everything outside the dialog, and with a nested dialog rendered
         * INSIDE this one "outside" does not include this one. The Tab trap
         * already redirected the keyboard, but a screen reader's virtual
         * cursor is not the keyboard, and it could still read and operate the
         * form the prompt is asking whether to discard.
         *
         * `inert` is the mechanism: it removes the subtree from the
         * accessibility tree and from hit-testing together, which is what
         * `aria-hidden` alone would not do. React 19 passes it through as a
         * real attribute (verified in the rendered DOM), so no fallback is
         * needed here.
         */
        inert={confirmingClose}
      >
        {/* The three announcers. Mounted for the life of the dialog and empty
            most of it; see SR_ONLY for why they cannot be the visible spans.

            Inside the dialog, so `aria-modal` above does not put them out of
            reach, which means they are inert along with everything else while
            the discard prompt is up. The one notice that can land in that
            window is a check answering, and that answer also takes the prompt
            away; `announce` writes on the following frame, by which time React
            has removed the attribute. */}
        <div aria-live="polite" aria-atomic="true" style={SR_ONLY}>{live.detect}</div>
        <div aria-live="polite" aria-atomic="true" style={SR_ONLY}>{live.port}</div>
        <div aria-live="assertive" aria-atomic="true" style={SR_ONLY}>{live.portError}</div>
        <div aria-live="assertive" aria-atomic="true" style={SR_ONLY}>{live.error}</div>

        {/* Header */}
        <div className="modal-h">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <h2 id="cm-title" style={{ margin: 0 }}>
                {showLimitPanel
                  ? tr('connect.titleLimitReached')
                  : isReconnect
                    ? tr('connect.titleReconnectProvider', { provider: providerLabel() })
                    : step === 2
                      ? tr('connect.titleConnectProvider', { provider: providerLabel() })
                      : tr('connect.titleConnectInbox')}
              </h2>
              <div className="sub" style={{ marginTop: 4 }}>
                {showLimitPanel
                  ? (typeof limitInboxCount === 'number' && typeof limitMaxInboxes === 'number'
                      ? tr('connect.subLimitReached', { plan: limitPlanName, count: limitInboxCount, max: limitMaxInboxes })
                      : tr('connect.subLimitReachedNoCount', { plan: limitPlanName }))
                  : step === 1
                    ? tr('connect.subChooseProvider')
                    : isGeneric
                      ? tr('connect.subGenericForm')
                      : tr(HINT_KEYS[provider] ?? 'connect.hintGeneric')}
              </div>
            </div>
            <button
              type="button"
              // Same guard as the scrim and Escape: this discards exactly the
              // same typed credentials, so it cannot be the one way out that
              // skips the confirmation.
              onClick={requestClose}
              aria-label={tr('connect.close')}
              className="plain-focus"
              /**
               * A 44x44 target around a 16px icon, with the growth taken back
               * out again in margin.
               *
               * It was `padding: 4` around that icon: a 24px square, which is
               * a comfortable click with a mouse and a coin toss with a thumb.
               * 44px is the documented minimum and this is the control that
               * throws away a half-filled credential form, so a mis-hit is not
               * a cheap mistake either way it goes.
               *
               * The negative margin is what makes this invisible. The border
               * box grows by 20px in each direction and the margin pulls 10px
               * back off every side, so the button occupies exactly the 24x24
               * it did before in the header's flex row and the X does not move
               * by a pixel. Only the hit area changed.
               */
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--fg-3)',
                padding: 14,
                margin: -10,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                lineHeight: 1,
              }}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="modal-body">

          {/* ─── Plan limit: upgrade prompt ────────────────────────────────── */}
          {showLimitPanel && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Icon + copy */}
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 10,
                padding: '8px 0 4px',
                textAlign: 'center',
              }}>
                <div style={{
                  width: 48,
                  height: 48,
                  borderRadius: 12,
                  background: 'var(--brand-soft)',
                  border: '1px solid rgba(37,71,229,0.18)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  <Icon name="zap" size={22} color="var(--brand)" />
                </div>
                <div>
                  <div style={{
                    fontFamily: 'var(--font-sans)',
                    fontSize: 15,
                    fontWeight: 600,
                    color: 'var(--fg-1)',
                    marginBottom: 4,
                  }}>
                    {tr(upgradeCopy.titleKey)}
                  </div>
                  <div style={{
                    fontFamily: 'var(--font-sans)',
                    fontSize: 13,
                    color: 'var(--fg-3)',
                    lineHeight: 1.5,
                  }}>
                    {tr(upgradeCopy.bodyKey)}
                  </div>
                </div>
              </div>

              {/* Feature highlights. The inbox count leads in both variants: it
                  is the thing they were just blocked on, and the rest is
                  supporting detail. */}
              {upgradeCopy.featureKeys.map(fKey => (
                <div key={fKey} style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontFamily: 'var(--font-sans)',
                  fontSize: 13,
                  color: 'var(--fg-2)',
                }}>
                  <Icon name="check" size={13} color="var(--mint-600)" />
                  {tr(fKey)}
                </div>
              ))}

              {/* The interval choice, under the offer it applies to and above
                  the button that acts on it. Renders nothing at all when the
                  plan has no yearly price to sell. */}
              <UpgradeIntervalChoice
                offer={annual}
                value={upgradeInterval}
                onChange={setUpgradeInterval}
              />
            </div>
          )}

          {/* ─── Step 1: Provider selection ─────────────────────────────────── */}
          {!showLimitPanel && step === 1 && (
            <>
              <div className="provider-grid" role="radiogroup" aria-label={tr('connect.subChooseProvider')}>
                {PROVIDERS.map(p => (
                  <div
                    key={p.k}
                    ref={el => { chipRefs.current[p.k] = el; }}
                    className={'provider-chip' + (provider === p.k ? ' sel' : '') + (p.disabled ? ' disabled' : '')}
                    onClick={() => { if (!p.disabled) setProvider(p.k); }}
                    role="radio"
                    aria-checked={provider === p.k}
                    aria-disabled={p.disabled || undefined}
                    // Roving tab stop: the group is one stop, not eight. Only
                    // the checked chip is tabbable and the arrows move from
                    // there, which is the behaviour role="radiogroup" promises.
                    tabIndex={!p.disabled && provider === p.k ? 0 : -1}
                    onKeyDown={e => handleChipKeyDown(e, p)}
                    title={p.disabled ? tr('connect.comingSoon') : undefined}
                    style={p.disabled ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
                  >
                    <ProviderLogo kind={p.logoKind} size={26} />
                    <div className="pn">{p.label}</div>
                    <div className="ps">{p.disabled ? tr('connect.comingSoon') : tr(p.subKey)}</div>
                  </div>
                ))}
              </div>

              {/* Gmail: Google sign-in, kept and demoted.

                  The app password above is the default because OAuth here has
                  a hard ceiling: an unverified Google app may only ever be
                  granted consent by 100 accounts in its lifetime, the counter
                  cannot be reset, and 71 of those are already spent. Removing
                  OAuth would strand the people who prefer it and the 56
                  inboxes already connected that way, so it stays, one click
                  down, with the walkthrough of Google's screens intact. */}
              {provider === 'gmail' && (
                <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border-1)' }}>
                  <button
                    type="button"
                    onClick={() => setGmailOauthOpen(open => !open)}
                    aria-expanded={gmailOauthOpen}
                    // No aria-controls, for the same reason the Advanced
                    // toggle has none: the panel is only in the DOM while it
                    // is open, so the id would be absent exactly when the
                    // attribute mattered.
                    className="plain-focus"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                      fontFamily: 'var(--font-sans)',
                      fontSize: 13,
                      fontWeight: 500,
                      color: 'var(--fg-2)',
                      width: 'fit-content',
                    }}
                  >
                    <span style={{
                      display: 'inline-flex',
                      transform: gmailOauthOpen ? 'rotate(90deg)' : 'none',
                      transition: 'transform 120ms ease',
                    }}>
                      <Icon name="chevron" size={13} />
                    </span>
                    {tr('connect.gmailOauthToggle')}
                  </button>

                  {gmailOauthOpen && (
                    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <p style={{
                        margin: 0,
                        fontFamily: 'var(--font-sans)',
                        fontSize: 12.5,
                        lineHeight: 1.55,
                        color: 'var(--fg-2)',
                      }}>
                        {tr('connect.gmailOauthBody')}
                      </p>

                      {OAUTH_VERIFICATION_PENDING && (
                        <div
                          role="note"
                          style={{
                            padding: 14,
                            background: 'var(--bg-sunken)',
                            border: '1px solid var(--border-1)',
                            borderRadius: 8,
                            fontFamily: 'var(--font-sans)',
                          }}
                        >
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-1)', marginBottom: 4 }}>
                            {tr('connect.googleStepsTitle')}
                          </div>
                          <p style={{ margin: '0 0 12px', fontSize: 12.5, lineHeight: 1.55, color: 'var(--fg-2)' }}>
                            {tr('connect.googleStepsIntro')}
                          </p>

                          {/* This asset is the icon registered on our Google OAuth
                              consent screen, so it is the mark the user is about to see
                              on Google's own page. Shown at badge size next to a line
                              saying exactly that: it helps the user confirm they are in
                              the right flow. It is deliberately NOT presented as a
                              screenshot of Google's screen, which is not what it is. */}
                          <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            marginBottom: 12,
                            padding: '8px 10px',
                            background: 'var(--bg-surface)',
                            border: '1px solid var(--border-1)',
                            borderRadius: 6,
                          }}>
                            <img
                              src="/google-consent-logo.png"
                              alt=""
                              width={28}
                              height={28}
                              style={{ flexShrink: 0, borderRadius: 4 }}
                            />
                            <span style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--fg-2)' }}>
                              {tr('connect.googleConsentAlt')}
                            </span>
                          </div>

                          <ol style={{
                            margin: 0,
                            paddingLeft: 18,
                            fontSize: 12.5,
                            lineHeight: 1.55,
                            color: 'var(--fg-2)',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 6,
                          }}>
                            <li>{tr('connect.googleStep1')}</li>
                            <li>{tr('connect.googleStep2')}</li>
                            <li>{tr('connect.googleStep3')}</li>
                          </ol>

                          <p style={{
                            margin: '12px 0 0',
                            paddingTop: 12,
                            borderTop: '1px solid var(--border-1)',
                            fontSize: 12,
                            lineHeight: 1.55,
                            color: 'var(--fg-3)',
                          }}>
                            {tr('connect.googleStepsWhy')}
                          </p>
                          {/* The old copy claimed access expired "roughly every 7 days".
                              It does not. Access tokens last an hour and are renewed by
                              a background job the user never sees; the refresh token
                              behind them is only invalidated if the user revokes it.
                              Production bears this out: the oldest Gmail inbox has been
                              connected and healthy for 82 days, and of 41 Gmail inboxes
                              the only 3 in an error state were explicit revocations.
                              The 7-day figure applies to Google projects left in
                              "Testing" publishing status, which is a different thing
                              from being unverified. */}
                          <p style={{ margin: '8px 0 0', fontSize: 12, lineHeight: 1.55, color: 'var(--fg-3)' }}>
                            {tr('connect.googleStepsDuration')}
                          </p>
                        </div>
                      )}

                      <Btn variant="secondary" onClick={handleGmailOauth}>
                        {tr('connect.connectWithGoogle')}
                      </Btn>
                    </div>
                  )}
                </div>
              )}

              {/* Generic IMAP is the lead option, so it gets a short case
                  for itself rather than a bare one-liner. */}
              {isGeneric && (
                <div style={{
                  marginTop: 16,
                  padding: 14,
                  background: 'var(--bg-sunken)',
                  border: '1px solid var(--border-1)',
                  borderRadius: 8,
                  fontFamily: 'var(--font-sans)',
                }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-1)', marginBottom: 4 }}>
                    {tr('connect.imapLeadTitle')}
                  </div>
                  <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: 'var(--fg-2)' }}>
                    {tr('connect.imapLeadBody')}
                  </p>
                </div>
              )}

              {/* App-password providers: guidance + a link straight to the page
                  that generates the credential. */}
              {(isPreset || provider === 'fastmail') && appPasswordUrl && (
                <p style={{
                  margin: '12px 0 0',
                  fontFamily: 'var(--font-sans)',
                  fontSize: 12,
                  color: 'var(--fg-3)',
                  lineHeight: 1.5,
                }}>
                  {tr(HINT_KEYS[provider])}{' '}
                  <a
                    href={appPasswordUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--brand)' }}
                  >
                    {tr('connect.howToGenerate')}
                  </a>.
                </p>
              )}
            </>
          )}

          {/* ─── Step 2: Credentials form ───────────────────────────────────── */}
          {!showLimitPanel && step === 2 && (
            // A real form, so Enter submits from the email, host and username
            // fields too. It used to work only from the password box, because
            // that box had the only keydown handler. The submit button stays in
            // the footer outside the form and keeps its own onClick, so the
            // existing path is untouched; the hidden submit below is what makes
            // implicit submission fire.
            <form
              onSubmit={e => { e.preventDefault(); if (!submitting) handleAppPasswordSubmit(); }}
              /**
               * The fields carry `required` so that assistive technology
               * announces them as required, and this turns off the browser's
               * own enforcement of it.
               *
               * Without `noValidate` the two ways of submitting this form would
               * disagree: Enter goes through the hidden submit button and would
               * be stopped by a native bubble in the browser's own wording,
               * while the footer's Connect button lives OUTSIDE the form and
               * calls the handler directly, so it would sail past the same
               * check and produce the modal's own message. One refusal, in one
               * place, in the user's own language.
               */
              noValidate
              style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
            >
              {isReconnect && (
                <div
                  role="note"
                  style={{
                    marginBottom: 4,
                    padding: '10px 12px',
                    background: 'var(--brand-soft)',
                    border: '1px solid rgba(37,71,229,0.18)',
                    borderRadius: 8,
                    fontFamily: 'var(--font-sans)',
                    fontSize: 12.5,
                    color: 'var(--fg-2)',
                    lineHeight: 1.5,
                  }}
                >
                  {tr('connect.reconnectHint')}
                </div>
              )}

              {provider === 'zoho' && (
                <div className="field">
                  <label htmlFor="cm-zoho-account-type">{tr('connect.zohoAccountTypeLabel')}</label>
                  {/* Locked on reconnect, like every other field that decides
                      which mailbox this is. Account type and region together
                      ARE the hostname (zohoHosts in imap-presets), so leaving
                      them editable made them the two identity fields a
                      reconnect could silently change: the form came up as
                      personal/global whatever the row said, and on success the
                      connect route's upsert writes imap_host from them. The
                      values above are read back out of the stored host, so what
                      is locked here is what the inbox actually uses. */}
                  <select
                    id="cm-zoho-account-type"
                    className="input"
                    value={zohoAccountType}
                    onChange={e => setZohoAccountType(e.target.value)}
                    disabled={isReconnect}
                    aria-describedby="cm-zoho-account-type-hint"
                  >
                    {ZOHO_ACCOUNT_TYPES.map(t => (
                      <option key={t.value} value={t.value}>{tr(t.labelKey)}</option>
                    ))}
                  </select>
                  <span id="cm-zoho-account-type-hint" style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                    {tr('connect.zohoAccountTypeHint')}
                  </span>
                </div>
              )}

              {provider === 'zoho' && (
                <div className="field">
                  <label htmlFor="cm-zoho-region">{tr('connect.zohoRegionLabel')}</label>
                  {/* Locked on reconnect for the same reason as the account
                      type above: the pair decides the host. */}
                  <select
                    id="cm-zoho-region"
                    className="input"
                    value={zohoRegion}
                    onChange={e => setZohoRegion(e.target.value)}
                    disabled={isReconnect}
                    aria-describedby="cm-zoho-region-hint"
                  >
                    {ZOHO_REGIONS.map(r => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                  <span id="cm-zoho-region-hint" style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                    {tr('connect.zohoRegionHint')}
                  </span>
                </div>
              )}

              <div className="field">
                <label htmlFor="cm-email">{tr('connect.emailLabel')}</label>
                <input
                  id="cm-email"
                  ref={bindField('email')}
                  className="input"
                  type="email"
                  placeholder="you@example.com"
                  // The form carries `noValidate`, so `required` is here for
                  // what it TELLS rather than for what it blocks: a screen
                  // reader announces the field as required, and the modal's own
                  // sentence stays the only refusal the user ever sees.
                  required
                  aria-required="true"
                  aria-invalid={isInvalid('email') || undefined}
                  aria-describedby={describedBy(
                    hostPrefillNote ? 'cm-email-detected' : null,
                    hostPrefillAppPasswordNote ? 'cm-email-credential' : null,
                    isInvalid('email') ? 'cm-form-error' : null
                  )}
                  value={form.email}
                  onChange={e => setForm(prev => ({ ...prev, email: e.target.value }))}
                  // On blur rather than on change: reacting mid-typing would
                  // match a half-typed domain and fill the server fields with
                  // someone else's provider.
                  // Blur runs it as well as the debounce below, because a
                  // user who types fast and tabs immediately should not have to
                  // wait out a timer that the tab just made pointless.
                  onBlur={e => detectMailSettings(e.target.value)}
                  // The mailbox being connected, not an account on this site.
                  // See NOT_A_LOGIN_FIELD: `autoComplete="email"` here, beside a
                  // current-password field, is what asked the browser to offer
                  // the saved mcpemails.com login.
                  name="mcpe-mailbox-address"
                  {...NOT_A_LOGIN_FIELD}
                  // Reconnect: the address is the row's identity — never change it,
                  // and lock it so the browser can't autofill another saved login.
                  readOnly={isReconnect}
                  aria-readonly={isReconnect || undefined}
                  autoFocus={!isReconnect}
                />
                {/* Where the settings on screen came from. Naming the provider
                    is the part that matters: it is the difference between "the
                    form filled itself in" and "we found Migadu on your domain",
                    and only the second one tells the user whether to trust it.
                    A DNS answer we cannot attribute to a provider we know says
                    so plainly rather than inventing a name for it. */}
                {/* No `role="status"` any more. It was on a span that appears
                    at the same moment as its text, which is the arrangement
                    screen readers announce least reliably; the persistent
                    announcer at the top of the dialog does the speaking, and
                    this is now plain text with an id the field points at. */}
                {hostPrefillNote && (
                  <span id="cm-email-detected" style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--brand)' }}>
                    {hostPrefillNote}
                  </span>
                )}
                {hostPrefillAppPasswordNote && (
                  <span id="cm-email-credential" style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                    {hostPrefillAppPasswordNote}
                  </span>
                )}
              </div>

              {provider === 'yandex' && (
                <>
                <div className="field">
                  <label htmlFor="cm-yandex-account-type">{tr('connect.yandexAccountTypeLabel')}</label>
                  <select id="cm-yandex-account-type" className="input" value={yandexAccountType} onChange={e => setYandexAccountType(e.target.value)} disabled={isReconnect} aria-describedby="cm-yandex-account-type-hint">
                    <option value="personal">{tr('connect.yandexPersonal')}</option>
                    <option value="business">{tr('connect.yandexBusiness')}</option>
                  </select>
                  <span id="cm-yandex-account-type-hint" style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                    {tr('connect.yandexAccountTypeHint')}
                  </span>
                </div>
                <div className="field">
                  <label htmlFor="cm-yandex-login">{tr('connect.yandexLoginLabel')}</label>
                  <input
                    id="cm-yandex-login"
                    className="input"
                    type="text"
                    placeholder={tr('connect.yandexLoginPlaceholder')}
                    value={yandexLogin}
                    onChange={e => setYandexLogin(e.target.value)}
                    // Yandex 360's own login, not an account here.
                    name="mcpe-yandex-login"
                    {...NOT_A_LOGIN_FIELD}
                    readOnly={isReconnect}
                    aria-readonly={isReconnect || undefined}
                    aria-describedby="cm-yandex-login-hint"
                  />
                  <span id="cm-yandex-login-hint" style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                    {tr('connect.yandexLoginHint')}
                  </span>
                </div>
                </>
              )}

              {/* Host and port, one row per protocol.
                  The ports used to live inside Advanced settings, on the
                  reasoning that 99% of mailboxes never change them. That is
                  true of CHANGING them and false of SEEING them: a port is
                  half of "where does this connect to", it is the field a
                  provider's setup page names in the same breath as the host,
                  and hiding it meant a user copying documented settings had to
                  discover a disclosure to finish the job. Both halves of one
                  answer now sit on one line, and the port column is sized for
                  the five digits it can ever hold rather than taking a full
                  row of its own.

                  What stayed behind the disclosure is the part that really is
                  rare: the security modes and the separate login username. */}
              {isGeneric && (
                <>
                  <div className="host-port-row">
                    <div className="field host-field">
                      <label htmlFor="cm-imap-host">{tr('connect.imapHostLabel')}</label>
                      <input
                        id="cm-imap-host"
                        ref={bindField('imapHost')}
                        className="input"
                        type="text"
                        placeholder="imap.example.com"
                        required
                        aria-required="true"
                        aria-invalid={isInvalid('imapHost') || undefined}
                        // The paste hint and the two notices below belong to
                        // this pair of controls but render outside the field
                        // (see the comment on the hint), so the association has
                        // to be made by id: without it, tabbing here announced
                        // "IMAP host, edit text" and nothing else.
                        aria-describedby={describedBy(
                          'cm-host-paste-hint',
                          portRangeError === 'imap' ? 'cm-imap-port-error' : null,
                          isInvalid('imapHost') ? 'cm-form-error' : null
                        )}
                        value={form.imapHost}
                        onChange={e => { setPortNote(null); setPortRangeError(null); setForm(prev => ({ ...prev, imapHost: e.target.value })); }}
                        onBlur={() => normalizeHostField('imap')}
                        readOnly={isReconnect}
                        aria-readonly={isReconnect || undefined}
                      />
                    </div>
                    <div className="field port-field">
                      <label htmlFor="cm-imap-port">{tr('connect.imapPortLabel')}</label>
                      <PortSelect
                        id="cm-imap-port"
                        inputRef={bindField('imapPort')}
                        protocol="imap"
                        value={form.imapPort}
                        onChange={value => setPort('imap', value)}
                        disabled={isReconnect}
                        invalid={isInvalid('imapPort')}
                        describedBy={describedBy(
                          portNote?.protocol === 'imap' ? 'cm-imap-port-note' : null,
                          isInvalid('imapPort') ? 'cm-form-error' : null
                        )}
                      />
                    </div>
                  </div>
                  {/* The hints belong to the row, not to the host box: with the
                      port beside it, a hint nested inside the host field would
                      be indented under a column rather than under the pair it
                      describes. */}
                  <span id="cm-host-paste-hint" style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)', marginTop: -6 }}>
                    {tr('connect.hostPasteHint')}
                  </span>
                  {/* Neither of these carries a live role any longer: both were
                      spans that arrive with their own text, which is the case
                      that does not announce. The dialog's persistent announcers
                      say them; the ids are what tie them to the controls. */}
                  {portNote?.protocol === 'imap' && (
                    <span id="cm-imap-port-note" style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--brand)', marginTop: -6 }}>
                      {portMovedNote}
                    </span>
                  )}
                  {portRangeError === 'imap' && (
                    <span id="cm-imap-port-error" style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--red-700)', marginTop: -6 }}>
                      {portRangeNote}
                    </span>
                  )}

                  <div className="host-port-row">
                    <div className="field host-field">
                      <label htmlFor="cm-smtp-host">{tr('connect.smtpHostLabel')}</label>
                      <input
                        id="cm-smtp-host"
                        ref={bindField('smtpHost')}
                        className="input"
                        type="text"
                        placeholder="smtp.example.com"
                        required
                        aria-required="true"
                        aria-invalid={isInvalid('smtpHost') || undefined}
                        aria-describedby={describedBy(
                          'cm-host-paste-hint',
                          portRangeError === 'smtp' ? 'cm-smtp-port-error' : null,
                          isInvalid('smtpHost') ? 'cm-form-error' : null
                        )}
                        value={form.smtpHost}
                        onChange={e => { setPortNote(null); setPortRangeError(null); setForm(prev => ({ ...prev, smtpHost: e.target.value })); }}
                        onBlur={() => normalizeHostField('smtp')}
                        readOnly={isReconnect}
                        aria-readonly={isReconnect || undefined}
                      />
                    </div>
                    <div className="field port-field">
                      <label htmlFor="cm-smtp-port">{tr('connect.smtpPortLabel')}</label>
                      <PortSelect
                        id="cm-smtp-port"
                        inputRef={bindField('smtpPort')}
                        protocol="smtp"
                        value={form.smtpPort}
                        onChange={value => setPort('smtp', value)}
                        disabled={isReconnect}
                        invalid={isInvalid('smtpPort')}
                        describedBy={describedBy(
                          portNote?.protocol === 'smtp' ? 'cm-smtp-port-note' : null,
                          isInvalid('smtpPort') ? 'cm-form-error' : null
                        )}
                      />
                    </div>
                  </div>
                  {portNote?.protocol === 'smtp' && (
                    <span id="cm-smtp-port-note" style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--brand)', marginTop: -6 }}>
                      {portMovedNote}
                    </span>
                  )}
                  {portRangeError === 'smtp' && (
                    <span id="cm-smtp-port-error" style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--red-700)', marginTop: -6 }}>
                      {portRangeNote}
                    </span>
                  )}
                </>
              )}

              <div className="field">
                <label htmlFor="cm-password">{needsAppPassword ? tr('connect.appPasswordLabel') : tr('connect.passwordLabel')}</label>
                {/* An app password is 16+ characters typed or pasted blind. With
                    no way to read it back, a single wrong character is not
                    correctable, only replaceable, so the field gets a reveal
                    toggle like every other credential box in the product. */}
                <div style={{ position: 'relative', display: 'flex' }}>
                  <input
                    id="cm-password"
                    ref={node => { passwordRef.current = node; fieldRefs.current.password = node; }}
                    className="input"
                    required
                    aria-required="true"
                    aria-invalid={isInvalid('password') || undefined}
                    aria-describedby={describedBy(
                      'cm-password-hint',
                      isInvalid('password') ? 'cm-form-error' : null
                    )}
                    // 48 rather than 40: the reveal button beside it is 44px
                    // wide now, and text running underneath a control is worse
                    // than text that stops short of one.
                    style={{ flex: 1, paddingRight: 48, minWidth: 0 }}
                    type={passwordVisible ? 'text' : 'password'}
                    // The old placeholder was "••••-••••-••••-••••", which asserts a
                    // dashed four-group shape. Only Apple's app-specific password
                    // looks like that; Yahoo's and Yandex's are unbroken strings and
                    // the generic connector takes an ordinary password. Showing a
                    // format that is wrong for most of the form invites users to
                    // retype the credential into that shape.
                    placeholder=""
                    value={form.password}
                    onChange={e => {
                      // Once they are typing a replacement, a later click back
                      // into the field is an edit, not a retry: stop the select.
                      selectPasswordOnFocus.current = false;
                      setForm(prev => ({ ...prev, password: e.target.value }));
                    }}
                    // A password that was REJECTED is replaced, not edited, so
                    // that one case still hands the field back selected and one
                    // keystroke overwrites it. It no longer fires on every focus:
                    // doing that wiped the value of anyone who clicked back in to
                    // correct a character.
                    onFocus={e => {
                      if (!selectPasswordOnFocus.current) return;
                      selectPasswordOnFocus.current = false;
                      e.target.select();
                    }}
                    // The mail provider's credential, never this site's. See
                    // NOT_A_LOGIN_FIELD: `autoComplete="current-password"` on a
                    // same-origin form is precisely the pattern every password
                    // manager treats as a sign-in prompt for mcpemails.com.
                    name="mcpe-mailbox-secret"
                    {...NOT_A_LOGIN_FIELD}
                    autoFocus={isReconnect}
                  />
                  <button
                    type="button"
                    className="plain-focus"
                    onClick={() => setPasswordVisible(v => !v)}
                    aria-label={passwordVisible ? tr('connect.hidePassword') : tr('connect.showPassword')}
                    aria-pressed={passwordVisible}
                    /**
                     * 44x44, centred on the 36px-tall input.
                     *
                     * It was 32x36, and it is the control a person reaches for
                     * precisely because they cannot read what they typed, which
                     * is the moment a missed tap costs the most: the field
                     * holds an unreadable string and there is no way to check
                     * it except this button.
                     *
                     * Absolutely positioned, so growing it moves nothing: the
                     * 4px it now overhangs above and below the input falls into
                     * the `.field` column's own 6px gaps and lands on no other
                     * control. The eye icon stays 15px and stays centred,
                     * because the box is centred on the same line it was.
                     */
                    style={{
                      position: 'absolute',
                      right: 0,
                      top: -4,
                      height: 44,
                      width: 44,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--fg-3)',
                      padding: 0,
                    }}
                  >
                    <Icon name={passwordVisible ? 'eyeoff' : 'eye'} size={15} />
                  </button>
                </div>
                {/* ── Getting the credential ────────────────────────────
                    Task order, not document order. Fetching the app password
                    is step one and happens on the PROVIDER'S site, so it is a
                    button with real weight rather than the 12px text link it
                    used to be, sitting under three paragraphs nobody read.
                    Buttons initiate actions; links navigate. This initiates
                    the action the whole form is blocked on.

                    Everything explanatory moved behind the disclosure below.
                    The old layout printed ~90 words between the password box
                    and the submit button, which is what made this modal read
                    as a wall of text. */}
                {appPasswordUrl && needsAppPassword && (
                  <a
                    href={appPasswordUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 7,
                      marginTop: 2,
                      padding: '9px 14px',
                      borderRadius: 8,
                      border: '1px solid var(--border-2)',
                      background: 'var(--bg-surface)',
                      fontFamily: 'var(--font-sans)',
                      fontSize: 13,
                      fontWeight: 600,
                      color: 'var(--fg-1)',
                      textDecoration: 'none',
                      width: 'fit-content',
                    }}
                  >
                    <Icon name="key" size={14} />
                    {tr('connect.openAppPasswordPage', { provider: appPasswordProvider })}
                    <Icon name="external" size={13} />
                  </a>
                )}

                <span id="cm-password-hint" style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                  {needsAppPassword
                    ? tr('connect.appPasswordHint', { provider: appPasswordProvider })
                    : tr('connect.passwordHint')}
                </span>

                {/* The per-provider detail (what it is called, where it lives,
                    what one looks like, the Workspace-admin caveat) is still
                    here for the person who needs it, one click away instead of
                    in front of the 95% who do not. */}
                {appPasswordStepsKey && needsAppPassword && (
                  <div>
                    <button
                      type="button"
                      className="plain-focus"
                      onClick={() => setAppPwHelpOpen(v => !v)}
                      aria-expanded={appPwHelpOpen}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        background: 'transparent',
                        border: 'none',
                        padding: 0,
                        cursor: 'pointer',
                        fontFamily: 'var(--font-sans)',
                        fontSize: 12.5,
                        fontWeight: 500,
                        color: 'var(--fg-2)',
                        width: 'fit-content',
                      }}
                    >
                      <span style={{
                        display: 'inline-flex',
                        transform: appPwHelpOpen ? 'rotate(90deg)' : 'none',
                        transition: 'transform 120ms ease',
                      }}>
                        <Icon name="chevron" size={12} />
                      </span>
                      {tr('connect.appPasswordHelpToggle')}
                    </button>
                    {appPwHelpOpen && (
                      <p style={{
                        margin: '8px 0 0',
                        fontFamily: 'var(--font-sans)',
                        fontSize: 12,
                        lineHeight: 1.55,
                        color: 'var(--fg-3)',
                      }}>
                        {tr(appPasswordStepsKey)}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* ── Advanced settings (generic IMAP only) ──────────────────
                  What is left in here after the ports moved up to the host
                  rows: the two transport security modes and the optional login
                  username.

                  Closed by default, but opened automatically whenever it holds
                  a value that differs from the default, and whenever a failure
                  comes back that is fixed by one of the controls inside it.
                  Nothing that is about to be submitted is ever hidden. */}
              {isGeneric && (
                <div style={{ borderTop: '1px solid var(--border-1)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <button
                    type="button"
                    onClick={() => setAdvancedOpen(open => !open)}
                    aria-expanded={advancedOpen}
                    // No aria-controls: the panel is only in the DOM while it
                    // is open, so the id it pointed at was absent exactly when
                    // the attribute mattered, and a reference to nothing is
                    // worse than no reference. Keeping the panel mounted and
                    // hidden instead would put two transport selects and a
                    // login-name box into the form for every mailbox that never
                    // needs them, which is the thing the disclosure exists to
                    // avoid. aria-expanded on the button is the part that
                    // carries the state.
                    className="plain-focus"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                      fontFamily: 'var(--font-sans)',
                      fontSize: 13,
                      fontWeight: 500,
                      color: 'var(--fg-2)',
                      width: 'fit-content',
                    }}
                  >
                    <span style={{
                      display: 'inline-flex',
                      transform: advancedOpen ? 'rotate(90deg)' : 'none',
                      transition: 'transform 120ms ease',
                    }}>
                      <Icon name="chevron" size={13} />
                    </span>
                    {tr('connect.advancedToggle')}
                  </button>

                  {advancedOpen && (
                    <div id="cm-advanced" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                      <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)', lineHeight: 1.5 }}>
                        {tr('connect.advancedHint')}
                      </span>

                      <div className="field">
                        <label htmlFor="cm-username">{tr('connect.usernameLabel')}</label>
                        <input
                          id="cm-username"
                          ref={bindField('username')}
                          className="input"
                          type="text"
                          placeholder={tr('connect.usernamePlaceholder')}
                          aria-invalid={isInvalid('username') || undefined}
                          aria-describedby={describedBy(
                            'cm-username-hint',
                            isInvalid('username') ? 'cm-form-error' : null
                          )}
                          value={form.username}
                          onChange={e => setForm(prev => ({ ...prev, username: e.target.value }))}
                          // The SASL login the MAIL server issued. Named
                          // `username` with autoComplete="username" it was the
                          // third of the three fields that made this look like a
                          // sign-in form, and it is the field the wrong-mailbox
                          // incident was traced to.
                          name="mcpe-mailbox-login"
                          {...NOT_A_LOGIN_FIELD}
                          // Locked on reconnect: this was the root cause of the
                          // wrong-mailbox bug — a blank username field autofilled with
                          // another account's saved login. Identity stays fixed.
                          readOnly={isReconnect}
                          aria-readonly={isReconnect || undefined}
                        />
                        <span id="cm-username-hint" style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                          {tr('connect.usernameHint')}
                        </span>
                      </div>

                      {/* One control each, but still one fieldset each. The
                          two security selects used to sit at opposite ends of
                          the form with nothing saying which half either
                          governed, and losing the legends when the ports moved
                          out to the host rows would put that ambiguity back. */}
                      <fieldset style={{ border: '1px solid var(--border-1)', borderRadius: 8, padding: 12, margin: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <legend style={{ fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 600, color: 'var(--fg-2)', padding: '0 6px' }}>
                          {tr('connect.imapSectionLabel')}
                        </legend>
                        <div className="field">
                          <label htmlFor="cm-imap-security">{tr('connect.imapSecurityLabel')}</label>
                          <select id="cm-imap-security" className="input" value={form.imapSecurity} onChange={e => setSecurity('imap', e.target.value)} disabled={isReconnect} aria-describedby="cm-imap-security-hint">
                            <option value="tls">{tr('connect.securityTls')}</option>
                            <option value="starttls">{tr('connect.securityStarttls')}</option>
                          </select>
                          <span id="cm-imap-security-hint" style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                            {tr('connect.securityPortNote')}
                          </span>
                        </div>
                      </fieldset>

                      <fieldset style={{ border: '1px solid var(--border-1)', borderRadius: 8, padding: 12, margin: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <legend style={{ fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 600, color: 'var(--fg-2)', padding: '0 6px' }}>
                          {tr('connect.smtpSectionLabel')}
                        </legend>
                        <div className="field">
                          <label htmlFor="cm-smtp-security">{tr('connect.smtpSecurityLabel')}</label>
                          <select id="cm-smtp-security" className="input" value={form.smtpSecurity} onChange={e => setSecurity('smtp', e.target.value)} disabled={isReconnect} aria-describedby="cm-smtp-security-hint">
                            <option value="tls">{tr('connect.securityTls')}</option>
                            <option value="starttls">{tr('connect.securityStarttls')}</option>
                          </select>
                          <span id="cm-smtp-security-hint" style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                            {tr('connect.securityPortNote')}
                          </span>
                        </div>
                      </fieldset>
                    </div>
                  )}
                </div>
              )}

              {/* What is happening, while it happens.
                  The only feedback used to be a disabled button that LOST its
                  icon, for a check that runs up to about 40 seconds (IMAP then
                  SMTP in sequence, PROTOCOL_BUDGET_MS of 20s each; the routes
                  declare maxDuration = 60). The button now spins, and this line
                  says what the spin is for and roughly how long it can last.

                  Deliberately ONE line with no stages and no bar. The browser
                  cannot see which protocol the server is on, how many
                  transports the autodetect loop has tried, or how far through
                  the budget it is; every one of those would be a number made up
                  here. The upper bound is not made up: it is what the route's
                  own budget allows. */}
              {submitting && (
                <div
                  role="status"
                  aria-live="polite"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '10px 12px',
                    background: 'var(--bg-sunken)',
                    border: '1px solid var(--border-1)',
                    borderRadius: 8,
                    fontFamily: 'var(--font-sans)',
                    fontSize: 12.5,
                    lineHeight: 1.5,
                    color: 'var(--fg-2)',
                  }}
                >
                  <span className="cm-check-spinner" aria-hidden="true" />
                  {tr('connect.verifyingStep')}
                </div>
              )}

              {/* One sentence, then a disclosure. The alert used to open with
                  the route's whole troubleshooting paragraph plus an appended
                  recovery sentence, which is more text than anyone reads at the
                  moment a connection just failed. The detail is still here, and
                  the app-password guidance (the single most common cause of a
                  rejection on every branded provider) is one click away with
                  its generator link. */}
              {formError && (
                <div
                  /**
                   * No `role="alert"`.
                   *
                   * It was on a node that is created together with its text and
                   * whose text then does not change: two identical rejections
                   * in a row rendered the same sentence into the same box and
                   * announced nothing, which is exactly why a scroll fallback
                   * keyed on the failure counter had to be bolted on to tell a
                   * sighted user anything had happened at all.
                   *
                   * The persistent assertive announcer at the top of the dialog
                   * says it instead, and it clears and re-writes so a repeat is
                   * a change. What is left here is the visible message, with an
                   * id that the field the failure is about points at.
                   */
                  ref={errorAlertRef}
                  style={{
                    padding: '10px 12px',
                    background: 'var(--red-100)',
                    border: '1px solid rgba(229,72,77,0.25)',
                    borderRadius: 8,
                    fontFamily: 'var(--font-sans)',
                    fontSize: 13,
                    color: 'var(--red-700)',
                    lineHeight: 1.5,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  <span id="cm-form-error">{formError}</span>

                  {/* The one failure whose fix is not in this form. It leads,
                      outside the disclosure, because a link the user has to
                      expand a section to find is a link that does not exist for
                      the person who has just been told their connection
                      failed. */}
                  {sessionExpired && (
                    <a
                      href={signInHref()}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                        color: 'var(--red-700)',
                        fontWeight: 600,
                        width: 'fit-content',
                      }}
                    >
                      <Icon name="logout" size={12} />
                      {tr('connect.errorSessionExpiredSignIn')}
                    </a>
                  )}

                  {(errorDetail || appPasswordUrl) && (
                    <>
                      <button
                        type="button"
                        onClick={() => setErrorDetailOpen(open => !open)}
                        aria-expanded={errorDetailOpen}
                        // Same call as the Advanced toggle: the detail block is
                        // conditionally rendered, so aria-controls pointed at an
                        // id that did not exist while the disclosure was shut.
                        className="plain-focus"
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 5,
                          background: 'transparent',
                          border: 'none',
                          padding: 0,
                          cursor: 'pointer',
                          fontFamily: 'var(--font-sans)',
                          fontSize: 12.5,
                          fontWeight: 500,
                          color: 'var(--red-700)',
                          textDecoration: 'underline',
                          width: 'fit-content',
                        }}
                      >
                        <span style={{
                          display: 'inline-flex',
                          transform: errorDetailOpen ? 'rotate(90deg)' : 'none',
                          transition: 'transform 120ms ease',
                        }}>
                          <Icon name="chevron" size={12} />
                        </span>
                        {tr('connect.errorWhatToCheck')}
                      </button>

                      {errorDetailOpen && (
                        <div id="cm-error-detail" style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12.5, lineHeight: 1.55 }}>
                          {/* The one thing to do next, for the specific
                              rejection this was. Ahead of everything else,
                              because in three of the four credential cases the
                              generic provider hint below is not the fix.
                              The provider's "what it is called and where it
                              lives" copy is deliberately NOT repeated here: it
                              is already printed beside the password field, and
                              for a login-name or IMAP-disabled failure it is
                              not the next step at all. */}
                          {authReason && AUTH_REASON_DETAIL_KEYS[authReason] && (
                            <span>{tr(AUTH_REASON_DETAIL_KEYS[authReason], { provider: appPasswordProvider })}</span>
                          )}
                          {!isGeneric && !authReason && (
                            <span>{tr(HINT_KEYS[provider] ?? 'connect.hintGeneric')}</span>
                          )}
                          {errorDetail && <span>{errorDetail}</span>}
                          {appPasswordUrl && (
                            <a
                              href={appPasswordUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 5,
                                color: 'var(--red-700)',
                                width: 'fit-content',
                              }}
                            >
                              <Icon name="key" size={12} />
                              {tr('connect.openAppPasswordPage', { provider: appPasswordProvider })}
                            </a>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* The form's default button. Hidden because the visible submit
                  lives in the footer, outside the form; without a default
                  button a browser will not submit on Enter from a form with
                  several fields. */}
              <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
            </form>
          )}

        </div>

        {/* Footer.
            The wrap used to be an inline style applied ONLY to the paywall
            panel with the annual interval chosen, on the reading that the
            annual CTA's price label was the thing that did not fit. That was
            measured in English. In Norwegian the MONTHLY row needs about 480px
            ("Avbryt" + "Sammenlign alle planer" + "Oppgrader til Personal,
            $5/md"), the modal is about 360px wide at a 375px viewport, .btn and
            both anchors are white-space: nowrap and .modal is overflow: hidden,
            so Cancel was clipped through the left edge of the dialog at the
            product's single revenue moment, with no way back to it.

            It is a class now (.modal-foot-limit, plus an unconditional wrap
            under 480px for every modal footer) and it is unconditional: with
            justify-content flex-end a row that fits still renders on one line,
            so wrapping costs the wide case nothing. */}
        <div className={'modal-foot' + (showLimitPanel ? ' modal-foot-limit' : '')}>
          {/* Plan limit reached: go straight to Stripe Checkout, at the
              interval chosen in the panel above and monthly until someone
              chooses otherwise. /api/stripe/checkout/start creates the session
              server side and redirects to Stripe, so this is one click from
              blocked to card form with no dashboard render in between. It must
              stay a plain anchor: a next/link prefetch would open checkout
              sessions for people who never clicked.

              Personal, not Pro: the cap this panel answers is the Free plan's
              single inbox, and the cheapest plan that clears it is Personal at
              $5. Sending someone to Pro to add a second mailbox prices the
              upgrade well above the problem. Anyone who genuinely needs
              unlimited mailboxes finds Pro through "Compare all plans", which
              stays as the secondary link.

              Only a capped account ever sees this panel, and the grandfathered
              cohort has no cap, so nobody who already holds unlimited inboxes
              can be routed at Personal from here. */}
          {showLimitPanel && (
            <>
              <Btn variant="ghost" onClick={onClose}>{tr('connect.cancel')}</Btn>
              <a
                href={limitUpgradeUrl}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  height: 34,
                  padding: '0 10px',
                  color: 'var(--fg-2)',
                  fontFamily: 'var(--font-sans)',
                  fontSize: 13,
                  textDecoration: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                {tr('connect.comparePlans')}
              </a>
              <a
                href={checkoutStartHref(upgradeCopy.plan, upgradeInterval === 'year')}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '0 16px',
                  height: 34,
                  background: 'var(--brand)',
                  color: '#fff',
                  borderRadius: 8,
                  fontFamily: 'var(--font-sans)',
                  fontSize: 13,
                  fontWeight: 500,
                  textDecoration: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                <Icon name="zap" size={13} color="#fff" />
                {upgradeCtaLabel(tr, {
                  offer: annual,
                  interval: upgradeInterval,
                  planName: planDisplayName(upgradeCopy.plan),
                  monthlyLabel: tr(upgradeCopy.ctaKey),
                })}
              </a>
            </>
          )}

          {/* Normal flow: provider selection */}
          {!showLimitPanel && step === 1 && (
            <>
              <Btn variant="ghost" onClick={onClose}>{tr('connect.cancel')}</Btn>
              <Btn variant="primary" icon="shield" onClick={handleConnect}>
                {connectLabel()}
              </Btn>
            </>
          )}

          {/* Normal flow: credentials */}
          {!showLimitPanel && step === 2 && (
            <>
              {/* Reconnect mode has no provider-selection step to return to, so the
                  secondary action cancels instead of going "back".

                  Both go through `requestClose`, never `onClose`: this button
                  discards exactly the same typed credentials as the X, the
                  scrim and Escape, and it was the one way out that skipped the
                  confirmation. While a check is running there is no "back" to
                  go to without abandoning it, so the label says Cancel and the
                  guard explains what closing costs. */}
              <Btn
                variant="ghost"
                onClick={submitting || isReconnect ? requestClose : handleBackToProviders}
              >
                {submitting || isReconnect ? tr('connect.cancel') : tr('connect.back')}
              </Btn>
              <Btn
                variant="primary"
                icon="shield"
                busy={submitting}
                onClick={handleAppPasswordSubmit}
              >
                {submitting ? tr('connect.verifying') : tr('connect.connectInbox')}
              </Btn>
            </>
          )}
        </div>

      </div>

      {/* Discard confirmation — shown when an outside click would otherwise
          wipe entered credentials. Its own scrim stops propagation so the
          backdrop click doesn't re-trigger the parent close guard. */}
      {confirmingClose && (
        <div
          className="scrim"
          onClick={e => { e.stopPropagation(); setConfirmingClose(false); }}
        >
          <div
            className="modal"
            ref={confirmRef}
            onClick={e => e.stopPropagation()}
            style={{ width: 380 }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="cm-discard-title"
          >
            <div className="modal-h">
              <h2 id="cm-discard-title" style={{ margin: 0 }}>
                {confirmingCloseDuringCheck ? tr('connect.discardTitleVerifying') : tr('connect.discardTitle')}
              </h2>
              <div className="sub" style={{ marginTop: 4 }}>
                {confirmingCloseDuringCheck ? tr('connect.discardBodyVerifying') : tr('connect.discardBody')}
              </div>
            </div>
            <div className="modal-foot">
              <Btn variant="secondary" onClick={() => setConfirmingClose(false)}>
                {confirmingCloseDuringCheck ? tr('connect.keepWaiting') : tr('connect.keepEditing')}
              </Btn>
              {/* Discarding closes the whole modal, so there is nothing behind
                  the prompt to hand focus back to. Clearing the opener stops
                  the restore effect from reaching for a control that is about
                  to be unmounted; the modal's own unmount cleanup returns focus
                  to whatever opened IT. */}
              <Btn variant="danger" onClick={() => { confirmOpenerRef.current = null; setConfirmingClose(false); onClose(); }}>
                {confirmingCloseDuringCheck ? tr('connect.closeAnyway') : tr('connect.discardConfirm')}
              </Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
