// ---------------------------------------------------------------------------
// Embedded signature images.
//
// The request this was built for, 2026-10-13: a signature logo hosted on the
// customer's own site did not show when a draft written here was opened in
// Thunderbird or Outlook, because those clients do not load remote images.
// With `inboxes.signature_embed_images` on, the logo travels inside the
// message instead.
//
// What is held in place below:
//   * the message that comes out is the shape mail clients resolve `cid:`
//     against, and our own readers do not start calling the logo an attachment;
//   * nothing but the inbox's own signature image is ever fetched, and the
//     fetch refuses everything that is not a small public raster image;
//   * a failure of any kind leaves the https URL, which is what went out
//     before the feature existed;
//   * a draft that already says `cid:` (the editor rebuilds from stored HTML)
//     gets its image back, or its URL back, never a broken reference.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  createSignatureImageFetcher,
  embeddableImageUrl,
  embedSignatureImages,
  type FetchedImage,
  restoreSignatureImageUrls,
  SIGNATURE_IMAGE_MAX_BYTES,
  SIGNATURE_IMAGE_MAX_COUNT,
  signatureImageCid,
  signatureImageUrls,
  sniffImageType,
  urlFromSignatureCid,
} from "./signature-images.ts";
import { buildDraftMime, buildMimeMessage } from "./mime-build.ts";
import { parseEmail, parseEmailJoined } from "./mime.ts";
import {
  applySignature,
  composeSignatureBlocks,
  rebuildHtmlKeepingSignature,
} from "./signature-compose.ts";
import { sanitizeEmailHtml } from "./signature-sanitizer.ts";

const LOGO = "https://www.example-shop.de/wp-content/uploads/2021/01/logo.png";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);
const PNG_B64 = btoa(String.fromCharCode(...PNG));

const INBOX = {
  signature_enabled: true,
  signature_text: "Example Shop\nKassel",
  signature_html:
    `<div style="font-family: Arial">Example Shop<br>Kassel<div><a href="https://www.example-shop.de"><img src="${LOGO}" alt="Example Shop" width="264" height="213" style="display: block; border: 0"></a></div></div>`,
};
const SIG_HTML = composeSignatureBlocks(INBOX)!.html;

function deps(over: {
  enabled?: boolean;
  images?: Record<string, FetchedImage | null>;
  calls?: string[];
} = {}) {
  const calls = over.calls ?? [];
  return {
    enabled: () => Promise.resolve(over.enabled ?? true),
    fetchImage: (url: string) => {
      calls.push(url);
      const images = over.images ?? { [LOGO]: { mimeType: "image/png", bytes: PNG } };
      return Promise.resolve(images[url] ?? null);
    },
  };
}

type Body = { textBody: string; htmlBody?: string };

function sign(textBody: string): Body {
  return applySignature<Body>({ textBody }, INBOX);
}

function signedBody(): string {
  return sign("Hello Anna,\n\nsee attached.").htmlBody!;
}

// ── the cid ────────────────────────────────────────────────────────────────

Deno.test("a signature cid round-trips to its URL", () => {
  const cid = signatureImageCid(LOGO);
  assert(/^mcpe-sig\.[A-Za-z0-9_-]+@mcpemails\.com$/.test(cid), cid);
  assertEquals(urlFromSignatureCid(cid), LOGO);
});

Deno.test("somebody else's cid is not ours", () => {
  assertEquals(urlFromSignatureCid("logo@brand"), null);
  assertEquals(urlFromSignatureCid("mcpe-sig.!!!@mcpemails.com"), null);
  // Decodes, but to something we would never embed.
  const http = signatureImageCid("http://example.com/a.png");
  assertEquals(urlFromSignatureCid(http), null);
  const js = signatureImageCid("javascript:alert(1)");
  assertEquals(urlFromSignatureCid(js), null);
});

