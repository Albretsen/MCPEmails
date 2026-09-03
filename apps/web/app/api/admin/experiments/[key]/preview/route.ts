import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin/require-admin';
import { getExperimentDecisionForRequest } from '@/lib/experiments/request';

/**
 * GET /api/admin/experiments/[key]/preview
 *
 * What this request would be shown, and why, as JSON.
 *
 * It exists for two reasons. It is how an operator checks that an override
 * actually took, without hunting for the difference on a marketing page. And
 * it is a second call site of the public API from somewhere that is not the
 * homepage, which keeps getExperimentDecisionForRequest honest about being a
 * general lookup rather than one page's helper.
 *
 * Reading a decision for a running experiment records an assignment for this
 * browser's subject id, exactly as a page render would. That is the point: it
 * previews the real thing, not a simulation of it.
 */

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<NextResponse> {
  await requireAdmin();
  const { key } = await params;
  const decision = await getExperimentDecisionForRequest(key);
  return NextResponse.json({ key, variantId: decision.variantId, reason: decision.reason });
}
