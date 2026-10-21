import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { decryptToken, encryptToken } from '@/lib/crypto';
import { validateImapCredential, type ImapValidationResult } from '@/lib/email/validate-imap';
import { validateSmtpCredential, type SmtpValidationResult } from '@/lib/email/validate-smtp';
import {
  connectionModeOf,
  normalizeSecurity,
  parseConnectionMode,
  usesImap,
  usesSmtp,
  type ConnectionMode,
} from '@/lib/email/connection-config';
import { mailRelayConfigFromEnv } from '@/lib/email/mail-relay';
import { detectWithRelay, refreshLearnedRelayHosts } from '@/lib/email/relay-fallback';
import { guardMailHost } from '@/lib/email/host-guard';
import { findConflictingInbox } from '@/lib/email/imap-login-collision';
import { explainAuthFailure } from '@/lib/email/auth-failure';
import { captureError } from '@/lib/errors/capture';
import { canManageInboxes, fetchWorkspaceRole, insufficientRoleBody } from '@/lib/workspace/roles';
import type { Database } from '@/types/database.types';

type InboxUpdate = Database['public']['Tables']['inboxes']['Update'];

/**
 * Adding a half dials it, with the same transport fallback and relay retry the
 * connect route uses (see app/api/inboxes/imap/route.ts for the budget).
 */
export const maxDuration = 90;

/**
 * PATCH /api/inboxes/[id]/connection
 *
 * Changes which halves a generic IMAP/SMTP inbox carries ('both', 'imap' =
 * receive only, 'smtp' = send only) on the existing row, so the inbox keeps
 * its id and every AI connection built on it. This used to happen through the
 * Reconnect dialog, which also asked for the password again.
 *
 *   - Dropping a half writes NULL host and port for it. Nothing is dialled.
 *   - Adding a half dials only that half, with the stored (decrypted) password
 *     and login, before anything is written. A failure answers 422 and the row
 *     is untouched.
 *   - When the stored login is refused by the new half, the answer carries
 *     `needs_login: true`. The client then asks for a username and password,
 *     and sends them as `username` / `appPassword`. Because one password
 *     column serves both halves, a supplied password is checked against EVERY
 *     half the new mode keeps, not only the added one, and replaces the stored
 *     one only when all of them accept it.
 *
 * Body: { mode, imapHost?, imapPort?, imapSecurity?, smtpHost?, smtpPort?,
 *         smtpSecurity?, username?, appPassword? }. Host fields are read only
 * for a half being added.
 *
 * Authorization mirrors /api/inboxes/[id]/folders and /check, which also
 * decrypt the stored password and dial: the RLS-scoped client proves the
 * inbox is visible, canManageInboxes refuses viewers, and the full row is read
 * and written through the service-role client scoped to id AND workspace.
 *
 * The MCP server needs no change: it reads receive-only and send-only off
 * which hosts are set (supabase/functions/mcp-server/connection-access.ts).
 */

type Params = { params: Promise<{ id: string }> };

const ROW_COLUMNS =
  'id, workspace_id, provider, service, email_address, imap_host, imap_port, imap_security, imap_username, imap_password, smtp_host, smtp_port, smtp_security';

interface InboxRow {
  id: string;
  workspace_id: string;
  provider: string;
  service: string | null;
  email_address: string;
  imap_host: string | null;
  imap_port: number | null;
  imap_security: string | null;
  imap_username: string | null;
  imap_password: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_security: string | null;
}

type Half = 'imap' | 'smtp';

interface HalfSettings {
  host: string;
  port: number;
  security: 'tls' | 'starttls';
}

function fail(error: string, status: number, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ error, ...extra }, { status });
}

/** mcpemails.com or any name under it, on label boundaries. */
function isOwnSiteHost(host: string): boolean {
  const target = host.replace(/\.$/, '');
  return target === 'mcpemails.com' || target.endsWith('.mcpemails.com');
}

function readHalf(body: Record<string, unknown>, half: Half): HalfSettings {
  const host = body[`${half}Host`];
  const port = body[`${half}Port`];
  return {
    host: typeof host === 'string' ? host.trim().toLowerCase() : '',
    port: typeof port === 'number' ? port : Number(port),
    security: normalizeSecurity(body[`${half}Security`]),
  };
}

function storedHalf(row: InboxRow, half: Half): HalfSettings {
  const port = (half === 'imap' ? row.imap_port : row.smtp_port) ?? (half === 'imap' ? 993 : 465);
  return {
    host: (half === 'imap' ? row.imap_host : row.smtp_host) ?? '',
    port,
    security: normalizeSecurity(half === 'imap' ? row.imap_security : row.smtp_security, port === 143 || port === 587 ? 'starttls' : 'tls'),
  };
}

