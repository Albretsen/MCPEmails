import { NextResponse } from 'next/server';

/**
 * GET /api/automations/preview/health
 *
 * Does this site's service key get through to the preview route? Run after every
 * deploy (`.github/workflows/preview-health.yml`, and the edge deploy workflow).
 * A rotated key breaks Preview and nothing else, so nothing else would notice.
 *
 * Public, because a deploy check holds no secret of this site. It names no key and
 * opens no mailbox: it sends the edge function a probe, which answers straight after
 * its auth check. The answer is reused briefly so hitting this route repeatedly
 * does not turn into repeated calls upstream.
 */

const REUSE_MS = 20_000;
let lastAnswer: { at: number; ok: boolean; reason: string | null } | null = null;

async function probe(): Promise<{ ok: boolean; reason: string | null }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { ok: false, reason: 'not_configured' };
  try {
    const upstream = await fetch(`${url}/functions/v1/mcp-server/triage-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ probe: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (upstream.ok) return { ok: true, reason: null };
    if (upstream.status === 401) return { ok: false, reason: 'key_refused' };
    // An edge function older than the probe: the key got through, but it answers
    // 400 for the missing fields. Deploy order is web first, so this can be seen
    // briefly and is not a broken preview.
    if (upstream.status === 400) return { ok: true, reason: 'edge_predates_probe' };
    return { ok: false, reason: `edge_status_${upstream.status}` };
  } catch {
    return { ok: false, reason: 'edge_unreachable' };
  }
}

export async function GET() {
  if (!lastAnswer || Date.now() - lastAnswer.at > REUSE_MS) {
    lastAnswer = { at: Date.now(), ...(await probe()) };
  }
  const { ok, reason } = lastAnswer;
  return NextResponse.json({ ok, reason }, { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
}
