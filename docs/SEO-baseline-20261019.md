# SEO baseline, 2026-10-19

Read-only snapshot of Google Search Console (sc-domain:mcpemails.com) and three owner checks, taken 2026-10-19 in a signed-in browser. Use it as the "before" for every SEO change from 10-19 on. Nothing in any account was changed.

Windows used everywhere: **current 28d = 2026-09-20..10-17**, **previous 28d = 2026-08-23..09-19**. GSC data ends 10-17; 10-16 and 10-17 are preliminary.

How to reproduce a query×page row without clicking through the UI (GSC URL parameters, `!` = exact match):

```
https://search.google.com/search-console/performance/search-analytics?resource_id=sc-domain%3Amcpemails.com&start_date=20260920&end_date=20261017&compare_start_date=20260823&compare_end_date=20260919&query=!email%20mcp&breakdown=page
https://search.google.com/search-console/performance/search-analytics?resource_id=sc-domain%3Amcpemails.com&start_date=20260920&end_date=20261017&compare_start_date=20260823&compare_end_date=20260919&page=!https%3A%2F%2Fmcpemails.com%2Fconnect%2Fimap&breakdown=query
```

## 0. Query × page for the five head queries

Cells are current / previous. Rows with identical numbers under `/` (`/#features`, `/#how`, `/pricing`, `/native-connectors-vs-mcp`) are homepage sitelinks, not competing pages.

### "email mcp" (total 16 / 7 clicks, 412 / 223 impr, pos 5.2 / 10.5)
| Page | Clicks | Impr | CTR | Pos |
|---|---|---|---|---|
| `/` | 14 / 7 | 388 / 204 | 3.6% | 4.1 / 6.8 |
| `/fr` | 1 / 0 | 3 / 2 | | 2.0 / 7.5 |
| `/es` | 1 / 0 | 3 / 0 | | 4.3 |
| `/blog` | 0 | 26 / 12 | 0% | 33.6 / 47.9 |
| `/docs` | 0 | 3 / 7 | 0% | 7.3 / 66.1 |
| `/self-hosting` | 0 | 3 / 0 | 0% | 7.3 |
| `/best-email-mcp-servers` | 0 | 3 / 0 | 0% | 13.3 |
| sitelinks (4 rows) | 0 | 16 / 2 each | | 6.8 |

### "email mcp server" (total 3 / 0 clicks, 229 / 98 impr, pos 8.9 / 18.6)
| Page | Clicks | Impr | CTR | Pos |
|---|---|---|---|---|
| `/` | 3 / 0 | 212 / 90 | 1.4% | 6.1 / 15.0 |
| `/blog` | 0 | 26 / 18 | 0% | 44.2 / 56.2 |
| `/best-email-mcp-servers` | 0 | 8 / 0 | 0% | 31.5 |
| `/docs`, `/self-hosting` | 0 | 6 / 0 each | 0% | 9.5 |
| sitelinks (4 rows) | 0 | 11 / 5 each | | 9.5 |

### "imap mcp" (total 5 / 0 clicks, 69 / 2 impr, pos 8.6 / 49.5)
| Page | Clicks | Impr | CTR | Pos |
|---|---|---|---|---|
| `/connect/imap` | 3 / 0 | 49 / 2 | 6.1% | 9.3 / 49.5 |
| `/` | 2 / 0 | 16 / 0 | 12.5% | 7.1 |
| `/es` | 1 / 0 | 4 / 0 | 25% | 6.3 |
| `/fr`, `/zh`, `/blog` | 0 | 3, 1, 2 | | |

### "connect claude to email" (total 1 / 0 clicks, 20 / 2 impr, pos 7.1 / 10.5)
| Page | Clicks | Impr | CTR | Pos |
|---|---|---|---|---|
| `/blog/connect-claude-to-email` | 1 / 0 | 20 / 2 | 5% | 7.1 / 10.5 |

### "icloud mcp" (total 1 / 0 clicks, 207 / 236 impr, pos 6.7 / 8.1)
| Page | Clicks | Impr | CTR | Pos |
|---|---|---|---|---|
| `/connect/icloud` | 1 / 0 | 197 / 223 | 0.5% | 6.9 / 8.3 |
| `/fr/connect/icloud` | 0 | 10 / 13 | 0% | 4.0 / 4.5 |

### Reading
- **No head query is cannibalized.** Each has one owner: the homepage for "email mcp" and "email mcp server", /connect/imap for "imap mcp", the Claude post for "connect claude to email", /connect/icloud for "icloud mcp". The second-ranked URL is always far behind (pos 13-44) or a locale twin.
- `/best-email-mcp-servers` is not competing with the homepage (pos 13-31, 3-8 impr). It can be optimized for "best email mcp server" freely.
- "icloud mcp" is a snippet problem, not an ownership problem: one URL at pos 6.9 with 0.5% CTR, and impressions slightly down (236 to 207).
- "connect claude to email" exact match is small (20 impr). The post's 4,051 impressions come from a long tail of 129 visible queries (333 visible impr): generic "connect/link claude to (my) email" ~175 impr, Gmail 43, Apple Mail 59 (incl. "how to connect claude to apple mail" 20 impr, pos 6.1), Yahoo 37, Outlook 11, iCloud 9.

## 0b. Cannibalization pairs from the 10-19 report

Per-page query lists, current 28d. Overlap = query visible on both URLs. "A" is the first page named.

### IMAP pair: /blog/claude-imap-connector (A, 43 queries) vs /connect/imap (B, 46 queries)
| Query | A clicks/impr @pos | B clicks/impr @pos |
|---|---|---|
| claude imap connector | 4 / 51 @6.5 | 0 / 12 @4.3 |
| claude imap mcp | 1 / 10 @6.2 | 0 / 8 @4.8 |
| connect imap to claude | 1 / 6 @12.2 | 1 / 7 @15.3 |
| imap mcp claude | 0 / 3 @7.3 | 0 / 7 @5.0 |
| claude imap | 0 / 4 @6.3 | 0 / 4 @4.0 |
| imap mcp | 0 (not listed for A) | 3 / 49 @9.3 |
| mcp imap | (not listed) | 0 / 18 @7.1 |

Verdict: **mild, real overlap on "claude + imap" queries only.** Google splits them across both URLs; /connect/imap ranks higher but the blog gets the clicks. Generic "imap mcp" belongs to /connect/imap alone. Both pages grew. Do not merge or 301. Fix with differentiation: blog title/H1 leads with "Claude", /connect/imap with "IMAP MCP server", plus a link from the blog to /connect/imap ("set it up") and back ("Claude walkthrough"). Re-read this table 28 days after the change.

/connect/imap also shows ~150 impressions for `"invoices@"` search-operator queries at pos 60-88. Junk, ignore.

### Multiple-accounts posts
/blog/multiple-email-accounts-in-claude-and-chatgpt: 6 visible queries, 9 impr total. /blog/manage-multiple-email-accounts-with-ai: 2 visible queries, 9 impr, pos 26-53. **No overlap.** Not a cannibalization case; the second post simply has no demand.

### Docs vs blog
- /docs/claude: 0 visible queries (all anonymised). Cannot overlap measurably with /blog/connect-claude-to-email. No action.
- /docs/chatgpt (60 queries) vs /blog/connect-chatgpt-to-email (29 queries): 9 shared queries, all 1-13 impr. Largest: "chatgpt fastmail" blog 5 @8.4 vs docs 12 @8.3; "fastmail chatgpt" blog 13 @7.9 vs docs 1 @1. **Negligible.** /docs/chatgpt's own impressions are generic "chatgpt mcp" queries at pos 41-72, a different intent.

