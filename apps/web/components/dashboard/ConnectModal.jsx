'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon, Btn, ProviderLogo } from '../Primitives';
import { trackProductEvent } from '@/lib/analytics.mjs';
import { useInboxPaywallView } from '@/lib/analytics/use-inbox-paywall.mjs';
import { OAUTH_VERIFICATION_PENDING } from '@/lib/oauth/verification-status';
import { checkoutStartHref } from '@/lib/billing/upgrade-intent.mjs';
import {
  IMAP_PRESETS,
  GENERIC_IMAP_DEFAULTS,
  isBrandedImapService,
  ZOHO_REGIONS,
  DEFAULT_ZOHO_REGION,
  DEFAULT_ZOHO_ACCOUNT_TYPE,
  portForSecurity,
  securityForPort,
  normalizeAppPassword,
} from '@/lib/email-providers/imap-presets';
import { prefillFromEmail } from '@/lib/email-providers/host-presets';

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
  icloud: 'connect.hintIcloud',
  yahoo: 'connect.hintYahoo',
  zoho: 'connect.hintZoho',
  yandex: 'connect.hintYandex',
  fastmail: 'connect.hintFastmail',
};

/**
 * Where each app-password provider actually generates the credential. These are
 * deep links to the generator, not to a help article: the top recorded failure
 * across every app-password provider is a plain `NO [AUTHENTICATIONFAILED]`,
 * i.e. the user submitted their normal account password, so the shortest route
 * to the right page is the thing most likely to change the outcome.
 */
const APP_PASSWORD_URLS = {
  icloud: 'https://account.apple.com/account/manage',
  yahoo: 'https://login.yahoo.com/myaccount/security/app-password',
  zoho: 'https://accounts.zoho.com/home#security/device_pass',
  yandex: 'https://id.yandex.com/security/app-passwords',
  fastmail: 'https://app.fastmail.com/settings/security/apppw',
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
};

/**
 * Failures whose fix lives in Advanced settings (port / security mode). When
 * one of these comes back, the section is opened so the fields the user has to
 * change are actually on screen.
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
 * no userinfo, and never a colon or a port glued to the end. That matters
 * because the server's `isValidHost` accepts almost anything with a dot in it,
 * so a host field still carrying `:` or `:99999` is sent to DNS and comes back
 * as "could not reach that server", which points the user at the wrong thing.
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
 * ConnectModal.jsx: inbox connection modal.
 *
 * Step 1: Provider selection.
 *   - Gmail / Outlook → clicking "Connect" navigates to the server-side OAuth
 *     initiation route, which redirects to the provider's consent screen.
 *   - Fastmail → OAuth (route) or app password (in-modal step 2).
 *   - iCloud / Yahoo / Zoho / Yandex → app password (in-modal step 2), using
 *     the host presets from lib/email-providers/imap-presets.
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
  ...Object.values(IMAP_PRESETS).map(p => ({
    k: p.service,
    label: p.label,
    subKey: 'connect.subAppPassword',
    logoKind: p.logoKind,
  })),
  { k: 'fastmail', label: 'Fastmail', subKey: 'connect.subFastmail',    logoKind: 'imap' },
  { k: 'gmail',    label: 'Gmail',    subKey: 'connect.subGmail',       logoKind: 'gmail' },
  // Outlook is temporarily unavailable (Microsoft connector not live yet) —
  // shown LAST, greyed out / non-selectable with a "coming soon" flag until it ships.
  { k: 'outlook',  label: 'Outlook',  subKey: 'connect.subOutlook',     logoKind: 'outlook', disabled: true },
];

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
 */
