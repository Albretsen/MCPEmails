/**
 * Personal Microsoft account addresses (Outlook.com, Hotmail, Live, MSN).
 *
 * Microsoft switched off password ("basic") authentication for IMAP, POP and
 * SMTP on personal Microsoft accounts on 2024-09-16. An @outlook.com or
 * @hotmail.com address typed into the IMAP / app-password form can therefore
 * never connect, whatever server, port or password is entered: the only way
 * in is OAuth, which is the Outlook card ("Sign in with Microsoft").
 *
 * Browser-safe (no imports): the connect modal uses it to show a notice under
 * the address field, and the IMAP / app-password routes use it to refuse the
 * attempt with `microsoft_account_use_outlook` before dialling a mail server.
 *
 * Deliberately a list of consumer DOMAINS, never an MX or host heuristic. A
 * business on its own domain whose mail happens to live in Microsoft 365 is
 * not matched, and is never blocked by this module.
 */

/** The error code the connect routes answer with for these addresses. */
export const MICROSOFT_ACCOUNT_USE_OUTLOOK = 'microsoft_account_use_outlook';

/**
 * `outlook.*` and `hotmail.*` are Microsoft's own brands in every country
 * variant, so any country suffix counts: outlook.de, outlook.com.br,
 * hotmail.co.uk, hotmail.no. The suffix must look like a country code
 * (optionally behind co./com.), so e.g. "outlook.example.org" does not match.
 */
const BRANDED_MICROSOFT_DOMAIN = /^(?:outlook|hotmail)\.(?:com|[a-z]{2}|(?:co|com)\.[a-z]{2})$/;

/**
 * Two-letter TLDs that are sold as generic names (outlook.io is a startup, not
 * Microsoft), so a bare outlook.<these> / hotmail.<these> is not assumed.
 */
const VANITY_CCTLDS: ReadonlySet<string> = new Set([
  'ai', 'cc', 'co', 'fm', 'gg', 'io', 'ly', 'me', 'sh', 'so', 'to', 'tv', 'ws',
]);

/**
 * `live.*` and `msn.*` are ordinary words that other people own in many
 * country domains, so only the variants Microsoft actually issues are listed.
 */
const LISTED_MICROSOFT_DOMAINS: ReadonlySet<string> = new Set([
  'msn.com',
  'passport.com',
  'windowslive.com',
  'live.com',
  'live.at',
  'live.be',
  'live.ca',
  'live.cl',
  'live.cn',
  'live.co.kr',
  'live.co.uk',
  'live.co.za',
  'live.com.ar',
  'live.com.au',
  'live.com.mx',
  'live.com.my',
  'live.com.pt',
  'live.com.sg',
  'live.de',
  'live.dk',
  'live.fi',
  'live.fr',
  'live.hk',
  'live.ie',
  'live.in',
  'live.it',
  'live.jp',
  'live.nl',
  'live.no',
  'live.ru',
  'live.se',
]);

function domainOf(emailOrDomain: string): string {
  const value = String(emailOrDomain ?? '').trim().toLowerCase().replace(/\.$/, '');
  const at = value.lastIndexOf('@');
  return at < 0 ? value : value.slice(at + 1);
}

/** True for a personal Microsoft account domain (outlook.com, hotmail.no, live.co.uk, msn.com, ...). */
export function isMicrosoftConsumerDomain(domain: string): boolean {
  const d = domainOf(domain);
  if (!d) return false;
  if (LISTED_MICROSOFT_DOMAINS.has(d)) return true;
  if (!BRANDED_MICROSOFT_DOMAIN.test(d)) return false;
  const labels = d.split('.');
  return !(labels.length === 2 && VANITY_CCTLDS.has(labels[1]));
}

/** True when the address is on a personal Microsoft account domain. */
export function isMicrosoftConsumerAddress(email: string): boolean {
  const value = String(email ?? '');
  return value.includes('@') && isMicrosoftConsumerDomain(value);
}

/** The route's 422 body. `error` is the English fallback; the dashboard localises by code. */
export function microsoftAccountErrorBody(): { error: string; error_code: string } {
  return {
    error:
      'Microsoft accounts (Outlook.com, Hotmail, Live, MSN) no longer accept a password over IMAP: ' +
      'Microsoft turned that off on 2024-09-16. Connect this address with the Outlook card ' +
      '("Sign in with Microsoft") instead.',
    error_code: MICROSOFT_ACCOUNT_USE_OUTLOOK,
  };
}
