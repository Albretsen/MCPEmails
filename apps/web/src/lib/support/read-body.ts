/**
 * Read a request body as UTF-8 text with a byte cap.
 *
 * `request.text()` buffers the whole body before a length check can run, and
 * `.length` counts UTF-16 units, not bytes. This reads the stream chunk by
 * chunk and cancels it as soon as the running byte count passes `maxBytes`,
 * so an oversized body is never held in memory. A declared Content-Length over
 * the cap is refused before reading.
 */
export type BodyReadResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'too_large' | 'unreadable' };

export async function readBodyWithLimit(request: Request, maxBytes: number): Promise<BodyReadResult> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await request.body?.cancel().catch(() => {});
    return { ok: false, reason: 'too_large' };
  }
  const body = request.body;
  if (!body) return { ok: true, text: '' };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: 'unreadable' };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}
