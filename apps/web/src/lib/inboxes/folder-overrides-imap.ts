import { decryptToken } from '@/lib/crypto';
import { openImapSession } from '@/lib/email/imap';
import { guardMailHost } from '@/lib/email/host-guard';
import { mailRelayConfigFromEnv } from '@/lib/email/mail-relay';
import { refreshLearnedRelayHosts } from '@/lib/email/relay-fallback';
import type { MailboxListEntry } from '@/lib/inboxes/folder-overrides';

/** The inbox columns a folder listing dials with. */
export interface ImapListRow {
  email_address: string;
  imap_host: string;
  imap_port: number | null;
  imap_username: string | null;
  imap_password: string;
}

/**
 * Every mailbox on the inbox's IMAP server (LIST "" "*"), names decoded.
 *
 * Dials exactly the way POST /api/inboxes/[id]/check does: the stored host is
 * re-checked by guardMailHost and the approved address is pinned (a stored
 * name can be repointed at an internal address after it was saved), and hosts
 * that only accept the relay go through it. Throws on any failure; the caller
 * answers with one line. Read-only: LIST changes nothing on the server.
 */
export async function listInboxMailboxes(row: ImapListRow, db: Parameters<typeof refreshLearnedRelayHosts>[0]): Promise<MailboxListEntry[]> {
  if (mailRelayConfigFromEnv()) await refreshLearnedRelayHosts(db);
  const port = row.imap_port ?? 993;
  const guard = await guardMailHost(row.imap_host, { protocol: 'imap', port });
  if (!guard.ok) throw new Error(guard.code);
  const session = await openImapSession({
    host: row.imap_host,
    pinnedAddress: guard.address,
    port,
    email: row.email_address,
    username: row.imap_username || undefined,
    authMethod: 'PLAIN',
    appPassword: decryptToken(row.imap_password),
  });
  try {
    const boxes = await session.list('', '*');
    return boxes.map((b) => ({ name: b.name, delimiter: b.delimiter, flags: b.attributes }));
  } finally {
    await session.logout().catch(() => {});
  }
}
