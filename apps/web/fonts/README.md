# Webfonts

Geist, Geist Mono and Instrument Serif, self-hosted. `fonts.css` declares them; `app/fonts.js` explains how they are loaded and what must not change.

All three families are licensed under the SIL Open Font License 1.1. The licence texts are in this directory (`OFL-Geist.txt`, `OFL-Geist-Mono.txt`, `OFL-Instrument-Serif.txt`, copied from github.com/google/fonts) and must stay next to the files.

The files are the ones fonts.gstatic.com served on 2026-10-03, unmodified (Geist v5, Geist Mono v6, Instrument Serif v5). Each was compared by SHA-256 with a fresh download that day. Geist and Geist Mono are variable fonts: one file per subset carries every weight.

| File | Family | Style | Subset | Bytes | SHA-256 | Original |
|---|---|---|---|---|---|---|
| `geist-cyrillic-ext.woff2` | Geist | normal | cyrillic-ext | 7252 | `b7a545bbb08256bd809f11cfe66d88da3e22d169ea4407737b1ef0ec1ed3d791` | https://fonts.gstatic.com/s/geist/v5/gyByhwUxId8gMEwRGFWNOITddY4.woff2 |
| `geist-cyrillic.woff2` | Geist | normal | cyrillic | 14900 | `6129fc8571c3e0cb0a4c41f5160c974a843b055009dc4ad8858bd808e18a2d86` | https://fonts.gstatic.com/s/geist/v5/gyByhwUxId8gMEwYGFWNOITddY4.woff2 |
| `geist-vietnamese.woff2` | Geist | normal | vietnamese | 7968 | `f689f638f29fff460a2d5749edb5d5c38d7bef0389f32032d871f23fc6ebb008` | https://fonts.gstatic.com/s/geist/v5/gyByhwUxId8gMEwTGFWNOITddY4.woff2 |
| `geist-latin-ext.woff2` | Geist | normal | latin-ext | 16540 | `58a6b173d5ca1dec92166ea3c6cb1a84a4144556d10928ac14e8e6b40e4787bd` | https://fonts.gstatic.com/s/geist/v5/gyByhwUxId8gMEwSGFWNOITddY4.woff2 |
| `geist-latin.woff2` | Geist | normal | latin | 29288 | `9b6f5ff45b278c744b5f379a2c4ecbaf858a842b8eaf82ac8d21b699ca16c608` | https://fonts.gstatic.com/s/geist/v5/gyByhwUxId8gMEwcGFWNOITd.woff2 |
| `geist-mono-cyrillic-ext.woff2` | Geist Mono | normal | cyrillic-ext | 6204 | `e27f657e38d52887baa3b6b2f812bef93dfdd356f0810e40edd4ee284cc7e9f6` | https://fonts.gstatic.com/s/geistmono/v6/or3nQ6H-1_WfwkMZI_qYFrodmhHkjkotbA.woff2 |
| `geist-mono-cyrillic.woff2` | Geist Mono | normal | cyrillic | 12872 | `75b3bedbebc35f347c0ae3b416aa871941555357e7b0f83767eb5987875589ed` | https://fonts.gstatic.com/s/geistmono/v6/or3nQ6H-1_WfwkMZI_qYFrMdmhHkjkotbA.woff2 |
| `geist-mono-symbols2.woff2` | Geist Mono | normal | symbols2 | 5892 | `d67e4a94ba498635f764ddca7d1ec4271f5642f032eb24b426764480f66f8497` | https://fonts.gstatic.com/s/geistmono/v6/or3nQ6H-1_WfwkMZI_qYFg08vz7MhEIVVeA.woff2 |
| `geist-mono-vietnamese.woff2` | Geist Mono | normal | vietnamese | 7728 | `16e1d48b6dd29eb240aec5db36184eb182933c082cd43de7f35af686d58087d2` | https://fonts.gstatic.com/s/geistmono/v6/or3nQ6H-1_WfwkMZI_qYFrgdmhHkjkotbA.woff2 |
| `geist-mono-latin-ext.woff2` | Geist Mono | normal | latin-ext | 14712 | `745994b5cd950ec201b66526375f057d540847cccfc70f4f24f5f571d26d3923` | https://fonts.gstatic.com/s/geistmono/v6/or3nQ6H-1_WfwkMZI_qYFrkdmhHkjkotbA.woff2 |
| `geist-mono-latin.woff2` | Geist Mono | normal | latin | 23108 | `5f3d6ad60f29d6cb708414ec6887163d63bf197377ef5417d2483ff31ace6c3b` | https://fonts.gstatic.com/s/geistmono/v6/or3nQ6H-1_WfwkMZI_qYFrcdmhHkjko.woff2 |
| `instrument-serif-italic-latin-ext.woff2` | Instrument Serif | italic | latin-ext | 8444 | `a04fc7ed18a8037149ce0bfda58076709d8e0840e136ed00abbdc196b7992443` | https://fonts.gstatic.com/s/instrumentserif/v5/jizHRFtNs2ka5fXjeivQ4LroWlx-6zAjgn7Motmp5r61.woff2 |
| `instrument-serif-italic-latin.woff2` | Instrument Serif | italic | latin | 15684 | `6ee678c33f388dd7ba59700ebea635deb98821baafd817b09891f7927177f702` | https://fonts.gstatic.com/s/instrumentserif/v5/jizHRFtNs2ka5fXjeivQ4LroWlx-6zAjjH7Motmp5g.woff2 |
| `instrument-serif-latin-ext.woff2` | Instrument Serif | normal | latin-ext | 7828 | `a8c4bd7cd7073180e740d2d83a616b5cb0845579b73207eeafeae8532e70c901` | https://fonts.gstatic.com/s/instrumentserif/v5/jizBRFtNs2ka5fXjeivQ4LroWlx-6zsTjnTLgNuZ5w.woff2 |
| `instrument-serif-latin.woff2` | Instrument Serif | normal | latin | 15040 | `60c06664b5a95c7de6cc3e00d1f9034d78bd1e40b564016b241674449a067d4d` | https://fonts.gstatic.com/s/instrumentserif/v5/jizBRFtNs2ka5fXjeivQ4LroWlx-6zUTjnTLgNs.woff2 |

To update a family: download the new files, replace them here, regenerate the rules in `fonts.css` from Google's css2 response for the same query, and re-run `npm run test:fonts` and `npm run check:built-output`.
