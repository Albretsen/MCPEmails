import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { recordProductFunnelEvent } from '@/lib/analytics/product-funnel';
import { checkRateLimit } from '@/lib/rate-limit';
import { createResend } from '@/lib/email/resend';
import { appUrl, lifecycleFrom, lifecycleReplyTo } from '@/lib/email/lifecycle';
import { normalizeChipClient } from '@/lib/onboarding/clients.mjs';
import { isInternalViewer } from '@/lib/onboarding/variant';
import {
  assistEvent,
  assistLocale,
  helpStepsEmail,
  isLinkKind,
  setupLinkEmail,
  tomorrowAtEight,
  validTimeZone,
  type ServiceEmail,
} from '@/lib/onboarding/assist';

type FunnelCategory = Parameters<typeof recordProductFunnelEvent>[1]['category'];
type FunnelStage = Parameters<typeof recordProductFunnelEvent>[1]['stage'];

/**
 * POST /api/onboarding/assist  { action, ... }
 *
 * The /onboarding steps after the inbox (WP-F, src/lib/onboarding/assist.ts):
 *
 *   event         {event, client?, tier?, prompt?}  one funnel row from the
 *                 closed list in assistEvent (handshake seen, help shown,
 *                 prompt copied, open-in-client clicked)
 *   email_link    {kind: add_to_ai | help_steps, client, locale}  one service
 *                 email to the SIGNED-IN user's own address: the setup link
 *                 (phones) or the help steps (10-minute help). Never any other
 *                 recipient. Internal accounts only in v1. 5 per hour per user.
 *   morning_brief {client, timeZone, locale}  store "Email me this tomorrow at
 *                 8": one row in onboarding_morning_brief_optins, sent by
 *                 /api/internal/onboarding-morning-brief/dispatch. Internal
 *                 accounts only in v1.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  const workspaceId = await resolveActiveWorkspaceId(supabase, user.id);
  if (!workspaceId) return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 });

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 });

  if (body.action === 'event') {
    const event = assistEvent(body);
    if (!event) return NextResponse.json({ error: 'Invalid event.' }, { status: 400 });
    await recordProductFunnelEvent(createServiceRoleClient(), {
      workspaceId, stage: event.stage as FunnelStage, outcome: 'success', category: event.category as FunnelCategory,
    });
    return NextResponse.json({ ok: true });
  }

  if (body.action !== 'email_link' && body.action !== 'morning_brief') {
    return NextResponse.json({ error: 'Unsupported action.' }, { status: 400 });
  }

  const db = createServiceRoleClient();
  const email = user.email ?? null;
  if (!email || !(await isInternalViewer(email, db))) {
    return NextResponse.json({ error: 'Not available.' }, { status: 403 });
  }
  const client = normalizeChipClient(body.client) ?? 'claude';
  const locale = assistLocale(body.locale);

  if (body.action === 'email_link') {
    if (!isLinkKind(body.kind)) return NextResponse.json({ error: 'Invalid link.' }, { status: 400 });
    if (await checkRateLimit(`onboarding:email:${user.id}`, 5, 3_600_000)) {
      return NextResponse.json({ error: 'Too many emails. Try again later.' }, { status: 429 });
    }
    const message = body.kind === 'add_to_ai' ? setupLinkEmail(locale, client, appUrl()) : helpStepsEmail(locale, client, appUrl());
    const sent = await sendServiceEmail(email, message, `onboarding-${body.kind}-${user.id}-${Math.floor(Date.now() / 60_000)}`);
    if (!sent) return NextResponse.json({ error: 'Could not send.' }, { status: 502 });
    await recordProductFunnelEvent(db, { workspaceId, stage: 'onboarding_link_emailed', outcome: 'success', category: `link_${body.kind}` as FunnelCategory });
    return NextResponse.json({ ok: true, email });
  }

  // morning_brief
  const timeZone = validTimeZone(body.timeZone) ?? 'UTC';
  const sendAt = tomorrowAtEight(Date.now(), timeZone);
  const now = new Date().toISOString();
  const { error } = await db.from('onboarding_morning_brief_optins').upsert({
    workspace_id: workspaceId,
    user_id: user.id,
    time_zone: timeZone,
    locale,
    client,
    send_at: sendAt.toISOString(),
    status: 'scheduled',
    sent_at: null,
    created_at: now,
    updated_at: now,
  }, { onConflict: 'workspace_id' });
  if (error) {
    console.error('[onboarding] morning brief opt-in failed', { error: error.message });
    return NextResponse.json({ error: 'Could not save.' }, { status: 500 });
  }
  await recordProductFunnelEvent(db, { workspaceId, stage: 'morning_brief_opt_in', outcome: 'success', category: client as FunnelCategory });
  return NextResponse.json({ ok: true, email, sendAt: sendAt.toISOString() });
}

/** One attempt through Resend, From the lifecycle sender, Reply-To support. */
async function sendServiceEmail(to: string, message: ServiceEmail, idempotencyKey: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  try {
    const { error } = await createResend(key).emails.send(
      { from: lifecycleFrom(), to, replyTo: lifecycleReplyTo(), subject: message.subject, html: message.html, text: message.text },
      { idempotencyKey },
    );
    if (error) {
      console.error('[onboarding] service email failed', { error: error.message });
      return false;
    }
    return true;
  } catch (err) {
    console.error('[onboarding] service email threw', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
