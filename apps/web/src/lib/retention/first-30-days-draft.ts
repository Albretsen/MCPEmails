/**
 * How the M2 stuck note reaches Asgeir. Never the customer.
 *
 * PRIMARY: AN IMAP DRAFT IN HIS OWN MAILBOX. The note is APPENDed, flagged
 * \Draft, to the Drafts folder of the mailbox named by FIRST30_DRAFT_MAILBOX
 * (default asgeir@mcpemails.com), using that inbox's own stored credentials,
 * the way POST /api/inboxes/[id]/check dials: the stored host is re-checked by
 * guardMailHost, the approved address is pinned, relay-only hosts go through
 * the relay. To = the owner, so he opens Drafts, reads, edits and presses send.
 * This follows the standing rule that the default is a saved draft.
 *
 * WHICH INBOX ROW. Looked up by address at run time, never by a hard-coded id,
 * and only accepted when the workspace that holds it is owned by one of us
 * (internal_accounts, GROWTH_INTERNAL_EMAILS, our own domains). Without that
 * check, anyone could connect an inbox row with this address pointing at a
 * server they control and receive every stuck customer's address and note.
 * Only password (IMAP) rows are used; an OAuth row is skipped.
 *
 * FALLBACK: AN INTERNAL NOTICE. If no usable row exists or the APPEND fails,
 * one email goes through Resend to the same mailbox only, with the note and a
 * mailto: link that opens it addressed to the owner. Either path counts as
 * done, and the ledger detail says which one ran.
 */

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database.types';
import { decryptToken } from '@/lib/crypto';
import { openImapSession, type ImapMailboxInfo } from '@/lib/email/imap';
import { guardMailHost } from '@/lib/email/host-guard';
import { mailRelayConfigFromEnv } from '@/lib/email/mail-relay';
import { refreshLearnedRelayHosts } from '@/lib/email/relay-fallback';
import { matchesInternal } from '@/lib/email/paywall-followup-store';
import { mailtoFor } from '@/lib/retention/first-30-days-templates';
import type { DraftResult, DraftWriter, Sender, StuckDraft } from '@/lib/retention/first-30-days';

type Db = SupabaseClient<Database>;

// ---------------------------------------------------------------------------
// Pure parts (tested)
// ---------------------------------------------------------------------------

/** RFC 2047 for a header value that is not plain ASCII. */
export function encodeHeader(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function assertHeaderSafe(value: string, what: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`${what} contains a line break`);
}

/**
 * The RFC 5322 message saved as the draft. Plain text, base64 body (any
 * character survives, lines stay short), no tracking, nothing but the note.
 */
