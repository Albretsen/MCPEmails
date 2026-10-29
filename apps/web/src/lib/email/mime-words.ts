/**
 * RFC 2047 encoded words ("=?UTF-8?B?SGVsbG8=?="), decoded for display.
 *
 * The web app's IMAP client returns ENVELOPE subjects raw (imap.ts leaves
 * decoding to mailparser, which only the MCP server runs). The onboarding
 * proof card shows three subject lines, so this is the small decoder it
 * needs: B and Q encodings, any charset TextDecoder knows, adjacent encoded
 * words joined without the whitespace between them (RFC 2047 6.2). Anything
 * it cannot decode is left as it was.
 */
const ENCODED_WORD = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;

function bytesFromQ(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '_') out.push(0x20);
    else if (ch === '=' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      out.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(ch.charCodeAt(0) & 0xff);
  }
  return Uint8Array.from(out);
}

function bytesFromB(text: string): Uint8Array | null {
  try {
    const binary = atob(text.replace(/[^A-Za-z0-9+/=]/g, ''));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function decodeWord(charset: string, encoding: string, text: string): string | null {
  const bytes = encoding.toUpperCase() === 'B' ? bytesFromB(text) : bytesFromQ(text);
  if (!bytes) return null;
  // RFC 2231 language suffix: "UTF-8*en".
  const label = charset.split('*')[0].toLowerCase();
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return null;
  }
}

export function decodeMimeWords(input: string | null | undefined): string {
  const value = String(input ?? '');
  if (!value.includes('=?')) return value;
  // Whitespace between two encoded words is not part of the text.
  const joined = value.replace(/(=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)\s+(?==\?)/g, '$1');
  return joined.replace(ENCODED_WORD, (whole, charset: string, encoding: string, text: string) => {
    return decodeWord(charset, encoding, text) ?? whole;
  });
}
