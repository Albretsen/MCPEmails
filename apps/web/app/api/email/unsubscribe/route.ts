import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { isLifecycleCategory, type LifecycleCategory } from '@/lib/email/lifecycle';
import { POSTAL_ADDRESS_LINE } from '@/lib/email/legal';

/**
 * One-click unsubscribe for lifecycle email.
 *
 * POST is the one that matters. RFC 8058 lets a mailbox provider POST straight
 * to the List-Unsubscribe URL when the message also carries
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, with no login, no
 * confirmation page and no round trip through us. Gmail's "Unsubscribe" button
 * next to the sender name is exactly this. If the POST does not work, the button
 * does not appear, and the reader's remaining option is the spam button.
 *
 * GET exists for the link at the bottom of the body, which a human clicks. It
 * performs the same opt-out and then says so in one plain sentence. It is
 * deliberately NOT a confirmation page: someone who clicked unsubscribe has
 * already decided, and making them click again to prove it is how a person ends
 * up reporting the mail instead.
 *
 * A GET that changes state is normally wrong. It is right here because the
 * alternative is worse for the reader, the token is single-purpose and
 * unguessable, and the only state it can reach is "send this person less mail".
 * A prefetcher that follows the link causes the outcome the link promises.
 *
 * AUTH is the token itself: a random uuid on the user row, unique-indexed. It
 * is not a user id, so a forwarded email leaks no primary key, and it cannot be
 * derived from an address someone already knows. Rotating it is one UPDATE.
 *
 * ?c= names the category to stop. A missing or unrecognised category is treated
 * as a GLOBAL opt-out rather than as an error, because a request that reaches
 * here at all is a person asking to stop, and the only unrecoverable mistake
 * available is to keep mailing them.
 *
 * Transactional mail (receipts, invites, password resets, security notices) does
 * not read these columns and keeps sending. That is the point of the split.
 *
 * Always 200, never 4xx. A mailbox provider that gets an error back may retry,
 * may surface a failure to the reader, or may stop offering the button. There
 * is no failure here worth telling them about.
 */

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function optOut(
  token: string | null,
  rawCategory: string | null,
): Promise<{ ok: boolean; category: LifecycleCategory | 'all' }> {
  const category: LifecycleCategory | 'all' =
    rawCategory && isLifecycleCategory(rawCategory) ? rawCategory : 'all';

  // Shape-check before the query: an unbounded string in a uuid comparison is a
  // 22P02 from Postgres, not a match, and there is no reason to send it.
  if (!token || !UUID_RE.test(token)) {
    return { ok: false, category };
  }

  try {
    const supabase = createServiceRoleClient();

    const { data: user, error: readError } = await supabase
      .from('users')
      .select('id, unsubscribed_categories')
      .eq('unsubscribe_token', token)
      .maybeSingle();

    if (readError || !user) {
      // An unknown token is not an error worth reporting to the caller: it is a
      // stale link, or a scanner. Say nothing about whether it existed.
      return { ok: false, category };
    }

    if (category === 'all') {
      const { error } = await supabase
        .from('users')
        .update({ unsubscribed_at: new Date().toISOString() })
        .eq('id', user.id);
      return { ok: !error, category };
    }

    const existing = user.unsubscribed_categories ?? [];
    if (existing.includes(category)) {
      // Already opted out. Idempotent by design: a provider may POST the
      // one-click URL more than once, and a second click must not look like a
      // failure.
      return { ok: true, category };
    }

    const { error } = await supabase
      .from('users')
      .update({ unsubscribed_categories: [...existing, category] })
      .eq('id', user.id);

    return { ok: !error, category };
  } catch {
    return { ok: false, category };
  }
}

/** RFC 8058 one-click. Body is ignored; the URL carries everything. */
export async function POST(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  await optOut(url.searchParams.get('token'), url.searchParams.get('c'));

  // 200 whatever happened. See the note above on why this never reports failure.
  return new NextResponse(null, { status: 200 });
}

/** The human-clicked link in the body. */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const { ok, category } = await optOut(
    url.searchParams.get('token'),
    url.searchParams.get('c'),
  );

  const message = ok
    ? category === 'all'
      ? 'Done. You will not get any more email from MCP Emails that is not a receipt or a security notice.'
      : 'Done. You will not get any more email like that one. Receipts, invites and security notices still work.'
    : 'That link has expired or was already used. Nothing was changed. If you are still getting email you do not want, reply to any of it and it will be stopped by hand.';

  const body = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta name="robots" content="noindex,nofollow"/>
  <title>Unsubscribed</title>
</head>
<body style="margin:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:520px;margin:80px auto;padding:0 24px;">
    <p style="font-size:18px;font-weight:700;color:#0f172a;margin:0 0 12px;">MCP Emails</p>
    <p style="font-size:16px;color:#334155;line-height:1.6;margin:0 0 24px;">${message}</p>
    <p style="font-size:13px;color:#94a3b8;line-height:1.6;margin:0;">
      ${POSTAL_ADDRESS_LINE}
    </p>
  </div>
</body>
</html>`;

  return new NextResponse(body, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}
