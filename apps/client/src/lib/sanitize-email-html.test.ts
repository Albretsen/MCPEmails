import { describe, expect, it } from "vitest";
import {
  EMAIL_FRAME_CSP,
  EMAIL_FRAME_SANDBOX,
  EMAIL_HTML_MAX_LENGTH,
  buildEmailSrcdoc,
  sanitizeEmailHtml,
  sanitizeStyle,
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