## 0c. Owner checks

| Check | Result (2026-10-19) |
|---|---|
| Bing Webmaster Tools | Not signed in; the site is **not verified** (no `msvalidate.01` meta, no `/BingSiteAuth.xml`, no Bing TXT record; the `MS=` TXT record is Microsoft 365, not Bing WMT). robots.txt carries the `Sitemap:` line. Bing `site:` query hit a CAPTCHA. On bing.com "email mcp server" (US), mcpemails.com is in neither the top 10 nor the Copilot answer. |
| Google Ads | Account has exactly **one** non-removed campaign, "Search - AI email test (Oct 2026)", status **Paused**. Account banner: no ads are serving. Last 7 days (10-12..10-18) show clicks only on 10-12, then zero. Matches the last `google_ads` signup on 10-12. Ads clicks are inside Vercel's google.com referrer from 09-29 to 10-12 only. |
| Review permalink in `components/marketing/reviews.mjs` | **Still resolves**, signed in and logged out. Maps still shows the place card (name, category, area, a map pin) and the review. Removing the Business Profile on 10-15 did not take the Maps place down. |
| Review rich results | GSC Search appearance "Review snippet": 25 clicks / 362 impr in the current 28d; Enhancements "Review snippets": 10 valid, 0 invalid. |

---

The sections below are the full GSC pull from earlier the same day (performance, top queries and pages, countries, devices, indexing, sitemaps, enhancements, links).

## 1. Performance

### Headline totals
| Window | Clicks | Impressions | CTR | Avg pos |
|---|---|---|---|---|
| 3 months (07-18..10-17) | 2.16K | 62.4K | 3.5% | 7.8 |
| Current 28d (09-20..10-17) | 1,374 | 41,782 | 3.3% | 7.0 |
| Previous 28d (08-23..09-19) | 589 | 14,610 | 4.0% | 7.9 |
| Change | +785 (+133%) | +27,172 (+186%) | -0.7 pt | +0.9 better |

(GSC Insights page shows the same: clicks +133%, impressions +186%.)

### Weekly trend, Sat-Fri weeks (summed from GSC daily rows; position is impression-weighted mean of daily averages, approximate)
| Week (Sat-Fri) | Days | Clicks | WoW clicks | Impressions | CTR | Avg pos (impr-weighted) |
|---|---|---|---|---|---|---|
| 07-18..07-24 | 7 | 9 |  | 195 | 4.6% | 10.6 |
| 07-25..07-31 | 7 | 17 | +89% | 445 | 3.8% | 12.6 |
| 08-01..08-07 | 7 | 33 | +94% | 1,425 | 2.3% | 10.6 |
| 08-08..08-14 | 7 | 61 | +85% | 1,847 | 3.3% | 13.3 |
| 08-15..08-21 | 7 | 67 | +10% | 1,836 | 3.6% | 14.6 |
| 08-22..08-28 | 7 | 57 | -15% | 2,149 | 2.7% | 13.8 |
| 08-29..09-04 | 7 | 117 | +105% | 3,174 | 3.7% | 9.4 |
| 09-05..09-11 | 7 | 169 | +44% | 4,189 | 4.0% | 6.3 |
| 09-12..09-18 | 7 | 220 | +30% | 4,747 | 4.6% | 6.1 |
| 09-19..09-25 | 7 | 237 | +8% | 6,834 | 3.5% | 6.9 |
| 09-26..10-02 | 7 | 305 | +29% | 11,261 | 2.7% | 6.7 |
| 10-03..10-09 | 7 | 395 | +30% | 11,108 | 3.6% | 6.5 |
| 10-10..10-16 | 7 | 427 | +8% | 11,935 | 3.6% | 7.8 |
| 10-17..10-23 (partial, 1 day) | 1 | 44 | n/a | 1,230 | 3.6% | 6.6 |

Observations (measured): impressions jumped from ~6.8K/wk to ~11.3K/wk in the week 09-26 and then **plateaued at 11.1-11.9K/wk for 3 weeks**; clicks kept rising only via CTR (2.7% -> 3.6%). Week 10-10..10-16 = 427 clicks (+8%), the first flat week. Daily avg position spiked to 11.3 on 10-12 and 8.0-8.1 on 10-13/14 (from 5.6-6.7 the week before), then recovered to 6.2-6.7.

### Daily, last 14 days
| Day | Clicks | Impr | CTR | Pos |
|---|---|---|---|---|
| Oct 17, 2026 | 44 | 1,230 | 3.6% | 6.6 |
| Oct 16, 2026 | 59 | 1,666 | 3.5% | 6.7 |
| Oct 15, 2026 | 79 | 1,859 | 4.2% | 6.2 |
| Oct 14, 2026 | 77 | 1,971 | 3.9% | 8.1 |
| Oct 13, 2026 | 62 | 1,920 | 3.2% | 8.0 |
| Oct 12, 2026 | 64 | 1,881 | 3.4% | 11.3 |
| Oct 11, 2026 | 53 | 1,366 | 3.9% | 6.7 |
| Oct 10, 2026 | 33 | 1,272 | 2.6% | 6.7 |
| Oct 9, 2026 | 70 | 1,669 | 4.2% | 5.8 |
| Oct 8, 2026 | 59 | 1,781 | 3.3% | 5.6 |
| Oct 7, 2026 | 69 | 1,857 | 3.7% | 6.2 |
| Oct 6, 2026 | 52 | 1,849 | 2.8% | 6.5 |
| Oct 5, 2026 | 56 | 1,687 | 3.3% | 6.6 |
| Oct 4, 2026 | 41 | 1,125 | 3.6% | 7.7 |

## 2. Queries and pages, current 28d vs previous 28d

### Query visibility
| Window | Query rows | Clicks in visible queries | Share of total clicks | Impr in visible queries |
|---|---|---|---|---|
| Current 28d | 1,000 (GSC UI cap) | 278 | 20% of 1,374 | 9,519 of 41,782 |
| Previous 28d | 349 | 80 | 14% of 589 | 2,582 of 14,610 |

~80% of clicks are on anonymised queries; query tables below cover only the visible 20%.