export function ConnectModal({
  onClose,
  onConnect,
  atInboxLimit = false,
  planName = 'Free',
  inboxCount = null,
  maxInboxes = null,
  reconnect = null,
}) {
  const tr = useTranslations('dashboardChrome');
  // Reconnect mode: re-open the form this inbox was created with, identity
  // pre-filled and locked, so only the password is re-entered. Map the stored
  // service back to a modal provider: 'generic' (or a missing service) → the
  // generic IMAP form; a branded service (fastmail/icloud/yahoo/zoho/yandex) →
  // that provider. This is what stops a generic IMAP inbox from being sent to
  // the Fastmail form, and stops the browser autofilling another saved login
  // into a blank field.
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
  const [zohoRegion, setZohoRegion] = useState(DEFAULT_ZOHO_REGION);
  const [zohoAccountType, setZohoAccountType] = useState(DEFAULT_ZOHO_ACCOUNT_TYPE);
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
  // The long-form troubleshooting text that used to lead the alert. It is kept,
  // but behind a disclosure, so the first thing the user reads is one sentence.
  const [errorDetail, setErrorDetail] = useState(null);
  const [errorDetailOpen, setErrorDetailOpen] = useState(false);
  // A rejected password is replaced far more often than it is edited, so after
  // a failure the field is focused with its contents selected: the next
  // keystroke overwrites it.
  const passwordRef = useRef(null);
  // Armed only by a rejected credential, and spent by the first focus that
  // follows. Selecting on EVERY focus meant that clicking back into the field
  // to fix one character of a 16-character app password destroyed the value on
  // the next keystroke, which is unrecoverable when the field is dots.
  const selectPasswordOnFocus = useRef(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  // Set when the address the user typed identified a known mail provider and we
  // filled the server fields in for them. Shape:
  // { label, requiresAppPassword, appPasswordHelpUrl }.
  const [hostPrefill, setHostPrefill] = useState(null);

  /**
   * Advanced settings (generic IMAP only): ports, security modes and the
   * optional login username. Collapsed by default because they are noise for
   * nearly every mailbox, but NEVER collapsed over a value that differs from
   * the default. A reconnect carrying port 143, STARTTLS or a separate login
   * username opens the section on mount, so nothing the user is about to
   * submit is hidden from them.
   */
  const [advancedOpen, setAdvancedOpen] = useState(() => {
    const imapPort = Number(reconnect?.imapPort ?? GENERIC_IMAP_DEFAULTS.imapPort);
    const smtpPort = Number(reconnect?.smtpPort ?? GENERIC_IMAP_DEFAULTS.smtpPort);
    const imapSecurity = reconnect?.imapSecurity ?? (reconnect?.imapPort === 143 ? 'starttls' : 'tls');
    const smtpSecurity = reconnect?.smtpSecurity ?? (reconnect?.smtpPort === 587 ? 'starttls' : 'tls');
    return (
      imapPort !== GENERIC_IMAP_DEFAULTS.imapPort ||
      smtpPort !== GENERIC_IMAP_DEFAULTS.smtpPort ||
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
  //
  // The cheapest plan that actually clears the cap just hit. Free stops at one
  // inbox, so Personal (three, $5) clears it, and sending someone to $29 Pro
  // to add a second mailbox would price the upgrade far above the problem.
  // Personal itself stops at three, so from there only Pro (unlimited) is a
  // way forward, and offering Personal to a Personal subscriber would sell
  // them the plan they are already on.
  //
  // Derived from the cap rather than from a plan id because that number is the
  // server's own, counted at the moment of the refusal, so it stays right even
  // when the plan changed in another tab. An unknown cap means the Free
  // assumption, which is what the "connects one inbox" heading already says.
  //
  // The grandfathered cohort has no cap at all and never reaches this panel,
  // so nobody holding unlimited inboxes can be routed at Personal from here.
  const capTargetsPersonal = (limitMaxInboxes ?? 1) <= 1;
  const upgradeCopy = capTargetsPersonal
    ? {
        plan: 'personal',
        titleKey: 'connect.personalUpgradeTitle',
        bodyKey: 'connect.personalUpgradeBody',
        ctaKey: 'connect.personalUpgradeCta',
        featureKeys: [
          'connect.personalFeatureInboxes',
          'connect.personalFeatureRateLimit',
          'connect.featureTeam',
          'connect.featureSupport',
        ],
      }
    : {
        plan: 'solo',
        titleKey: 'connect.upgradeTitle',
        bodyKey: 'connect.upgradeBody',
        ctaKey: 'connect.viewUpgradeOptions',
        featureKeys: [
          'connect.featureInboxes',
          'connect.featureRateLimit',
          'connect.featureTeam',
          'connect.featureSupport',
        ],
      };

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
   * Fill the server fields in from the address, when we recognise the provider.
   *
   * The generic form asks for two hostnames, two ports and two security modes,
   * and a user who does not have them in front of them has no way to produce
   * them except by guessing. The production record is exactly that: twelve
   * consecutive attempts against one host with the port and security mode
   * alternating between the two standard pairs. Every entry in the lookup table
   * is a provider that produced repeated failures like it.
   *
   * Only ever fills EMPTY fields. A host the user typed came from their
   * provider's own documentation and is better than our table by definition,
   * and silently rewriting it would be the same class of bug as a browser
   * autofilling the wrong login.
   */
  const applyEmailPrefill = () => {
    if (!isGeneric || isReconnect) return;
    const match = prefillFromEmail(form.email.trim());
    if (!match) { setHostPrefill(null); return; }
    if (form.imapHost.trim() || form.smtpHost.trim()) return;
    setForm(prev => ({
      ...prev,
      imapHost: match.imapHost,
      imapPort: match.imapPort,
      imapSecurity: match.imapSecurity,
      smtpHost: match.smtpHost,
      smtpPort: match.smtpPort,
      smtpSecurity: match.smtpSecurity,
    }));
    setHostPrefill({
      label: match.label,
      requiresAppPassword: match.requiresAppPassword,
      appPasswordHelpUrl: match.appPasswordHelpUrl,
    });
  };

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
    setForm(prev => ({
      ...prev,
      [protocol === 'imap' ? 'imapSecurity' : 'smtpSecurity']: security,
      [protocol === 'imap' ? 'imapPort' : 'smtpPort']: portForSecurity(protocol, security),
    }));
  };

  const setPort = (protocol, value) => {
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
    // Reconnect locks the server fields: nothing to rewrite, and the stored
    // host is the row's identity.
    if (isReconnect) return parsed;
    if (parsed.host !== form[key]) {
      setForm(prev => ({ ...prev, [key]: parsed.host }));
    }
    if (parsed.port !== null) {
      // Reuse the port setter so the security mode still follows a standard
      // port, exactly as if the value had been typed into the port field.
      setPort(protocol, String(parsed.port));
      setAdvancedOpen(true);
      setPortNote({ protocol, port: parsed.port });
    }
    // An impossible port is named on the spot. The alternative is what the
    // field used to do: keep the digits on the hostname, hand the whole string
    // to DNS, and answer with "could not reach that server", which sends the
    // user hunting for a network fault that does not exist.
    if (parsed.portError === 'range') {
      setPortNote(null);
      setPortRangeError(protocol);
    } else if (portRangeError === protocol) {
      setPortRangeError(null);
    }
    return parsed;
  };

  /** Replace the alert with a single sentence and no expandable detail. */
  const showError = message => {
    setFormError(message);
    setErrorDetail(null);
    setErrorDetailOpen(false);
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

  const handleConnect = async () => {
    trackProductEvent('inbox_connect_started', { provider: provider === 'generic' ? 'imap' : provider });
    try {
      await fetch('/api/onboarding', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'provider_selected', provider: provider === 'generic' ? 'generic_imap' : provider }),
        keepalive: true,
      });
    } catch { /* the connection remains available if analytics is unavailable */ }
    if (usesAppPassword) {
      setStep(2);
      return;
    }
    // OAuth paths (Gmail, Outlook, Fastmail OAuth) navigate to the server-side
    // initiation route. The page reloads after the provider redirects back.
    window.location.href = OAUTH_ROUTES[provider];
  };

  const connectLabel = () => {
    if (provider === 'gmail') return tr('connect.connectWithGoogle');
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
  const appPasswordUrl = isGeneric ? (hostPrefill?.appPasswordHelpUrl ?? null) : (APP_PASSWORD_URLS[provider] ?? null);
  const appPasswordProvider = isGeneric ? (hostPrefill?.label ?? providerLabel()) : providerLabel();

  // ── Step 2: credentials submission ─────────────────────────────────────────

  const handleAppPasswordSubmit = async () => {
    showError(null);

    const email = form.email.trim().toLowerCase();
    // Branded app-password providers issue tokens that never contain
    // whitespace, but they display them in groups and copy-paste readily drags
    // in a stray space, newline or non-breaking space. Those characters travel
    // inside the SASL token and come back as an ordinary credential rejection,
    // so the user is told to fix a password that was already right. The generic
    // connector is excluded: there the value is a real account password and a
    // space in it may well be deliberate.
    const appPassword = isGeneric
      ? form.password.trim()
      : normalizeAppPassword(form.password);

    if (!email || !email.includes('@')) {
      showError(tr('connect.errorEmailRequired'));
      return;
    }
    if (!appPassword) {
      showError(tr('connect.errorPasswordRequired'));
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
      // Digits that cannot be a port were just stripped off a host field.
      // Submitting anyway would connect on the default port, which is not what
      // the user asked for, so stop and say what was wrong with the number.
      if (imapParsed.portError === 'range' || smtpParsed.portError === 'range') {
        showError(tr('connect.errorPortRange'));
        return;
      }
      const imapHost = imapParsed.host.toLowerCase();
      const smtpHost = smtpParsed.host.toLowerCase();
      const imapPort = Number(imapParsed.port ?? form.imapPort);
      const smtpPort = Number(smtpParsed.port ?? form.smtpPort);
      if (!imapHost || !smtpHost) {
        showError(tr('connect.errorHostRequired'));
        return;
      }
      if (!imapPort || !smtpPort) {
        showError(tr('connect.errorPortRequired'));
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
        const code = data.error_code ?? 'connection_failed';
        const count = lastFailure.code === code ? lastFailure.count + 1 : 1;
        setLastFailure({ code, count });

        // One sentence leads. The route's own paragraph is real diagnostic
        // detail, so it is kept, but folded into "What to check" underneath
        // together with the second-attempt advice.
        setFormError(tr(ERROR_HEADLINE_KEYS[code] ?? 'connect.errorConnectionFailed'));
        const details = [];
        if (typeof data.error === 'string' && data.error.trim()) details.push(data.error.trim());
        if (count >= 2) details.push(tr('connect.errorRepeatHint'));
        setErrorDetail(details.length > 0 ? details.join(' ') : null);
        setErrorDetailOpen(false);

        // A port/security failure is fixed in Advanced settings, so put those
        // fields on screen rather than leaving the fix behind a closed section.
        if (isGeneric && TRANSPORT_ERROR_CODES.has(code)) setAdvancedOpen(true);

        // A rejected credential is almost always replaced wholesale rather than
        // edited, so hand the field back ready to overwrite. Only for auth
        // failures: stealing focus when the fix is a host or a port would move
        // the user away from the field they need.
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
      // (icloud/yahoo/zoho/yandex) and Fastmail, and 'imap' for the generic
      // connector; the label falls back to the address local-part when there's
      // no display name.
      const optimisticProvider = provider === 'generic' ? 'imap' : provider;
      const optimisticLabel = email.split('@')[0] || email;
      onConnect({ provider: optimisticProvider, address: email, label: optimisticLabel });
    } catch {
      showError(tr('connect.errorNetwork'));
    } finally {
      setSubmitting(false);
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
    !submitting &&
    // The credentials form is no longer on screen once the upgrade panel
    // takes over, so there is nothing for a discard prompt to protect.
    !showLimitPanel &&
    Boolean(
      form.email.trim() ||
        form.username.trim() ||
        form.password ||
        form.imapHost.trim() ||
        form.smtpHost.trim() ||
        yandexLogin.trim()
    );

  /**
   * The one way out of this modal. Every close affordance goes through here:
   * the scrim, the header X and the Escape key all put the same typed
   * credentials at risk, so they all get the same discard confirmation. The X
   * used to call onClose directly, which threw away a filled-in form without
   * asking.
   */
  const requestClose = () => {
    if (hasUnsavedInput()) {
      setConfirmingClose(true);
      return;
    }
    onClose();
  };

  // ── Dialog behaviour: focus restore, Escape, focus trap ────────────────────

  const dialogRef = useRef(null);
  const confirmRef = useRef(null);
  /** The element that opened the modal, so focus can be handed back to it. */
  const openerRef = useRef(null);

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

  // When the discard confirmation opens, move focus into it. Without this the
  // trap below would be guarding a dialog that focus is not actually inside.
  useEffect(() => {
    if (!confirmingClose) return;
    const first = confirmRef.current?.querySelector('button');
    if (first) first.focus();
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
      >

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
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--fg-3)',
                padding: 4,
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

              {/* Gmail: a plain account of what Google's screens look like.
                  This used to be an amber alert box with a warning triangle,
                  which is the wrong instrument: the screen it describes is a
                  permanent condition of shipping an unverified Google app, not
                  an incident, and dressing it as a hazard talked users out of a
                  flow they had already chosen. 39.5% of Gmail connects were
                  abandoned with no failure ever recorded on our side, i.e. on
                  Google's screen. So: show the screen, name the exact buttons,
                  and say why the wording is what it is. */}
              {OAUTH_VERIFICATION_PENDING && provider === 'gmail' && (
                <div
                  role="note"
                  style={{
                    marginTop: 16,
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
                    {/* eslint-disable-next-line @next/next/no-img-element */}
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
              {(isPreset || provider === 'fastmail') && (
                <p style={{
                  margin: '12px 0 0',
                  fontFamily: 'var(--font-sans)',
                  fontSize: 12,
                  color: 'var(--fg-3)',
                  lineHeight: 1.5,
                }}>
                  {tr(HINT_KEYS[provider])}{' '}
                  <a
                    href={APP_PASSWORD_URLS[provider]}
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
                  <select
                    id="cm-zoho-account-type"
                    className="input"
                    value={zohoAccountType}
                    onChange={e => setZohoAccountType(e.target.value)}
                  >
                    {ZOHO_ACCOUNT_TYPES.map(t => (
                      <option key={t.value} value={t.value}>{tr(t.labelKey)}</option>
                    ))}
                  </select>
                  <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                    {tr('connect.zohoAccountTypeHint')}
                  </span>
                </div>
              )}

              {provider === 'zoho' && (
                <div className="field">
                  <label htmlFor="cm-zoho-region">{tr('connect.zohoRegionLabel')}</label>
                  <select
                    id="cm-zoho-region"
                    className="input"
                    value={zohoRegion}
                    onChange={e => setZohoRegion(e.target.value)}
                  >
                    {ZOHO_REGIONS.map(r => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                  <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                    {tr('connect.zohoRegionHint')}
                  </span>
                </div>
              )}

              <div className="field">
                <label htmlFor="cm-email">{tr('connect.emailLabel')}</label>
                <input
                  id="cm-email"
                  className="input"
                  type="email"
                  placeholder="you@example.com"
                  value={form.email}
                  onChange={e => setForm(prev => ({ ...prev, email: e.target.value }))}
                  // On blur rather than on change: reacting mid-typing would
                  // match a half-typed domain and fill the server fields with
                  // someone else's provider.
                  onBlur={applyEmailPrefill}
                  autoComplete="email"
                  // Reconnect: the address is the row's identity — never change it,
                  // and lock it so the browser can't autofill another saved login.
                  readOnly={isReconnect}
                  aria-readonly={isReconnect || undefined}
                  autoFocus={!isReconnect}
                />
                {isGeneric && hostPrefill && (
                  <span role="status" style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--brand)' }}>
                    {tr('connect.hostPrefillNote', { provider: hostPrefill.label })}
                  </span>
                )}
                {isGeneric && hostPrefill?.requiresAppPassword && (
                  <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                    {tr('connect.hostPrefillAppPassword', { provider: hostPrefill.label })}
                  </span>
                )}
              </div>

              {provider === 'yandex' && (
                <>
                <div className="field">
                  <label htmlFor="cm-yandex-account-type">{tr('connect.yandexAccountTypeLabel')}</label>
                  <select id="cm-yandex-account-type" className="input" value={yandexAccountType} onChange={e => setYandexAccountType(e.target.value)} disabled={isReconnect}>
                    <option value="personal">{tr('connect.yandexPersonal')}</option>
                    <option value="business">{tr('connect.yandexBusiness')}</option>
                  </select>
                  <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
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
                    autoComplete="username"
                    readOnly={isReconnect}
                    aria-readonly={isReconnect || undefined}
                  />
                  <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                    {tr('connect.yandexLoginHint')}
                  </span>
                </div>
                </>
              )}

              {/* The common path: the two hosts, nothing else. Ports, security
                  modes and the optional login username are protocol detail that
                  99% of mailboxes never need, and having them inline (with two
                  unlabelled TLS/STARTTLS selects bracketing the host rows, so
                  neither obviously belonged to IMAP or to SMTP) is what made
                  this form read as a wall of settings. They now live in
                  Advanced settings, below the password. */}
              {isGeneric && (
                <>
                  <div className="field">
                    <label htmlFor="cm-imap-host">{tr('connect.imapHostLabel')}</label>
                    <input
                      id="cm-imap-host"
                      className="input"
                      type="text"
                      placeholder="imap.example.com"
                      value={form.imapHost}
                      onChange={e => { setPortNote(null); setPortRangeError(null); setForm(prev => ({ ...prev, imapHost: e.target.value })); }}
                      onBlur={() => normalizeHostField('imap')}
                      readOnly={isReconnect}
                      aria-readonly={isReconnect || undefined}
                    />
                    <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                      {tr('connect.hostPasteHint')}
                    </span>
                    {portNote?.protocol === 'imap' && (
                      <span role="status" style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--brand)' }}>
                        {tr('connect.portMovedNote', { port: String(portNote.port), protocol: 'IMAP' })}
                      </span>
                    )}
                    {portRangeError === 'imap' && (
                      <span role="alert" style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--red-700)' }}>
                        {tr('connect.errorPortRange')}
                      </span>
                    )}
                  </div>

                  <div className="field">
                    <label htmlFor="cm-smtp-host">{tr('connect.smtpHostLabel')}</label>
                    <input
                      id="cm-smtp-host"
                      className="input"
                      type="text"
                      placeholder="smtp.example.com"
                      value={form.smtpHost}
                      onChange={e => { setPortNote(null); setPortRangeError(null); setForm(prev => ({ ...prev, smtpHost: e.target.value })); }}
                      onBlur={() => normalizeHostField('smtp')}
                      readOnly={isReconnect}
                      aria-readonly={isReconnect || undefined}
                    />
                    {portNote?.protocol === 'smtp' && (
                      <span role="status" style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--brand)' }}>
                        {tr('connect.portMovedNote', { port: String(portNote.port), protocol: 'SMTP' })}
                      </span>
                    )}
                    {portRangeError === 'smtp' && (
                      <span role="alert" style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--red-700)' }}>
                        {tr('connect.errorPortRange')}
                      </span>
                    )}
                  </div>
                </>
              )}

              <div className="field">
                <label htmlFor="cm-password">{isGeneric ? tr('connect.passwordLabel') : tr('connect.appPasswordLabel')}</label>
                {/* An app password is 16+ characters typed or pasted blind. With
                    no way to read it back, a single wrong character is not
                    correctable, only replaceable, so the field gets a reveal
                    toggle like every other credential box in the product. */}
                <div style={{ position: 'relative', display: 'flex' }}>
                  <input
                    id="cm-password"
                    ref={passwordRef}
                    className="input"
                    style={{ flex: 1, paddingRight: 40, minWidth: 0 }}
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
                    autoComplete="current-password"
                    autoFocus={isReconnect}
                  />
                  <button
                    type="button"
                    className="plain-focus"
                    onClick={() => setPasswordVisible(v => !v)}
                    aria-label={passwordVisible ? tr('connect.hidePassword') : tr('connect.showPassword')}
                    aria-pressed={passwordVisible}
                    style={{
                      position: 'absolute',
                      right: 4,
                      top: 0,
                      height: 36,
                      width: 32,
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
                <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                  {isGeneric ? tr('connect.passwordHint') : tr('connect.appPasswordHint', { provider: providerLabel() })}
                </span>
                {/* The link to generate the credential only ever existed on the
                    provider-selection step, so by the time the user was actually
                    looking at the password box it was gone. Every app-password
                    provider's dominant failure is a bare
                    `NO [AUTHENTICATIONFAILED]` — the account password submitted
                    in place of an app password — so the link belongs here, next
                    to the field it is about. */}
                {!isGeneric && APP_PASSWORD_URLS[provider] && (
                  <a
                    href={APP_PASSWORD_URLS[provider]}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      marginTop: 2,
                      fontFamily: 'var(--font-sans)',
                      fontSize: 12,
                      color: 'var(--brand)',
                      width: 'fit-content',
                    }}
                  >
                    <Icon name="key" size={12} />
                    {tr('connect.openAppPasswordPage', { provider: providerLabel() })}
                  </a>
                )}
              </div>

              {/* ── Advanced settings (generic IMAP only) ──────────────────
                  Closed by default, but opened automatically whenever it holds
                  a value that differs from the default, whenever a port is
                  lifted out of a host field, and whenever a failure comes back
                  that can only be fixed in here. Nothing that is about to be
                  submitted is ever hidden. */}
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
                    // hidden instead would put a fieldset of ports into the
                    // form for every mailbox that never needs it, which is the
                    // thing the disclosure exists to avoid. aria-expanded on
                    // the button is the part that carries the state.
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
                          className="input"
                          type="text"
                          placeholder={tr('connect.usernamePlaceholder')}
                          value={form.username}
                          onChange={e => setForm(prev => ({ ...prev, username: e.target.value }))}
                          autoComplete="username"
                          // Locked on reconnect: this was the root cause of the
                          // wrong-mailbox bug — a blank username field autofilled with
                          // another account's saved login. Identity stays fixed.
                          readOnly={isReconnect}
                          aria-readonly={isReconnect || undefined}
                        />
                        <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                          {tr('connect.usernameHint')}
                        </span>
                      </div>

                      {/* Each control sits under the protocol it belongs to.
                          Previously the two security selects sat at opposite
                          ends of the form and neither said which half it
                          governed. */}
                      <fieldset style={{ border: '1px solid var(--border-1)', borderRadius: 8, padding: 12, margin: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <legend style={{ fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 600, color: 'var(--fg-2)', padding: '0 6px' }}>
                          {tr('connect.imapSectionLabel')}
                        </legend>
                        <div className="field">
                          <label htmlFor="cm-imap-security">{tr('connect.imapSecurityLabel')}</label>
                          <select id="cm-imap-security" className="input" value={form.imapSecurity} onChange={e => setSecurity('imap', e.target.value)} disabled={isReconnect}>
                            <option value="tls">{tr('connect.securityTls')}</option>
                            <option value="starttls">{tr('connect.securityStarttls')}</option>
                          </select>
                          <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                            {tr('connect.securityPortNote')}
                          </span>
                        </div>
                        <div className="field">
                          <label htmlFor="cm-imap-port">{tr('connect.imapPortLabel')}</label>
                          <input
                            id="cm-imap-port"
                            className="input"
                            type="number"
                            value={form.imapPort}
                            onChange={e => setPort('imap', e.target.value)}
                            readOnly={isReconnect}
                            aria-readonly={isReconnect || undefined}
                          />
                        </div>
                      </fieldset>

                      <fieldset style={{ border: '1px solid var(--border-1)', borderRadius: 8, padding: 12, margin: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <legend style={{ fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 600, color: 'var(--fg-2)', padding: '0 6px' }}>
                          {tr('connect.smtpSectionLabel')}
                        </legend>
                        <div className="field">
                          <label htmlFor="cm-smtp-security">{tr('connect.smtpSecurityLabel')}</label>
                          <select id="cm-smtp-security" className="input" value={form.smtpSecurity} onChange={e => setSecurity('smtp', e.target.value)} disabled={isReconnect}>
                            <option value="tls">{tr('connect.securityTls')}</option>
                            <option value="starttls">{tr('connect.securityStarttls')}</option>
                          </select>
                          <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                            {tr('connect.securityPortNote')}
                          </span>
                        </div>
                        <div className="field">
                          <label htmlFor="cm-smtp-port">{tr('connect.smtpPortLabel')}</label>
                          <input
                            id="cm-smtp-port"
                            className="input"
                            type="number"
                            value={form.smtpPort}
                            onChange={e => setPort('smtp', e.target.value)}
                            readOnly={isReconnect}
                            aria-readonly={isReconnect || undefined}
                          />
                        </div>
                      </fieldset>
                    </div>
                  )}
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
                  role="alert"
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
                  <span>{formError}</span>

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
                          {!isGeneric && (
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

        {/* Footer */}
        <div className="modal-foot">
          {/* Plan limit reached: go straight to Stripe Checkout for Personal
              monthly. /api/stripe/checkout/start creates the session server
              side and redirects to Stripe, so this is one click from blocked
              to card form with no dashboard render in between. It must stay a
              plain anchor: a next/link prefetch would open checkout sessions
              for people who never clicked.

              Personal, not Pro: the cap this panel answers is the Free plan's
              single inbox, and the cheapest plan that clears it is Personal at
              $5. Sending someone to $29 Pro to add a second mailbox prices the
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
                href={checkoutStartHref(upgradeCopy.plan, false)}
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
                {tr(upgradeCopy.ctaKey)}
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
                  secondary action cancels instead of going "back". */}
              <Btn variant="ghost" onClick={isReconnect ? onClose : handleBackToProviders}>
                {isReconnect ? tr('connect.cancel') : tr('connect.back')}
              </Btn>
              <Btn
                variant="primary"
                icon={submitting ? undefined : 'shield'}
                disabled={submitting}
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
              <h2 id="cm-discard-title" style={{ margin: 0 }}>{tr('connect.discardTitle')}</h2>
              <div className="sub" style={{ marginTop: 4 }}>{tr('connect.discardBody')}</div>
            </div>
            <div className="modal-foot">
              <Btn variant="secondary" onClick={() => setConfirmingClose(false)}>
                {tr('connect.keepEditing')}
              </Btn>
              <Btn variant="danger" onClick={() => { setConfirmingClose(false); onClose(); }}>
                {tr('connect.discardConfirm')}
              </Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
