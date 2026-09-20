/**
 * Is this mailbox on a company's own domain, or on a consumer mail service?
 *
 * WHY THIS EXISTS. Measured on production on 2026-09-20: a workspace holding a
 * mailbox on a business (non-consumer) domain converts at the inbox paywall at
 * roughly 22%, against under 2% for a consumer one. The buyer is one operator
 * running several company mailboxes (info@, sales@, invoices@ on one domain),
 * and that is a different offer from "work, personal, and one more". This
 * module is the one place that draws the line, so the paywall, and anything
 * else that later wants the segment, cannot each draw it somewhere different.
 *
 * DEFINITION BY EXCLUSION. There is no list of businesses. A domain is
 * business-shaped when it is a syntactically plausible domain that is NOT a
 * known consumer mail service. So every mistake this module can make is the
 * same mistake: a consumer service missing from the list reads as a business.
 * The measurement that motivated this found exactly that (a Canadian ISP and an
 * Indian Yahoo variant were both counted as companies), which is why the list
 * is backed by brand FAMILIES that match under any TLD or ccTLD, instead of by
 * an attempt to enumerate every country a webmail brand operates in.
 *
 * The cost of the mistake is small and one-directional: a consumer wrongly
 * read as a business is shown Personal AND Pro instead of Personal alone. They
 * are never shown less, and never a different price.
 *
 * FAILS CLOSED. Anything that is not a recognisable address or domain
 * (undefined, a number, an empty string, "not an email") is NOT business. The
 * paywall's behaviour for an unknown workspace must be today's behaviour.
 *
 * Pure, dependency-free and `.mjs` so the client bundle, the server and
 * `node --test` can all import the same file.
 */

/**
 * Exact consumer domains. Seeded from the classifier used for the segment
 * measurement (docs/PLAN-multi-mailbox-business-segment.md, section 3.4), plus
 * the ISPs that measurement was found to be missing.
 *
 * Domains covered by a brand family below are still listed when they were in
 * the original seed, so this list stays diffable against the SQL array.
 */
export const CONSUMER_EMAIL_DOMAINS = Object.freeze([
  // Google
  'gmail.com', 'googlemail.com',
  // Yahoo and its older brands
  'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in', 'yahoo.fr', 'yahoo.de', 'yahoo.es',
  'yahoo.it', 'yahoo.ca', 'yahoo.com.br', 'yahoo.com.au', 'ymail.com',
  'rocketmail.com', 'myyahoo.com',
  // Apple
  'icloud.com', 'me.com', 'mac.com',
  // Microsoft consumer
  'outlook.com', 'outlook.es', 'outlook.fr', 'outlook.de', 'outlook.com.br',
  'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'hotmail.es', 'hotmail.it',
  'hotmail.de', 'live.com', 'live.co.uk', 'live.nl', 'msn.com', 'passport.com',
  // AOL / Verizon Media
  'aol.com', 'aim.com',
  // Privacy-first webmail
  'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me',
  'tutanota.com', 'tutanota.de', 'tutamail.com', 'tuta.io', 'tuta.com', 'keemail.me',
  'mailfence.com', 'posteo.de', 'posteo.net', 'runbox.com', 'mailbox.org',
  'hushmail.com', 'startmail.com', 'disroot.org', 'riseup.net',
  // Russian-language webmail
  'yandex.com', 'yandex.ru', 'ya.ru', 'mail.ru', 'bk.ru', 'inbox.ru', 'list.ru',
  'rambler.ru',
  // German-language webmail and ISPs
  'gmx.com', 'gmx.de', 'gmx.net', 'gmx.co.uk', 'gmx.at', 'gmx.ch', 'web.de',
  't-online.de', 'freenet.de', 'arcor.de', 'vodafone.de', 'mail.de', 'bluewin.ch',
  'aon.at',
  // Hosted personal mail sold to individuals
  'zoho.com', 'zohomail.com', 'zohomail.eu', 'fastmail.com', 'fastmail.fm',
  'hey.com', 'duck.com', 'migadu.com', 'mail.com', 'email.com', 'usa.com',
  'inbox.com', 'inbox.lv',
  // East and South Asia
  'qq.com', 'foxmail.com', '163.com', '126.com', 'yeah.net', 'sina.com',
  'sina.cn', 'sohu.com', 'aliyun.com', '139.com', '189.cn', 'naver.com',
  'daum.net', 'hanmail.net', 'kakao.com', 'nate.com', 'rediffmail.com',
  'docomo.ne.jp', 'ezweb.ne.jp', 'softbank.ne.jp',
  // United States ISPs
  'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'cox.net',
  'charter.net', 'spectrum.net', 'bellsouth.net', 'earthlink.net',
  'optonline.net', 'optimum.net', 'roadrunner.com', 'rr.com', 'twc.com',
  'frontier.com', 'frontiernet.net', 'windstream.net', 'centurylink.net',
  'juno.com', 'netzero.net', 'netzero.com', 'mindspring.com', 'pacbell.net',
  'ameritech.net', 'swbell.net', 'suddenlink.net', 'mediacombb.net',
  // Canadian ISPs (the gap the 2026-09-20 measurement found)
  'rogers.com', 'shaw.ca', 'bell.net', 'sympatico.ca', 'telus.net',
  'videotron.ca', 'cogeco.ca', 'eastlink.ca', 'sasktel.net', 'mts.net',
  'telusplanet.net', 'ns.sympatico.ca',
  // United Kingdom and Ireland
  'btinternet.com', 'btopenworld.com', 'sky.com', 'virginmedia.com',
  'talktalk.net', 'ntlworld.com', 'blueyonder.co.uk', 'tiscali.co.uk',
  'plus.net', 'eircom.net',
  // France
  'orange.fr', 'free.fr', 'laposte.net', 'wanadoo.fr', 'sfr.fr', 'bbox.fr',
  'neuf.fr', 'numericable.fr', 'aliceadsl.fr',
  // Italy
  'libero.it', 'virgilio.it', 'alice.it', 'tin.it', 'tiscali.it',
  'fastwebnet.it', 'email.it',
  // Spain, Portugal, Latin America
  'terra.com', 'terra.com.br', 'telefonica.net', 'movistar.es', 'sapo.pt',
  'uol.com.br', 'bol.com.br', 'ig.com.br', 'globo.com', 'globomail.com',
  'prodigy.net.mx',
  // Nordics, Benelux
  'online.no', 'hotmail.no', 'live.no', 'telenor.no', 'getmail.no',
  'altibox.no', 'lyse.net', 'telia.com', 'comhem.se', 'bredband.net',
  'spray.se', 'mail.dk', 'tdcadsl.dk', 'kolumbus.fi', 'elisanet.fi',
  'luukku.com', 'ziggo.nl', 'kpnmail.nl', 'kpnplanet.nl', 'xs4all.nl',
  'home.nl', 'planet.nl', 'hetnet.nl', 'upcmail.nl', 'casema.nl', 'telenet.be',
  'skynet.be', 'proximus.be',
  // Central and Eastern Europe
  'seznam.cz', 'email.cz', 'centrum.cz', 'wp.pl', 'onet.pl', 'o2.pl',
  'interia.pl', 'op.pl', 'abv.bg', 'freemail.hu', 'citromail.hu', 'ukr.net',
  'i.ua',
  // Australia and New Zealand
  'bigpond.com', 'bigpond.net.au', 'optusnet.com.au', 'iinet.net.au',
  'tpg.com.au', 'xtra.co.nz',
  // Disposable
  'yopmail.com', 'mailinator.com', 'guerrillamail.com', 'sharklasers.com',
  '10minutemail.com', 'temp-mail.org',
]);

