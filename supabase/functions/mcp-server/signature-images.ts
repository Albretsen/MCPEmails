// ---------------------------------------------------------------------------
// signature-images: turn a signature's hosted logo into an image that travels
// INSIDE the message (multipart/related + Content-ID), per inbox, opt-in
// ---------------------------------------------------------------------------
//
// WHY. A signature image is stored as an https URL. Desktop mail clients
// (Thunderbird, Outlook, Apple Mail with privacy protection) do not load remote
// content until the reader allows it, so a draft we wrote opens with a blank
// box where the logo should be, and so does the delivered mail for many
// recipients. The same clients embed the logo when the user composes there
// themselves, which is the behaviour people compare us against. With
// `inboxes.signature_embed_images` on, the image bytes are fetched once and
// attached inline, and the HTML points at them with `cid:`.
//
// WHERE IT RUNS. At the transport, immediately before the MIME is built, and
// NOT in `applySignature`. Three reasons:
//
//   1. `applySignature` is pure and synchronous, and its output is what an
//      approval snapshot stores and a reviewer reads. A snapshot must keep the
//      https URL: `cid:` means nothing without the part it names.
//   2. The draft editor rebuilds a draft from its stored HTML on every save and
//      writes no parts of its own. Because this step also RECOGNISES its own
//      `cid:` references (see below), that rebuild gets its image back without
//      the editor knowing the feature exists.
//   3. One place per transport covers send, reply, scheduled, approved and
//      draft writes alike.
//
// THE CID IS REVERSIBLE, ON PURPOSE. `mcpe-sig.<base64url(url)>@mcpemails.com`.
// A stored draft whose HTML says `cid:` can therefore always be put right: if
// the image can be attached again it is, and if it cannot (the setting was
// switched off, the signature changed, the host is down) the reference goes
// back to the https URL it came from instead of staying a broken image.
//
// WHAT MAY BE FETCHED. Only a URL that is an `<img>` in THIS inbox's own stored
// signature (the caller passes that signature's markup). A `cid:` that decodes to anything else is never fetched, only
// turned back into its URL, so an agent cannot use `html_body` to make this
// server fetch a URL of its choosing. The fetch itself is guarded like every
// other caller-influenced destination here: https only, default port, the
// host-guard address policy on every resolved address and on every redirect
// hop, a raster allow-list checked against the bytes, and hard caps on size,
// count and time.
//
// KNOWN LIMIT. The guard approves the host's addresses and `fetch` then resolves
// the name again, so a record repointed between the two is dialled unchecked.
// What that buys is a TLS connect to an internal :443 that would have to
// present a valid certificate for the attacker's own name and answer with
// raster image bytes before anything came back. Deno's fetch cannot be pinned
// to an address without giving up certificate validation, which is worse.
//
// IT NEVER FAILS A SEND, AND NEVER HOLDS ONE UP FOR LONG. All images are
// fetched together under SIGNATURE_IMAGE_EMBED_DEADLINE_MS. Every failure leaves the https URL in place, which is
// exactly what went out before this existed.
//
// OUTLOOK is not covered: Graph takes structured attachments rather than MIME
// and none of its paths are wired. The caller does not invoke this there.
// ---------------------------------------------------------------------------

// Imports nothing from signature-compose.ts, which imports THIS module (for
// `restoreSignatureImageUrls`). The caller hands over the signature's markup.
import { guardMailHost, type HostLookup } from "./host-guard.ts";

/** One image part of a multipart/related body. */
export interface InlineImage {
  /** Content-ID without angle brackets; the HTML says `cid:<this>`. */
  cid: string;
  mimeType: string;
  /** Standard base64. */
  data: string;
}

export const SIGNATURE_CID_PREFIX = "mcpe-sig.";
export const SIGNATURE_CID_DOMAIN = "@mcpemails.com";

