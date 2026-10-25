import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { listInboxMailboxes } from '@/lib/inboxes/folder-overrides-imap';
import {
  FOLDER_ERROR_STATUS,
  folderChoiceApplies,
  isFolderOverrideRole,
  loadFolderSettings,
  saveFolderOverride,
  type FolderDeps,
  type FolderResult,
} from '@/lib/inboxes/folder-overrides';
import { canManageInboxes, fetchWorkspaceRole, insufficientRoleBody } from '@/lib/workspace/roles';

/**
 * /api/inboxes/[id]/folders: which IMAP folder MCPEmails uses per role.
 *
 *   GET                         pickable folders, and per role the automatic pick and the user's pick
 *   PUT {role, folder|null}     save one role's pick, or clear it (null) back to automatic
 *
 * Authorization mirrors POST /api/inboxes/[id]/check, because both decrypt the
 * stored password and dial the stored host: the inbox is read through the
 * RLS-scoped client (a returned row proves workspace membership), then
 * canManageInboxes, then the full row through the service-role client scoped
 * to the inbox id AND that workspace. Viewers are refused both methods.
 *
 * The rules live in lib/inboxes/folder-overrides.ts (imported from the edge
 * function, which enforces the same ones). `folder_overrides` is read in its
 * own query, never added to a shared select: before the migration lands it
 * answers 503 'unavailable' here and nowhere else breaks.
 */

type Params = { params: Promise<{ id: string }> };

const ROW_COLUMNS =
  'id, workspace_id, provider, email_address, imap_host, imap_port, imap_security, imap_username, imap_password, oauth_access_token';

interface InboxRow {
  id: string;
  workspace_id: string;
  provider: string;
  email_address: string;
  imap_host: string | null;
  imap_port: number | null;
  imap_security: string | null;
  imap_username: string | null;
  imap_password: string | null;
  oauth_access_token: string | null;
}

type Authorized = { ok: true; deps: FolderDeps } | { ok: false; response: NextResponse };

function fail(error: string, status: number): { ok: false; response: NextResponse } {
  return { ok: false, response: NextResponse.json({ error }, { status }) };
}

async function authorize(params: Params['params']): Promise<Authorized> {
  const { id: inboxId } = await params;
  if (!inboxId || typeof inboxId !== 'string' || inboxId.length > 100) return fail('Invalid inbox ID.', 400);

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) return fail('Unauthorized.', 401);

  const { data: visible, error } = await supabase
    .from('inboxes')
    .select('id, workspace_id')
    .eq('id', inboxId)
    .is('deleted_at', null)
    .single();
  if (error || !visible) return fail('Inbox not found.', 404);

  const role = await fetchWorkspaceRole(supabase, visible.workspace_id, user.id);
  if (!canManageInboxes(role)) {
    return {
      ok: false,
      response: NextResponse.json(insufficientRoleBody('Workspace viewers cannot change folder settings.'), { status: 403 }),
    };
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
  if (!folderChoiceApplies(row)) return fail('unsupported_inbox', FOLDER_ERROR_STATUS.unsupported_inbox);

  const scoped = <T extends { eq: (column: string, value: string) => T }>(query: T): T =>
    query.eq('id', row.id).eq('workspace_id', row.workspace_id);

  return {
    ok: true,
    deps: {
      listMailboxes: () =>
        listInboxMailboxes(
          {
            email_address: row.email_address,
            imap_host: row.imap_host!,
            imap_port: row.imap_port,
            imap_username: row.imap_username,
            imap_password: row.imap_password!,
          },
          service,
        ),
      readOverrides: async () => {
        const { data, error: readError } = await scoped(service.from('inboxes').select('folder_overrides')).maybeSingle();
        if (readError) {
          // 42703: the column is not there yet (migration not applied).
          return { ok: false, unavailable: readError.code === '42703' };
        }
        return { ok: true, raw: (data as { folder_overrides?: unknown } | null)?.folder_overrides ?? null };
      },
      writeOverrides: async (next) => {
        const { error: writeError } = await scoped(service.from('inboxes').update({ folder_overrides: next }));
        if (writeError) throw new Error(writeError.message);
      },
    },
  };
}

function respond<T>(result: FolderResult<T>): NextResponse {
  if (result.ok) return NextResponse.json(result.value);
  return NextResponse.json({ error: result.error }, { status: FOLDER_ERROR_STATUS[result.error] });
}

export async function GET(_request: NextRequest, { params }: Params): Promise<NextResponse> {
  const auth = await authorize(params);
  if (!auth.ok) return auth.response;
  try {
    return respond(await loadFolderSettings(auth.deps));
  } catch (err) {
    console.error('[folders] load failed:', (err as Error).message);
    return NextResponse.json({ error: 'load_failed' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest, { params }: Params): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('shape');
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  if (!isFolderOverrideRole(body.role)) return NextResponse.json({ error: 'invalid_role' }, { status: 400 });
  if (body.folder !== null && typeof body.folder !== 'string') {
    return NextResponse.json({ error: 'invalid_folder' }, { status: 400 });
  }

  const auth = await authorize(params);
  if (!auth.ok) return auth.response;
  try {
    return respond(await saveFolderOverride(auth.deps, body.role, body.folder));
  } catch (err) {
    console.error('[folders] save failed:', (err as Error).message);
    return NextResponse.json({ error: 'save_failed' }, { status: 500 });
  }
}