const CONSUMER_DOMAIN_SET = new Set(CONSUMER_EMAIL_DOMAINS);

/**
 * Consumer webmail BRANDS that operate under many TLDs and ccTLDs.
 *
 * A family matches when the brand is the registrable label and what follows is
 * a public suffix: either one label (`yahoo.in`, `hotmail.no`, `live.se`) or a
 * generic second level plus a country code (`yahoo.co.jp`, `outlook.com.ar`).
 * It deliberately does NOT match a brand word used as somebody's subdomain, so
 * `yahoo.acme.example` stays a business, and it does not match a longer word,
 * so `livestock.example` and `outlookfarm.example` are not Microsoft.
 *
 * No public-suffix list is bundled for this. The handful of generic second
 * levels below covers every two-label suffix these brands actually trade
 * under, and a miss only means a consumer is shown one extra plan.
 *
 * `live.*` is the loosest of these: somebody can own `live.example-tld` as a
 * real company domain. Accepted knowingly. A wrongly-consumer business is
 * offered exactly what every Free workspace is offered today, so the error
 * costs nothing that is not already being paid.
 */
export const CONSUMER_BRAND_FAMILIES = Object.freeze([
  'yahoo', 'ymail', 'hotmail', 'outlook', 'live', 'msn', 'gmx', 'yandex',
  'aol', 'googlemail', 'zohomail',
]);

const FAMILY_SET = new Set(CONSUMER_BRAND_FAMILIES);

/** Generic second levels that sit between a brand and a country code. */
const GENERIC_SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'ne', 'or']);

/** `proton*`: proton.me, protonmail.com, protonmail.ch, and whatever is next. */
const PROTON_LABEL = /^proton(mail)?$/;

/**
 * Second-level labels that mean "academic" under a country code: `ac.uk`,
 * `edu.au`. With the bare `.edu` TLD, that is the whole of the school rule. A
 * student's mailbox is on a custom domain, but a student is not an operator
 * running a company's mailboxes, and the Pro pitch written for that operator
 * would be talking to somebody else.
 *
 * Deliberately trivial. No list of universities, no `k12`, no guessing from the
 * name: a school this misses is shown both plans, which is harmless.
 */
const ACADEMIC_SECOND_LEVEL = new Set(['edu', 'ac']);

/** A label: letters, digits, hyphens; no leading or trailing hyphen. */
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The lower-cased domain of an address or bare domain, or null when the input
 * is not recognisably either. Never throws.
 *
 * @param {unknown} emailOrDomain
 * @returns {string|null}
 */