### Top queries (current 28d, by clicks, then highest-impression zero-click queries). Prev values looked up in the complete 349-row previous list; "new" = no impressions in previous 28d.
| # | Query | Clicks | Δ clicks | Impr | Δ impr | CTR | Pos | Prev pos |
|---|---|---|---|---|---|---|---|---|
| 1 | `mcpemails` | 48 | +45 | 107 | +94 | 44.9% | 3.9 | 4.7 |
| 2 | `mcp emails` | 30 | +15 | 65 | -3 | 46.2% | 1.4 | 2.4 |
| 3 | `mcp email` | 21 | +12 | 138 | +49 | 15.2% | 2.7 | 5.5 |
| 4 | `email mcp` | 16 | +9 | 412 | +189 | 3.9% | 5.2 | 10.5 |
| 5 | `icloud mail mcp` | 7 | +5 | 88 | +77 | 8% | 3.1 | 3.8 |
| 6 | `mcpemail` | 7 | new (0 prev impr) | 7 | new (0 prev impr) | 100% | 2.3 | - |
| 7 | `yahoo mail mcp` | 5 | -7 | 98 | +3 | 5.1% | 3.0 | 3.4 |
| 8 | `imap mcp` | 5 | +5 | 69 | +67 | 7.2% | 8.6 | 49.5 |
| 9 | `yahoo mail connector for claude` | 5 | +5 | 24 | +19 | 20.8% | 1.3 | 4.0 |
| 10 | `claude imap connector` | 4 | +4 | 51 | +36 | 7.8% | 6.2 | 7.0 |
| 11 | `yahoo mail claude connector` | 4 | +4 | 45 | +38 | 8.9% | 1.9 | 3.3 |
| 12 | `mcp mail` | 4 | +4 | 39 | +25 | 10.3% | 2.1 | 6.7 |
| 13 | `claude yahoo mail connector` | 4 | +3 | 37 | +30 | 10.8% | 1.6 | 1.9 |
| 14 | `connect claude to apple mail` | 4 | new (0 prev impr) | 26 | new (0 prev impr) | 15.4% | 6.7 | - |
| 15 | `connect claude to yahoo mail` | 4 | +3 | 18 | +6 | 22.2% | 1.8 | 5.2 |
| 16 | `email mcp server` | 3 | +3 | 229 | +131 | 1.3% | 8.9 | 18.6 |
| 17 | `mail mcp` | 3 | +2 | 146 | +87 | 2.1% | 6.8 | 7.2 |
| 18 | `mcp icloud` | 3 | +2 | 44 | +8 | 6.8% | 4.9 | 5.8 |
| 19 | `qq邮箱mcp` | 3 | new (0 prev impr) | 34 | new (0 prev impr) | 8.8% | 6.3 | - |
| 20 | `purelymail mcp` | 3 | new (0 prev impr) | 17 | new (0 prev impr) | 17.6% | 4.2 | - |
| 21 | `how to connect claude to yahoo mail` | 3 | +3 | 16 | +8 | 18.8% | 2.3 | 2.6 |
| 22 | `mcp zimbra` | 3 | new (0 prev impr) | 11 | new (0 prev impr) | 27.3% | 4.8 | - |
| 23 | `privateemail mcp` | 3 | +3 | 11 | +6 | 27.3% | 5.1 | 4.6 |
| 24 | `yahoo mail mcp server` | 2 | +2 | 53 | +8 | 3.8% | 2.0 | 3.5 |
| 25 | `mcp email server` | 2 | +2 | 39 | +27 | 5.1% | 14.7 | 49.9 |
| 26 | `how to connect apple mail to claude` | 2 | new (0 prev impr) | 37 | new (0 prev impr) | 5.4% | 4.4 | - |
| 27 | `claude yahoo mail` | 2 | +2 | 28 | +22 | 7.1% | 2.1 | 3.3 |
| 28 | `connect yahoo mail to chatgpt` | 2 | +2 | 27 | +16 | 7.4% | 2.5 | 4.5 |
| 29 | `icloud claude` | 2 | +1 | 27 | +12 | 7.4% | 6.1 | 5.5 |
| 30 | `yahoo email mcp` | 2 | +1 | 26 | +17 | 7.7% | 1.5 | 2.6 |
| 31 | `connect yahoo mail to claude` | 2 | new (0 prev impr) | 23 | new (0 prev impr) | 8.7% | 1.2 | - |
| 32 | `mailcow mcp` | 2 | new (0 prev impr) | 21 | new (0 prev impr) | 9.5% | 5.9 | - |
| 33 | `qq邮箱 mcp` | 2 | new (0 prev impr) | 20 | new (0 prev impr) | 10% | 6.8 | - |
| 34 | `claude imap mcp` | 2 | new (0 prev impr) | 17 | new (0 prev impr) | 11.8% | 5.0 | - |
| 35 | `how to connect yahoo mail to claude` | 2 | +2 | 13 | +7 | 15.4% | 1.7 | 2.7 |
| 36 | `connect imap to claude` | 2 | +2 | 10 | +7 | 20% | 14.3 | 33.0 |
| 37 | `chatgpt imap connector` | 2 | +2 | 9 | +6 | 22.2% | 4.4 | 11.7 |
| 38 | `icloud mail chatgpt` | 2 | new (0 prev impr) | 9 | new (0 prev impr) | 22.2% | 4.8 | - |
| 39 | `chatgpt` | 2 | new (0 prev impr) | 7 | new (0 prev impr) | 28.6% | 5.0 | - |
| 40 | `webmail mcp` | 2 | new (0 prev impr) | 3 | new (0 prev impr) | 66.7% | 1.0 | - |
| 41 | `imap claude` | 2 | new (0 prev impr) | 3 | new (0 prev impr) | 66.7% | 2.0 | - |
| 42 | `yahoo email mcp server` | 2 | +2 | 3 | -1 | 66.7% | 3.3 | 5.0 |
| 43 | `icloud mcp` | 1 | +1 | 207 | -29 | 0.5% | 6.7 | 8.1 |
| 44 | `claude email mcp` | 1 | +0 | 80 | +46 | 1.2% | 4.6 | 5.6 |
| 45 | `can claude connect to yahoo mail` | 1 | +1 | 42 | +19 | 2.4% | 2.5 | 3.8 |
| 46 | `hey email mcp` | 1 | new (0 prev impr) | 39 | new (0 prev impr) | 2.6% | 4.8 | - |
| 47 | `hey.com mcp` | 1 | new (0 prev impr) | 33 | new (0 prev impr) | 3% | 6.3 | - |
| 48 | `hostinger mail mcp` | 1 | new (0 prev impr) | 33 | new (0 prev impr) | 3% | 7.2 | - |
| 49 | `hey mcp` | 1 | new (0 prev impr) | 32 | new (0 prev impr) | 3.1% | 7.8 | - |
| 50 | `mcp for email` | 1 | +0 | 21 | +16 | 4.8% | 4.4 | 31.4 |
| 51 | `connect claude to email` | 1 | +1 | 20 | +18 | 5% | 7.0 | 10.5 |
| 52 | `ionos mail mcp` | 1 | -5 | 19 | +6 | 5.3% | 3.4 | 2.8 |
| 53 | `dreamhost mcp` | 1 | new (0 prev impr) | 18 | new (0 prev impr) | 5.6% | 4.7 | - |
| 54 | `how to connect yahoo mail to chatgpt` | 1 | new (0 prev impr) | 17 | new (0 prev impr) | 5.9% | 2.7 | - |
| 55 | `claude icloud connector` | 1 | +1 | 17 | +2 | 5.9% | 4.6 | 3.8 |
| 56 | `mcp hostgator` | 1 | new (0 prev impr) | 17 | new (0 prev impr) | 5.9% | 6.3 | - |
| 57 | `titan email mcp` | 1 | new (0 prev impr) | 17 | new (0 prev impr) | 5.9% | 6.3 | - |
| 58 | `mcp infomaniak` | 1 | new (0 prev impr) | 17 | new (0 prev impr) | 5.9% | 6.8 | - |
| 59 | `verizon.net` | 1 | new (0 prev impr) | 16 | new (0 prev impr) | 6.2% | 8.4 | - |
| 60 | `apple mail claude connector` | 1 | new (0 prev impr) | 15 | new (0 prev impr) | 6.7% | 6.4 | - |
| 61 | `connect claude to my email` | 1 | +1 | 14 | +13 | 7.1% | 6.1 | 11.0 |
| 62 | `mcp yahoo mail` | 1 | +0 | 13 | +8 | 7.7% | 2.1 | 1.4 |
| 63 | `claude icloud mcp` | 1 | +1 | 13 | +6 | 7.7% | 2.7 | 3.4 |
| 64 | `connect icloud to claude` | 1 | +0 | 12 | -7 | 8.3% | 2.6 | 5.2 |
| 65 | `foxmail mcp` | 1 | +1 | 12 | +9 | 8.3% | 3.9 | 3.0 |
| 66 | `apple mail claude` | 1 | new (0 prev impr) | 11 | new (0 prev impr) | 9.1% | 4.8 | - |
| 67 | `mcpmail` | 1 | new (0 prev impr) | 10 | new (0 prev impr) | 10% | 2.9 | - |
| 68 | `yahoo mail mcp for claude` | 1 | -1 | 9 | -1 | 11.1% | 2.1 | 4.2 |
| 69 | `mcp mail server` | 1 | new (0 prev impr) | 9 | new (0 prev impr) | 11.1% | 3.1 | - |
| 70 | `claude en gmail` | 1 | new (0 prev impr) | 8 | new (0 prev impr) | 12.5% | 3.6 | - |
| 71 | `one.com mcp` | 1 | new (0 prev impr) | 8 | new (0 prev impr) | 12.5% | 4.2 | - |
| 72 | `mcp server email` | 1 | +1 | 7 | +6 | 14.3% | 3.0 | 9.0 |
| 73 | `mcp-email` | 1 | +1 | 6 | +0 | 16.7% | 1.8 | 5.0 |
| 74 | `inbox mcp` | 1 | new (0 prev impr) | 6 | new (0 prev impr) | 16.7% | 4.5 | - |
| 75 | `mcp hotmail` | 1 | new (0 prev impr) | 4 | new (0 prev impr) | 25% | 2.5 | - |
| 76 | `outlook.com mcp` | 1 | new (0 prev impr) | 2 | new (0 prev impr) | 50% | 3.0 | - |
| 77 | `can i use it on an iphone` | 1 | new (0 prev impr) | 1 | new (0 prev impr) | 100% | 1.0 | - |
| 78 | `connect claude to icloud mail` | 1 | new (0 prev impr) | 1 | new (0 prev impr) | 100% | 1.0 | - |
| 79 | `gibt es alternativen?` | 1 | new (0 prev impr) | 1 | new (0 prev impr) | 100% | 1.0 | - |
| 80 | `was ist 2.` | 1 | new (0 prev impr) | 1 | new (0 prev impr) | 100% | 1.0 | - |
| 81 | `which is best` | 1 | new (0 prev impr) | 1 | new (0 prev impr) | 100% | 1.0 | - |
| 82 | `which is the best` | 1 | new (0 prev impr) | 1 | new (0 prev impr) | 100% | 1.0 | - |
| 83 | `hey.com api` | 1 | new (0 prev impr) | 1 | new (0 prev impr) | 100% | 2.0 | - |
| 84 | `i dont understand step 2` | 1 | new (0 prev impr) | 1 | new (0 prev impr) | 100% | 2.0 | - |
| 85 | `на русском пожалуйста` | 1 | new (0 prev impr) | 1 | new (0 prev impr) | 100% | 2.0 | - |
| 86 | `domain.co.za` | 1 | new (0 prev impr) | 1 | new (0 prev impr) | 100% | 3.0 | - |
| 87 | `xneelo` | 1 | new (0 prev impr) | 1 | new (0 prev impr) | 100% | 3.0 | - |
| 88 | `otro` | 1 | new (0 prev impr) | 1 | new (0 prev impr) | 100% | 6.0 | - |
| 89 | `10` | 1 | new (0 prev impr) | 1 | new (0 prev impr) | 100% | 7.0 | - |
| 90 | `imap online.no` | 1 | new (0 prev impr) | 1 | new (0 prev impr) | 100% | 9.0 | - |
| 91 | `laposte.net email` | 0 | new (0 prev impr) | 635 | new (0 prev impr) | 0% | 3.1 | - |
| 92 | `fastmail mcp` | 0 | +0 | 169 | +49 | 0% | 10.1 | 9.8 |
| 93 | `kpnmail` | 0 | new (0 prev impr) | 161 | new (0 prev impr) | 0% | 7.2 | - |
| 94 | `ex4.mail.ovh.net smtp` | 0 | new (0 prev impr) | 125 | new (0 prev impr) | 0% | 9.4 | - |
| 95 | `"invoices@"` | 0 | new (0 prev impr) | 123 | new (0 prev impr) | 0% | 66.2 | - |
| 96 | `email mcp connector` | 0 | +0 | 114 | +96 | 0% | 2.4 | 4.7 |
| 97 | `siteground mcp` | 0 | new (0 prev impr) | 88 | new (0 prev impr) | 0% | 6.4 | - |
| 98 | `aol mail login` | 0 | new (0 prev impr) | 85 | new (0 prev impr) | 0% | 4.0 | - |
| 99 | `what mcp servers work with claude desktop for email?` | 0 | new (0 prev impr) | 71 | new (0 prev impr) | 0% | 4.9 | - |
| 100 | `aol verizon email` | 0 | new (0 prev impr) | 68 | new (0 prev impr) | 0% | 4.6 | - |
| 101 | `purelymail smtp` | 0 | new (0 prev impr) | 60 | new (0 prev impr) | 0% | 7.4 | - |
| 102 | `icloud mcp server` | 0 | -1 | 57 | +28 | 0% | 5.7 | 5.0 |
| 103 | `how to hook uo ai to my email to` | 0 | +0 | 56 | +47 | 0% | 8.4 | 7.8 |
| 104 | `"invoices@" -gmail -yahoo -hotmail` | 0 | new (0 prev impr) | 56 | new (0 prev impr) | 0% | 65.8 | - |
| 105 | `mail ru connexion` | 0 | new (0 prev impr) | 55 | new (0 prev impr) | 0% | 4.6 | - |
| 106 | `claude icloud` | 0 | -1 | 54 | +42 | 0% | 6.2 | 6.1 |
| 107 | `telenetinbox` | 0 | new (0 prev impr) | 54 | new (0 prev impr) | 0% | 8.7 | - |
| 108 | `sapo mail` | 0 | new (0 prev impr) | 51 | new (0 prev impr) | 0% | 7.3 | - |
| 109 | `zimbra mcp` | 0 | new (0 prev impr) | 49 | new (0 prev impr) | 0% | 6.0 | - |
| 110 | `163mail` | 0 | new (0 prev impr) | 48 | new (0 prev impr) | 0% | 8.1 | - |
| 111 | `orange mail` | 0 | new (0 prev impr) | 46 | new (0 prev impr) | 0% | 8.0 | - |
| 112 | `riseup mcp` | 0 | new (0 prev impr) | 45 | new (0 prev impr) | 0% | 9.1 | - |
| 113 | `verizon aol email` | 0 | new (0 prev impr) | 42 | new (0 prev impr) | 0% | 2.2 | - |
| 114 | `purelymail imap` | 0 | new (0 prev impr) | 40 | new (0 prev impr) | 0% | 8.8 | - |
| 115 | `o2.pl` | 0 | new (0 prev impr) | 39 | new (0 prev impr) | 0% | 8.5 | - |
| 116 | `gmail mcp` | 0 | +0 | 37 | +24 | 0% | 34.5 | 43.8 |
| 117 | `gmail mcp server pricing free google account` | 0 | +0 | 36 | -13 | 0% | 6.9 | 9.7 |
| 118 | `o2. pl` | 0 | new (0 prev impr) | 33 | new (0 prev impr) | 0% | 5.4 | - |
| 119 | `disroot mail` | 0 | new (0 prev impr) | 33 | new (0 prev impr) | 0% | 8.1 | - |
| 120 | `fastmail chatgpt` | 0 | +0 | 30 | +9 | 0% | 7.6 | 8.4 |
| 121 | `orange mail login` | 0 | new (0 prev impr) | 29 | new (0 prev impr) | 0% | 2.9 | - |
| 122 | `bigpond` | 0 | new (0 prev impr) | 29 | new (0 prev impr) | 0% | 8.0 | - |

