// Both imports are browser-safe: the connect modal calls into this module on
// every keystroke-free render, so nothing here may reach for a node builtin.
import { MAIL_HOST_PRESETS, findMailHostPreset } from '@/lib/email-providers/host-presets';
import { normalizeAppPassword } from '@/lib/email-providers/imap-presets';

/**
 * What a provider's app-specific password actually is, and what one looks like.
 *
 * `host-presets.ts` already knows WHICH provider serves a mailbox, and it
 * already carries a `requiresAppPassword` flag and a deep link to the
 * generator. What it does not know is what the generated credential looks like,
 * and that is the piece the production numbers ask for: `auth_failed` is 72.9%
 * of every connection failure, and the dominant cause is a person submitting
 * the password they log into webmail with. That mistake is visible in the
 * string itself — an Apple app-specific password is sixteen lowercase letters
 * and an account password almost never is — so it can be named before a request
 * is sent, instead of after a server has rejected it and counted a failed login
 * against the account.
 *
 * The table below is therefore only the part host-presets cannot answer. Label
 * and help URL are read back out of host-presets so there is one copy of each.
 */

/** Providers whose app password we can recognise by sight. */
export type AppPasswordProviderId = 'gmail' | 'icloud' | 'yahoo' | 'yandex' | 'zoho' | 'fastmail';

export interface AppPasswordShape {
  /** Characters a generated token is built from. */
  alphabet: 'lower-letters' | 'lower-alnum';
  /** Length after whitespace and display separators are removed. */
  length: number;
  /**
   * True when the provider DISPLAYS the token in groups (Apple hyphenates its
   * four blocks of four). Only affects what we strip before matching; the
   * separators are not part of the credential.
   */
  grouped: boolean;
}

export interface AppPasswordPolicy {
  provider: AppPasswordProviderId;
  /** Provider name, from the host-preset table. */
  label: string;
  /** Deep link to the generator, from the host-preset table. */
  helpUrl: string;
  /**
   * True when the ordinary account password cannot authenticate a mail client
   * at all, so a rejected login is a missing app password rather than a typo.
   */
  requiresAppPassword: boolean;
  /**
   * The generated token's shape, or null when the provider does not fix one.
   * Zoho is the null case on purpose: its "application-specific password" is
   * generated per device with no published format, and a made-up rule there
   * would reject credentials that work.
   */
  shape: AppPasswordShape | null;
}

/**
 * Shapes as the providers generate them (verified against their own generator
 * screens, 2026). All of them are sixteen characters; only the alphabet and the
 * display grouping differ.
 *
 * Fastmail is the one entry that allows digits. Its tokens are letters in
 * practice, but the generator is documented as alphanumeric and the cost of
 * being wrong is asymmetric: an over-tight rule tells a user with a valid
 * credential that it is invalid, which is worse than the failure this whole
 * module exists to prevent.
 */
const SHAPES: Record<AppPasswordProviderId, AppPasswordShape | null> = {
  // Google shows its sixteen letters as four space-separated blocks. The
  // spaces are already stripped by normalizeAppPassword, but `grouped` is set
  // because people retype what they see and a separator they added themselves
  // must not be read as evidence that they submitted an account password.
  gmail: { alphabet: 'lower-letters', length: 16, grouped: true },
  icloud: { alphabet: 'lower-letters', length: 16, grouped: true },
  yahoo: { alphabet: 'lower-letters', length: 16, grouped: false },
  yandex: { alphabet: 'lower-letters', length: 16, grouped: false },
  fastmail: { alphabet: 'lower-alnum', length: 16, grouped: false },
  zoho: null,
};

/** Type guard for the ids this module knows a policy for. */
export function isAppPasswordProvider(value: unknown): value is AppPasswordProviderId {
  return (
    value === 'gmail' ||
    value === 'icloud' ||
    value === 'yahoo' ||
    value === 'yandex' ||
    value === 'zoho' ||
    value === 'fastmail'
  );
}

