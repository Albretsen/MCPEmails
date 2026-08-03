/**
 * Return the exact decoded size of a standard base64 payload, or null when the
 * value is malformed. This is deliberately stricter than atob alone: atob
 * accepts a few non-canonical inputs, while attachment data must be portable
 * to the provider/dispatcher that eventually consumes it.
 */
export function decodedBase64ByteLength(data: string): number | null {
  const clean = data.replace(/\s/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(clean)) {
    return null;
  }
  try {
    return atob(clean).length;
  } catch {
    return null;
  }
}