Notable previous-period queries that disappeared or fell (prev 28d): `icloud mcp claude` 2 clicks/33 impr; `gmx mcp` 1/18; `fastmail mcp claude` 1/15; `connect claude to icloud` 1/11; Spanish "agentes de ia" inbox queries 72+65+19+11 impr at 0 clicks; `zoho mcp connector` 17 impr pos 33.5.

Query observations (measured): brand queries (`mcpemails`, `mcp emails`, `mcp email`, `mcpemail`, `mcpmail`) = 107 of 278 visible clicks (38%); `mcpemails` went 3 -> 48 clicks. Generic head terms rank on page 1 but convert poorly: `email mcp` 412 impr pos 5.2 CTR 3.9%; `email mcp server` 229 impr pos 8.9 (was 18.6) CTR 1.3%; `icloud mcp` 207 impr pos 6.7, 1 click; `fastmail mcp` 169 impr pos 10.1, 0 clicks; `email mcp connector` 114 impr pos 2.4, 0 clicks. Off-intent provider-login queries collect impressions at 0 clicks: `laposte.net email` 635 impr pos 3.1, `kpnmail` 161, `aol mail login` 85, `aol verizon email` 68, `mail ru connexion` 55, `telenetinbox` 54, `sapo mail` 51, `163mail` 48, `orange mail` 46. `gmail mcp` pos 34.5 (Gmail lost territory, as known).

