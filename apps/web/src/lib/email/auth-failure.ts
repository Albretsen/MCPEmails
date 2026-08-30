import {
  checkAppPasswordShape,
  identifyAppPasswordProvider,
  type AppPasswordPolicy,
  type AppPasswordShapeResult,
} from '@/lib/email-providers/app-password';

/**
 * What a rejected login actually means, so the user can be told which of four
 * different mistakes they made.
 *
 * `AUTH_FAILED` is 72.9% of every inbox-connection failure (304 events across
 * 78 workspaces), and until now every one of them produced the same sentence:
 * the server rejected that password. That sentence is true and useless. Behind
 * it sit at least four unrelated situations with four different fixes:
 *
 *   - the mailbox has IMAP switched off, so no credential can ever work;
 *   - the provider will not accept an account password from a mail client and
 *     wants a generated app password (which itself requires 2FA to be on);
 *   - the account password was submitted where an app password belongs, which
 *     the credential's own shape gives away;
 *   - the host issues a login name that is not the email address;
 *   - and, finally, an ordinary wrong password.
 *
 * Telling them apart is what turns 3.9 attempts per affected workspace into
 * one. The classifier is pure and takes everything it needs as an argument so
 * the policy is testable without a mail server, in the same shape as
 * `transport-autodetect.ts`.
 *
 * IMPORTANT: this decides a REASON, never a message, and the server hands the
 * client only the reason. The server's rejection text is sanitized before it
 * ever reaches here (see `sanitizeAuthDiagnostic`) and is still not forwarded:
 * a mail server controls that string, and the enum cannot carry a credential
 * out of the process the way an echoed line can.
 */
export type AuthFailureReason =
  /** The mailbox does not allow IMAP logins at all. */
  | 'imap_disabled'
  /** The provider requires a generated app password; the account one never works. */
  | 'app_password_required'
  /** What was submitted is shaped like an account password, not a generated token. */
  | 'account_password_used'
  /** The server did not recognise the login name (which may not be the address). */
  | 'login_username_required'
  /** Nothing more specific: the credential was simply refused. */
  | 'password_rejected';

/**
 * IMAP/POP access switched off in the account's own settings. Zoho ships with
 * it off by default and is the reason this case is not hypothetical.
 *
 * `[LOGINDISABLED]` is deliberately NOT matched here, tempting as it looks. In
 * RFC 3501 it advertises that the LOGIN command is refused on THIS connection,
 * which in practice means plaintext auth before TLS, not a mailbox with IMAP
 * turned off. Reading it as the latter would tell a user to go and enable a
 * setting that is already on.
 */
const IMAP_DISABLED = /\b(imap|pop)\b[^.]{0,40}\b(disabled|not enabled|not allowed|turned off)\b|\benable\s+(imap|pop)\b/i;

/**
 * The server naming the credential it wants. Gmail's `[ALERT] Application-
 * specific password required` is the archetype, and several smaller hosts copy
 * the wording.
 */
const APP_PASSWORD_NAMED = /\bapp(lication)?[-\s]?specific\s+password\b|\bapp\s?password\b/i;

/**
 * The server rejecting the IDENTITY rather than the secret.
 *
 * Deliberately narrow. "Incorrect username or password" — Yahoo's standard
 * rejection — must NOT match: it names both halves precisely because the server
 * will not say which, and reading it as a login problem would send users to
 * change a field that was right.
 */
const UNKNOWN_LOGIN = /\b(unknown user|user unknown|no such user|user not found|user does not exist|invalid mailbox name|authentication identity)\b/i;

export interface AuthFailureInput {
  /** Sanitized server rejection text, when the server gave one. */
  detail?: string | null;
  /** The provider serving this mailbox, when one was identified. */
  policy?: AppPasswordPolicy | null;
  /** Result of shape-checking the submitted secret against that provider. */
  shape?: AppPasswordShapeResult | null;
  /**
   * True when the user supplied a login name distinct from their address. When
   * they did, "unknown user" is no longer evidence that a separate login exists
   * — they already gave us one, and it was wrong.
   */
  usernameProvided?: boolean;
}

/**
 * Classify one rejected login.
 *
 * Order is the whole design. Evidence the SERVER gave us outranks anything we
 * inferred, because it is about this mailbox rather than about the provider in
 * general; among our own inferences, the shape of the submitted secret outranks
 * the provider's policy, because it names what the user actually did rather
 * than what they might have done.
 */
export function classifyAuthFailure(input: AuthFailureInput): AuthFailureReason {
  const detail = typeof input.detail === 'string' ? input.detail : '';

  // 1. The server said the door is shut. No credential fixes this, so it has to
  //    outrank every credential explanation.
  if (IMAP_DISABLED.test(detail)) return 'imap_disabled';

  // 2. The server named the credential it wants.
  if (APP_PASSWORD_NAMED.test(detail)) return 'app_password_required';

  // 3. The server rejected the identity, and the user has not already tried a
  //    login name of their own.
  if (UNKNOWN_LOGIN.test(detail) && !input.usernameProvided) return 'login_username_required';

  // 4. We can see what they typed, and it is not one of this provider's tokens.
  //    Only for providers that refuse account passwords outright: elsewhere an
  //    unusual-looking password is just a password.
  if (
    input.policy?.requiresAppPassword &&
    input.shape &&
    input.shape.ok === false
  ) {
    return 'account_password_used';
  }

  // 5. The provider refuses account passwords, and the server told us nothing
  //    more specific. Saying so is still far better than "wrong password",
  //    which is advice that cannot work here.
  if (input.policy?.requiresAppPassword) return 'app_password_required';

  return 'password_rejected';
}

/**
 * The whole explanation for one rejected login, in the shape a connect route
 * needs it: a reason to record, and the extra response fields the dashboard
 * turns into a localised sentence and a link to the right generator page.
 *
 * All three connect routes have exactly these inputs and exactly this use, so
 * the identification, the shape check and the classification live together
 * here rather than being copied into each of them.
 *
 * `secret` is used only to measure the credential's shape and is never stored,
 * logged or returned. Nothing derived from the server's own text leaves this
 * function either: the caller gets an enum and the provider's public name.
 */
export function explainAuthFailure(input: {
  /** Sanitized server rejection text, when the server gave one. */
  detail?: string | null;
  /** The branded service the user picked, when they picked one. */
  service?: string | null;
  email?: string | null;
  /** The IMAP or SMTP host the attempt used. */
  host?: string | null;
  secret: string;
  usernameProvided?: boolean;
}): { reason: AuthFailureReason; fields: Record<string, string> } {
  const policy = identifyAppPasswordProvider({
    service: input.service,
    email: input.email,
    host: input.host,
  });
  const reason = classifyAuthFailure({
    detail: input.detail,
    policy,
    shape: checkAppPasswordShape(policy, input.secret),
    usernameProvided: input.usernameProvided,
  });
  const fields: Record<string, string> = { auth_reason: reason };
  // Only when we actually know the provider. A label guessed from the address
  // would put the wrong company's name on the advice, and a link to the wrong
  // company's settings page is worse than no link.
  if (policy) {
    fields.auth_provider = policy.provider;
    fields.auth_provider_label = policy.label;
    fields.app_password_url = policy.helpUrl;
  }
  return { reason, fields };
}
