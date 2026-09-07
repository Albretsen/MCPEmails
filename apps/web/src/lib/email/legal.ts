/**
 * Who we legally are, in the form that belongs at the bottom of an email.
 *
 * WHY THIS EXISTS AS A MODULE. CAN-SPAM (15 U.S.C. 7704(a)(5)) requires a valid
 * physical postal address in every commercial or marketing-adjacent message,
 * and the Norwegian ehandelsloven section 8 requires the same identification
 * from the service provider. Both senders that owe a reader that line live in
 * different places (the billing lifecycle templates and the unsubscribe
 * confirmation page), and one of them, src/lib/email/lifecycle.ts, carries a
 * standing rule that the transactional senders must never import it. A plain
 * constants file is importable by all of them, including any transactional
 * template that later wants the same line, without dragging suppression
 * machinery along with it.
 *
 * THESE VALUES ARE NOT COPY. They must match our entry in Enhetsregisteret and
 * the identical strings on /privacy, /terms and the home page footer
 * (messages/{en,nb}/home.json, key `legalEntity`). Do not edit them without
 * checking brreg.no first. "MCPEmails" is only the trading name of the service;
 * the legal person is Albretsen Consulting.
 *
 * TONE. The address is a legal identifier, not a message. Wherever it is
 * rendered it goes BELOW the human footer and in the quietest type available:
 * the line above it is deliberately written to sound like a person, and a
 * registration number set at the same weight drowns that out.
 */

export const LEGAL_ENTITY_NAME = 'Albretsen Consulting';
export const LEGAL_ORG_NUMBER = '926 646 753';
export const LEGAL_POSTAL_ADDRESS = 'Håsteins gate 9, 5160 Laksevåg, Norway';

/**
 * The one sentence, worded exactly as it already appears on the marketing site
 * so a reader who checks both sees the same registration and the same street.
 */
export const POSTAL_ADDRESS_LINE = `MCPEmails is a service of ${LEGAL_ENTITY_NAME} (enkeltpersonforetak), organisation number ${LEGAL_ORG_NUMBER}, ${LEGAL_POSTAL_ADDRESS}.`;