### Top pages (current 28d, by clicks, then zero-click pages by impressions). Current list: 669 page rows; previous: 133 page rows (prev only partially captured below ~3 impressions).
| # | Page | Clicks | Δ clicks | Impr | Δ impr | CTR | Pos | Prev pos |
|---|---|---|---|---|---|---|---|---|
| 1 | `/` | 254 | +170 | 4,841 | +2,877 | 5.2% | 6.8 | 8.3 |
| 2 | `/connect/yahoo` | 235 | +120 | 3,875 | +1,639 | 6.1% | 3.2 | 4.4 |
| 3 | `/connect/icloud` | 134 | +61 | 3,680 | +1,396 | 3.6% | 4.2 | 5.2 |
| 4 | `/blog/connect-claude-to-email` | 79 | +58 | 4,051 | +3,289 | 2% | 6.2 | 7.6 |
| 5 | `/blog/claude-imap-connector` | 42 | +29 | 815 | +629 | 5.2% | 5.7 | 6.5 |
| 6 | `/connect/ionos` | 37 | -14 | 634 | +119 | 5.8% | 16.0 | 5.1 |
| 7 | `/fr/connect/icloud` | 29 | +9 | 522 | +199 | 5.6% | 5.0 | 5.1 |
| 8 | `/connect/imap` | 24 | +20 | 849 | +668 | 2.8% | 20.8 | 7.1 |
| 9 | `/blog/connect-chatgpt-to-email` | 20 | +17 | 554 | +537 | 3.6% | 6.4 | 7.4 |
| 10 | `/es` | 19 | +14 | 179 | +113 | 10.6% | 4.5 | 16.3 |
| 11 | `/fr` | 15 | +13 | 226 | +165 | 6.6% | 4.7 | 8.0 |
| 12 | `/connect/namecheap` | 15 | n/a (prev not captured, small or absent) | 145 | n/a (prev not captured, small or absent) | 10.3% | 4.9 | - |
| 13 | `/zh/blog/connect-chatgpt-to-email` | 14 | n/a (prev not captured, small or absent) | 203 | n/a (prev not captured, small or absent) | 6.9% | 5.9 | - |
| 14 | `/es/blog/multiple-email-accounts-in-claude-and-chatgpt` | 13 | n/a (prev not captured, small or absent) | 287 | n/a (prev not captured, small or absent) | 4.5% | 4.2 | - |
| 15 | `/fr/connect/yahoo` | 12 | -2 | 79 | +13 | 15.2% | 3.1 | 3.0 |
| 16 | `/connect/strato` | 12 | +12 | 64 | +61 | 18.8% | 4.0 | 3.7 |
| 17 | `/fr/connect/ovh` | 11 | n/a (prev not captured, small or absent) | 304 | n/a (prev not captured, small or absent) | 3.6% | 8.4 | - |
| 18 | `/connect/gmail` | 10 | +5 | 978 | +228 | 1% | 9.6 | 16.9 |
| 19 | `/connect/hey` | 10 | n/a (prev not captured, small or absent) | 338 | n/a (prev not captured, small or absent) | 3% | 6.3 | - |
| 20 | `/es/connect/cpanel` | 10 | n/a (prev not captured, small or absent) | 96 | n/a (prev not captured, small or absent) | 10.4% | 4.2 | - |
| 21 | `/blog/connect-email-to-ai-agent-under-2-minutes` | 9 | +0 | 403 | +59 | 2.2% | 6.4 | 7.0 |
| 22 | `/connect` | 9 | +6 | 304 | +177 | 3% | 9.2 | 8.3 |
| 23 | `/self-hosting` | 8 | +6 | 169 | +18 | 4.7% | 17.5 | 13.8 |
| 24 | `/zh/connect/qq` | 8 | n/a (prev not captured, small or absent) | 147 | n/a (prev not captured, small or absent) | 5.4% | 5.2 | - |
| 25 | `/fr/connect/infomaniak` | 7 | n/a (prev not captured, small or absent) | 122 | n/a (prev not captured, small or absent) | 5.7% | 5.5 | - |
| 26 | `/es/blog/connect-gmail-to-claude` | 6 | n/a (prev not captured, small or absent) | 1,691 | n/a (prev not captured, small or absent) | 0.4% | 6.0 | - |
| 27 | `/blog/multiple-email-accounts-in-claude-and-chatgpt` | 6 | n/a (prev not captured, small or absent) | 306 | n/a (prev not captured, small or absent) | 2% | 5.7 | - |
| 28 | `/fr/blog/connect-chatgpt-to-email` | 6 | n/a (prev not captured, small or absent) | 299 | n/a (prev not captured, small or absent) | 2% | 6.6 | - |
| 29 | `/pricing` | 6 | +6 | 268 | +128 | 2.2% | 4.9 | 6.6 |
| 30 | `/connect/cpanel` | 6 | n/a (prev not captured, small or absent) | 187 | n/a (prev not captured, small or absent) | 3.2% | 5.6 | - |
| 31 | `/fr/blog/claude-imap-connector` | 6 | +2 | 110 | +84 | 5.5% | 4.0 | 2.7 |
| 32 | `/connect/ovh` | 6 | n/a (prev not captured, small or absent) | 91 | n/a (prev not captured, small or absent) | 6.6% | 6.1 | - |
| 33 | `/es/connect/icloud` | 6 | -3 | 88 | +22 | 6.8% | 4.5 | 4.7 |
| 34 | `/connect/rackspace` | 6 | n/a (prev not captured, small or absent) | 58 | n/a (prev not captured, small or absent) | 10.3% | 11.8 | - |
| 35 | `/connect/icewarp` | 6 | n/a (prev not captured, small or absent) | 30 | n/a (prev not captured, small or absent) | 20% | 3.7 | - |
| 36 | `/docs/chatgpt` | 5 | n/a (prev not captured, small or absent) | 677 | n/a (prev not captured, small or absent) | 0.7% | 12.8 | - |
| 37 | `/es/connect/hostinger` | 5 | n/a (prev not captured, small or absent) | 199 | n/a (prev not captured, small or absent) | 2.5% | 7.5 | - |
| 38 | `/connect/zimbra` | 5 | +3 | 178 | +173 | 2.8% | 5.2 | 2.0 |
| 39 | `/es/docs/chatgpt` | 5 | n/a (prev not captured, small or absent) | 128 | n/a (prev not captured, small or absent) | 3.9% | 5.8 | - |
| 40 | `/fr/connect/zimbra` | 5 | n/a (prev not captured, small or absent) | 93 | n/a (prev not captured, small or absent) | 5.4% | 7.9 | - |
| 41 | `/connect/mdaemon` | 5 | n/a (prev not captured, small or absent) | 17 | n/a (prev not captured, small or absent) | 29.4% | 2.7 | - |
| 42 | `/es/connect/office365` | 4 | n/a (prev not captured, small or absent) | 273 | n/a (prev not captured, small or absent) | 1.5% | 7.6 | - |
| 43 | `/connect/yandex` | 4 | -3 | 262 | +23 | 1.5% | 4.9 | 5.8 |
| 44 | `/es/connect/outlook` | 4 | n/a (prev not captured, small or absent) | 243 | n/a (prev not captured, small or absent) | 1.6% | 6.8 | - |
| 45 | `/blog/email-signatures-for-claude` | 4 | +0 | 212 | +55 | 1.9% | 6.0 | 7.1 |
| 46 | `/es/blog/connect-email-to-ai-agent-under-2-minutes` | 4 | +1 | 184 | -141 | 2.2% | 6.5 | 7.7 |
| 47 | `/fr/connect/laposte` | 4 | n/a (prev not captured, small or absent) | 135 | n/a (prev not captured, small or absent) | 3% | 13.2 | - |
| 48 | `/fr/blog/multiple-email-accounts-in-claude-and-chatgpt` | 4 | n/a (prev not captured, small or absent) | 115 | n/a (prev not captured, small or absent) | 3.5% | 6.8 | - |
| 49 | `/connect/aol` | 4 | -15 | 107 | -133 | 3.7% | 3.4 | 5.2 |
| 50 | `/docs/claude` | 4 | n/a (prev not captured, small or absent) | 77 | n/a (prev not captured, small or absent) | 5.2% | 6.8 | - |
| 51 | `/connect/gmx` | 4 | -36 | 53 | -345 | 7.5% | 4.3 | 4.3 |
| 52 | `/es/docs/claude` | 4 | n/a (prev not captured, small or absent) | 51 | n/a (prev not captured, small or absent) | 7.8% | 6.9 | - |
| 53 | `/connect/web-de` | 4 | n/a (prev not captured, small or absent) | 43 | n/a (prev not captured, small or absent) | 9.3% | 4.3 | - |
| 54 | `/es/connect/zimbra` | 4 | n/a (prev not captured, small or absent) | 37 | n/a (prev not captured, small or absent) | 10.8% | 4.5 | - |
| 55 | `/connect/purelymail` | 3 | n/a (prev not captured, small or absent) | 433 | n/a (prev not captured, small or absent) | 0.7% | 7.3 | - |
| 56 | `/connect/siteground` | 3 | n/a (prev not captured, small or absent) | 196 | n/a (prev not captured, small or absent) | 1.5% | 6.3 | - |
| 57 | `/connect/proton` | 3 | +3 | 178 | +167 | 1.7% | 7.3 | 6.4 |
| 58 | `/blog/connect-gmail-to-claude` | 3 | +2 | 154 | -134 | 1.9% | 8.4 | 20.8 |
| 59 | `/blog/manage-multiple-email-accounts-with-ai` | 3 | n/a (prev not captured, small or absent) | 154 | n/a (prev not captured, small or absent) | 1.9% | 9.0 | - |
| 60 | `/fr/connect/orange-fr` | 3 | n/a (prev not captured, small or absent) | 125 | n/a (prev not captured, small or absent) | 2.4% | 15.8 | - |
| 61 | `/connect/infomaniak` | 3 | +2 | 74 | +34 | 4.1% | 4.7 | 5.0 |
| 62 | `/zh/connect/icloud` | 3 | +0 | 66 | +8 | 4.5% | 5.2 | 5.9 |
| 63 | `/connect/posteo` | 3 | n/a (prev not captured, small or absent) | 63 | n/a (prev not captured, small or absent) | 4.8% | 7.7 | - |
| 64 | `/zh/docs/chatgpt` | 3 | n/a (prev not captured, small or absent) | 56 | n/a (prev not captured, small or absent) | 5.4% | 8.2 | - |
| 65 | `/es/connect/imap` | 3 | n/a (prev not captured, small or absent) | 48 | n/a (prev not captured, small or absent) | 6.2% | 2.6 | - |
| 66 | `/connect/plesk` | 3 | n/a (prev not captured, small or absent) | 30 | n/a (prev not captured, small or absent) | 10% | 5.7 | - |
| 67 | `/connect/greengeeks` | 3 | n/a (prev not captured, small or absent) | 24 | n/a (prev not captured, small or absent) | 12.5% | 4.0 | - |
| 68 | `/zh/blog/connect-email-to-ai-agent-under-2-minutes` | 3 | +0 | 16 | -7 | 18.8% | 4.7 | 7.8 |
| 69 | `/fr/connect/poste-io` | 3 | n/a (prev not captured, small or absent) | 16 | n/a (prev not captured, small or absent) | 18.8% | 4.8 | - |
| 70 | `/fr/connect/gmail` | 3 | n/a (prev not captured, small or absent) | 16 | n/a (prev not captured, small or absent) | 18.8% | 6.2 | - |
| 71 | `/blog/extract-email-attachments-for-ai` | 2 | -5 | 458 | +28 | 0.4% | 7.4 | 8.1 |
| 72 | `/connect/tutanota` | 2 | +2 | 282 | +273 | 0.7% | 7.8 | 5.9 |
| 73 | `/docs` | 2 | +2 | 150 | -157 | 1.3% | 13.3 | 20.8 |
| 74 | `/connect/laposte` | 0 | n/a (prev not captured, small or absent) | 712 | n/a (prev not captured, small or absent) | 0% | 3.7 | - |
| 75 | `/connect/verizon` | 0 | +0 | 296 | +290 | 0% | 9.1 | 6.2 |
| 76 | `/connect/hostinger` | 0 | n/a (prev not captured, small or absent) | 285 | n/a (prev not captured, small or absent) | 0% | 7.9 | - |
| 77 | `/connect/kpn` | 0 | n/a (prev not captured, small or absent) | 274 | n/a (prev not captured, small or absent) | 0% | 8.6 | - |
| 78 | `/connect/disroot` | 0 | n/a (prev not captured, small or absent) | 223 | n/a (prev not captured, small or absent) | 0% | 6.6 | - |
| 79 | `/docs/providers` | 0 | +0 | 161 | +128 | 0% | 9.6 | 7.8 |
| 80 | `/blog/gmail-labels-vs-imap-folders-ai-agents` | 0 | +0 | 144 | -56 | 0% | 8.1 | 8.1 |
| 81 | `/native-connectors-vs-mcp` | 0 | +0 | 140 | +20 | 0% | 9.9 | 12.0 |
| 82 | `/docs/cursor` | 0 | n/a (prev not captured, small or absent) | 88 | n/a (prev not captured, small or absent) | 0% | 29.5 | - |
| 83 | `/connect/bigpond` | 0 | n/a (prev not captured, small or absent) | 74 | n/a (prev not captured, small or absent) | 0% | 12.7 | - |
| 84 | `/connect/orange-fr` | 0 | n/a (prev not captured, small or absent) | 74 | n/a (prev not captured, small or absent) | 0% | 7.4 | - |
| 85 | `/for/founders` | 0 | -1 | 64 | +16 | 0% | 5.0 | 8.2 |
| 86 | `/connect/centurylink` | 0 | n/a (prev not captured, small or absent) | 55 | n/a (prev not captured, small or absent) | 0% | 16.0 | - |