Deno.test("only plain https URLs on the default port are embeddable", () => {
  assertEquals(embeddableImageUrl(LOGO), LOGO);
  assertEquals(embeddableImageUrl("http://example.com/a.png"), null);
  assertEquals(embeddableImageUrl("https://example.com:8443/a.png"), null);
  assertEquals(embeddableImageUrl("https://user:pw@example.com/a.png"), null);
  assertEquals(embeddableImageUrl("data:image/png;base64,AAAA"), null);
  assertEquals(embeddableImageUrl("not a url"), null);
  assertEquals(embeddableImageUrl("https://example.com/" + "a".repeat(700)), null);
});

Deno.test("the signature's image URLs are read off its own markup", () => {
  assertEquals(signatureImageUrls(SIG_HTML), [LOGO]);
  assertEquals(signatureImageUrls(null), []);
  assertEquals(signatureImageUrls("<p>no image</p>"), []);
});

// ── embedding ──────────────────────────────────────────────────────────────

Deno.test("the signature logo becomes a cid reference with its part", async () => {
  const out = await embedSignatureImages(signedBody(), SIG_HTML, deps());
  assertEquals(out.inlineImages.length, 1);
  assertEquals(out.inlineImages[0], {
    cid: signatureImageCid(LOGO),
    mimeType: "image/png",
    data: PNG_B64,
  });
  assertStringIncludes(out.html!, `src="cid:${signatureImageCid(LOGO)}"`);
  assert(!out.html!.includes(LOGO), "the remote URL is gone from the img");
  // Everything else about the tag survives.
  assertStringIncludes(out.html!, 'alt="Example Shop" width="264" height="213"');
  assertStringIncludes(out.html!, '<a href="https://www.example-shop.de">');
});

Deno.test("off means off: nothing fetched, nothing changed", async () => {
  const calls: string[] = [];
  const body = signedBody();
  const out = await embedSignatureImages(body, SIG_HTML, deps({ enabled: false, calls }));
  assertEquals(out.html, body);
  assertEquals(out.inlineImages, []);
  assertEquals(calls, []);
});

Deno.test("a body with no signature image asks nothing and costs nothing", async () => {
  let asked = false;
  const out = await embedSignatureImages("<p>Hello <img src=\"https://other.example/x.png\"></p>", SIG_HTML, {
    enabled: () => {
      asked = true;
      return Promise.resolve(true);
    },
    fetchImage: () => {
      throw new Error("must not fetch");
    },
  });
  assertEquals(asked, false);
  assertEquals(out.inlineImages, []);
  assertStringIncludes(out.html!, "https://other.example/x.png");
});

Deno.test("no html, no work", async () => {
  assertEquals(await embedSignatureImages(undefined, SIG_HTML, deps()), { html: undefined, inlineImages: [] });
  assertEquals(await embedSignatureImages("", SIG_HTML, deps()), { html: "", inlineImages: [] });
});

Deno.test("an image the caller put in html_body is never fetched", async () => {
  const calls: string[] = [];
  const body = `<p><img src="https://internal.example/secret.png"></p>${signedBody()}`;
  const out = await embedSignatureImages(body, SIG_HTML, deps({ calls }));
  assertEquals(calls, [LOGO]);
  assertStringIncludes(out.html!, 'src="https://internal.example/secret.png"');
});

Deno.test("a forged cid cannot make the server fetch a URL of the caller's choosing", async () => {
  const calls: string[] = [];
  const forged = signatureImageCid("https://169.254.169.254/latest/meta-data");
  const out = await embedSignatureImages(`<img src="cid:${forged}">`, SIG_HTML, deps({ calls }));
  assertEquals(calls, []);
  assertEquals(out.inlineImages, []);
  // It is turned back into the plain URL it claims to be, like any other img.
  assertEquals(out.html, `<img src="https://169.254.169.254/latest/meta-data">`);
});

Deno.test("a failed fetch leaves the https URL, exactly as before the feature", async () => {
  const body = signedBody();
  const out = await embedSignatureImages(body, SIG_HTML, deps({ images: { [LOGO]: null } }));
  assertEquals(out.html, body);
  assertEquals(out.inlineImages, []);
});