/** Longest URL we will carry in a Content-ID (the header line stays far under 998). */
export const SIGNATURE_IMAGE_MAX_URL_LENGTH = 600;
/** Images embedded per message. A signature with more keeps the rest remote. */
export const SIGNATURE_IMAGE_MAX_COUNT = 6;
/** One image. A logo is tens of kilobytes; this is every message's overhead. */
export const SIGNATURE_IMAGE_MAX_BYTES = 512 * 1024;
/** All images of one message together. */
export const SIGNATURE_IMAGE_MAX_TOTAL_BYTES = 1024 * 1024;
/** Whole fetch, redirects included. It sits on the send path. */
export const SIGNATURE_IMAGE_FETCH_TIMEOUT_MS = 4000;
/**
 * Everything `embedSignatureImages` may spend on one message: the images are
 * fetched together and whatever has not arrived by then stays remote. The
 * fetch timeout alone is not this bound, since a DNS lookup that hangs is
 * outside it and there can be several images.
 */
export const SIGNATURE_IMAGE_EMBED_DEADLINE_MS = 5000;
const MAX_REDIRECTS = 3;
const CACHE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 32;

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(text: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - text.length % 4) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * A URL this module is willing to embed, in its canonical form, or null.
 * https, default port, no credentials, bounded length.
 */
export function embeddableImageUrl(raw: string): string | null {
  if (raw.length > SIGNATURE_IMAGE_MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.port !== "" || url.username !== "" || url.password !== "") return null;
  if (url.href.length > SIGNATURE_IMAGE_MAX_URL_LENGTH) return null;
  return url.href;
}

/** The Content-ID (no brackets) for a signature image URL. */
export function signatureImageCid(url: string): string {
  return `${SIGNATURE_CID_PREFIX}${base64UrlEncode(url)}${SIGNATURE_CID_DOMAIN}`;
}

/** The https URL a Content-ID of ours stands for, or null for anyone else's. */
export function urlFromSignatureCid(cid: string): string | null {
  if (!cid.startsWith(SIGNATURE_CID_PREFIX) || !cid.endsWith(SIGNATURE_CID_DOMAIN)) return null;
  const decoded = base64UrlDecode(
    cid.slice(SIGNATURE_CID_PREFIX.length, cid.length - SIGNATURE_CID_DOMAIN.length),
  );
  return decoded === null ? null : embeddableImageUrl(decoded);
}

function decodeAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function encodeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Both patterns are written to stay LINEAR on hostile input, because they run
// over a caller-supplied `html_body`. `[^<>]` (not `[^>]`) means an unclosed
// `<img ` stops at the next tag instead of scanning to the end of the body
// from every one of them, and the length bound caps a single tag.
const IMG_TAG = /<img\b[^<>]{0,8192}>/gi;
// One attribute at a time, in order, so a `src=` that is only TEXT inside
// another attribute's value (alt="see src=...") is never taken for the real
// one. Rewriting that would close the quote early and turn the rest of the
// value into live attributes.
//
// Sticky: each match must start where the last one ended, and the walk stops
// at the first thing that is not an attribute. Unanchored, a long run of
// spaces was retried from every position in it.
const ATTRIBUTE = /\s+([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+)))?/y;

/** Where the real `src` attribute of one `<img …>` tag is, and what it says. */
function findSrc(tag: string): { start: number; end: number; value: string } | null {
  ATTRIBUTE.lastIndex = 4; // past "<img"
  for (let m = ATTRIBUTE.exec(tag); m !== null; m = ATTRIBUTE.exec(tag)) {
    if (m[1].toLowerCase() !== "src") continue;
    return {
      start: m.index,
      end: m.index + m[0].length,
      value: decodeAttribute(m[2] ?? m[3] ?? m[4] ?? "").trim(),
    };
  }
  return null;
}

/** The decoded `src` of one `<img …>` tag, or null when it has none. */
function srcOf(tag: string): string | null {
  return findSrc(tag)?.value ?? null;
}

function withSrc(tag: string, src: string): string {
  const found = findSrc(tag);
  if (!found) return tag;
  return `${tag.slice(0, found.start)} src="${encodeAttribute(src)}"${tag.slice(found.end)}`;
}

/**
 * Put every `cid:` reference of ours in `html` back to the https URL it stands
 * for. Pure. For code that handles a stored body as MARKUP rather than as a
 * message: the signature sanitizer allows https images only, so a signature
 * block lifted out of a stored draft has to be shown to it in this form (the
 * transport then embeds it again).
 */