/**
 * The policy for a provider id, built from the host-preset entry of the same
 * id. Returns null for a provider we hold no app-password knowledge about,
 * which is the honest answer for every host in the table that authenticates
 * with an ordinary mailbox password.
 */
export function appPasswordPolicyFor(provider: string | null | undefined): AppPasswordPolicy | null {
  if (!isAppPasswordProvider(provider)) return null;
  const preset = MAIL_HOST_PRESETS.find((entry) => entry.id === provider);
  if (!preset?.appPasswordHelpUrl) return null;
  return {
    provider,
    label: preset.label,
    helpUrl: preset.appPasswordHelpUrl,
    requiresAppPassword: preset.requiresAppPassword === true,
    shape: SHAPES[provider],
  };
}

/**
 * Identify the app-password provider behind a connection attempt.
 *
 * `service` is what the user clicked in the modal and is believed outright: a
 * branded card carries the provider's own name. Everything else is inferred
 * from the address and the mail host through the existing host lookup, which is
 * what closes the gap this module was written for — someone typing
 * `me@yahoo.com` into the GENERIC form gets the same guidance as someone who
 * clicked the Yahoo card, instead of none at all.
 *
 * A `service` we hold no policy for still falls through to the lookup rather
 * than returning null, so the generic connector ('generic') behaves like an
 * unlabelled attempt rather than like a provider we know nothing about.
 */
export function identifyAppPasswordProvider(input: {
  service?: string | null;
  email?: string | null;
  host?: string | null;
}): AppPasswordPolicy | null {
  const fromService = appPasswordPolicyFor(input.service);
  if (fromService) return fromService;
  const preset = findMailHostPreset({ email: input.email, host: input.host });
  return preset ? appPasswordPolicyFor(preset.id) : null;
}

/** Why a submitted secret cannot be one of this provider's app passwords. */
export type AppPasswordShapeProblem =
  /** Characters outside the generator's alphabet: capitals, digits, punctuation. */
  | 'account_password'
  /** Right alphabet, wrong number of characters — a truncated or doubled paste. */
  | 'wrong_length';

export type AppPasswordShapeResult =
  | { ok: true }
  /** Nothing is claimed: the provider has no fixed format, or none is known. */
  | { ok: true; unknown: true }
  | { ok: false; problem: AppPasswordShapeProblem };

const ALPHABETS: Record<AppPasswordShape['alphabet'], RegExp> = {
  'lower-letters': /^[a-z]+$/,
  'lower-alnum': /^[a-z0-9]+$/,
};

/**
 * Can this string be one of the provider's generated app passwords?
 *
 * Deliberately a shape test and nothing more. It cannot tell a correct app
 * password from an expired one, and it is not meant to: the single thing worth
 * catching before the network call is the mistake behind most of the 304
 * recorded `auth_failed` events, which is a human account password submitted
 * where a generated token belongs. Those are trivially separable — "Sommer2024!"
 * has capitals, digits and punctuation, and a generated token has none of them.
 *
 * Whitespace is stripped first for the same reason `normalizeAppPassword`
 * exists (copy-paste drags in newlines and non-breaking spaces), and the
 * display hyphens are stripped for the providers that show grouped tokens.
 *
 * A provider with no fixed format answers `{ ok: true, unknown: true }`, which
 * callers must not present as a pass: it means "no opinion".
 */
export function checkAppPasswordShape(
  policy: AppPasswordPolicy | null,
  secret: string
): AppPasswordShapeResult {
  if (!policy?.shape) return { ok: true, unknown: true };
  const shape = policy.shape;

  let candidate = normalizeAppPassword(String(secret ?? ''));
  if (shape.grouped) candidate = candidate.replace(/-/g, '');
  if (!candidate) return { ok: true, unknown: true };

  if (!ALPHABETS[shape.alphabet].test(candidate)) return { ok: false, problem: 'account_password' };
  if (candidate.length !== shape.length) return { ok: false, problem: 'wrong_length' };
  return { ok: true };
}