Deno.test("a throwing fetch or a throwing flag read never fails the send", async () => {
  const body = signedBody();
  const thrown = await embedSignatureImages(body, SIG_HTML, {
    enabled: () => Promise.resolve(true),
    fetchImage: () => Promise.reject(new Error("boom")),
  });
  assertEquals(thrown.html, body);
  const flag = await embedSignatureImages(body, SIG_HTML, {
    enabled: () => Promise.reject(new Error("db down")),
    fetchImage: () => Promise.resolve({ mimeType: "image/png", bytes: PNG }),
  });
  assertEquals(flag, { html: body, inlineImages: [] });
});

Deno.test("the same logo twice is one part", async () => {
  const calls: string[] = [];
  const body = `${signedBody()}<img src="${LOGO}">`;
  const out = await embedSignatureImages(body, SIG_HTML, deps({ calls }));
  assertEquals(calls, [LOGO]);
  assertEquals(out.inlineImages.length, 1);
  assertEquals(out.html!.split(`cid:${signatureImageCid(LOGO)}`).length - 1, 2);
});

Deno.test("an ampersand in the URL survives the attribute round trip", async () => {
  const url = "https://cdn.example.com/logo.png?w=200&h=80";
  const sig = `<img src="https://cdn.example.com/logo.png?w=200&amp;h=80" alt="x">`;
  assertEquals(signatureImageUrls(sig), [url]);
  const out = await embedSignatureImages(`<p>Hi</p>${sig}`, sig, deps({
    images: { [url]: { mimeType: "image/png", bytes: PNG } },
  }));
  assertEquals(out.inlineImages.length, 1);
  assertEquals(urlFromSignatureCid(out.inlineImages[0].cid), url);
  // And back again, entity-encoded as it was.
  assertEquals(restoreSignatureImageUrls(out.html!), `<p>Hi</p>${sig}`);
});

Deno.test("a src= that is only text inside another attribute is not the src", async () => {
  // Rewriting the first ` src=` found would close alt's quote early and turn
  // the rest of its value into live attributes.
  const tricky = `<img alt="x src=${LOGO} onerror=alert(1)" src="${LOGO}">`;
  const out = await embedSignatureImages(tricky, SIG_HTML, deps());
  assertEquals(out.html, `<img alt="x src=${LOGO} onerror=alert(1)" src="cid:${signatureImageCid(LOGO)}">`);
  const noSrc = `<img alt="x src=${LOGO}">`;
  assertEquals((await embedSignatureImages(noSrc, SIG_HTML, deps())).html, noSrc);
  // Quote styles and case.
  const single = await embedSignatureImages(`<IMG SRC='${LOGO}' width=10>`, SIG_HTML, deps());
  assertEquals(single.html, `<IMG src="cid:${signatureImageCid(LOGO)}" width=10>`);
  const bare = await embedSignatureImages(`<img src=${LOGO}>`, SIG_HTML, deps());
  assertEquals(bare.html, `<img src="cid:${signatureImageCid(LOGO)}">`);
});

Deno.test("hostile markup is scanned in linear time, with or without a signature", async () => {
  // Each of these took seconds when the patterns could be retried from every
  // position: a run of spaces inside a tag, and a body of unclosed tags.
  const spaces = `<img${" ".repeat(200_000)}>` + `<img src="${LOGO}">`;
  const unclosed = "<img ".repeat(100_000) + `<img src="${LOGO}">`;
  for (const body of [spaces, unclosed]) {
    for (const sig of [SIG_HTML, null]) {
      const started = performance.now();
      const out = await embedSignatureImages(body, sig, deps());
      const elapsed = performance.now() - started;
      assert(elapsed < 500, `took ${Math.round(elapsed)}ms`);
      assertEquals(out.inlineImages.length, sig ? 1 : 0);
    }
    const started = performance.now();
    restoreSignatureImageUrls(body);
    assert(performance.now() - started < 500);
  }
});

Deno.test("a body with no https and no cid of ours is not parsed at all", async () => {
  let asked = false;
  const body = "<p>plain</p><img src=\"data:image/png;base64,AAAA\">";
  const out = await embedSignatureImages(body, SIG_HTML, {
    enabled: () => {
      asked = true;
      return Promise.resolve(true);
    },
    fetchImage: () => Promise.reject(new Error("must not fetch")),
  });
  assertEquals(out.html, body);
  assertEquals(asked, false);
});

