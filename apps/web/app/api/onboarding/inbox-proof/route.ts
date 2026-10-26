import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { decryptToken } from '@/lib/crypto';
import { openImapSession, type ImapSession } from '@/lib/email/imap';
import { guardMailHost } from '@/lib/email/host-guard';
import { relayRouteForHost } from '@/lib/email/relay-fallback';
import { decodeMimeWords } from '@/lib/email/mime-words';
import { canManageInboxes, fetchWorkspaceRole } from '@/lib/workspace/roles';
import type { Tables } from '@/types/database.types';

/**
 * POST /api/onboarding/inbox-proof   body { inboxId }
 *
 * The proof card at the end of the onboarding inbox step (plan A5): how many
 * messages the inbox holds and the newest three subject lines, read live from
 * the mailbox the user just connected.
 *
 * 200 { available: true, count, subjects: string[] }
 *     { available: false }   anything this route does not read (an OAuth
 *                            inbox, a host reached only through the relay, a
 *                            mailbox that did not answer in time). The card
 *                            then shows the connection without the preview;
 *                            the connection itself has already been verified
 *                            by the connect route.
 *
 * Read only (STATUS, UID SEARCH, UID FETCH ENVELOPE; nothing is marked read).
 * The subjects go to the signed-in owner of the mailbox and are never logged or
 * stored. Same authorization and SSRF guard as POST /api/inboxes/[id]/check.
 */
export const runtime = 'nodejs';
export const maxDuration = 30;

const PROOF_TIMEOUT_MS = 15_000;
const SUBJECTS = 3;
const SUBJECT_MAX = 140;
/** How far below UIDNEXT to look for the newest messages before falling back to ALL. */
const RECENT_WINDOW = 500;
const FULL_SEARCH_MAX = 20_000;

const unavailable = () => NextResponse.json({ available: false }, { headers: { 'Cache-Control': 'no-store' } });

function cleanSubject(raw: string | undefined): string {
  let value = String(raw ?? '');
  // A subject sent as an IMAP literal is not parsed by imap.ts's tokeniser;
  // the card shows it as "no subject" rather than as "{23}".
  if (/^\{\d+\}$/.test(value)) return '';
  value = decodeMimeWords(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return value.length > SUBJECT_MAX ? `${value.slice(0, SUBJECT_MAX - 1)}…` : value;
}

async function readProof(session: ImapSession): Promise<{ count: number; subjects: string[] }> {
  const status = await session.status('INBOX', ['MESSAGES', 'UIDNEXT']);
  const count = Number.isFinite(status.MESSAGES) ? status.MESSAGES : 0;
  if (count === 0) return { count: 0, subjects: [] };

  let uids: number[] = [];
  if (Number.isFinite(status.UIDNEXT) && status.UIDNEXT > 1) {
    uids = await session.search('INBOX', `UID ${Math.max(1, status.UIDNEXT - RECENT_WINDOW)}:*`);
  }
  if (uids.length === 0 && count <= FULL_SEARCH_MAX) uids = await session.search('INBOX', 'ALL');
  const newest = [...new Set(uids)].sort((a, b) => b - a).slice(0, SUBJECTS);
  if (newest.length === 0) return { count, subjects: [] };

  const messages = await session.fetch('INBOX', newest.join(','), '(UID ENVELOPE)');
  const subjects = messages
    .sort((a, b) => b.uid - a.uid)
    .map((m) => cleanSubject(m.envelope?.subject))
    .slice(0, SUBJECTS);
  return { count, subjects };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized.', error_code: 'session_expired' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const inboxId = typeof body?.inboxId === 'string' ? body.inboxId : '';
  if (!/^[0-9a-f-]{36}$/i.test(inboxId)) return NextResponse.json({ error: 'Invalid inbox ID.' }, { status: 400 });

  // RLS proves membership; the role check keeps credential use to operators,
  // exactly as the connection check does.
  const { data: visible } = await supabase
    .from('inboxes')
    .select('id, workspace_id')
    .eq('id', inboxId)
    .is('deleted_at', null)
    .maybeSingle();
  if (!visible) return NextResponse.json({ error: 'Inbox not found.' }, { status: 404 });
  const role = await fetchWorkspaceRole(supabase, visible.workspace_id, user.id);
  if (!canManageInboxes(role)) return NextResponse.json({ error: 'Not allowed.' }, { status: 403 });

  const { data: inbox } = await createServiceRoleClient()
    .from('inboxes')
    .select('*')
    .eq('id', inboxId)
    .eq('workspace_id', visible.workspace_id)
    .is('deleted_at', null)
    .maybeSingle<Tables<'inboxes'>>();
  if (!inbox || !inbox.imap_host || !inbox.imap_password || inbox.oauth_access_token) return unavailable();
  if (relayRouteForHost(inbox.imap_host, 'imap')) return unavailable();

  const port = inbox.imap_port ?? 993;
  const guard = await guardMailHost(inbox.imap_host, { protocol: 'imap', port });
  if (!guard.ok) return unavailable();

  let session: ImapSession | null = null;
  const work = (async () => {
    session = await openImapSession({
      host: inbox.imap_host!,
      pinnedAddress: guard.address,
      port,
      email: inbox.email_address,
      username: inbox.imap_username || undefined,
      authMethod: 'PLAIN',
      appPassword: decryptToken(inbox.imap_password!),
    });
    return readProof(session);
  })();

  try {
    const proof = await Promise.race([
      work,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), PROOF_TIMEOUT_MS)),
    ]);
    if (!proof) return unavailable();
    return NextResponse.json({ available: true, ...proof }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    // The message only: never the mailbox's answer, which can carry subjects.
    console.warn('[onboarding/inbox-proof] read failed', { error: err instanceof Error ? err.name : 'unknown' });
    return unavailable();
  } finally {
    work.catch(() => undefined).finally(() => {
      const open = session as ImapSession | null;
      open?.logout().catch(() => undefined);
    });
  }
}