export async function PATCH(request: NextRequest, { params }: Params): Promise<NextResponse> {
  const { id: inboxId } = await params;
  if (!inboxId || typeof inboxId !== 'string' || inboxId.length > 100) return fail('Invalid inbox ID.', 400);

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('shape');
    body = parsed as Record<string, unknown>;
  } catch {
    return fail('Invalid request body.', 400, { error_code: 'invalid_request' });
  }
  // Required here, unlike on the connect route: a change of type with no type
  // named is a client bug, not a request for 'both'.
  const mode: ConnectionMode | null = body.mode === undefined ? null : parseConnectionMode(body.mode);
  if (!mode) return fail("mode must be 'both', 'imap' or 'smtp'.", 400, { error_code: 'invalid_mode' });
  const suppliedPassword = typeof body.appPassword === 'string' ? body.appPassword.trim() : '';
  // Usernames may be case-sensitive: trim only.
  const suppliedUsername = typeof body.username === 'string' ? body.username.trim() : '';

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) return fail('Unauthorized.', 401);

  const { data: visible, error: visibleError } = await supabase
    .from('inboxes')
    .select('id, workspace_id')
    .eq('id', inboxId)
    .is('deleted_at', null)
    .single();
  if (visibleError || !visible) return fail('Inbox not found.', 404);

  const role = await fetchWorkspaceRole(supabase, visible.workspace_id, user.id);
  if (!canManageInboxes(role)) {
    return NextResponse.json(insufficientRoleBody('Workspace viewers cannot change an inbox connection.'), { status: 403 });
  }

  const service = createServiceRoleClient();
  const { data: row, error: rowError } = await service
    .from('inboxes')
    .select(ROW_COLUMNS)
    .eq('id', inboxId)
    .eq('workspace_id', visible.workspace_id)
    .is('deleted_at', null)
    .single<InboxRow>();
  if (rowError || !row) return fail('Inbox not found.', 404);

  // Generic IMAP/SMTP only. Branded connectors (iCloud, Yahoo, Zoho, ...) and
  // OAuth inboxes always carry both halves on fixed servers.
  const current = connectionModeOf(row);
  if (row.provider !== 'imap' || (row.service && row.service !== 'generic') || !current || !row.imap_password) {
    return fail('This inbox does not support changing its connection type.', 400, { error_code: 'unsupported_inbox' });
  }

  const respondWith = (saved: InboxRow, extra: Record<string, unknown> = {}) =>
    NextResponse.json({
      success: true,
      mode: connectionModeOf(saved),
      imapHost: saved.imap_host,
      imapPort: saved.imap_port,
      imapSecurity: saved.imap_security,
      smtpHost: saved.smtp_host,
      smtpPort: saved.smtp_port,
      smtpSecurity: saved.smtp_security,
      username: saved.imap_username,
      ...extra,
    });

  if (mode === current && !suppliedPassword) return respondWith(row, { unchanged: true });

  const keeps: Record<Half, boolean> = { imap: usesImap(mode), smtp: usesSmtp(mode) };
  const has: Record<Half, boolean> = { imap: !!row.imap_host, smtp: !!row.smtp_host };
  const added = (['imap', 'smtp'] as const).filter((half) => keeps[half] && !has[half]);
  // A supplied password replaces the one both halves share, so every half the
  // new mode keeps must accept it. Otherwise only an added half is dialled.
  const toDial = suppliedPassword ? (['imap', 'smtp'] as const).filter((half) => keeps[half]) : added;

  const settings: Partial<Record<Half, HalfSettings>> = {};
  for (const half of toDial) {
    settings[half] = added.includes(half) ? readHalf(body, half) : storedHalf(row, half);
  }

  for (const half of added) {
    const s = settings[half]!;
    if (!s.host) return fail(`Enter the ${half.toUpperCase()} server.`, 422, { error_code: 'host_required', half });
    if (isOwnSiteHost(s.host)) {
      return fail(`The ${half.toUpperCase()} server is set to ${s.host}, which is MCPEmails itself, not your mail server.`, 422, {
        error_code: 'own_site_host',
        half,
      });
    }
  }

  // SSRF guard on every host about to be dialled, before any socket opens.
  const pinned: Partial<Record<Half, string>> = {};
  for (const half of toDial) {
    const s = settings[half]!;
    const guard = await guardMailHost(s.host, { protocol: half, port: s.port });
    if (!guard.ok) return fail(guard.message, 422, { error_code: guard.code, half });
    pinned[half] = guard.address;
  }

  const email = row.email_address;
  const password = suppliedPassword || decryptToken(row.imap_password);
  const username = suppliedPassword ? suppliedUsername : (row.imap_username ?? '');

  // Lets the relay loop tell a refused password (never retried through the
  // relay) from a refusal of where we connect from.
  const authReasonFor = (host: string) => (result: ImapValidationResult | SmtpValidationResult) =>
    !result.ok && result.code === 'AUTH_FAILED'
      ? explainAuthFailure({ detail: result.detail, email, host, secret: password, usernameProvided: Boolean(username) }).reason
      : null;

  const relay = mailRelayConfigFromEnv();
  if (relay && toDial.length) await refreshLearnedRelayHosts(service);

  const resolved: Partial<Record<Half, HalfSettings>> = {};
  for (const half of toDial) {
    const s = settings[half]!;
    const { detection, route } = half === 'imap'
      ? await detectWithRelay<ImapValidationResult>({
          protocol: 'imap',
          host: s.host,
          requested: { port: s.port, security: s.security },
          relay,
          db: service,
          authReasonOf: authReasonFor(s.host),
          attempt: (candidate, timeoutMs, tunnel) =>
            validateImapCredential({
              host: s.host,
              pinnedAddress: tunnel ? undefined : pinned.imap,
              port: candidate.port,
              email,
              username: username || undefined,
              password,
              security: candidate.security,
              timeoutMs,
              tunnel,
            }),
        })
      : await detectWithRelay<SmtpValidationResult>({
          protocol: 'smtp',
          host: s.host,
          requested: { port: s.port, security: s.security },
          relay,
          db: service,
          authReasonOf: authReasonFor(s.host),
          attempt: (candidate, timeoutMs, tunnel) =>
            validateSmtpCredential({
              host: s.host,
              pinnedAddress: tunnel ? undefined : pinned.smtp,
              port: candidate.port,
              email,
              username: username || undefined,
              password,
              security: candidate.security,
              timeoutMs: tunnel ? Math.max(timeoutMs, 15_000) : timeoutMs,
              tunnel,
            }),
        });
    const result = detection.result;
    if (!result.ok) {
      await captureError(new Error(result.message), {
        severity: 'low',
        route: 'api/inboxes/[id]/connection',
        reason: result.code,
        phase: half === 'smtp' ? `smtp_${result.phase}` : result.phase,
        [`${half}Host`]: s.host,
        [`${half}Port`]: s.port,
        attempts: detection.attempts,
        viaRelay: Boolean(route),
        workspaceId: row.workspace_id,
      });
      return fail(result.message, 422, {
        error_code: result.code.toLowerCase(),
        half,
        // The stored login was refused by a server it was never checked
        // against: the new half may want a different one. Ask for it.
        ...(result.code === 'AUTH_FAILED' ? { needs_login: true } : {}),
      });
    }
    resolved[half] = { host: s.host, port: detection.candidate.port, security: detection.candidate.security };
  }

  // Same guard as the connect route (the wrong-mailbox incident): an IMAP
  // login another address in this workspace already uses is refused.
  if (resolved.imap && (added.includes('imap') || suppliedPassword)) {
    const conflict = await findConflictingInbox(service, row.workspace_id, {
      host: resolved.imap.host,
      effectiveLogin: username || email,
      email,
    });
    if (conflict.conflict) {
      return fail(`This mailbox login is already connected as ${conflict.address}.`, 422, {
        error_code: 'login_already_connected',
        half: 'imap',
      });
    }
  }

  const now = new Date().toISOString();
  const patch: InboxUpdate = { updated_at: now };
  if (!keeps.imap) {
    patch.imap_host = null;
    patch.imap_port = null;
  } else if (resolved.imap) {
    patch.imap_host = resolved.imap.host;
    patch.imap_port = resolved.imap.port;
    patch.imap_security = resolved.imap.security;
    patch.imap_tls = true;
  }
  if (!keeps.smtp) {
    patch.smtp_host = null;
    patch.smtp_port = null;
  } else if (resolved.smtp) {
    patch.smtp_host = resolved.smtp.host;
    patch.smtp_port = resolved.smtp.port;
    patch.smtp_security = resolved.smtp.security;
    patch.smtp_tls = true;
  }
  if (suppliedPassword) {
    patch.imap_password = encryptToken(suppliedPassword);
    patch.imap_username = suppliedUsername || null;
    // Every half the inbox now has just accepted this login.
    patch.status = 'active';
    patch.last_error = null;
  }

  const { data: saved, error: saveError } = await service
    .from('inboxes')
    .update(patch)
    .eq('id', row.id)
    .eq('workspace_id', row.workspace_id)
    .select(ROW_COLUMNS)
    .single<InboxRow>();
  if (saveError || !saved) {
    console.error('[inbox-connection] save failed:', saveError?.message);
    return fail('Failed to save the connection type.', 500, { error_code: 'save_failed' });
  }

  return respondWith(saved);
}