Deno.test("a slow image host cannot hold a send: one deadline for all images, fetched together", async () => {
  const urls = [0, 1, 2].map((i) => `https://cdn.example.com/${i}.png`);
  const sig = urls.map((u) => `<img src="${u}">`).join("");
  const timers: ReturnType<typeof setTimeout>[] = [];
  let inFlight = 0;
  let peak = 0;
  const started = performance.now();
  const out = await embedSignatureImages(sig, sig, {
    enabled: () => Promise.resolve(true),
    deadlineMs: 50,
    fetchImage: (url) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // The first answers at once, the others hang far past the deadline.
      if (url === urls[0]) return Promise.resolve({ mimeType: "image/png", bytes: PNG });
      return new Promise((resolve) => {
        timers.push(setTimeout(() => resolve({ mimeType: "image/png", bytes: PNG }), 10_000));
      });
    },
  });
  const elapsed = performance.now() - started;
  timers.forEach(clearTimeout);
  assert(elapsed < 1000, `took ${Math.round(elapsed)}ms`);
  assertEquals(peak, 3, "all three were started together");
  assertEquals(out.inlineImages.map((i) => urlFromSignatureCid(i.cid)), [urls[0]]);
  assertStringIncludes(out.html!, `src="${urls[1]}"`);
  assertStringIncludes(out.html!, `src="${urls[2]}"`);
});

Deno.test("count and total size are capped; the rest stay remote", async () => {
  const urls = Array.from({ length: SIGNATURE_IMAGE_MAX_COUNT + 2 }, (_, i) => `https://cdn.example.com/${i}.png`);
  const sig = urls.map((u) => `<img src="${u}">`).join("");
  const out = await embedSignatureImages(sig, sig, deps({
    images: Object.fromEntries(urls.map((u) => [u, { mimeType: "image/png", bytes: PNG }])),
  }));
  assertEquals(out.inlineImages.length, SIGNATURE_IMAGE_MAX_COUNT);
  assertStringIncludes(out.html!, `src="${urls[urls.length - 1]}"`);

  const big = new Uint8Array(600 * 1024);
  const two = `<img src="${urls[0]}"><img src="${urls[1]}">`;
  const capped = await embedSignatureImages(two, two, deps({
    images: { [urls[0]]: { mimeType: "image/png", bytes: big }, [urls[1]]: { mimeType: "image/png", bytes: big } },
  }));
  assertEquals(capped.inlineImages.length, 1);
  assertStringIncludes(capped.html!, `src="${urls[1]}"`);
});

// ── a body that already says cid: (the editor's rebuild) ───────────────────

Deno.test("embedding is idempotent over its own output", async () => {
  const first = await embedSignatureImages(signedBody(), SIG_HTML, deps());
  const second = await embedSignatureImages(first.html, SIG_HTML, deps());
  assertEquals(second, first);
});

Deno.test("a stored cid goes back to its URL when the setting is off", async () => {
  const body = signedBody();
  const first = await embedSignatureImages(body, SIG_HTML, deps());
  const off = await embedSignatureImages(first.html, SIG_HTML, deps({ enabled: false }));
  assertEquals(off.html, body);
  assertEquals(off.inlineImages, []);
});

Deno.test("a stored cid goes back to its URL when the image cannot be had", async () => {
  const body = signedBody();
  const first = await embedSignatureImages(body, SIG_HTML, deps());
  const down = await embedSignatureImages(first.html, SIG_HTML, deps({ images: { [LOGO]: null } }));
  assertEquals(down.html, body);
  // The signature changed since: the old logo is no longer ours to fetch.
  const calls: string[] = [];
  const changed = await embedSignatureImages(first.html, "<p>new signature</p>", deps({ calls }));
  assertEquals(changed.html, body);
  assertEquals(calls, []);
});

