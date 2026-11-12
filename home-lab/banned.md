# Banned: the generic "Claude look"

Every Homepage Lab variant avoids all of these. The review step greps for them, and a variant that ships one goes back to its builder.

## Visual clichés
- Green pulsing or blinking "live" dots, status pills, fake terminals with traffic-light buttons.
- A centred hero with a pill badge above the H1. (Marketing layout on this site is left-aligned: never centre blocks of content.)
- Gradient blobs, glassmorphism, frosted panels, purple-to-indigo gradients, glow shadows.
- A grid of three feature cards with icons. Bento grids of empty cards.
- Emoji used as icons.
- Inter (or any system sans) on white with no real assets.
- Stock photos, stock or AI-looking illustrations, isometric "people at laptops".

## Invented proof
- Invented logos, "trusted by" strips, testimonials, numbers, user counts, ratings or uptime figures.
- Reviews come only from `components/marketing/reviews.mjs`, quoted verbatim.
- Provider logos only to name supported providers, never as "customers".

## Copy
- "Supercharge", "Seamlessly", "Unlock", "Effortlessly", "Elevate", "Revolutionize", "Game-changer", "Next-level", "Harness the power".
- Stacked adjectives ("powerful, secure, lightning-fast"), filler, "the honest answer is", "In today's world".
- Em dashes (use commas, colons, full stops).
- SOC 2 in any form, "30 days", a hard-coded tool count, raw plan slugs (use `planDisplayName`), "MCP Emails" (the name is "MCPEmails"), Fastmail OAuth or JMAP.
- Claims the code does not back. Data is stored in Stockholm; mail is fetched live and not stored.

## Motion
- Autoplaying sound, scroll-jacking, parallax, cursor followers, typewriter effects.
- Motion that loops for no reason. A single muted product clip that shows a real flow is fine.
- Anything that ignores `prefers-reduced-motion`.

## Grep list (used by the review)
```
pulse|blink|backdrop-filter|glassmorphism|from-purple|to-indigo|Supercharge|Seamless|Unlock|Effortless|Elevate|Revolution|Game-changer|Next-level|Harness the power|honest answer|—|SOC ?2|30 days|MCP Emails|JMAP|typewriter|parallax
```
