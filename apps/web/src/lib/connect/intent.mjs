import { getProvider } from './providers.mjs';
import { isReleased } from './release.mjs';
import { connectIntentSlugShape } from './intent-carry.mjs';

/**
 * Deciding what a carried provider slug means for the connect modal.
 *
 * intent-carry.mjs moves a slug-shaped string from a landing page to the
 * dashboard and trusts none of it. This file is where it is checked against
 * the registry, every time it is read: a string in a URL or in browser storage
 * is whatever somebody put there.
 *
 * It imports the provider registry, so it must only ever be loaded with a
 * dynamic `import()` from client code (see the note in intent-carry.mjs).
 */

/**
 * Registry slugs that have a card of their own in the connect modal.
 *
 * The values are the `k` of a card in ConnectModal.jsx's PROVIDERS list (the
 * branded IMAP presets, plus Fastmail and Outlook). intent-modal.test.ts pins
 * every value here to a card that exists, so a renamed card fails a test
 * instead of silently preselecting nothing.
 *
 * Gmail and Outlook are here as cards and nothing more. Outlook and
 * Microsoft 365 connect through Microsoft Graph OAuth, and the Gmail card
 * carries its own fixed hosts, so none of the four is ever given IMAP settings
 * to prefill. Google Workspace is a Gmail mailbox on a company domain and
 * connects through the same card.
 */
export const MODAL_CARD_BY_SLUG = Object.freeze({
  gmail: 'gmail',
  'google-workspace': 'gmail',
  outlook: 'outlook',
  office365: 'outlook',
  icloud: 'icloud',
  yahoo: 'yahoo',
  zoho: 'zoho',
  yandex: 'yandex',
  fastmail: 'fastmail',
});

/** The card every other provider lands on: the generic IMAP / SMTP form. */
export const GENERIC_CARD = 'generic';

const SECURITY = new Set(['tls', 'starttls']);
const IMAP_PORTS = new Set([993, 143]);
const SMTP_PORTS = new Set([465, 587]);

/** The registry's settings for one provider, or null if any part is unusable. */
function registrySettings(provider) {
  const { imap, smtp } = provider;
  if (!imap || !smtp) return null;
  if (typeof imap.host !== 'string' || !imap.host || typeof smtp.host !== 'string' || !smtp.host) return null;
  if (!IMAP_PORTS.has(imap.port) || !SMTP_PORTS.has(smtp.port)) return null;
  if (!SECURITY.has(imap.security) || !SECURITY.has(smtp.security)) return null;
  return {
    imapHost: imap.host,
    imapPort: imap.port,
    imapSecurity: imap.security,
    smtpHost: smtp.host,
    smtpPort: smtp.port,
    smtpSecurity: smtp.security,
  };
}

/**
 * Turn a carried slug into something the connect modal can act on, or null.
 *
 * Null means "behave exactly as if there had been no hint", and it is the
 * answer for:
 *  - anything that is not a registry slug;
 *  - a provider whose page is not released (a held wave has no public page, so
 *    a link naming it was not produced by this site);
 *  - a provider we cannot connect (Hey, Proton, Tutanota: category `blocked`,
 *    status `limited`). Their pages explain why not. Opening a form with their
 *    name on it would promise the opposite.
 *
 * `settings` is non-null only for the generic card, and only when the registry
 * holds a complete, standard pair of hosts. cPanel hosts, self-hosted stacks
 * and /connect/imap itself have no fixed hostname, so they resolve to the
 * generic card with nothing to fill in.
 */
export function resolveConnectIntent(slug, now = new Date()) {
  const clean = connectIntentSlugShape(slug);
  if (!clean) return null;
  const provider = getProvider(clean);
  if (!provider) return null;
  if (!isReleased(provider, now)) return null;
  if (provider.category === 'blocked' || provider.status !== 'supported') return null;

  const card = MODAL_CARD_BY_SLUG[provider.slug] ?? GENERIC_CARD;
  return {
    slug: provider.slug,
    name: provider.name,
    card,
    settings: card === GENERIC_CARD ? registrySettings(provider) : null,
  };
}

/**
 * The shape ConnectModal takes as its `preselect` prop.
 *
 * The hosts, ports and security modes are the registry's, as they are: they
 * were probed against the live server, and they are the same values the person
 * has just read in the settings table on the landing page, so the form agrees
 * with the page that sent them.
 *
 * `findPreset` is `findMailHostPreset` from email-providers/host-presets,
 * passed in so this file stays plain `.mjs` with no TypeScript import. It
 * contributes one thing the registry does not hold: whether the modal's own
 * table (MAIL_HOST_PRESETS) knows this host as a provider that insists on an
 * app password, and where to make one. That drives the same note the modal
 * shows when it recognises a provider from a typed address.
 *
 * The label is always the registry's name: the person came from a page titled
 * with it, and Namecheap's mail is "Private Email" only to Namecheap.
 */
export function connectPreselectFor(intent, findPreset = null) {
  if (!intent) return null;
  if (intent.card !== GENERIC_CARD || !intent.settings) {
    return { slug: intent.slug, card: intent.card, label: intent.name, form: null };
  }
  let preset = null;
  try {
    preset = findPreset ? findPreset({ host: intent.settings.imapHost }) : null;
  } catch {
    preset = null;
  }
  return {
    slug: intent.slug,
    card: GENERIC_CARD,
    label: intent.name,
    form: { ...intent.settings },
    requiresAppPassword: preset?.requiresAppPassword === true,
    appPasswordHelpUrl: preset?.appPasswordHelpUrl ?? null,
  };
}
