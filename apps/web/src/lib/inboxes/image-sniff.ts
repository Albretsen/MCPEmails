/**
 * Identifies a signature image by its leading bytes, not by the declared
 * Content-Type (which the browser takes from the filename and an attacker sets
 * to anything). Only the four raster formats the signature bucket serves are
 * recognised; everything else, SVG and HTML included, is null.
 */
export type SniffedImage = { contentType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; ext: string };

const startsWith = (bytes: Uint8Array, sig: number[], offset = 0): boolean =>
  bytes.length >= offset + sig.length && sig.every((b, i) => bytes[offset + i] === b);

export function sniffImageType(bytes: Uint8Array): SniffedImage | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { contentType: 'image/png', ext: 'png' };
  // JPEG: FF D8 FF
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { contentType: 'image/jpeg', ext: 'jpg' };
  // GIF: "GIF87a" / "GIF89a"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return { contentType: 'image/gif', ext: 'gif' };
  }
  // WebP: "RIFF" <size> "WEBP"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { contentType: 'image/webp', ext: 'webp' };
  }
  return null;
}
