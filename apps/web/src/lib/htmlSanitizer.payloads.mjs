// ---------------------------------------------------------------------------
// The shared payload corpus.
//
// This file is imported by BOTH test suites: the Node one next to it and the
// Deno one at supabase/functions/mcp-server/html-sanitizer.test.ts, which reads
// it across the repo purely as a test fixture (nothing shipped imports it, so
// the edge bundle is untouched).
//
// One corpus, two runtimes, compared output-for-output. The two sanitizers are
// hand-ported twins, and a hand-ported twin drifts: the honest way to know they
// still agree is to run the same bytes through both and diff, not to read them
// side by side and believe it.
//
// Entries are [name, payload]. Add the payload that broke something, never just
// the fix for it.
// ---------------------------------------------------------------------------

/**
 * The confirmed bypasses of the regex deny-list this sanitizer replaced. Every
 * one of these was returned UNCHANGED by the old code, in production, on a
 * string handed to the model as `body_html`.
 */
export const BYPASS_PAYLOADS = [
  ["handler after a quote", '<img/src="https://a/b"onerror=alert(1)>'],
  ["leading space in scheme", '<a href=" javascript:alert(1)">click</a>'],
  ["entity-encoded scheme", '<a href="jav&#x61;script:alert(1)">click</a>'],
  ["style-based scheme", '<div style="background:url(javascript:alert(1))">x</div>'],
  ["strip-and-rescan splice", "<scr<script>ipt>alert(1)</script>"],
  ["unquoted external src", "<img src=https://evil.tld/pixel.gif>"],
  ["srcset second channel", '<img srcset="https://evil.tld/p.gif 1x" alt="x">'],
];

/** Every spelling of "load a remote image" we know of. */
export const EXTERNAL_SRC_PAYLOADS = [
  ["double-quoted https", '<img src="https://evil.tld/p.gif">'],
  ["single-quoted https", "<img src='https://evil.tld/p.gif'>"],
  ["unquoted https", "<img src=https://evil.tld/p.gif>"],
  ["unquoted http", "<img src=http://evil.tld/p.gif>"],
  ["uppercase attribute", '<IMG SRC="https://evil.tld/p.gif">'],
  ["whitespace around equals", '<img src = "https://evil.tld/p.gif">'],
  ["protocol-relative", '<img src="//evil.tld/p.gif">'],
  ["ftp", '<img src="ftp://evil.tld/p.gif">'],
  ["tab inside the scheme", '<img src="ht\ttps://evil.tld/p.gif">'],
  ["entity-encoded scheme", '<img src="htt&#x70;s://evil.tld/p.gif">'],
  ["srcset instead of src", '<img srcset="https://evil.tld/p.gif 2x">'],
  ["slash-separated attribute", '<img/src="https://evil.tld/p.gif">'],
  ["svg data URI", '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">'],
  ["background attribute", '<td background="https://evil.tld/p.gif">x</td>'],
];

