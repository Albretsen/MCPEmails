import { createHash } from 'node:crypto';

import { stripe } from '@/lib/stripe/client';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { checkoutSessionIdOrNull } from '@/lib/email/abandoned-checkout';
import type { CheckoutLocale } from '@/lib/stripe/checkout-core';

/**
 * The web half of the chat checkout link.
 *
 * When a Free workspace hits the monthly action cap inside a chat, the edge
 * function (supabase/functions/mcp-server) may put a link to
 * https://mcpemails.com/u/<token> in the refusal. This module holds what the
 * three web surfaces of that link share: the redeem route (app/u/[token]),
 * the success page (app/upgrade/done) and its status poll
 * (app/api/upgrade/status). Plan and decisions:
 * Documents/plans/paywall-checkout-link-20261024.md; schema:
 * supabase/migrations/20261024180000_chat_checkout_links.sql.
 *
 * THE TOKEN. 32 random-looking bytes as base64url without padding: always 43
 * characters. Only sha256 over the UTF-8 bytes of that 43-character STRING is
 * stored (not over the decoded bytes); the edge function hashes it the same
 * way. Nothing here can mint a token or derive one: the web side only ever
 * hashes what it was handed and looks the hash up.
 */

/** base64url, no padding, 32 bytes: exactly 43 characters. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How long the Checkout Session a link opens stays payable, in seconds.
 *
 * 31 minutes rather than the link's own 30: Stripe refuses an `expires_at` less
 * than 30 minutes ahead, and the extra minute absorbs clock skew between us and
 * Stripe so the create call cannot fail on the boundary.
 */
export const CHECKOUT_LINK_SESSION_TTL_SECONDS = 31 * 60;

/** True for a string shaped like a link token. Checked before any database call. */
export function isCheckoutLinkToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

/**
 * The token's stored hash, in the form PostgREST accepts for a `bytea`
 * argument: the Postgres hex literal `\x<64 hex chars>`.
 */
export function checkoutLinkTokenHash(token: string): string {
  return `\\x${createHash('sha256').update(token, 'utf8').digest('hex')}`;
}

/**
 * User-Agent fragments of link unfurlers and crawlers. A chat app that renders
 * a preview of the link fetches it before (or instead of) the person, and that
 * fetch must neither create a Checkout Session nor count as an open.
 */
const PREVIEW_UA_RE =
  /slackbot|facebookexternalhit|facebot|twitterbot|discordbot|whatsapp|telegrambot|linkedinbot|skypeuripreview|applebot|googlebot|bingbot|embedly|iframely|redditbot|preview/i;

/**
 * True when a request to /u/<token> is a link preview or a prefetch rather
 * than a person opening the link: a known unfurler or crawler User-Agent, an
 * empty one, or a prefetch/preview purpose header. Pure; the route answers
 * these with a blank page and makes no database or Stripe call.
 */
export function isLinkPreviewRequest(headers: {
  get(name: string): string | null;
}): boolean {
  const ua = (headers.get('user-agent') ?? '').trim();
  if (!ua || PREVIEW_UA_RE.test(ua)) return true;
  const purpose = (name: string) => (headers.get(name) ?? '').trim().toLowerCase();
  return (
    purpose('purpose') === 'prefetch' ||
    purpose('sec-purpose').split(';')[0].trim() === 'prefetch' ||
    purpose('x-purpose') === 'preview'
  );
}

/** A `checkout_links.id` from Stripe metadata, or null. */
export function checkoutLinkIdOrNull(value: unknown): string | null {
  return typeof value === 'string' && UUID_RE.test(value) ? value.toLowerCase() : null;
}

/**
 * The hosted page's language for a link checkout.
 *
 * German or English only, for the reason in checkout-core.ts (CheckoutLocale):
 * the German page is the one whose subscribe button carries the wording
 * §312j BGB asks for. There is no stored language choice on the server (the
 * app language lives in the browser's localStorage), so two signals are used:
 * the workspace's `acquisition_locale` (the locale of the page they signed up
 * from) and the primary language of the browser that is opening the link,
 * which is the browser that will show Stripe's page. Either one being German
 * is enough; erring towards the German button is the safe direction.
 */
export function checkoutLinkLocale(
  acquisitionLocale: string | null | undefined,
  acceptLanguage: string | null | undefined,
): CheckoutLocale {
  if (acquisitionLocale === 'de') return 'de';
  const primary = (acceptLanguage ?? '').split(',')[0]?.trim().toLowerCase() ?? '';
  return primary === 'de' || primary.startsWith('de-') ? 'de' : 'en';
}

/**
 * Where a link's checkout stands, for the success page and its poll.
 *
 *   unknown     not a session a chat link created (or Stripe could not be read)
 *   unpaid      a link session that is open or expired, not paid
 *   activating  paid, the webhook has not moved the workspace's plan yet
 *   active      paid and the workspace is on a paid plan
 *
 * The session must carry a `checkout_link_id` AND be the session stored on
 * that row, so a session id from any other checkout reads as `unknown` and
 * this cannot be used to ask about someone else's purchase. Nothing about the
 * buyer (email, name, plan, amount) leaves this function.
 */
export type CheckoutLinkStatus = 'unknown' | 'unpaid' | 'activating' | 'active';

export async function checkoutLinkStatus(sessionId: unknown): Promise<CheckoutLinkStatus> {
  const id = checkoutSessionIdOrNull(sessionId);
  if (!id) return 'unknown';

  let session: { id: string; status: string | null; metadata: Record<string, string> | null };
  try {
    session = await stripe.checkout.sessions.retrieve(id);
  } catch (err) {
    console.error(
      '[checkout-link] session retrieve failed:',
      err instanceof Error ? err.message : String(err),
    );
    return 'unknown';
  }

  const linkId = checkoutLinkIdOrNull(session.metadata?.checkout_link_id);
  if (!linkId) return 'unknown';
  if (session.status !== 'complete') return 'unpaid';

  const db = createServiceRoleClient();
  const { data: link, error: linkError } = await db
    .from('checkout_links')
    .select('workspace_id')
    .eq('id', linkId)
    .eq('stripe_session_id', session.id)
    .maybeSingle();
  if (linkError) console.error('[checkout-link] link lookup failed:', linkError.message);
  if (!link) return 'unknown';

  // The webhook projects the user's plan onto every workspace they own
  // (applyUserPlan), so the refusal's own workspace leaving `free` is exactly
  // the moment the blocked call in the chat will succeed.
  const { data: workspace, error: wsError } = await db
    .from('workspaces')
    .select('plan')
    .eq('id', link.workspace_id)
    .maybeSingle();
  if (wsError) console.error('[checkout-link] workspace plan lookup failed:', wsError.message);
  return workspace?.plan && workspace.plan !== 'free' ? 'active' : 'activating';
}

/**
 * Called from the webhook's `checkout.session.completed`: stamp the link as
 * paid, for the experiment read-out. Best effort, never throws, so a failed
 * analytics write cannot fail a webhook that just granted a plan.
 */
export async function markCheckoutLinkComplete(metadataLinkId: unknown): Promise<void> {
  const id = checkoutLinkIdOrNull(metadataLinkId);
  if (!id) return;
  try {
    const { error } = await createServiceRoleClient().rpc('checkout_link_complete', { p_id: id });
    if (error) console.error('[checkout-link] complete failed:', error.message);
  } catch (err) {
    console.error(
      '[checkout-link] complete failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}