export function emailDomain(emailOrDomain) {
  if (typeof emailOrDomain !== 'string') return null;
  const trimmed = emailOrDomain.trim().toLowerCase();
  if (!trimmed) return null;

  // The LAST "@", so a quoted local part cannot move the boundary. An address
  // with nothing before the "@" is not an address.
  const at = trimmed.lastIndexOf('@');
  if (at === 0) return null;
  let domain = at === -1 ? trimmed : trimmed.slice(at + 1);

  // A fully-qualified trailing dot is the same domain.
  if (domain.endsWith('.')) domain = domain.slice(0, -1);
  if (!domain || domain.length > 253) return null;

  const labels = domain.split('.');
  // A bare hostname ("localhost", "gmail") is not a mail domain anyone can be
  // classified on.
  if (labels.length < 2) return null;
  if (!labels.every(label => LABEL.test(label))) return null;
  // An all-numeric final label is an IP address, not a domain.
  if (/^\d+$/.test(labels[labels.length - 1])) return null;

  return domain;
}

/**
 * Whether a VALID domain belongs to a consumer mail service.
 *
 * @param {string} domain A value already normalised by `emailDomain`.
 */
function isConsumerDomain(domain) {
  if (CONSUMER_DOMAIN_SET.has(domain)) return true;

  const labels = domain.split('.');

  // Brand families: the brand label followed by a public suffix, which is one
  // label, or a generic second level plus a two-letter country code. Anything
  // else in the middle (`yahoo.acme.example`) is somebody's own subdomain.
  const brand = labels[0];
  if (FAMILY_SET.has(brand) || PROTON_LABEL.test(brand)) {
    if (labels.length === 2) return true;
    if (
      labels.length === 3 &&
      GENERIC_SECOND_LEVEL.has(labels[1]) &&
      labels[2].length === 2
    ) {
      return true;
    }
  }

  // A subdomain of an exact consumer domain is the same service
  // (`mail.yahoo.com`, `eu.zoho.com`).
  for (let i = 1; i < labels.length - 1; i += 1) {
    if (CONSUMER_DOMAIN_SET.has(labels.slice(i).join('.'))) return true;
  }

  return false;
}

/** Whether a VALID domain is a school's. See ACADEMIC_SECOND_LEVEL. */
function isAcademicDomain(domain) {
  const labels = domain.split('.');
  const tld = labels[labels.length - 1];
  if (tld === 'edu') return true;
  return labels.length >= 3 && ACADEMIC_SECOND_LEVEL.has(labels[labels.length - 2]);
}

/**
 * True when the address (or bare domain) is on a consumer mail service.
 * False for garbage: "not consumer" is NOT "business", see below.
 *
 * @param {unknown} emailOrDomain
 */
export function isConsumerEmailDomain(emailOrDomain) {
  const domain = emailDomain(emailOrDomain);
  return domain !== null && isConsumerDomain(domain);
}

/**
 * True when the address (or bare domain) is on a company's own domain.
 *
 * False for a consumer service, false for a school, and false for anything
 * that is not recognisably an address or a domain.
 *
 * @param {unknown} emailOrDomain
 * @returns {boolean}
 */
export function isBusinessEmailDomain(emailOrDomain) {
  const domain = emailDomain(emailOrDomain);
  if (domain === null) return false;
  return !isConsumerDomain(domain) && !isAcademicDomain(domain);
}

/**
 * True when AT LEAST ONE of the addresses is on a business domain.
 *
 * One is enough, on purpose. The common real shape is a personal Gmail that
 * signed up plus the company's info@ as the first connected mailbox, and that
 * workspace is the buyer this exists to recognise. Requiring every address to
 * be a business one would classify it as a consumer.
 *
 * Tolerates a non-array and non-string members: both mean "no signal", which is
 * false.
 *
 * @param {unknown} addresses
 * @returns {boolean}
 */
export function isBusinessShaped(addresses) {
  if (!Array.isArray(addresses)) return false;
  return addresses.some(address => isBusinessEmailDomain(address));
}

/**
 * The business-shape signal for a WORKSPACE, from what the dashboard already
 * holds in memory. One function so the connect modal and the Inboxes page are
 * handed the same answer, computed once, rather than each deriving its own.
 *
 * THE SIGNAL IS THE MAILBOXES ALREADY CONNECTED. The paywall panel is shown the
 * moment the modal opens, before any new address has been typed, so the address
 * somebody is ABOUT to add is not available and must not be waited for.
 *
 * The owner's account email is OR-ed in when the caller has it, which the SQL
 * measurement also did (`sig_custom_domain`). Pass it ONLY for the owner: a
 * member's own address says nothing about who pays for the workspace.
 *
 * @param {{inboxes?: Array<{address?: unknown}>|null, ownerEmail?: unknown}} [workspace]
 * @returns {boolean}
 */
export function isBusinessShapedWorkspace(workspace) {
  const inboxes = Array.isArray(workspace?.inboxes) ? workspace.inboxes : [];
  const addresses = inboxes.map(inbox => inbox?.address);
  addresses.push(workspace?.ownerEmail);
  return isBusinessShaped(addresses);
}