/** Handlers, schemes, and container tricks that are not image-specific. */
export const GENERAL_PAYLOADS = [
  ["onclick double-quoted", '<p onclick="alert(1)">x</p>'],
  ["onclick uppercase", "<p ONCLICK=alert(1)>x</p>"],
  ["onclick spaced equals", "<p onclick = alert(1)>x</p>"],
  ["handler after newline", "<p\nonmouseover=alert(1)>x</p>"],
  ["img onerror", "<img src=x onerror=alert(1)>"],
  ["body onload", '<body onload="alert(1)">x</body>'],
  ["script then text", "<script>alert(1)</script>after"],
  ["style then text", "<style>body{background:url(javascript:alert(1))}</style>after"],
  ["iframe", '<iframe src="https://evil.tld"></iframe>after'],
  ["object", '<object data="https://evil.tld"></object>after'],
  ["form with input", '<form action="https://evil.tld"><input name=a></form>after'],
  ["svg with script", "<svg><script>alert(1)</script></svg>after"],
  ["noscript wrapper", "<noscript><img src=https://evil.tld/p.gif></noscript>after"],
  ["textarea smuggling", "<textarea><img src=x onerror=alert(1)></textarea>after"],
  ["title smuggling", "<title><img src=x onerror=alert(1)></title>after"],
  ["conditional comment", "a<!--[if IE]><script>alert(1)</script><![endif]-->b"],
  ["doctype", "<!DOCTYPE html><p>x</p>"],
  ["processing instruction", "<?xml version='1.0'?><p>x</p>"],
  ["data: html href", '<a href="data:text/html,<script>alert(1)</script>">x</a>'],
  ["vbscript href", '<a href="vbscript:msgbox(1)">x</a>'],
  ["file href", '<a href="file:///etc/passwd">x</a>'],
  ["mixed-case javascript", '<a href="jAvAsCrIpT:alert(1)">x</a>'],
  ["NUL inside scheme", '<a href="java\u0000script:alert(1)">x</a>'],
  ["decimal entity scheme", '<a href="&#106;avascript:alert(1)">x</a>'],
  ["unterminated quote", '<a href="x onmouseover=alert(1)>hello'],
  ["marquee unwrap", "<marquee>scrolling <custom-el>text</custom-el></marquee>"],
  ["unclosed nesting", "<div><p>one<p>two<div><span>three</div>"],
  ["stray lt", "5 < 6 & 7 > 3"],
  ["unknown entity", "&zzz;"],
  ["named entity", "caf&eacute;"],
  ["escaped amp", "A&amp;B"],
  ["style class id data", '<p style="color:red" class="x" id="y" data-z="1">text</p>'],
  ["orphan end tag", "</div>text"],
  ["bare lt", "<"],
  ["empty", ""],
  ["safe link", '<a href="https://example.com/x?a=1&amp;b=2">link</a>'],
  ["mailto", '<a href="mailto:a@b.com">m</a>'],
  ["cid image", '<img src="cid:logo@example" alt="Logo">'],
  ["https logo", '<img src="https://cdn.example.com/logo.png" alt="Acme">'],
  ["http logo", '<img src="http://cdn.example.com/logo.png">'],
  ["data png", '<img src="data:image/png;base64,iVBORw0KGgo=">'],
  [
    "real mail",
    '<div dir="ltr"><p>Hi <strong>Asgeir</strong>,</p>' +
      '<p>See the <a href="https://example.com/report">report</a>.</p>' +
      '<table><tbody><tr><td colspan="2">Q3</td><td>42</td></tr></tbody></table>' +
      "<blockquote>Previous message</blockquote></div>",
  ],
];

/**
 * Shapes taken from real mail in a live inbox (Google AdMob, PayPal, a Mailmojo
 * newsletter, a Zendesk receipt), reduced to the structures that actually
 * stress the tokenizer.
 *
 * These are here because the synthetic payloads all passed while two of these
 * did NOT: a `<tr>` opened while a `<td>` was still open produced different
 * output on a second pass. Bulk mail is written by template engines that leave
 * rows and cells unclosed and quote almost nothing, and no hand-written payload
 * had that shape.
 */
export const REAL_MAIL_PAYLOADS = [
  ["unquoted attrs everywhere", "<table role=presentation align=center border=0 width=100%><tbody><tr><td align=center valign=top style=\"padding-top:26px\" class=pd0><a target=_blank href=https://c.gle/AbCd style=text-decoration:none><img src=https://www.gstatic.com/logo.png width=204 style=\"display: block;\"></a></td></tr></tbody></table>"],
  ["unclosed td then new tr", "<table><tbody><tr><td>A<tr><td>B</table>"],
  ["unclosed td then new td", "<table><tbody><tr><td>A<td>B</tr></tbody></table>"],
  ["unclosed p run", "<div><p>one<p>two<p>three</div>"],
  ["href to a bare fragment", "<a href=# style=\"pointer-events: none;\">pub-1354741235649835</a>"],
  ["tracking pixel, unquoted", "<img src=https://www.gstatic.com/spacer.gif width=10 height=1>"],
  ["1x1 hidden pixel", "<img style=\"width:1px;height:1px;display:none!important;\" width=\"1\" height=\"1\"/>"],
  ["xml doctype + xmlns", "<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.0 Strict//EN\" \"http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd\"><html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>t</title></head><body><p>hi</p></body></html>"],
  ["mso conditional comment", "<!--[if !mso]><!--><p>shown</p><!--<![endif]-->"],
  ["nbsp and emoji", "<h3><span style=\"font-family:Arial\"><strong>Kykkeli ki,&nbsp;<span class=\"personalization\">Asgeir</span>!&nbsp;\u{1F413}</strong></span></h3>"],
  ["preheader hidden text", "<h4 id=\"preHeader\" style=\"display:none;color:#F5F7FA;font-size:0px\">hidden preheader</h4>"],
  ["table width percent", "<table width=\"100%\" bgcolor=\"#F5F7FA\"><tbody><tr><td width=\"640\" align=\"center\" valign=\"top\">x</td></tr></tbody></table>"],
];

/** Everything, flattened, for the cross-runtime parity comparison. */
export const ALL_PAYLOADS = [
  ...BYPASS_PAYLOADS,
  ...EXTERNAL_SRC_PAYLOADS,
  ...GENERAL_PAYLOADS,
  ...REAL_MAIL_PAYLOADS,
];
