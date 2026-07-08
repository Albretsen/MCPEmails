import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { checkRateLimit } from '@/lib/rate-limit';

/**
 * POST /api/inboxes/[id]/signature/image
 *
 * Uploads a single signature logo/image to the public `signature-assets`
 * Storage bucket and returns its public https URL for embedding in
 * signature_html (hosted URLs only — no base64/CID, per deliverability + XSS
 * decisions in the rich signature dev plan).
 *
 * Authorization mirrors the PATCH handler in ../../route.ts EXACTLY:
 *  1. Authenticate the user via the RLS-scoped client (401 on failure).
 *  2. Fetch the inbox via the RLS-scoped client. The inboxes SELECT policy
 *     guarantees the row is in a workspace the user belongs to and is not
 *     soft-deleted, so a returned row is proof of authorization (404 otherwise).
 *  3. Write (here: the Storage upload) via the service-role client, using the
 *     inbox's own workspace_id in the object key — never a client-supplied one.
 *
 * Abuse guards: the current controls are (a) auth (steps 1–2), (b) a strict
 * mime allowlist (raster only, no SVG), (c) a 2 MB size cap, and (d) a light
 * per-inbox rate limit below. A tighter per-user quota / total-bytes cap is a
 * follow-up (see Phase 1 Task 5 in the dev plan).
 */

// Validated mime → file extension. The client filename is NOT trusted; the
// extension is derived from the detected/declared content type only.
const ALLOWED_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: inboxId } = await params;

  if (!inboxId || typeof inboxId !== 'string' || inboxId.length > 100) {
    return NextResponse.json({ error: 'Invalid inbox ID.' }, { status: 400 });
  }

  // Parse the multipart body. The rich editor's image button posts a single
  // file under the `file` field via FormData; this matches App Router's
  // request.formData().
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: 'Expected a multipart/form-data body with a `file` field.' },
      { status: 400 }
    );
  }

  // Validate declared content type against the raster-only allowlist. SVG and
  // everything else is rejected.
  const contentType = file.type;
  const ext = ALLOWED_TYPES[contentType];
  if (!ext) {
    return NextResponse.json(
      { error: 'Unsupported image type. Allowed: png, jpeg, gif, webp.' },
      { status: 400 }
    );
  }

  // Enforce the 2 MB cap.
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: 'Image too large. Maximum size is 2 MB.' },
      { status: 413 }
    );
  }

  const supabase = await createClient();

  // 1. Authenticate the requesting user.
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  // 2. Fetch the inbox via the RLS-scoped client. A returned row authorizes the
  //    upload (the SELECT policy enforces workspace membership + not deleted).
  const { data: inbox, error: fetchError } = await supabase
    .from('inboxes')
    .select('id, workspace_id')
    .eq('id', inboxId)
    .is('deleted_at', null)
    .single();

  if (fetchError || !inbox) {
    return NextResponse.json({ error: 'Inbox not found.' }, { status: 404 });
  }

  const workspaceId = inbox.workspace_id;

  // Light per-inbox abuse guard: at most 30 uploads per 10 minutes. Fails open
  // on infrastructure errors, so it never blocks a legitimate upload.
  const limited = await checkRateLimit(`signature:image:${inboxId}`, 30, 10 * 60 * 1000);
  if (limited) {
    return NextResponse.json(
      { error: 'Too many uploads. Please try again shortly.' },
      { status: 429 }
    );
  }

  // 3. Upload via the service-role client. Key uses the inbox's OWN
  //    workspace_id (from the authorized row above), never a client value.
  const key = `${workspaceId}/${inboxId}/${crypto.randomUUID()}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());

  const service = createServiceRoleClient();
  const { error: uploadError } = await service.storage
    .from('signature-assets')
    .upload(key, bytes, { contentType, upsert: false });

  if (uploadError) {
    console.error('[signature-image] Upload failed:', uploadError.message);
    return NextResponse.json({ error: 'Failed to upload image.' }, { status: 500 });
  }

  // Public URL for the object. For the hosted Supabase project this is an
  // https URL, which the signature sanitizer requires for img src.
  const { data: pub } = service.storage.from('signature-assets').getPublicUrl(key);
  const url = pub.publicUrl;

  return NextResponse.json({ url }, { status: 201 });
}