Deno.test("the editor's rebuild keeps the logo: cid is restored before the signature is re-sanitised", async () => {
  const stored = await embedSignatureImages(signedBody(), SIG_HTML, deps());
  const storedText = sign("Hello Anna,\n\nsee attached.").textBody;
  const editedText = storedText.replace("see attached.", "see the attached offer.");
  const rebuilt = rebuildHtmlKeepingSignature(editedText, INBOX, stored.html, storedText);
  assert(rebuilt !== null);
  assertStringIncludes(rebuilt!, "see the attached offer.");
  assertStringIncludes(rebuilt!, `src="${LOGO}"`);
  // ...and the transport then embeds it again.
  const again = await embedSignatureImages(rebuilt!, SIG_HTML, deps());
  assertEquals(again.inlineImages.length, 1);
  assertStringIncludes(again.html!, `cid:${signatureImageCid(LOGO)}`);
});

Deno.test("restoring leaves other people's cid images alone", () => {
  const html = `<img src="cid:logo@brand"><img src="cid:${signatureImageCid(LOGO)}">`;
  assertEquals(restoreSignatureImageUrls(html), `<img src="cid:logo@brand"><img src="${LOGO}">`);
});

// ── the message ────────────────────────────────────────────────────────────

const BASE = {
  from: "Example Shop <info@example-shop.de>",
  to: ["anna@example.org"],
  subject: "Offer",
  messageId: "11111111-1111-1111-1111-111111111111",
};

Deno.test("the html part becomes multipart/related inside the alternative", async () => {
  const signed = sign("Hello Anna");
  const embedded = await embedSignatureImages(signed.htmlBody, SIG_HTML, deps());
  const mime = buildMimeMessage({
    ...BASE,
    textBody: signed.textBody,
    htmlBody: embedded.html,
    inlineImages: embedded.inlineImages,
  });
  const order = [
    "Content-Type: multipart/alternative;",
    "Content-Type: text/plain; charset=UTF-8",
    'Content-Type: multipart/related; type="text/html";',
    "Content-Type: text/html; charset=UTF-8",
    "Content-Type: image/png",
    `Content-ID: <${signatureImageCid(LOGO)}>`,
    "Content-Disposition: inline",
  ];
  let at = -1;
  for (const marker of order) {
    const next = mime.indexOf(marker, at + 1);
    assert(next > at, `${marker} is missing or out of order`);
    at = next;
  }
  // No name anywhere on the image part: a name is what makes a part an
  // attachment to our own readers.
  assert(!/filename=/i.test(mime) && !/name="/i.test(mime), "the logo part carries no filename");
  assert(mime.split("\r\n").every((line) => line.length <= 998), "no over-long line");

  const parsed = parseEmail(mime);
  assertEquals(parsed.attachments.length, 0);
  assertStringIncludes(parsed.html!, `cid:${signatureImageCid(LOGO)}`);
  assertStringIncludes(parsed.text!, "Hello Anna");
  const joined = parseEmailJoined(mime, (h) => h);
  assertEquals(joined.attachments.length, 0);
  assertStringIncludes(joined.html!, `cid:${signatureImageCid(LOGO)}`);
  // What a reader of the draft gets back still names the image.
  assertStringIncludes(sanitizeEmailHtml(parsed.html!), `cid:${signatureImageCid(LOGO)}`);
});

Deno.test("with real attachments the related sits inside the mixed, and only the file is an attachment", async () => {
  const signed = sign("Hello Anna");
  const embedded = await embedSignatureImages(signed.htmlBody, SIG_HTML, deps());
  const mime = buildMimeMessage({
    ...BASE,
    textBody: signed.textBody,
    htmlBody: embedded.html,
    inlineImages: embedded.inlineImages,
    attachments: [{ filename: "offer.pdf", mimeType: "application/pdf", data: btoa("%PDF-1.4") }],
  });
  assert(mime.indexOf("multipart/mixed") < mime.indexOf("multipart/alternative"));
  assert(mime.indexOf("multipart/alternative") < mime.indexOf("multipart/related"));
  const parsed = parseEmail(mime);
  assertEquals(parsed.attachments.map((a) => a.filename), ["offer.pdf"]);
  assertStringIncludes(parsed.html!, `cid:${signatureImageCid(LOGO)}`);
});

Deno.test("no inline images, no change: the message is what it always was", () => {
  const realUuid = crypto.randomUUID;
  try {
    crypto.randomUUID = () => "00000000-0000-0000-0000-000000000000";
    const realNow = Date.prototype.toUTCString;
    Date.prototype.toUTCString = () => "Tue, 13 Oct 2026 18:00:00 GMT";
    try {
      const a = buildMimeMessage({ ...BASE, textBody: "t", htmlBody: "<p>t</p>" });
      const b = buildMimeMessage({ ...BASE, textBody: "t", htmlBody: "<p>t</p>", inlineImages: [] });
      assertEquals(a, b);
      assert(!a.includes("multipart/related"));
      // Without an HTML body there is nothing to reference them, so none are written.
      const textOnly = buildMimeMessage({
        ...BASE,
        textBody: "t",
        inlineImages: [{ cid: "x@y", mimeType: "image/png", data: PNG_B64 }],
      });
      assert(!textOnly.includes("Content-ID"));
    } finally {
      Date.prototype.toUTCString = realNow;
    }
  } finally {
    crypto.randomUUID = realUuid;
  }
});

Deno.test("a draft carries the image too, and a hostile cid cannot inject a header", () => {
  const mime = buildDraftMime({
    ...BASE,
    to: [],
    textBody: "t",
    htmlBody: '<img src="cid:a@b">',
    inlineImages: [{ cid: "a@b>\r\nBcc: evil@example.com", mimeType: "image/png\r\nX-Evil: 1", data: PNG_B64 }],
  });
  assert(!/^Bcc:/m.test(mime));
  assert(!/^X-Evil:/m.test(mime));
  assertStringIncludes(mime, "multipart/related");
});

// ── the guarded fetch ──────────────────────────────────────────────────────

const PUBLIC = () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]);

