/**
 * Reads the upload link's fragment (`#t=...&n=...&s=...&e=...`), written by
 * supabase/functions/mcp-server/attachment-uploads.ts#uploadPageUrl.
 *
 * The signed upload URL rides in the fragment so it never reaches a server
 * log. The page only ever sends a file to a signed upload URL in the
 * attachment-uploads bucket of OUR Supabase project: anything else is
 * refused, so a crafted link cannot turn this page into a way to send a
 * user's file somewhere else.
 */

const SIGNED_PATH = '/storage/v1/object/upload/sign/attachment-uploads/';

function decodeBase64Url(text) {
  try {
    const normal = text.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normal + '='.repeat((4 - (normal.length % 4)) % 4));
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/**
 * @param {string} hash  location.hash, with or without the leading '#'
 * @param {string} supabaseOrigin  e.g. https://abc.supabase.co
 * @returns {{ putUrl: string, filename: string, size: number | null, expiresAt: string | null } | null}
 */
export function parseUploadFragment(hash, supabaseOrigin) {
  const params = new URLSearchParams(String(hash ?? '').replace(/^#/, ''));
  const raw = params.get('t');
  if (!raw) return null;
  const putUrl = decodeBase64Url(raw);
  if (!putUrl) return null;
  let url;
  let origin;
  try {
    url = new URL(putUrl);
    origin = new URL(supabaseOrigin).origin;
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.origin !== origin) return null;
  if (url.username || url.password) return null;
  if (!url.pathname.startsWith(SIGNED_PATH) || url.pathname.includes('/../')) return null;
  if (!url.searchParams.get('token')) return null;
  const sizeText = params.get('s');
  const size = sizeText !== null && /^\d+$/.test(sizeText) ? Number(sizeText) : null;
  const expires = params.get('e');
  const expiresAt = expires && !Number.isNaN(Date.parse(expires)) ? expires : null;
  const filename = (params.get('n') ?? '').slice(0, 255);
  return { putUrl: url.toString(), filename, size, expiresAt };
}

/** 10 MB: one email's attachment limit, and the bucket's. */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