Notable previous-period pages that fell: `/connect/gmx` 40 -> 4 clicks (398 -> 53 impr); `/connect/aol` 19 -> 4 (240 -> 107 impr); `/connect/ionos` 51 -> 37 with **pos 5.1 -> 16.0**; `/connect/fastmail` 6 clicks/861 impr prev, not in current top-75 by clicks (was pos 7.4); `/connect/imap` pos 7.1 -> 20.8 though clicks 4 -> 24; `/es/connect/zoho` 37 impr pos 23.9; `/blog` index 251 impr pos 29.4 prev.

### Clicks by section and locale (current 28d, page aggregation; clicks / impressions / page count)
| Locale | Home | /connect/* | /blog/* | /docs* | Other | Total clicks |
|---|---|---|---|---|---|---|
| en | 254 / 4,841 / 1 | 594 / 18,139 / 99 | 170 / 7,814 / 39 | 14 / 1,421 / 16 | 31 / 1,832 / 23 | 1,063 |
| fr | 15 / 226 | 90 / 2,422 / 91 | 22 / 774 / 23 | 1 / 136 / 10 | 2 / 26 | 130 |
| es | 19 / 179 | 54 / 2,781 / 95 | 27 / 2,443 / 16 | 11 / 437 / 14 | 2 / 66 | 113 |
| zh | 0 / 68 | 34 / 1,136 / 82 | 21 / 405 / 13 | 6 / 140 / 13 | 0 / 15 | 61 |
| nb | 1 / 13 | 6 / 511 / 82 | 5 / 322 / 13 | 0 / 90 / 9 | 0 / 25 | 12 |

Non-English = ~316 clicks (23%) and ~12.9K impr. Top-3 pages (/, /connect/yahoo, /connect/icloud) = 623 clicks (45%); top-4 incl. /blog/connect-claude-to-email = 702 (51%). Largest zero-click pages: /connect/laposte 712 impr pos 3.7; /connect/verizon 296; /connect/hostinger 285; /connect/kpn 274; /connect/disroot 223; /docs/providers 161; /es/blog/connect-gmail-to-claude 1,691 impr for 6 clicks (0.4%).

## 3. Countries, devices, search appearance

### Countries (top 30 current; prev for comparison)
| Country | Clicks cur | Impr cur | CTR cur | Pos cur | Clicks prev | Impr prev | CTR prev | Pos prev |
|---|---|---|---|---|---|---|---|---|
| United States | 244 | 9,688 | 2.5% | 8.2 | 118 | 4,928 | 2.4% | 7.9 |
| France | 166 | 3,233 | 5.1% | 7.0 | 56 | 708 | 7.9% | 5.7 |
| United Kingdom | 105 | 2,376 | 4.4% | 5.8 | 44 | 943 | 4.7% | 5.6 |
| Germany | 94 | 1,875 | 5.0% | 6.1 | 91 | 959 | 9.5% | 4.9 |
| Spain | 74 | 2,867 | 2.6% | 6.7 | 26 | 510 | 5.1% | 8.8 |
| Canada | 48 | 1,365 | 3.5% | 6.2 | 25 | 439 | 5.7% | 5.7 |
| Australia | 46 | 1,203 | 3.8% | 7.0 | 12 | 456 | 2.6% | 8.0 |
| Netherlands | 33 | 855 | 3.9% | 10.8 | 10 | 308 | 3.2% | 6.6 |
| India | 30 | 1,191 | 2.5% | 7.1 | 16 | 448 | 3.6% | 13.8 |
| Italy | 28 | 546 | 5.1% | 5.9 | 13 | 145 | 9.0% | 5.2 |
| China | 25 | 435 | 5.7% | 6.3 | 9 | 108 | 8.3% | 6.5 |
| Belgium | 23 | 536 | 4.3% | 6.1 | 11 | 130 | 8.5% | 5.3 |
| Singapore | 23 | 467 | 4.9% | 5.0 | 4 | 165 | 2.4% | 5.2 |
| Norway | 22 | 847 | 2.6% | 6.2 | 18 | 345 | 5.2% | 4.8 |
| Switzerland | 21 | 455 | 4.6% | 6.1 | 7 | 159 | 4.4% | 5.8 |
| Mexico | 19 | 819 | 2.3% | 6.0 | 4 | 202 | 2.0% | 13.8 |
| Poland | 18 | 420 | 4.3% | 7.2 | 4 | 116 | 3.4% | 5.8 |
| Brazil | 17 | 1,117 | 1.5% | 6.4 | 9 | 307 | 2.9% | 5.2 |
| Portugal | 17 | 282 | 6.0% | 5.3 | 4 | 79 | 5.1% | 4.9 |
| Malaysia | 17 | 239 | 7.1% | 6.2 | n/a | | | |
| Chile | 16 | 477 | 3.4% | 5.9 | 4 | 45 | 8.9% | 6.5 |
| Japan | 16 | 430 | 3.7% | 6.9 | 3 | 152 | 2.0% | 5.1 |
| Sweden | 16 | 336 | 4.8% | 5.3 | n/a | | | |
| UAE | 13 | 263 | 4.9% | 5.5 | 3 | 115 | 2.6% | 5.3 |
| South Africa | 13 | 244 | 5.3% | 5.9 | 5 | 107 | 4.7% | 5.4 |
| Indonesia | 12 | 324 | 3.7% | 8.8 | 3 | 116 | 2.6% | 17.4 |
| Russia | 12 | 276 | 4.3% | 7.0 | 6 | 101 | 5.9% | 7.9 |
| Czechia | 12 | 245 | 4.9% | 4.5 | n/a | | | |
| Austria | 11 | 239 | 4.6% | 8.1 | 5 | 111 | 4.5% | 4.9 |
| Colombia | 10 | 664 | 1.5% | 6.1 | 6 | 67 | 9.0% | 6.4 |

195 countries current vs 158 prev. **Germany is flat (91 -> 94 clicks) while impressions doubled and CTR halved (9.5% -> 5.0%)**; it fell from #2 to #4 behind France (+196%) and UK (+139%). US is 18% of clicks.

### Devices
| Device | Clicks cur | Impr cur | CTR | Pos | Clicks prev | Impr prev | CTR prev | Pos prev |
|---|---|---|---|---|---|---|---|---|
| Desktop | 1,053 | 32,202 | 3.3% | 7.2 | 450 | 11,356 | 4.0% | 8.4 |
| Mobile | 305 | 9,370 | 3.3% | 6.5 | 136 | 3,199 | 4.3% | 6.1 |
| Tablet | 16 | 210 | 7.6% | 5.2 | 3 | 55 | 5.5% | 4.3 |

Desktop = 77% of clicks (stable share).

### Search appearance
| Appearance | Clicks cur | Impr cur | CTR | Pos | Prev |
|---|---|---|---|---|---|
| Review snippet | 25 | 362 | 6.9% | 5.2 | 0 clicks / 3 impr / pos 39.3 |
| Translated results | 0 | 3 | 0% | 3.7 | n/a |

Insights "additional traffic sources": Image search 1 click.

## 4. Indexing > Pages (report last updated 2026-10-12)
| Status | Pages |
|---|---|
| Indexed | **712** |
| Not indexed | **66** (6 reasons) |

(Historical: 178 indexed / 125 not on 09-22; 211 / 116 on 09-24. Indexed count has more than tripled.)

| Reason | Source | Validation | Pages | All example URLs shown (last crawled) |
|---|---|---|---|---|
| Crawled - currently not indexed | Google | **Failed** | 12 | /connect/a2hosting (10-13), /es/privacy (10-13), /demo/connect-and-triage.nb.vtt (10-12), /.well-known/oauth-authorization-server (10-11), /fr/privacy (10-10), /demo/connect-and-triage.es.vtt (10-06), /_next/static/immutable/media/geist-latin...woff2 (10-06), /_next/static/chunks/42mxepx3uxfn7.css?dpl=... (09-22), /_next/static/chunks/2_y4ehmns9-ac.js?dpl=... (09-17), /es/docs (09-15), /_next/static/chunks/3xicyc81bcvon.css?dpl=... (08-04), /nb/blog/hosted-vs-self-hosted-gmail-mcp-server (06-04) |
| Not found (404) | Website | Not started | 14 | **/es/best-email-mcp-servers (10-13), /fr/best-email-mcp-servers (10-12), /nb/best-email-mcp-servers (10-12), /zh/best-email-mcp-servers (10-10)**, /NVW20ZF537ilHk+QqEMPQ== (10-12), /.well-known/ (10-11), /forever (10-09), 2x /_next/static/chunks/05~upq48xw_p0.js?dpl=... (10-09, 10-06), /zKaEPSmffHQYw/pM12YJw== (10-04), /5dbq6sIna7VTptMjWR8Tw== (10-02), /sKSl14Aor/9+epMvqmMqQ== (10-02), /gMI68qui8hpF5N6PHVLpA== (09-30), /zh/connect/bluehost (09-22) |
| Alternate page with proper canonical tag | Website | Not started | 14 | /es,/nb,/fr variants of blog posts ai-agent-email-workflows-and-prompts, extract-email-attachments-for-ai, prevent-duplicate-ai-agent-email-sends, approve-ai-agent-email-sends, gmail-labels-vs-imap-folders-ai-agents (crawled 08-04..10-10) |
| Blocked by robots.txt | Website | Not started | 13 | /signup?redirect=/api/stripe/checkout/start?plan=... (solo/pro/personal, month/year; 5 URLs), /signup?provider=hushmail, proton, zimbra, online-no, /signup, /login, /dashboard, /api/mcp |
| Page with redirect | Website | Not started | 6 | https://www.mcpemails.com/, http://mcpemails.com/, http://www.mcpemails.com/, /es/, /zh/, /fr/ (harmless) |
| Discovered - currently not indexed | Google | **Passed** | 7 | /blog/7-things-ai-agent-can-do-with-inbox-access, /blog/build-email-auto-responder-mcp-agent, /blog/connect-outlook-microsoft-365-ai-agent-mcp, /blog/hosted-vs-self-hosted-gmail-mcp-server, /blog/what-is-an-mcp-email-server, /connect/google-workspace, /docs/clients (all "last crawled N/A") |

