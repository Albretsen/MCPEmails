"""Writes home-lab/baseline.md from extract_baseline.py output.

Usage: python3 -I home-lab/write_baseline.py <baseline.json> [gsc.md] [lighthouse.md]
"""
import json
import sys

a = json.load(open(sys.argv[1]))
faq = json.load(open('apps/web/messages/en/home.json'))['faq']['items']
extra = [open(p).read() for p in sys.argv[2:]]
L = []
L.append('# Homepage SEO baseline (English, https://mcpemails.com/)\n')
L.append('Captured 2026-11-12 14:57 Oslo from the production HTML (no JavaScript). Staging renders the same page. '
         'Re-run with `python3 -I home-lab/extract_baseline.py <file.html> > out.json`.\n')
L.append('## Head\n')
L.append(f'- `<title>`: {a["title"]}')
L.append('  - The `· mcpemails` suffix belongs to the running snippet CTR test (PR #159). Variants never change metadata: '
         '`generateMetadata` in `app/[locale]/page.tsx` stays as it is for every variant.')
L.append(f'- meta description: {a["description"]}')
L.append("- canonical and hreflang (`metaAlternates(locale, '')`):")
for h, u in a['alternates']:
    L.append(f'  - {h}: {u}')
L.append('\n## Headings (document order)\n')
for t, h in a['headings']:
    L.append(f'- {t.upper()}: {h}')
L.append('\nNote: the current features section hard-codes a tool count ("Twenty-one focused tools"). Variants must not.\n')
L.append('## First 150 words (rendered text, nav included)\n')
L.append('> ' + a['first150'] + '\n')
L.append(f'## Word count\n\n{a["word_count"]} words of visible text (nav, footer and FAQ answers included, scripts excluded). '
         'Every variant renders at least this many, in real sections.\n')
L.append('## Main terms the title, H1 and first paragraph keep\n')
L.append('email MCP server, MCPEmails, Claude, ChatGPT, connector, Gmail, Outlook, IMAP (plus iCloud, Fastmail in the first paragraph), '
         'and the fact that mail is fetched live and never stored.\n')
for e in extra:
    L.append(e)
L.append('## Internal links (every one stays reachable from the page)\n')
for link in a['internal_links']:
    L.append(f'- `{link}`')
L.append('\n## External links\n')
for link in a['external_links']:
    L.append(f'- {link}')
L.append('\n## FAQ (`home.faq.items`, shown on the page and mirrored in the FAQPage JSON-LD)\n')
for f in faq:
    L.append(f'- {f["q"]}')
L.append('\n## JSON-LD\n')
L.append('Built by `homeJsonLd()` in `apps/web/src/i18n/seo.ts` and rendered by `app/[locale]/page.tsx` for every variant. '
         'One `@graph`: Organization, WebSite, SoftwareApplication (featureList, offers from `planOffers`, review markup from '
         '`components/marketing/reviews.mjs`), FAQPage (`#faq`, the same `home.faq.items`). Node types found:\n')
for g in a['jsonld']:
    for n in g.get('@graph', [g]):
        L.append(f'- {n.get("@type")} {n.get("@id", "")}')
L.append('\n## Images in the HTML\n')
for i in a['images']:
    L.append(f'- {i}')
open('home-lab/baseline.md', 'w').write('\n'.join(L) + '\n')
print('wrote home-lab/baseline.md')