function imageResponse(bytes: Uint8Array, init: ResponseInit = {}): Response {
  return new Response(bytes.slice().buffer, { status: 200, ...init });
}

Deno.test("fetches a small public png and sniffs its type from the bytes", async () => {
  const seen: Array<{ url: string; redirect?: string }> = [];
  const fetcher = createSignatureImageFetcher({
    lookup: PUBLIC,
    fetch: ((url: string, init?: RequestInit) => {
      seen.push({ url, redirect: init?.redirect });
      // The server's own label is not trusted.
      return Promise.resolve(imageResponse(PNG, { headers: { "content-type": "text/plain" } }));
    }) as typeof fetch,
  });
  const image = await fetcher(LOGO);
  assertEquals(image?.mimeType, "image/png");
  assertEquals(image?.bytes, PNG);
  assertEquals(seen, [{ url: LOGO, redirect: "manual" }]);
});

Deno.test("a second send reuses the fetched logo", async () => {
  let hits = 0;
  let clock = 0;
  const fetcher = createSignatureImageFetcher({
    lookup: PUBLIC,
    now: () => clock,
    fetch: (() => {
      hits++;
      return Promise.resolve(imageResponse(PNG));
    }) as typeof fetch,
  });
  await fetcher(LOGO);
  await fetcher(LOGO);
  assertEquals(hits, 1);
  clock = 11 * 60 * 1000;
  await fetcher(LOGO);
  assertEquals(hits, 2);
});

Deno.test("a failure is remembered briefly, then tried again", async () => {
  let hits = 0;
  let clock = 0;
  const fetcher = createSignatureImageFetcher({
    lookup: PUBLIC,
    now: () => clock,
    fetch: (() => {
      hits++;
      return Promise.resolve(new Response("nope", { status: 503 }));
    }) as typeof fetch,
  });
  assertEquals(await fetcher(LOGO), null);
  assertEquals(await fetcher(LOGO), null);
  assertEquals(hits, 1);
  clock = 5 * 60 * 1000 + 1;
  await fetcher(LOGO);
  assertEquals(hits, 2);
});