Live HTTP check today (curl): /best-email-mcp-servers 200; /es/ and /fr/best-email-mcp-servers **404** (English-only page; localized URLs still being discovered, source not verified, likely the locale switcher or internal links); /forever 404; /connect/a2hosting, /zh/connect/bluehost, /blog/what-is-an-mcp-email-server, /connect/google-workspace, /docs/clients all 200. Live sitemap lists /best-email-mcp-servers with en + x-default hreflang only (no localized alternates). The base64-looking 404 paths (e.g. /NVW20ZF537ilHk+QqEMPQ==) look like junk/externally generated URLs (inference).

## 5. Sitemaps
| Sitemap | Type | Submitted | Last read | Status | Discovered pages | Videos |
|---|---|---|---|---|---|---|
| https://mcpemails.com/sitemap.xml | Sitemap | 2026-08-31 | **2026-10-19** | Success | **163** | 0 |

Matches the live sitemap (163 `<loc>`). Indexed (712) is far above 163 because localized pages are found via hreflang alternates, not listed as `<loc>`.

## 6. Core Web Vitals
| Device | Status |
|---|---|
| Mobile | "Not enough usage data in the last 90 days" (no CrUX field data) |
| Desktop | "Not enough usage data in the last 90 days" |

HTTPS report: 82 HTTPS URLs, 0 non-HTTPS, no issues.

