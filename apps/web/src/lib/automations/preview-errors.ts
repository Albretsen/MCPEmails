/**
 * What a failed automation preview tells the person looking at it.
 *
 * The edge function answers in machine codes (`unauthorized`, `scope_denied`,
 * `search_failed`), and these used to reach the form as the visible error. Every
 * code is mapped here, and anything not listed becomes the generic line, so a new
 * upstream code can never show up raw. The form translates by `code`; `error` is
 * the English fallback for a caller that is not the form.
 */

export const PREVIEW_UNAVAILABLE = 'preview_unavailable';
export const PREVIEW_TIMEOUT = 'preview_timeout';
const PREVIEW_FAILED = 'preview_failed';

const UPSTREAM_ERRORS: Record<string, { code: string; error: string; status: number }> = {
  api_key_not_found: { code: 'key_not_available', error: 'That API key is not available any more. Choose another one.', status: 400 },
  api_key_expired: { code: 'key_expired', error: 'That API key has expired. Choose another one.', status: 400 },
  scope_denied: { code: 'key_cannot_read', error: 'That API key cannot read mail, so it cannot preview. Choose a key that can.', status: 400 },
  inbox_not_permitted: { code: 'key_not_for_inbox', error: 'That API key is not allowed to use this inbox.', status: 400 },
  inbox_not_found: { code: 'inbox_not_available', error: 'This inbox is not available right now.', status: 400 },
  search_failed: { code: 'search_failed', error: 'The mailbox could not be searched. Check the inbox connection, then try again.', status: 502 },
};

export const PREVIEW_UNAVAILABLE_ANSWER = {
  code: PREVIEW_UNAVAILABLE,
  error: 'Preview is not available right now. The problem is on our side and your automation is not affected. Try again in a little while.',
  status: 503,
};

/** Maps a failed upstream answer. A refused key or a missing route is on us, not the filter. */
export function previewFailureFor(status: number, upstreamError: unknown): { code: string; error: string; status: number } {
  if (status === 401 || (status === 404 && upstreamError == null)) return PREVIEW_UNAVAILABLE_ANSWER;
  const mapped = typeof upstreamError === 'string' && Object.hasOwn(UPSTREAM_ERRORS, upstreamError)
    ? UPSTREAM_ERRORS[upstreamError]
    : null;
  return mapped ?? {
    code: PREVIEW_FAILED,
    error: 'Could not preview this filter against the mailbox.',
    status: status >= 400 && status < 500 ? 400 : 502,
  };
}

/** Preview response code to its message under `automations.modal`. */
export const PREVIEW_ERROR_MESSAGE_KEYS: Record<string, string> = {
  [PREVIEW_UNAVAILABLE]: 'previewUnavailable',
  [PREVIEW_TIMEOUT]: 'previewTimeout',
  [PREVIEW_FAILED]: 'previewFailed',
  key_not_available: 'previewKeyNotAvailable',
  key_expired: 'previewKeyExpired',
  key_cannot_read: 'previewKeyCannotRead',
  key_not_for_inbox: 'previewKeyNotForInbox',
  inbox_not_available: 'previewInboxNotAvailable',
  search_failed: 'previewSearchFailed',
};
