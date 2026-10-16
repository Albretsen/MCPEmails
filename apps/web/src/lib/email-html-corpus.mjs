// ---------------------------------------------------------------------------
// A corpus of realistic inbound HTML email bodies.
//
// Shared test fixture, like sanitizer-payloads.mjs next to it: the Node
// sanitizer suite reads it here, and the Deno suites (text-extract and
// signature-sanitizer) import it across the repo. Nothing shipped imports it.
//
// Purpose: golden-output tests. The expected outputs in
// email-html-corpus.golden.json (sanitizers) and
// supabase/functions/mcp-server/text-extract.golden.json (stripHtmlToText)
// were captured from the code as it was BEFORE the 2026-10-16 linear-time
// rewrites, so any byte that changes on real-shaped mail fails a test.
//
// Every entry is the SHAPE of real mail (newsletter tables, Office HTML, Gmail
// and Outlook reply quoting, CJK and RTL prose, receipts, OTP codes), written
// for this file. No real message, address or person is reproduced here.
//
// Entries are [name, html]. Append; never edit an entry in place, or its
// golden values stop meaning "what the old code produced".
// ---------------------------------------------------------------------------

const PREHEADER_PAD = "&#847;&zwnj;&nbsp;".repeat(40);

export const EMAIL_HTML_CORPUS = [
  [
    "newsletter: table layout, MSO comments, preheader padding",
    `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>The Weekly Digest</title>
<!--[if gte mso 9]><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<style type="text/css">
  body { margin:0; padding:0; }
  @media only screen and (max-width:600px) { .wrapper > td { display:block !important; width:100% !important; } }
  a[x-apple-data-detectors] { color: inherit !important; }
</style>
<!--[if mso]><style>.fallback-font { font-family: Arial, sans-serif; }</style><![endif]-->
</head>
<body style="margin:0;padding:0;background:#f4f4f4;">
<div style="display:none;max-height:0;overflow:hidden;">Five things worth reading this week ${PREHEADER_PAD}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td align="center" style="padding:20px 0;">
      <a href="https://news.example.com/view?id=abc123&amp;utm_source=email" style="color:#888;font-size:12px;">View in browser</a>
    </td>
  </tr>
  <tr class="wrapper">
    <td style="padding:0 24px;">
      <a href="https://news.example.com/?utm_source=email"><img src="https://cdn.example.com/logo.png" width="120" alt=""></a>
      <h1 style="font-size:24px;">This week&rsquo;s top stories</h1>
      <p>1. <a href="https://news.example.com/a/1?utm_campaign=wk42">Why the ocean is getting louder</a> &mdash; a 6 minute read.</p>
      <p>2. <a href='https://news.example.com/a/2'>Ten tools we actually use</a> &ndash; reader picks.</p>
      <p>3. Visit <a href="https://news.example.com/events">news.example.com/events</a> for this month&#39;s meetups.</p>
      <!--[if !mso]><!-->
      <p class="mobile-only">Swipe for more &rarr;</p>
      <!--<![endif]-->
      <table role="presentation" width="100%"><tr><td>&nbsp;</td><td>&nbsp;</td></tr></table>
      <p>Price: &euro;12&#46;00 &middot; &pound;10 &middot; &copy; 2026 Example Media&trade;</p>
    </td>
  </tr>
  <tr>
    <td style="font-size:11px;color:#999;">
      You are receiving this because you subscribed.<br>
      <a href="https://news.example.com/unsubscribe?u=xyz">Unsubscribe</a> | <a href="https://news.example.com/prefs">Preferences</a><br/>
      Example Media, 1 Harbour St, Springfield
    </td>
  </tr>
</table>
<img src="https://t.example.com/open.gif?u=xyz" width="1" height="1" alt="" style="display:none">
</body>
</html>`,
  ],
  [
    "Outlook desktop: Word-generated HTML with o:p and mso styles",
    `<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns:m="http://schemas.microsoft.com/office/2004/12/omml" xmlns="http://www.w3.org/TR/REC-html40">\r
<head>\r
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">\r
<meta name="Generator" content="Microsoft Word 15 (filtered medium)">\r
<style><!--\r
/* Font Definitions */\r
@font-face\r
\t{font-family:"Cambria Math";\r
\tpanose-1:2 4 5 3 5 4 6 3 2 4;}\r
p.MsoNormal, li.MsoNormal, div.MsoNormal\r
\t{margin:0cm;\r
\tfont-size:11.0pt;\r
\tfont-family:"Calibri",sans-serif;}\r
a:link, span.MsoHyperlink\r
\t{mso-style-priority:99;\r
\tcolor:#0563C1;\r
\ttext-decoration:underline;}\r
.MsoChpDefault\r
\t{mso-style-type:export-only;}\r
@page WordSection1\r
\t{size:612.0pt 792.0pt;\r
\tmargin:72.0pt 72.0pt 72.0pt 72.0pt;}\r
div.WordSection1\r
\t{page:WordSection1;}\r
--></style><!--[if gte mso 9]><xml>\r
<o:shapedefaults v:ext="edit" spidmax="1026" />\r
</xml><![endif]--><!--[if gte mso 9]><xml>\r
<o:shapelayout v:ext="edit">\r
<o:idmap v:ext="edit" data="1" />\r
</o:shapelayout></xml><![endif]-->\r
</head>\r
<body lang="EN-US" link="#0563C1" vlink="#954F72" style="word-wrap:break-word">\r
<div class="WordSection1">\r
<p class="MsoNormal">Hi Sam,<o:p></o:p></p>\r
<p class="MsoNormal"><o:p>&nbsp;</o:p></p>\r
<p class="MsoNormal">Please find the Q3 numbers attached. The summary is on our <a href="https://intranet.example.org/finance/q3">finance page</a>.<o:p></o:p></p>\r
<p class="MsoNormal"><o:p>&nbsp;</o:p></p>\r
<p class="MsoNormal">Revenue grew 12% &#8211; mostly in the &quot;Enterprise&quot; segment.<o:p></o:p></p>\r
<p class="MsoNormal"><o:p>&nbsp;</o:p></p>\r
<p class="MsoNormal">Kind regards,<o:p></o:p></p>\r
<p class="MsoNormal"><b><span style="font-size:10.0pt;color:#1F3864">Alex Rivera<o:p></o:p></span></b></p>\r
<p class="MsoNormal"><span style="font-size:9.0pt">Finance Lead | +1 555 0100 | <a href="mailto:alex@example.org">alex@example.org</a><o:p></o:p></span></p>\r
</div>\r
</body>\r
</html>\r
`,
  ],
  [
    "Gmail reply with quoted original",
    `<div dir="ltr">Sounds good, Thursday at 3pm works for me.<div><br></div><div>I&#39;ll book the room.</div></div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Tue, Oct 14, 2026 at 9:12 AM Jordan Lee &lt;<a href="mailto:jordan@example.net">jordan@example.net</a>&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex"><div dir="ltr">Hi,<div><br></div><div>Can we move the review to Thursday? The deck is here:&nbsp;<a href="https://docs.example.net/d/1AbC/edit?usp=sharing" target="_blank">https://docs.example.net/d/1AbC/edit?usp=sharing</a></div><div><br></div><div>Thanks,</div><div>Jordan</div></div>
</blockquote></div>`,
  ],
  [
    "Outlook web reply with divRplyFwdMsg header",
    `<html><head>
<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">
<style type="text/css" style="display:none;"> P {margin-top:0;margin-bottom:0;} </style>
</head>
<body dir="ltr">
<div class="elementToProof" style="font-family: Aptos, Arial, Helvetica, sans-serif; font-size: 12pt; color: rgb(0, 0, 0);">
Approved &#8212; go ahead with the order.</div>
<div id="appendonsend"></div>
<hr style="display:inline-block;width:98%" tabindex="-1">
<div id="divRplyFwdMsg" dir="ltr"><font face="Calibri, sans-serif" style="font-size:11pt" color="#000000"><b>From:</b> Pat Morgan &lt;pat@example.com&gt;<br>
<b>Sent:</b> Wednesday, October 15, 2026 4:01 PM<br>
<b>To:</b> Chris Doe &lt;chris@example.com&gt;<br>
<b>Subject:</b> PO 4471 for approval</font>
<div>&nbsp;</div>
</div>
<div>
<p>Hi Chris,</p>
<p>PO 4471 (12 &times; monitors, total $3,480.00) needs your approval. Details: <a href="https://erp.example.com/po/4471">https://erp.example.com/po/4471</a></p>
<p>Thanks<br>Pat</p>
</div>
</body>
</html>`,
  ],
  [
    "Japanese newsletter (CJK) with full-width punctuation",
    `<html><body><table width="100%"><tr><td style="font-family:'Hiragino Sans',Meiryo,sans-serif;">
<p>いつもご利用いただき、誠にありがとうございます。</p>
<p>秋の新商品のご案内です。<br>詳しくは<a href="https://shop.example.jp/autumn?utm=mail">こちら</a>をご覧ください。</p>
<p>　・送料無料キャンペーン：10月31日まで</p>
<p>　・ポイント２倍デー：毎週金曜日</p>
<p>※本メールは送信専用です。ご返信いただいてもお答えできません。</p>
<p>配信停止は<a href="https://shop.example.jp/unsubscribe">こちら</a></p>
</td></tr></table></body></html>`,
  ],
  [
    "Chinese and Korean transactional notice",
    `<div style="font-size:14px">您好，您的订单 <b>#20261016-88</b> 已发货。</div>
<div>快递单号：SF1234567890&nbsp;&nbsp;（顺丰速运）</div>
<div><a href="https://track.example.cn/?no=SF1234567890">查看物流</a></div>
<hr>
<div>안녕하세요, 주문하신 상품이 발송되었습니다.</div>
<div>배송 조회: <a href="https://track.example.kr/SF1234567890">track.example.kr/SF1234567890</a></div>`,
  ],
  [
    "Hebrew and Arabic RTL with bidi marks",
    `<div dir="rtl" style="text-align:right">
<p>&#x200F;שלום רב,&#x200E;</p>
<p>הפגישה נקבעה ליום חמישי בשעה 10:00.</p>
<p dir="rtl">مرحبا، تم تأكيد طلبك رقم&nbsp;٤٥٦.</p>
<p><a href="https://example.co.il/meet">לפרטים נוספים</a></p>
</div>`,
  ],
  [
    "OTP / verification code email",
    `<!doctype html><html><head><style>.code{font-size:32px;letter-spacing:6px}</style></head><body>
<table align="center" width="480"><tr><td>
<h2>Verify your email</h2>
<p>Your verification code is:</p>
<p class="code"><strong>482&nbsp;913</strong></p>
<p>This code expires in 10 minutes. If you didn&rsquo;t request it, you can ignore this email.</p>
<p style="color:#999">&copy; 2026 Example Inc. &bull; <a href="https://example.com/privacy">Privacy</a></p>
</td></tr></table>
</body></html>`,
  ],
  [
    "receipt with entities, numeric refs and uppercase tags",
    `<HTML><BODY>
<TABLE BORDER=0 CELLPADDING=4>
<TR><TD><B>Item</B></TD><TD ALIGN=RIGHT><B>Price</B></TD></TR>
<TR><TD>Coffee beans 1&nbsp;kg</TD><TD ALIGN=RIGHT>&#x20AC;24,90</TD></TR>
<TR><TD>Shipping</TD><TD ALIGN=RIGHT>&#8364;4,90</TD></TR>
<TR><TD COLSPAN=2><HR></TD></TR>
<TR><TD><B>Total</B></TD><TD ALIGN=RIGHT><B>&euro;29,80</B></TD></TR>
</TABLE>
<P>Questions? Reply to this email or visit <A HREF=https://help.example.de/orders>our help centre</A>.</P>
<P>Order ref: A&amp;B-7731 &lt;keep this&gt; &unknownentity; &#0; &#xD800; &#55357;</P>
<BR CLEAR=ALL>
</BODY></HTML>`,
  ],
  [
    "marketing email with script, noscript, svg and iframe",
    `<html><head><script type="text/javascript">window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);} if (a < b && c > d) {}</script>
<script type="application/ld+json">{"@context":"http://schema.org","@type":"EmailMessage","potentialAction":{"@type":"ViewAction","url":"https://deals.example.com/x"}}</script></head>
<body>
<noscript><img src="https://t.example.com/ns.gif"></noscript>
<div><svg width="24" height="24" viewBox="0 0 24 24"><title>star</title><path d="M12 2l3 7h7l-5.5 4 2 7-6.5-4.5L5.5 20l2-7L2 9h7z"/></svg> Flash sale: 40% off everything!</div>
<iframe src="https://deals.example.com/embed" width="0" height="0"></iframe>
<p><a href="https://deals.example.com/sale" onclick="track()">Shop now</a> &raquo;</p>
<p><a href="javascript:void(0)">Do nothing</a> and <a href="#top">back to top</a> and <a href="data:text/html,hi">data link</a></p>
<p><a href="https://deals.example.com/app"><img src="https://cdn.example.com/appstore.png" alt="Get the app"></a></p>
<video src="https://cdn.example.com/promo.mp4" controls>Your client does not support video.</video>
<audio src="https://cdn.example.com/jingle.mp3"></audio>
<template><p>hidden template</p></template>
<p>Use code <code>FALL40</code> at checkout.</p>
</body></html>`,
  ],
  [
    "ticketing system: CRLF table cells and empty text part shape",
    `<table>\r\n<tr>\r\n<td>\r\n \r\n</td>\r\n</tr>\r\n<tr>\r\n<td>\r\n<p>Ticket <b>#58210</b> has been updated by Support.</p>\r\n</td>\r\n</tr>\r\n<tr>\r\n<td>\r\n \r\n</td>\r\n</tr>\r\n<tr>\r\n<td>\r\n<p>We have reset your password link. Please follow <a href="https://support.example.io/hc/requests/58210">this link</a> to view the conversation.</p>\r\n</td>\r\n</tr>\r\n<tr>\r\n<td>\r\n \r\n</td>\r\n</tr>\r\n<tr>\r\n<td style="color:#aaa">[ZX9-ABCDE-1]</td>\r\n</tr>\r\n</table>\r\n`,
  ],
  [
    "Apple Mail forward with blockquote type=cite",
    `<html><head><meta http-equiv="content-type" content="text/html; charset=utf-8"></head><body style="overflow-wrap: break-word; -webkit-nbsp-mode: space; line-break: after-white-space;">FYI, see below.<br id="lineBreakAtBeginningOfMessage"><div><br><blockquote type="cite"><div>Begin forwarded message:</div><br class="Apple-interchange-newline"><div style="margin-top: 0px; margin-right: 0px; margin-bottom: 0px; margin-left: 0px;"><span style="font-family: -webkit-system-font, Helvetica Neue, Helvetica, sans-serif; color:rgba(0, 0, 0, 1.0);"><b>From: </b></span><span style="font-family: -webkit-system-font, Helvetica Neue, Helvetica, sans-serif;">Taylor &lt;<a href="mailto:taylor@example.org">taylor@example.org</a>&gt;<br></span></div><div><b>Subject: </b>Flight change</div><br><div><div>Your flight EX 123 now departs at 07:45 instead of 07:15.<br>Manage booking: <a href="https://air.example.org/manage?pnr=XY12AB">air.example.org/manage</a></div></div></blockquote></div><br></body></html>`,
  ],
  [
    "links: quoting styles, spacing, nested markup and duplicates",
    `<p>Read the <A HREF = "https://example.com/Guide">user <em>guide</em></A>.</p>
<p>Single: <a class="btn" href='https://example.com/s?a=1&amp;b=2' target=_blank>Start</a></p>
<p>Unquoted: <a href=https://example.com/u/>Profile</a></p>
<p>Shown already: <a href="https://example.com/docs/">example.com/docs</a></p>
<p>Mail: <a href="mailto:help@example.com">help@example.com</a> or <a href="mailto:help@example.com?subject=Hi">write to us</a></p>
<p>Empty: <a href="https://example.com/pixel"></a><a href="https://example.com/logo"><img src="x.png"></a></p>
<p>No href: <a name="top">anchor</a> <a id="x">plain</a></p>
<p>Data attr first: <a data-href="nope" href="https://example.com/real">real link</a></p>
<p>Broken closer: <a href="https://example.com/b">bold</a >after</p>
<p>Tel: <a href="tel:+15550100">call us</a></p>`,
  ],
  [
    "plain-text-ish HTML with pre and long lines",
    `<html><body><pre style="font-family:monospace">
Build #4182 FAILED

  step 3/7: npm test
    &gt; 2 failing tests
    &gt; src/lib/foo.test.ts:41  expected 3, got 4

See https://ci.example.dev/builds/4182 for logs.
</pre></body></html>`,
  ],
  [
    "calendar invitation HTML",
    `<div style="font-family:Roboto,Helvetica,Arial,sans-serif"><table cellspacing="0" cellpadding="8" border="0" style="width:100%"><tr><td><h2 style="font-size:16px">Design sync</h2><p><b>When</b><br>Thursday Oct 16, 2026 &#8901; 3pm &ndash; 3:30pm (Central European Time - Oslo)</p><p><b>Joining info</b><br><a href="https://meet.example.com/abc-defg-hij" style="color:#1a73e8">meet.example.com/abc-defg-hij</a></p><p><b>Guests</b><br><a href="mailto:a@example.com">a@example.com</a> - organizer<br><a href="mailto:b@example.com">b@example.com</a></p><p><a href="https://calendar.example.com/event?action=RESPOND&amp;rst=1">Yes</a> | <a href="https://calendar.example.com/event?action=RESPOND&amp;rst=2">No</a> | <a href="https://calendar.example.com/event?action=RESPOND&amp;rst=3">Maybe</a></p></td></tr></table></div>`,
  ],
  [
    "quirks: stray brackets, comment forms and mixed-case style",
    `<p>If a < b and b > c then a ? c.</p>
<p>Math: 3 <> 4, x<y, y>z, <> empty</p>
<!-- a plain comment with a > inside -->
<!---->
<!-- unterminated looking -- but closed -->
<STYLE TYPE="text/css">p{color:red}</STYLE>
<Style>
.x > .y { margin: 0 }
</style >
<p>After styles.</p>
<scripty>not a script</scripty>
<styles>not a style</styles>
<p>Smart quotes: &ldquo;hi&rdquo; &lsquo;there&rsquo; &hellip; 20&deg;C</p>
<p>Zero width: a&#8203;b&zwj;c&#xFEFF;d &shy;soft</p>
<div>line<br/>break<BR>again<br  />done</div>`,
  ],
  [
    "signature-style snippet",
    `<table cellpadding="0" cellspacing="0"><tr><td style="padding-right:10px"><img src="https://cdn.example.com/avatar.png" width="64" height="64" alt="Robin"></td><td><b style="color:#222">Robin Park</b><br><span style="color:#666">Head of Ops &middot; Example Co</span><br><a href="https://example.com" style="color:#0a66c2">example.com</a> &middot; <a href="tel:+4712345678">+47 123 45 678</a></td></tr></table>`,
  ],
];

export default EMAIL_HTML_CORPUS;