## 7. Enhancements, manual actions, security
| Report | Valid | Invalid | Notes |
|---|---|---|---|
| Breadcrumbs | 87 | 0 | no issues in 90 days |
| Review snippets | 10 | 0 | no issues; produced 25 clicks / 362 impr in current 28d |
| Product snippets | 1 | 0 | non-critical: missing "aggregateRating", missing "review" (1 item each) |
| Merchant listings | 1 | 0 | earlier "Missing field image" invalid now validation **Passed** (0); non-critical: missing hasMerchantReturnPolicy, shippingDetails (in offers), invalid object type for "brand" (1 each) |
| FAQ / HowTo / other | not present in the GSC sidebar (no report shown) | | |
| Videos | report exists in sidebar; sitemap shows 0 videos | | not opened |
| Manual actions | No issues detected | | |
| Security issues | No issues detected | | |

## 8. Links report
| Metric | Value |
|---|---|
| External links total | **175** |
| Linking sites (root domains) | **45** |
| Internal links total | 4,745 |

### Top linked pages (external)
| Target | Incoming links | Linking sites |
|---|---|---|
| / | 111 | 45 |
| /pricing | 30 | 8 |
| /security | 17 | 4 |
| /about | 11 | 1 |
| /connect | 2 | 2 |
| /docs | 2 | 1 |
| /docs/vscode | 2 | 2 |

No /connect/<provider> or /blog page has any external link.

### All 45 linking sites (linking pages / target pages)
| Site | Links | Targets |
|---|---|---|
| mcpservers.org | 53 | 5 |
| trustpilot.com | 19 | 1 |
| lobehub.com | 18 | 3 |
| github.com | 17 | 5 |
| claudeskills.info | 5 | 1 |
| glama.ai | 5 | 4 |
| reddit.com | 5 | 1 |
| mcp.tc | 3 | 1 |
| mcpfield.com | 3 | 3 |
| mcpvault.io | 3 | 1 |
| agentery.com, ai-visibility.org.uk, aiboardmeeting.com, emailforagents.ai, linkedin.com, mailbox-mcp.com, shipmail.to, tracevero.com, unyly.org | 2 each | 1-2 |
| agentuni.ai, aiagentboard.org, albretsen.no, anchorterminal.com, crossaitools.com, cursor.directory, electraindex.com, faceabot.com, fewservers.com, findmcp.app, freemcp.space, getdrio.com, llmmart.ai, mcpi.app, mcpindex.ai, mcpnav.net, metatext.io, musedirectory.ai, pulsemcp.com, rateme12.com, rokmcp.com, skillsplayground.com, smithery.ai, sourceweft.com, syncdev.com, yarnpkg.com | 1 each | 1 |

(GSC does not show follow/nofollow. Note emailforagents.ai, mailbox-mcp.com, shipmail.to look like competitor/adjacent email-for-agents products linking in.)

### Top linking text (67 total; top 25 by rank)
mcpemails com; security; pricing; https mcpemails com; asgeir albretsen; see full feature comparison; visit website; mcp emails logo; website; com mcpemails emails; visitar o site; visiter le site web; zur website; (empty); homepage; besök webbplatsen; besøg websitet; besøk nettstedet; bezoek de website; docs; logo de mcp emails; logo mcp emails; mcp emails; mcpemails; mcpemails com connect.

No descriptive keyword anchors (e.g. "email MCP server", "Yahoo Mail MCP") in the top 25; anchors are brand/navigational, "visit website" in 8 languages (directory boilerplate).

### Internal top linked pages
/pricing 196; / 189; /security 174; /connect 166; /terms 164; /zh 164; /docs/providers 163; /self-hosting 163; /es 162; /connect/icloud 161.
