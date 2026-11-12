# Brand constraints for the Homepage Lab (from Asgeir's interview, 2026-11-12 15:01 Oslo)

- All 10 variants are **light** designs. Dark accents (a dark product screenshot, one inverse band) are fine inside a light page.
- Keep the **logo** (`apps/web/public/logo-wordmark.svg`, `logo-mark.svg`; dark versions exist) and the **brand colours** below in every variant. A brief's `visual_style` is applied through texture, contrast, density, surfaces, rules and how these colours are used, never a new palette.
- 7 of 10 variants are bold or experimental, 3 are normal.
- Fonts are open: any font that self-hosts well (open licence). Today's fonts are Geist, Geist Mono and Instrument Serif.

## Colours (`apps/web/styles/colors_and_type.css`)

| Token | Hex | Role |
|---|---|---|
| cobalt-500 | #2547E5 | brand, primary actions |
| cobalt-600 / 700 | #1B36C2 / #16299A | hover / press |
| cobalt-50 / 100 / 200 / 300 / 400 | #EEF2FF / #DDE5FF / #B6C5FF / #889EFF / #5973F5 | tints |
| cobalt-800 / 900 | #131F73 / #0E1750 | deep blue |
| ink-0 / 25 / 50 / 100 / 200 / 300 | #FFFFFF / #FAFBFD / #F5F6FA / #ECEEF4 / #DEE1EB / #C6CBDA | page, surfaces, hairlines |
| ink-400 / 500 / 600 / 700 / 800 / 900 | #9AA1B6 / #626A7D / #4B5167 / #2F3447 / #181C2B / #0B1020 | text, inverse |
| mint-50 / 500 / 700 | #E4FBF1 / #1FCB8B / #0B7E55 | "connected" state |
| amber-100 / 500 / 700 | #FCEFD2 / #F0A53E / #9A6311 | warnings, highlights |
| red-100 / 500 / 700 | #FCE3E4 / #E5484D / #A11D22 | errors |

Text on white must meet WCAG AA: body text ink-700 or darker; cobalt-500 passes for text and buttons on white.
