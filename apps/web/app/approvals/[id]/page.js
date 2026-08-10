import { redirect, notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { issueCsrfToken } from '@/lib/oauth/csrf';
import { loadApprovalForReview } from '@/lib/approvals/review';
import { ApprovalReview } from '../../../components/approvals/ApprovalReview';

/**
 * The authenticated send-review page.
 *
 * This is the single load-bearing security control of the MCP Apps feature.
 * The review card in Claude opens it with `ui/open-link` at
 * https://mcpemails.com/approvals/<approval_id> — a BARE ID, no token, no
 * signature. That is deliberate: a signed URL sitting in a model's context
 * would itself be a bearer capability, and the model can call whichever tool
 * hands out the token (see docs/mcp-apps/contract.md §6). The id is worthless
 * without a Supabase session and an owner/admin role, which is what this file
 * enforces.
 *
 * Three guards, in order:
 *   1. Not signed in            → redirect to /login with a return path here.
 *   2. Not a member of the      → notFound(), byte-identical to a genuinely
 *      approval's workspace        missing id. No existence oracle.
 *   3. Not owner/admin          → read-only review with an explanation.
 *
 * Nothing on this page mutates anything. The decision is a POST to
 * /api/approvals/[id]/decide carrying a single-use CSRF token.
 */

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  return {
    title: 'Review send · MCP Emails',
    // This URL travels through an AI conversation. Keep it out of every index.
    robots: { index: false, follow: false, nocache: true },
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ApprovalReviewPage({ params }) {
  const { id } = await params;

  // A malformed id would make Postgres raise on the uuid cast; answer with the
  // same 404 a valid-but-unknown id gets.
  if (!UUID_RE.test(id ?? '')) notFound();

  const auth = await createClient();
  const {
    data: { user },
  } = await auth.auth.getUser();

  if (!user) {
    // The proxy also guards /approvals, but never rely on the proxy alone:
    // a matcher change once silently disabled the dashboard auth guard.
    redirect(`/login?redirect=${encodeURIComponent(`/approvals/${id}`)}`);
  }

  const db = createServiceRoleClient();
  const review = await loadApprovalForReview(db, id, user.id);

  if (review === 'not_found') notFound();

  // Only mint a CSRF token when there is actually something to decide. The
  // token is single-use and user-bound; a read-only render never gets one.
  const csrfToken =
    review.state === 'pending' && review.canDecide ? await issueCsrfToken(user.id) : null;

  return <ApprovalReview review={review} csrfToken={csrfToken} />;
}