export function restoreSignatureImageUrls(html: string): string {
  return html.replace(IMG_TAG, (tag) => {
    const src = srcOf(tag);
    if (src === null || !/^cid:/i.test(src)) return tag;
    const url = urlFromSignatureCid(src.slice(4));
    return url === null ? tag : withSrc(tag, url);
  });
}

/**
 * The image URLs of a signature, canonical, in document order. `signatureHtml`
 * is the sanitized markup `applySignature` appends (`composeSignatureBlocks`),
 * so what is matched in a body is what was written into it.
 */
export function signatureImageUrls(signatureHtml: string | null | undefined): string[] {
  if (!signatureHtml) return [];
  const urls: string[] = [];
  for (const tag of signatureHtml.match(IMG_TAG) ?? []) {
    const src = srcOf(tag);
    const url = src === null ? null : embeddableImageUrl(src);
    if (url !== null && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

export interface FetchedImage {
  mimeType: string;
  bytes: Uint8Array;
}

export interface EmbedSignatureImagesDeps {
  /** `inboxes.signature_embed_images`. Asked only when there is something to do. */
  enabled: () => Promise<boolean>;
  /** The guarded fetch. Null means "leave this one remote". */
  fetchImage: (url: string) => Promise<FetchedImage | null>;
  /** Test seam for SIGNATURE_IMAGE_EMBED_DEADLINE_MS. */
  deadlineMs?: number;
}

export interface EmbeddedHtml {
  html: string | undefined;
  inlineImages: InlineImage[];
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/**
 * Rewrite the signature's images in `html` to `cid:` references and return the
 * parts they name. Idempotent: HTML that already carries our `cid:` references
 * comes back with the same references and the same parts.
 *
 * Never throws.
 */
export async function embedSignatureImages(
  html: string | undefined,
  signatureHtml: string | null | undefined,
  deps: EmbedSignatureImagesDeps,
): Promise<EmbeddedHtml> {
  const unchanged: EmbeddedHtml = { html, inlineImages: [] };
  if (!html) return unchanged;
  try {
    const ownUrls = new Set(signatureImageUrls(signatureHtml));
    // The cheap way out, taken by almost every message: nothing of ours can be
    // in a body that names neither a cid of ours nor (for a signature that has
    // images at all) an https image. No tag is parsed before this.
    if (!html.includes(SIGNATURE_CID_PREFIX) && (ownUrls.size === 0 || !html.includes("https://"))) {
      return unchanged;
    }
    const tags = html.match(IMG_TAG);
    if (!tags) return unchanged;

    // What each <img> points at: an https URL of the signature, or one of our
    // cid references (whatever URL it decodes to).
    const target = (tag: string): { url: string; viaCid: boolean } | null => {
      const src = srcOf(tag);
      if (src === null) return null;
      if (/^cid:/i.test(src)) {
        const url = urlFromSignatureCid(src.slice(4));
        return url === null ? null : { url, viaCid: true };
      }
      const url = embeddableImageUrl(src);
      return url !== null && ownUrls.has(url) ? { url, viaCid: false } : null;
    };

    const wanted: string[] = [];
    let anyCid = false;
    for (const tag of tags) {
      const t = target(tag);
      if (!t) continue;
      if (t.viaCid) anyCid = true;
      if (ownUrls.has(t.url) && !wanted.includes(t.url)) wanted.push(t.url);
    }
    if (wanted.length === 0 && !anyCid) return unchanged;

    const enabled = await deps.enabled();
    const images = new Map<string, InlineImage>();
    if (enabled) {
      const urls = wanted.slice(0, SIGNATURE_IMAGE_MAX_COUNT);
      // Together, under one deadline. A fetch that loses the race is not
      // cancelled: it finishes into the fetcher's cache for the next message.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), deps.deadlineMs ?? SIGNATURE_IMAGE_EMBED_DEADLINE_MS);
      });
      const results = await Promise.all(urls.map((url) =>
        Promise.race([
          Promise.resolve().then(() => deps.fetchImage(url)).catch(() => null),
          deadline,
        ])
      ));
      clearTimeout(timer);
      let total = 0;
      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        const fetched = results[i];
        if (!fetched) continue;
        if (total + fetched.bytes.length > SIGNATURE_IMAGE_MAX_TOTAL_BYTES) continue;
        total += fetched.bytes.length;
        images.set(url, {
          cid: signatureImageCid(url),
          mimeType: fetched.mimeType,
          data: bytesToBase64(fetched.bytes),
        });
      }
    }

    const rewritten = html.replace(IMG_TAG, (tag) => {
      const t = target(tag);
      if (!t) return tag;
      const image = images.get(t.url);
      if (image) return withSrc(tag, `cid:${image.cid}`);
      // Not embedded. A cid of ours with no part behind it would be a broken
      // image, so it goes back to the URL it stands for.
      return t.viaCid ? withSrc(tag, t.url) : tag;
    });
    return { html: rewritten, inlineImages: [...images.values()] };
  } catch (error) {
    console.warn("[mcp-server] signature_image_embed_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return unchanged;
  }
}

// ---------------------------------------------------------------------------
// The guarded fetch
// ---------------------------------------------------------------------------

/** Raster types only, decided by the bytes. SVG can carry script and is never embedded. */
export function sniffImageType(bytes: Uint8Array): string | null {
  const at = (i: number) => bytes[i];
  if (bytes.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 && at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
    at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export interface SignatureImageFetcherOptions {
  /** Test seams. */
  fetch?: typeof fetch;
  lookup?: HostLookup;
  now?: () => number;
}

/**
 * Build the fetcher `embedSignatureImages` uses. One per isolate: it holds a
 * small cache, so a mailbox that sends ten messages fetches its logo once.
 */
export function createSignatureImageFetcher(
  options: SignatureImageFetcherOptions = {},
): (url: string) => Promise<FetchedImage | null> {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; image: FetchedImage | null }>();

  const hostAllowed = async (hostname: string): Promise<boolean> => {
    // The mail-host guard's ADDRESS policy is the one we want (every resolved
    // address public, every literal encoding understood). Its port rule is
    // about mail and is satisfied here with a constant; the URL's own port is
    // already pinned to 443 by `embeddableImageUrl`.
    const verdict = await guardMailHost(hostname, {
      protocol: "imap",
      port: 993,
      ...(options.lookup ? { lookup: options.lookup } : {}),
    });
    return verdict.ok;
  };

  const readCapped = async (resp: Response): Promise<Uint8Array | null> => {
    const declared = Number(resp.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > SIGNATURE_IMAGE_MAX_BYTES) {
      await resp.body?.cancel().catch(() => {});
      return null;
    }
    if (!resp.body) return null;
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > SIGNATURE_IMAGE_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  };

  const load = async (start: string): Promise<FetchedImage | null> => {
    const signal = AbortSignal.timeout(SIGNATURE_IMAGE_FETCH_TIMEOUT_MS);
    let current = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const safe = embeddableImageUrl(current);
      if (safe === null) return null;
      if (!(await hostAllowed(new URL(safe).hostname))) return null;
      const resp = await doFetch(safe, {
        redirect: "manual",
        signal,
        headers: { Accept: "image/png,image/jpeg,image/gif,image/webp" },
      });
      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get("location");
        await resp.body?.cancel().catch(() => {});
        if (!location) return null;
        current = new URL(location, safe).href;
        continue;
      }
      if (resp.status !== 200) {
        await resp.body?.cancel().catch(() => {});
        return null;
      }
      const bytes = await readCapped(resp);
      if (bytes === null) return null;
      const mimeType = sniffImageType(bytes);
      return mimeType === null ? null : { mimeType, bytes };
    }
    return null;
  };

  return async (url: string): Promise<FetchedImage | null> => {
    const hit = cache.get(url);
    if (hit && now() - hit.at < (hit.image ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS)) return hit.image;
    let image: FetchedImage | null = null;
    try {
      image = await load(url);
    } catch (error) {
      console.warn("[mcp-server] signature_image_fetch_failed", {
        host: (() => {
          try {
            return new URL(url).hostname;
          } catch {
            return null;
          }
        })(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
    cache.delete(url);
    cache.set(url, { at: now(), image });
    return image;
  };
}
