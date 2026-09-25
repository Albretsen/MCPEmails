import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';

/**
 * "This address is already connected, through a different method."
 *
 * Every connect path (Gmail OAuth, Outlook OAuth, generic IMAP, branded app
 * password, Fastmail app password) saves with
 * `upsert(..., { onConflict: 'workspace_id, email_address' })`. That is right
 * for a RECONNECT of the same mailbox: the row, its UUID and its activity_log
 * history are kept. It is badly wrong when the existing row belongs to a
 * different provider, because the upsert then silently converts it.
 *
 * Found live on 2026-09-25: a workspace had asgeir@mcpemails.com connected over
 * IMAP (Migadu). The owner then ran the Outlook connect while signed in to a
 * Microsoft work account with the same address, and the callback overwrote the
 * working IMAP row with provider 'outlook' (and an account that has no mailbox
 * at all). The IMAP inbox stopped working with no warning.
 *
 * The rule: an ACTIVE (non-deleted) row for the address with a different
 * provider family is refused, and the user is told to remove that inbox first
 * if they really mean to switch. A soft-deleted row is fair game: removing an
 * inbox clears its credentials, so reviving it under another provider is the
 * switch the user asked for.
 */
export const INBOX_EXISTS_OTHER_PROVIDER = 'inbox_exists_other_provider' as const;

/**
 * Providers that write the same kind of row and may replace each other.
 *
 * `fastmail` is the retired Fastmail OAuth/JMAP connector (removed 2026-06-01).
 * The only way left to repair such a row is the Fastmail app-password route,
 * which saves `provider: 'imap'`, so the two are one family: blocking it would
 * leave those rows unrepairable. Every IMAP flavour (generic, branded app
 * password, Fastmail app password) is `imap` and may replace another, which is
 * how a user moves from a generic setup to a preset or rotates a password.
 */
export function providerFamily(provider: string): string {
  return provider === 'fastmail' ? 'imap' : provider;
}

/**
 * Whether saving `incomingProvider` for an address would overwrite an active
 * inbox of a different provider. `existingProvider` is null when there is no
 * active row for the address.
 */
export function isOtherProviderConflict(
  existingProvider: string | null | undefined,
  incomingProvider: string,
): boolean {
  if (!existingProvider) return false;
  return providerFamily(existingProvider) !== providerFamily(incomingProvider);
}

/**
 * The provider of the active inbox for this exact address, or null.
 *
 * Exact match on `email_address` on purpose: the upsert's conflict target is
 * the raw column, so this asks precisely "which row would the upsert touch".
 * Pass a client that sees every workspace row (the routes hand in the
 * service-role client they already use for the upsert).
 */
export async function activeInboxProvider(
  db: SupabaseClient<Database>,
  workspaceId: string,
  email: string,
): Promise<string | null> {
  const { data } = await db
    .from('inboxes')
    .select('provider')
    .eq('workspace_id', workspaceId)
    .eq('email_address', email)
    .is('deleted_at', null)
    .maybeSingle();
  return data?.provider ?? null;
}

/** `activeInboxProvider` + `isOtherProviderConflict` in one call. */
export async function findOtherProviderInbox(
  db: SupabaseClient<Database>,
  workspaceId: string,
  email: string,
  incomingProvider: string,
): Promise<{ conflict: true; existingProvider: string } | { conflict: false }> {
  const existing = await activeInboxProvider(db, workspaceId, email);
  return existing && isOtherProviderConflict(existing, incomingProvider)
    ? { conflict: true, existingProvider: existing }
    : { conflict: false };
}

/**
 * The JSON body the three password-based connect routes answer with (409).
 * The OAuth callbacks redirect with `?error=inbox_exists_other_provider`
 * instead. The sentence is an unlocalised fallback; the dashboard localises
 * off `error_code`.
 */
export function otherProviderErrorBody(existingProvider: string): {
  error: string;
  error_code: typeof INBOX_EXISTS_OTHER_PROVIDER;
  existing_provider: string;
} {
  return {
    error:
      'This address is already connected with another method. ' +
      'Remove that inbox first if you want to switch how it is connected.',
    error_code: INBOX_EXISTS_OTHER_PROVIDER,
    existing_provider: existingProvider,
  };
}
