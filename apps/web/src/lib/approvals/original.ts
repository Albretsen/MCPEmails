import { neutralizeNullable, neutralizeText } from '@/lib/textSafety';

/**
 * A held forward's original as the review surfaces show it, read live from the
 * mailbox by the mcp-server and stored nowhere.
 *
 * All of it is written by whoever sent the message. The names are short facts a
 * reviewer scans, so invisible and bidi characters are stripped from them: a file
 * named `invoice<U+202E>fdp.exe` must not read as a PDF. The preview is prose: the
 * mcp-server tidies it as it does any list preview, this file leaves it alone, and
 * the page isolates its direction. React escapes everything; none of it is rendered
 * as HTML.
 */

export type OriginalUnavailableReason = 'not_found' | 'ambiguous' | 'mailbox' | 'unreadable' | 'not_forward';

export interface OriginalAttachment {
  filename: string;
  size_bytes: number | null;
}

export type OriginalView =
  | {
    status: 'ok';
    moved: boolean;
    from_name: string | null;
    from_email: string | null;
    date: string | null;
    preview: string;
    attachments: OriginalAttachment[];
  }
  | { status: 'unavailable'; reason: OriginalUnavailableReason };

const REASONS: readonly OriginalUnavailableReason[] = ['not_found', 'ambiguous', 'mailbox', 'unreadable', 'not_forward'];

const MAX_PREVIEW_CHARS = 600;

/** The edge function's answer as the page may see it. Anything odd is "unavailable". */
export function cleanOriginal(raw: unknown): OriginalView {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (value.status !== 'ok') {
    const reason = REASONS.find((known) => known === value.reason);
    return { status: 'unavailable', reason: reason ?? 'mailbox' };
  }
  const from = (value.from && typeof value.from === 'object' ? value.from : {}) as Record<string, unknown>;
  const files = Array.isArray(value.attachments) ? value.attachments : [];
  return {
    status: 'ok',
    moved: value.moved === true,
    from_name: neutralizeNullable(from.name as string | null) || null,
    from_email: neutralizeNullable(from.email as string | null) || null,
    date: typeof value.date === 'string' ? value.date : null,
    preview: typeof value.preview === 'string' ? value.preview.slice(0, MAX_PREVIEW_CHARS) : '',
    attachments: files.map((file) => {
      const entry = (file && typeof file === 'object' ? file : {}) as Record<string, unknown>;
      return {
        filename: neutralizeText(typeof entry.filename === 'string' ? entry.filename : '') || 'attachment',
        size_bytes: typeof entry.size_bytes === 'number' ? entry.size_bytes : null,
      };
    }),
  };
}
