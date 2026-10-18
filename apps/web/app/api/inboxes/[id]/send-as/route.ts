import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { checkRateLimit } from '@/lib/rate-limit';
import { sendSendAsCode } from '@/lib/email/send-as-code';
import { createSendAsStore } from '@/lib/inboxes/send-as-store';
import {
  addAlias,
  listAliases,
  removeAlias,
  resendCode,
  SEND_AS_ERROR_STATUS,
  verifyAlias,
  type SendAsDeps,
  type SendAsInbox,
  type SendAsResult,
} from '@/lib/inboxes/send-as';
import { canManageInboxes, fetchWorkspaceRole, insufficientRoleBody } from '@/lib/workspace/roles';

/**
 * /api/inboxes/[id]/send-as: Send As addresses for an IMAP inbox.
 *
 *   GET                                    list (any member, viewers included)
 *   POST {action:'add', email_address, display_name?}   add + mail a code
 *   POST {action:'resend', alias_id}                     mail a fresh code
 *   POST {action:'verify', alias_id, code}               check the code
 *   DELETE ?alias_id=                                     remove
 *
 * Authorization mirrors PATCH /api/inboxes/[id]: the inbox is read through
 * the RLS-scoped client (a returned row proves workspace membership), then
 * writes need canManageInboxes. Every write goes through the service-role
 * client, scoped to the inbox id AND workspace id. The rules themselves,
 * including verification and rate limits, are in lib/inboxes/send-as.ts.
 */

type Params = { params: Promise<{ id: string }> };

type Authorized =
  | { ok: true; inbox: SendAsInbox; userId: string; canWrite: boolean }
  | { ok: false; response: NextResponse };

async function authorize(params: Params['params']): Promise<Authorized> {
  const { id: inboxId } = await params;
  if (!inboxId || typeof inboxId !== 'string' || inboxId.length > 100) {
    return { ok: false, response: NextResponse.json({ error: 'Invalid inbox ID.' }, { status: 400 }) };
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized.' }, { status: 401 }) };
  }

  const { data: inbox, error } = await supabase
    .from('inboxes')
    .select('id, workspace_id, provider, email_address, smtp_host')
    .eq('id', inboxId)
    .is('deleted_at', null)
    .single();
  if (error || !inbox) {
    return { ok: false, response: NextResponse.json({ error: 'Inbox not found.' }, { status: 404 }) };
  }

  const role = await fetchWorkspaceRole(supabase, inbox.workspace_id, user.id);
  return { ok: true, inbox: inbox as SendAsInbox, userId: user.id, canWrite: canManageInboxes(role) };
}

function deps(): SendAsDeps {
  return {
    store: createSendAsStore(createServiceRoleClient()),
    mailer: { sendCode: sendSendAsCode },
    rateLimit: checkRateLimit,
    now: () => Date.now(),
  };
}

function respond<T>(result: SendAsResult<T>, key: string): NextResponse {
  if (result.ok) return NextResponse.json({ [key]: result.value });
  return NextResponse.json({ error: result.error }, { status: SEND_AS_ERROR_STATUS[result.error] });
}

function viewerRefused(): NextResponse {
  return NextResponse.json(insufficientRoleBody('Workspace viewers cannot change Send As addresses.'), {
    status: 403,
  });
}

export async function GET(_request: NextRequest, { params }: Params): Promise<NextResponse> {
  const auth = await authorize(params);
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json({ aliases: await listAliases(deps(), auth.inbox) });
  } catch (err) {
    console.error('[send-as] list failed:', (err as Error).message);
    return NextResponse.json({ error: 'Failed to load Send As addresses.' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: Params): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('shape');
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  const action = body.action;
  if (action !== 'add' && action !== 'resend' && action !== 'verify') {
    return NextResponse.json({ error: "action must be 'add', 'resend' or 'verify'." }, { status: 400 });
  }
  if (action !== 'add' && (typeof body.alias_id !== 'string' || body.alias_id.length > 100)) {
    return NextResponse.json({ error: 'alias_id is required.' }, { status: 400 });
  }

  const auth = await authorize(params);
  if (!auth.ok) return auth.response;
  if (!auth.canWrite) return viewerRefused();

  try {
    const d = deps();
    if (action === 'add') {
      return respond(
        await addAlias(d, auth.inbox, auth.userId, {
          email_address: body.email_address,
          display_name: body.display_name,
        }),
        'alias',
      );
    }
    if (action === 'resend') return respond(await resendCode(d, auth.inbox, body.alias_id as string), 'alias');
    return respond(await verifyAlias(d, auth.inbox, body.alias_id as string, body.code), 'alias');
  } catch (err) {
    console.error(`[send-as] ${action} failed:`, (err as Error).message);
    return NextResponse.json({ error: 'Failed to update Send As addresses.' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: Params): Promise<NextResponse> {
  const aliasId = new URL(request.url).searchParams.get('alias_id');
  if (!aliasId || aliasId.length > 100) {
    return NextResponse.json({ error: 'alias_id is required.' }, { status: 400 });
  }
  const auth = await authorize(params);
  if (!auth.ok) return auth.response;
  if (!auth.canWrite) return viewerRefused();
  try {
    const result = await removeAlias(deps(), auth.inbox, aliasId);
    return result.ok ? NextResponse.json({ success: true }) : respond(result, 'alias');
  } catch (err) {
    console.error('[send-as] delete failed:', (err as Error).message);
    return NextResponse.json({ error: 'Failed to remove the Send As address.' }, { status: 500 });
  }
}
