/**
 * The inline format check on the onboarding password field (plan A4).
 *
 * A WARNING, never a block: the user can always press Connect. It reuses the
 * dashboard's shape rules (email-providers/app-password.ts), keyed by the
 * onboarding panel instead of the modal card. Client-safe.
 */
import { appPasswordPolicyFor, checkAppPasswordShape } from '../email-providers/app-password.ts';
import { normalizeAppPassword } from '../email-providers/imap-presets.ts';
import type { InboxKind } from './inbox-detect.ts';

/** Panel -> the provider whose generated token it takes. */
const POLICY_BY_KIND: Partial<Record<InboxKind, string>> = {
  gmail: 'gmail',
  google_workspace: 'gmail',
  icloud: 'icloud',
  yahoo: 'yahoo',
  // AOL runs on Yahoo's account system: the same 16 lowercase letters.
  aol: 'yahoo',
  fastmail: 'fastmail',
  yandex: 'yandex',
};

/** Panels whose secret is always a generated app password. */
export function takesAppPassword(kind: InboxKind | null | undefined): boolean {
  return Boolean(kind && POLICY_BY_KIND[kind]);
}

export type FormatWarning = 'account_password' | 'wrong_length';

/**
 * Null when the value looks right, is empty, or the provider has no fixed
 * format. Spaces and the hyphens Apple shows are ignored ("spaces are fine").
 */
export function appPasswordFormatWarning(kind: InboxKind | null | undefined, value: string): FormatWarning | null {
  const provider = kind ? POLICY_BY_KIND[kind] : undefined;
  if (!provider) return null;
  const policy = appPasswordPolicyFor(provider);
  if (!policy || !String(value ?? '').trim()) return null;
  const result = checkAppPasswordShape(policy, value);
  if (result.ok) return null;
  return result.problem;
}

/**
 * What is sent. A generated token never contains whitespace, so it is
 * stripped (copy-paste drags in spaces and newlines); any other mailbox
 * password is only trimmed, because a space in it may be real.
 */
export function passwordForSubmit(kind: InboxKind | null | undefined, value: string): string {
  return takesAppPassword(kind) ? normalizeAppPassword(String(value ?? '')) : String(value ?? '').trim();
}
