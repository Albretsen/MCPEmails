import { describe, expect, it } from "vitest";
import {
  EMAIL_FRAME_CSP,
  EMAIL_FRAME_SANDBOX,
  EMAIL_HTML_MAX_LENGTH,
  buildEmailSrcdoc,
  sanitizeEmailHtml,
  sanitizeStyle,
  stripTrailingImportant,
} from "./sanitize-email-html";

const clean = (html: string) => sanitizeEmailHtml(html).html;

describe("sanitizeEmailHtml", () => {
  it("keeps ordinary formatting", () => {
    expect(clean("<p>Hello <b>world</b></p><ul><li>one</li></ul>")).toBe("<p>Hello <b>world</b></p><ul><li>one</li></ul>");
  });

  it("drops scripts, styles and embedded documents with their content", () => {
    const out = clean(
      `<p>a</p><script>alert(1)</script><style>p{color:red}</style><iframe src="https://evil.test"></iframe><object data="x"></object><svg><script>alert(2)</script></svg><form><input name="x"><button>Go</button></form><p>b</p>`,
    );
    expect(out).toBe("<p>a</p><p>b</p>");
  });

  it("survives nested and broken script tags", () => {
    const out = clean(`<scr<script>ipt>alert(1)</scr</script>ipt><p>ok</p>`);
    expect(out).not.toMatch(/<script/i);
    expect(out).toContain("<p>ok</p>");
  });

  it("strips event handlers however they are quoted", () => {
    const out = clean(`<p onclick="x()" ONMOUSEOVER='y()' onload=z>hi</p><a href="https://a.test/"onclick="x()">l</a><img src=x onerror=alert(1)>`);
    expect(out).not.toMatch(/\son\w+=/i);
    expect(out).not.toContain("alert");
    expect(out).toContain("hi");
  });

  it("removes javascript:, data: and vbscript: links but keeps the text", () => {
    for (const href of [
      "javascript:alert(1)",
      " javascript:alert(1)",
      "java\tscript:alert(1)",
      "&#106;avascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:x",
      "//evil.test",
    ]) {
      const out = clean(`<a href="${href}">click</a>`);
      expect(out).toBe("<a>click</a>");
    }
  });

  it("keeps http, https and mailto links, with rel and target", () => {
    const out = clean(`<a href="https://example.com/a?b=1" target="_top" rel="opener">x</a><a href="mailto:a@b.co">m</a>`);
    const doc = new DOMParser().parseFromString(out, "text/html");
    const [a, m] = [...doc.querySelectorAll("a")];
    expect(a?.getAttribute("href")).toBe("https://example.com/a?b=1");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(m?.getAttribute("href")).toBe("mailto:a@b.co");
  });

  it("blocks remote images, counts them, and keeps the alt text", () => {
    const r = sanitizeEmailHtml(
      `<img src="https://t.test/pixel.gif" width="1" height="1"><img src="http://cdn.test/logo.png" alt="Acme logo"><img src="//cdn.test/x.png"><img srcset="https://cdn.test/y.png 2x">`,
    );
    expect(r.remoteImages).toBe(4);
    expect(r.html).not.toMatch(/<img/i);
    expect(r.html).not.toContain("cdn.test");
    expect(r.html).toContain("[image: Acme logo]");
    // The 1x1 tracking pixel leaves no placeholder behind.
    expect(r.html.match(/data-blocked-image/g)?.length).toBe(3);
  });

  it("keeps inline data images and does not count cid images as remote", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const r = sanitizeEmailHtml(`<img src="${png}" alt="dot"><img src="cid:logo@x"><img src="data:image/svg+xml;base64,PHN2Zz4=">`);
    expect(r.html).toContain(`<img src="${png}" alt="dot">`);
    expect(r.html).not.toContain("svg+xml");
    expect(r.html).not.toContain("cid:");
    expect(r.remoteImages).toBe(1);
  });

  it("drops class, id, data-* and aria-* attributes", () => {
    expect(clean(`<div class="x" id="y" data-z="1" aria-label="Send money" title="t">a</div>`)).toBe(`<div title="t">a</div>`);
  });

  it("unwraps unknown elements and keeps their text", () => {
    expect(clean("<article><custom-el>text</custom-el></article>")).toBe("text");
  });

  it("neutralises bidi overrides in text", () => {
    expect(clean("<p>invoice\u202efdp.exe</p>")).toBe("<p>invoicefdp.exe</p>");
  });

  it("filters inline styles to a safe subset", () => {
    const out = clean(
      `<p style="color: #333; background: url(https://t.test/p.gif); position: fixed; font-size: 14px; width: expression(alert(1))">x</p>`,
    );
    expect(out).toBe(`<p style="color: #333; font-size: 14px">x</p>`);
  });

  it("truncates oversized input", () => {
    const r = sanitizeEmailHtml(`<p>${"a".repeat(EMAIL_HTML_MAX_LENGTH + 10)}</p>`);
    expect(r.truncated).toBe(true);
    expect(r.html.length).toBeLessThanOrEqual(EMAIL_HTML_MAX_LENGTH + 16);
  });

  it("returns nothing for non-strings and empty input", () => {
    expect(sanitizeEmailHtml(null)).toEqual({ html: "", remoteImages: 0, truncated: false });
    expect(sanitizeEmailHtml("")).toEqual({ html: "", remoteImages: 0, truncated: false });
  });
});