export function buildDraftMessage(input: {
  from: string;
  to: string;
  subject: string;
  text: string;
  date: Date;
  messageId: string;
}): string {
  assertHeaderSafe(input.from, 'From');
  assertHeaderSafe(input.to, 'To');
  assertHeaderSafe(input.subject, 'Subject');
  assertHeaderSafe(input.messageId, 'Message-ID');
  const body = Buffer.from(input.text.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64');
  const wrapped = body.match(/.{1,76}/g)?.join('\r\n') ?? '';
  return [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${encodeHeader(input.subject)}`,
    `Date: ${input.date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${input.messageId}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapped,
    '',
  ].join('\r\n');
}

/** The Drafts folder: the \Drafts special-use attribute, else a folder named Drafts, else "Drafts". */
export function pickDraftsMailbox(boxes: ImapMailboxInfo[]): string {
  const special = boxes.find((b) => b.attributes.some((a) => a.toLowerCase() === '\\drafts'));
  if (special) return special.name;
  const named = boxes.find((b) => /^(inbox[./])?drafts?$/i.test(b.name));
  return named ? named.name : 'Drafts';
}

/** The internal fallback notice: the note, plus a mailto that opens it addressed to the owner. */
export function internalNoticeText(draft: StuckDraft): string {
  return [
    `A paying customer has had no successful tool call in the 72 hours since paying (workspace ${draft.workspaceId}).`,
    'The IMAP draft could not be saved, so here is the note instead. Nothing has been sent to the customer.',
    '',
    `To: ${draft.to}`,
    `Subject: ${draft.note.subject}`,
    '',
    draft.note.text,
    '',
    '---',
    `Open it as a draft in your mail app: ${mailtoFor(draft.to, draft.note)}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// IMAP draft writer
// ---------------------------------------------------------------------------

interface DraftInboxRow {
  email_address: string;
  imap_host: string;
  imap_port: number | null;
  imap_username: string | null;
  imap_password: string;
}

/** The founder's inbox row, only from a workspace one of us owns. */
export async function findDraftInbox(db: Db, address: string): Promise<DraftInboxRow | null> {
  const { data: rows, error } = await db
    .from('inboxes')
    .select('workspace_id, email_address, imap_host, imap_port, imap_username, imap_password, updated_at')
    // Case-insensitive, with LIKE wildcards escaped so the match stays exact.
    .ilike('email_address', address.replace(/[\\%_]/g, '\\$&'))
    .is('deleted_at', null)
    .not('imap_host', 'is', null)
    .not('imap_password', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(10);
  if (error) throw new Error(`draft inbox read failed: ${error.message}`);
  if (!rows || rows.length === 0) return null;

  const { data: internalRows, error: internalError } = await db.from('internal_accounts').select('email');
  if (internalError) throw new Error(`internal account read failed: ${internalError.message}`);
  const listed = new Set((internalRows ?? []).map((r) => r.email.toLowerCase()));

  for (const row of rows) {
    const { data: ws } = await db.from('workspaces').select('owner_id, deleted_at').eq('id', row.workspace_id).maybeSingle();
    if (!ws || ws.deleted_at) continue;
    const { data: owner } = await db.from('users').select('email').eq('id', ws.owner_id).maybeSingle();
    if (!matchesInternal(owner?.email ?? null, listed)) continue;
    return {
      email_address: row.email_address,
      imap_host: row.imap_host!,
      imap_port: row.imap_port,
      imap_username: row.imap_username,
      imap_password: row.imap_password!,
    };
  }
  return null;
}

export function createImapDraftWriter(db: Db, mailboxAddress: string): DraftWriter {
  return async (draft) => {
    const row = await findDraftInbox(db, mailboxAddress);
    if (!row) return { ok: false, reason: 'draft_inbox_not_found' };

    if (mailRelayConfigFromEnv()) await refreshLearnedRelayHosts(db);
    const port = row.imap_port ?? 993;
    const guard = await guardMailHost(row.imap_host, { protocol: 'imap', port });
    if (!guard.ok) return { ok: false, reason: `draft_host_${guard.code}` };

    const messageId = `${randomUUID()}@mcpemails.com`;
    const message = buildDraftMessage({
      from: row.email_address,
      to: draft.to,
      subject: draft.note.subject,
      text: draft.note.text,
      date: new Date(),
      messageId,
    });

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
      const mailbox = pickDraftsMailbox(await session.list('', '*'));
      await session.append(mailbox, message, ['\\Draft', '\\Seen']);
      return { ok: true, via: 'imap_draft', id: messageId };
    } finally {
      await session.logout().catch(() => {});
    }
  };
}

// ---------------------------------------------------------------------------
// Fallback, and the combination the route uses
// ---------------------------------------------------------------------------

export function createInternalNoticeWriter(send: Sender, mailboxAddress: string): DraftWriter {
  return async (draft) => {
    const text = internalNoticeText(draft);
    const result = await send({
      to: mailboxAddress,
      subject: `Draft to send: ${draft.note.subject} (${draft.to})`,
      text,
      html: `<pre style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;white-space:pre-wrap;">${text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')}</pre>`,
      headers: {},
      idempotencyKey: `${draft.idempotencyKey}-notice`,
    });
    return result.ok ? { ok: true, via: 'internal_notice', id: result.id } : { ok: false, reason: result.reason };
  };
}

/** Try each writer in order; the first success wins. Failures are joined into one reason. */
export function firstThatWorks(...writers: DraftWriter[]): DraftWriter {
  return async (draft) => {
    const reasons: string[] = [];
    for (const write of writers) {
      let result: DraftResult;
      try {
        result = await write(draft);
      } catch (err) {
        result = { ok: false, reason: err instanceof Error ? err.message.slice(0, 120) : 'unexpected_error' };
      }
      if (result.ok) {
        return reasons.length > 0 ? { ...result, via: `${result.via} (after: ${reasons.join('; ')})` } : result;
      }
      reasons.push(result.reason);
    }
    return { ok: false, reason: reasons.join('; ') || 'no_writer' };
  };
}