Deno.test("refuses anything that is not a raster image: svg, html, empty", async () => {
  for (const body of ['<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>', "<html></html>", ""]) {
    const fetcher = createSignatureImageFetcher({
      lookup: PUBLIC,
      fetch: (() =>
        Promise.resolve(
          new Response(body, { status: 200, headers: { "content-type": "image/png" } }),
        )) as typeof fetch,
    });
    assertEquals(await fetcher(LOGO), null, body);
  }
  assertEquals(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assertEquals(sniffImageType(new TextEncoder().encode("GIF89a...")), "image/gif");
  assertEquals(sniffImageType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assertEquals(sniffImageType(new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt ")), null);
});

Deno.test("refuses an oversized image, declared or not", async () => {
  const big = new Uint8Array(SIGNATURE_IMAGE_MAX_BYTES + 1);
  big.set(PNG);
  const declared = createSignatureImageFetcher({
    lookup: PUBLIC,
    fetch: (() =>
      Promise.resolve(
        new Response("x", { status: 200, headers: { "content-length": String(big.length) } }),
      )) as typeof fetch,
  });
  assertEquals(await declared(LOGO), null);
  const streamed = createSignatureImageFetcher({
    lookup: PUBLIC,
    fetch: (() => Promise.resolve(imageResponse(big))) as typeof fetch,
  });
  assertEquals(await streamed(LOGO), null);
});

Deno.test("never dials a private address: literal, resolved, or every encoding of one", async () => {
  let dialled = 0;
  const count = (() => {
    dialled++;
    return Promise.resolve(imageResponse(PNG));
  }) as typeof fetch;
  const literal = createSignatureImageFetcher({ fetch: count, lookup: PUBLIC });
  for (
    const url of [
      "https://127.0.0.1/a.png",
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.5/a.png",
      "https://[::1]/a.png",
      "https://2130706433/a.png",
      "https://0x7f.0.0.1/a.png",
      "https://localhost/a.png",
    ]
  ) {
    assertEquals(await literal(url), null, url);
  }
  const rebound = createSignatureImageFetcher({
    fetch: count,
    lookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }]),
  });
  assertEquals(await rebound(LOGO), null);
  const nxdomain = createSignatureImageFetcher({
    fetch: count,
    lookup: () => Promise.reject(new Error("NXDOMAIN")),
  });
  assertEquals(await nxdomain(LOGO), null);
  assertEquals(dialled, 0);
});

Deno.test("a redirect is followed by hand, and not into a private address or off https", async () => {
  const hops: string[] = [];
  const to = (location: string) =>
    createSignatureImageFetcher({
      lookup: (host) =>
        Promise.resolve([{ address: host === "internal.example" ? "192.168.1.10" : "93.184.216.34", family: 4 }]),
      fetch: ((url: string) => {
        hops.push(url);
        return Promise.resolve(
          url === LOGO
            ? new Response(null, { status: 302, headers: { location } })
            : imageResponse(PNG),
        );
      }) as typeof fetch,
    });

  assertEquals((await to("https://cdn.example.com/logo.png")(LOGO))?.mimeType, "image/png");
  assertEquals(hops, [LOGO, "https://cdn.example.com/logo.png"]);

  hops.length = 0;
  assertEquals(await to("https://internal.example/logo.png")(LOGO), null);
  assertEquals(await to("http://cdn.example.com/logo.png")(LOGO), null);
  assertEquals(await to("https://cdn.example.com:8080/logo.png")(LOGO), null);
  // Only the first hop was ever requested in the three refusals.
  assertEquals(hops, [LOGO, LOGO, LOGO]);
});

Deno.test("a redirect loop ends", async () => {
  let hits = 0;
  const fetcher = createSignatureImageFetcher({
    lookup: PUBLIC,
    fetch: (() => {
      hits++;
      return Promise.resolve(new Response(null, { status: 302, headers: { location: LOGO } }));
    }) as typeof fetch,
  });
  assertEquals(await fetcher(LOGO), null);
  assertEquals(hits, 4);
});

Deno.test("a fetch that throws is a miss, not an error", async () => {
  const fetcher = createSignatureImageFetcher({
    lookup: PUBLIC,
    fetch: (() => Promise.reject(new Error("connection reset"))) as typeof fetch,
  });
  assertEquals(await fetcher(LOGO), null);
});