describe("sanitizeStyle", () => {
  it("rejects anything that can fetch or escape", () => {
    expect(sanitizeStyle("background-color: red; background-image: url(x)")).toBe("background-color: red");
    expect(sanitizeStyle("color: var(--brand)")).toBe("");
    expect(sanitizeStyle("font-family: a\\62 c")).toBe("");
    expect(sanitizeStyle("display: flex; display: none")).toBe("display: none");
    expect(sanitizeStyle("color: red /* x */")).toBe("");
  });
});

describe("sanitizeStyle !important handling", () => {
  // The pre-2026-10-16 rule, kept as the oracle.
  const legacy = (value: string) => value.replace(/\s*!important$/i, "");
  it("strips a trailing !important exactly as the old regex did", () => {
    expect(sanitizeStyle("color: red !important")).toBe("color: red");
    expect(sanitizeStyle("color: red!IMPORTANT")).toBe("color: red");
    expect(sanitizeStyle("color: red \u00a0\t !Important")).toBe("color: red");
    expect(sanitizeStyle("color: red !important; font-weight: bold")).toBe("color: red; font-weight: bold");
    expect(sanitizeStyle("color: !important")).toBe("");
    expect(sanitizeStyle("color: red !importantx")).toBe("color: red !importantx");
  });
  it("matches the old regex on random values", () => {
    const pieces = [" ", "\t", "\u00a0", "\u3000", "!", "important", "IMPORTANT", "!important", "red", "x", "İ", "K"];
    let seed = 12345;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
    for (let round = 0; round < 5000; round++) {
      let value = "";
      const count = 1 + Math.floor(rnd() * 8);
      for (let i = 0; i < count; i++) value += pieces[Math.floor(rnd() * pieces.length)];
      expect(stripTrailingImportant(value)).toBe(legacy(value));
      expect(stripTrailingImportant(value.trim())).toBe(legacy(value.trim()));
    }
  });
  it("is linear on long whitespace runs", () => {
    const value = "color: a" + " ".repeat(4000) + "b";
    const started = performance.now();
    for (let i = 0; i < 200; i++) sanitizeStyle(value);
    // The old regex took ~20 ms per call here, 4 s for 200.
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("email frame", () => {
  it("never allows scripts in the sandbox", () => {
    expect(EMAIL_FRAME_SANDBOX).not.toContain("allow-scripts");
    expect(EMAIL_FRAME_SANDBOX).not.toContain("allow-top-navigation");
    expect(EMAIL_FRAME_SANDBOX.split(" ").sort()).toEqual(["allow-popups", "allow-popups-to-escape-sandbox", "allow-same-origin"]);
  });

  it("builds a document with the strict CSP and a _blank base", () => {
    const doc = buildEmailSrcdoc("<p>hi</p>");
    expect(EMAIL_FRAME_CSP).toBe("default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'");
    expect(doc).toContain(`<meta http-equiv="Content-Security-Policy" content="${EMAIL_FRAME_CSP}">`);
    expect(doc).toContain(`<base target="_blank">`);
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<style>"));
    expect(doc).toContain("<body><p>hi</p></body>");
  });
});
