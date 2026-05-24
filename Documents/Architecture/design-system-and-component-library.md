# Design System and Component Library

MCPEmails uses a hand-rolled design system defined in four CSS files and two JSX component files. There is no CSS Modules, Tailwind, or third-party component library. Every visual decision is expressed through CSS custom properties (design tokens) applied to semantic class names. Components in Primitives.jsx and MarketingPrimitives.jsx are thin wrappers that compose those class names.

---

## 1. Design Token System

All tokens live in `:root` inside `apps/web/styles/colors_and_type.css`. Dark-mode overrides live in `apps/web/styles/theme.css` under the `html[data-theme="dark"]` selector.

### 1.1 Color Tokens — Raw Scale

These are palette primitives. Never use raw scale tokens directly in components; always go through semantic aliases (section 1.2).

#### Cobalt — brand primary

| Token | Light value | Intended use |
|---|---|---|
| `--cobalt-50` | `#EEF2FF` | Soft tint backgrounds, active nav |
| `--cobalt-100` | `#DDE5FF` | Avatar background |
| `--cobalt-200` | `#B6C5FF` | Subtle bar charts, text selection bg |
| `--cobalt-300` | `#889EFF` | Terminal arrows, decorative arrows |
| `--cobalt-400` | `#5973F5` | Brand on dark backgrounds |
| `--cobalt-500` | `#2547E5` | **Brand primary**, focus rings, featured price border |
| `--cobalt-600` | `#1B36C2` | Brand hover state |
| `--cobalt-700` | `#16299A` | Brand press state, active nav text, permission icons |
| `--cobalt-800` | `#131F73` | Deep accent |
| `--cobalt-900` | `#0E1750` | Deepest cobalt |

#### Ink — neutral, cool-cast grays

| Token | Light value | Dark override | Intended use |
|---|---|---|---|
| `--ink-0` | `#FFFFFF` | — | Surface (white) |
| `--ink-25` | `#FAFBFD` | `#131932` | Sunken footer rows, table row hover |
| `--ink-50` | `#F5F6FA` | `#1A2140` | Page background tint, hover backgrounds |
| `--ink-100` | `#ECEEF4` | `#232A4D` | Sunken backgrounds, badge neutral bg |
| `--ink-200` | `#DEE1EB` | `#2E3660` | Default borders, dot-grid color |
| `--ink-300` | `#C6CBDA` | `#3D4778` | Stronger divider, gray bar charts |
| `--ink-400` | `#9AA1B6` | `#5A6080` | Placeholder, disabled text |
| `--ink-500` | `#6B7388` | — | Muted text |
| `--ink-600` | `#4B5167` | — | Body text alternative |
| `--ink-700` | `#2F3447` | `#BFC4D9` | Body text |
| `--ink-800` | `#181C2B` | `#EAECF5` | Near-black |
| `--ink-900` | `#0B1020` | `#FFFFFF` | Primary text, page bg in dark mode |

#### Mint — live / connected / success accent

Use mint sparingly. It signals "this account is connected and live" or "success". Do not use it for decorative purposes.

| Token | Light value | Dark override | Intended use |
|---|---|---|---|
| `--mint-50` | `#E4FBF1` | `rgba(31,203,139,0.12)` | Soft badge background |
| `--mint-100` | `#BFF4DC` | — | Light tint |
| `--mint-300` | `#5EE0AE` | — | Terminal tool names |
| `--mint-500` | `#1FCB8B` | — | Live dot, cursor blink |
| `--mint-600` | `#11A971` | — | Checkmark strokes, icon accents |
| `--mint-700` | `#0B7E55` | — | Badge text on light |

#### Semantic status colors

| Token | Light value | Dark override | Intended use |
|---|---|---|---|
| `--amber-100` | `#FCEFD2` | `rgba(240,165,62,0.16)` | Warning badge background |
| `--amber-500` | `#F0A53E` | — | Warning dot |
| `--amber-700` | `#9A6311` | — | Warning badge text, code string color |
| `--red-100` | `#FCE3E4` | `rgba(229,72,77,0.16)` | Error/danger badge background |
| `--red-500` | `#E5484D` | — | Error dot, error border |
| `--red-700` | `#A11D22` | — | Error badge text, error message text |

### 1.2 Semantic Surface Tokens

These are the tokens to actually use in components. They map to scale values in light mode and are overridden for dark mode in `theme.css`.

| Token | Light value (alias) | Dark value | Usage |
|---|---|---|---|
| `--bg-page` | `var(--ink-50)` → `#F5F6FA` | `#0B1020` | Page background |
| `--bg-surface` | `var(--ink-0)` → `#FFFFFF` | `#131932` | Cards, panels, modals |
| `--bg-sunken` | `var(--ink-100)` → `#ECEEF4` | `#1B2244` | Code blocks, wells, inset areas |
| `--bg-inverse` | `var(--ink-900)` → `#0B1020` | `#FFFFFF` | Dark sections on light pages |
| `--fg-1` | `var(--ink-900)` → `#0B1020` | `#EAECF5` | Primary text, headings |
| `--fg-2` | `var(--ink-700)` → `#2F3447` | `#BFC4D9` | Body text |
| `--fg-3` | `var(--ink-500)` → `#6B7388` | `#8389A6` | Muted text, labels, captions |
| `--fg-4` | `var(--ink-400)` → `#9AA1B6` | `#5A6080` | Placeholder, disabled |
| `--fg-on-brand` | `var(--ink-0)` → `#FFFFFF` | `#FFFFFF` | Text on cobalt buttons |
| `--fg-on-dark` | `var(--ink-0)` → `#FFFFFF` | `#FFFFFF` | Text on inverse/dark sections |
| `--border-1` | `var(--ink-200)` → `#DEE1EB` | `#232A4D` | Default hairline borders |
| `--border-2` | `var(--ink-300)` → `#C6CBDA` | `#2E3660` | Stronger borders on hover |
| `--border-focus` | `var(--cobalt-500)` → `#2547E5` | `#5973F5` | Focus ring border color |
| `--brand` | `var(--cobalt-500)` → `#2547E5` | `#5973F5` | Brand primary |
| `--brand-hover` | `var(--cobalt-600)` → `#1B36C2` | `#889EFF` | Brand hover state |
| `--brand-press` | `var(--cobalt-700)` → `#16299A` | `#2547E5` | Brand pressed state |
| `--brand-soft` | `var(--cobalt-50)` → `#EEF2FF` | `rgba(89,115,245,0.12)` | Tint backgrounds behind brand elements |
| `--live` | `var(--mint-500)` → `#1FCB8B` | — | Connected indicator dot |
| `--live-soft` | `var(--mint-50)` → `#E4FBF1` | — | Ring around connected dot |

### 1.3 Spacing Tokens (4px grid)

All spacing is on a 4px base grid. Never use arbitrary pixel values — pick the nearest token.

| Token | Value | Common use |
|---|---|---|
| `--space-1` | `4px` | Icon padding, tight gaps |
| `--space-2` | `8px` | Button gaps, badge padding |
| `--space-3` | `12px` | Modal body gap, field gap |
| `--space-4` | `16px` | Card padding unit, stat padding |
| `--space-5` | `20px` | Card body padding |
| `--space-6` | `24px` | Section padding, modal padding |
| `--space-8` | `32px` | Page content padding, container padding |
| `--space-10` | `40px` | Auth form margin |
| `--space-12` | `48px` | Section head margin |
| `--space-16` | `64px` | Hero bottom padding |
| `--space-20` | `80px` | Hero top padding, quote padding |
| `--space-24` | `96px` | Full section vertical padding |

### 1.4 Radius Tokens

| Token | Value | Use |
|---|---|---|
| `--r-2` | `2px` | Step progress pip |
| `--r-4` | `4px` | Inline code, small badge elements |
| `--r-6` | `6px` | Nav items |
| `--r-8` | `8px` | Buttons, inputs, search bar, provider chips |
| `--r-12` | `12px` | Stat cards, dashboard cards, bar chart tops |
| `--r-16` | `16px` | Modals, auth cards, large panels |
| `--r-pill` | `999px` | Badges, dots, theme toggle, eyebrow chips |

### 1.5 Shadow Tokens

Shadows are layered for depth. In dark mode they become heavier to compensate for the lack of contrast.

| Token | Light value | Dark value |
|---|---|---|
| `--shadow-1` | `0 1px 2px rgba(11,16,32,0.04)` | `0 1px 2px rgba(0,0,0,0.4)` |
| `--shadow-2` | `0 1px 2px rgba(11,16,32,0.04), 0 2px 8px rgba(11,16,32,0.04)` | `0 1px 2px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.32)` |
| `--shadow-3` | `0 2px 4px rgba(11,16,32,0.04), 0 8px 24px rgba(11,16,32,0.08)` | `0 2px 4px rgba(0,0,0,0.4), 0 8px 24px rgba(0,0,0,0.5)` |
| `--shadow-4` | `0 8px 24px rgba(11,16,32,0.08), 0 24px 56px rgba(11,16,32,0.12)` | `0 8px 24px rgba(0,0,0,0.5), 0 24px 56px rgba(0,0,0,0.6)` |
| `--shadow-focus` | `0 0 0 3px rgba(37,71,229,0.18)` | `0 0 0 3px rgba(89,115,245,0.32)` |

Use `--shadow-1` on flush cards, `--shadow-2` on auth cards, `--shadow-3` on floating hero cards, `--shadow-4` on modals and elevated dialogs. Only use `--shadow-focus` on focused form inputs.

### 1.6 Motion Tokens

| Token | Value | Use |
|---|---|---|
| `--ease-out` | `cubic-bezier(0.2, 0.7, 0.2, 1)` | All interactive state transitions |
| `--ease-in-out` | `cubic-bezier(0.6, 0, 0.2, 1)` | Entrance/exit animations |
| `--dur-1` | `120ms` | Fast micro-interactions (hover, active) |
| `--dur-2` | `200ms` | Standard transitions (modal fade) |
| `--dur-3` | `320ms` | Slower contextual transitions |

The pattern for interactive elements: `transition: all var(--dur-1) var(--ease-out)`.

---

## 2. Theme Support

### How it works

The theme system is attribute-based, not class-based. The `<html>` element carries a `data-theme` attribute:

```html
<html data-theme="light">   <!-- default, matches :root -->
<html data-theme="dark">    <!-- activates html[data-theme="dark"] overrides -->
```

`colors_and_type.css` defines all tokens in `:root` (light). `theme.css` defines overrides in `html[data-theme="dark"]`. Because CSS custom properties cascade, any component that reads a semantic token (e.g. `var(--bg-surface)`) automatically adapts without any component-level logic.

### Persistence

`ThemeToggle` in `MarketingPrimitives.jsx` writes the preference to `localStorage` under the key `mcpe-theme`. An immediately-invoked function at the bottom of `MarketingPrimitives.jsx` reads that key on page load (before React hydrates) and sets `data-theme` on `<html>` to prevent a flash of the wrong theme.

### Tokens that change between themes

Every token in section 1.2 changes. Additionally, specific component selectors in `theme.css` override structural styles that cannot be expressed through a token swap alone:

- `.nav` background becomes `rgba(19,25,50,0.88)` with `--border-1` bottom (instead of `rgba(255,255,255,0.85)`)
- `.hero` dot-grid uses white dots at 6% opacity instead of `--ink-200`
- `.footer` background becomes `#07091A`
- `.price.featured::before` banner gets white text on `--brand`
- `html[data-theme="dark"] .auth-shell::before` switches dot color to `rgba(255,255,255,0.06)`

Ink scale tokens themselves are remapped in dark mode. `--ink-25` through `--ink-300` invert to deep navy shades, while `--ink-700`, `--ink-800`, `--ink-900` become near-white. This means any component that uses `var(--ink-*)` raw (instead of a semantic alias) must be reviewed for dark-mode correctness.

---

## 3. Typography Scale

### Font Families

```css
--font-sans:    "Geist", ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
--font-mono:    "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace;
--font-display: "Instrument Serif", "Iowan Old Style", Georgia, serif;
```

Loaded via Google Fonts: Geist (weights 300, 400, 500, 600, 700), Geist Mono (weights 400, 500, 600), Instrument Serif (italic only).

- `--font-sans` is the workhorse. Use for all UI text, labels, buttons, body copy.
- `--font-mono` is for code, MCP tool names, timestamps, kbd hints, URL segments, monospace values.
- `--font-display` (Instrument Serif italic) is an editorial accent only. Use on a single word or short phrase inside a headline — never for blocks of text.

### Type Scale

| Token | `rem` | `px` | Role |
|---|---|---|---|
| `--fs-12` | `0.75rem` | 12 | Micro labels, uppercase section labels |
| `--fs-13` | `0.8125rem` | 13 | Captions, nav items, activity rows |
| `--fs-14` | `0.875rem` | 14 | Small body, UI inputs, table cells |
| `--fs-15` | `0.9375rem` | 15 | Dense body, card header title |
| `--fs-16` | `1rem` | 16 | Body (base), principle body text |
| `--fs-18` | `1.125rem` | 18 | Lead text, step headings |
| `--fs-20` | `1.25rem` | 20 | h5, lead |
| `--fs-24` | `1.5rem` | 24 | h4, auth card heading, principle heading |
| `--fs-30` | `1.875rem` | 30 | h3 |
| `--fs-38` | `2.375rem` | 38 | h2, quote text |
| `--fs-48` | `3rem` | 48 | h1 |
| `--fs-64` | `4rem` | 64 | Display small |
| `--fs-88` | `5.5rem` | 88 | Display large |

The marketing hero `h1` uses `clamp(48px, 5.4vw, 64px)` directly (not a token) because it is a fluid size between `--fs-48` and `--fs-64`.

### Line Heights

| Token | Value | Use |
|---|---|---|
| `--lh-tight` | `1.05` | Display headings, h1 |
| `--lh-snug` | `1.2` | h2, h3, h4, h5 |
| `--lh-base` | `1.5` | Body text, inputs |
| `--lh-relaxed` | `1.65` | Lead text, long body paragraphs |

### Letter Spacing

| Token | Value | Use |
|---|---|---|
| `--tracking-tight` | `-0.02em` | h1, h2, large headings |
| `--tracking-snug` | `-0.01em` | h3, h4 |
| `--tracking-normal` | `0` | Body |
| `--tracking-wide` | `0.04em` | Uppercase labels (`t-label`), table headers |
| `--tracking-mono` | `-0.005em` | Monospace body text |

### Semantic Type Classes

Apply these classes directly to elements rather than combining individual font/size/weight properties. All are defined in `colors_and_type.css`.

| Class | Family | Weight | Size | Line Height | Letter Spacing |
|---|---|---|---|---|---|
| `.t-display-lg` | sans | 600 | `--fs-88` | `0.98` | `-0.035em` |
| `.t-display-sm` | sans | 600 | `--fs-64` | `1.0` | `-0.03em` |
| `.t-display-italic` | display (Instrument Serif) | 400 | inherits | — | `-0.01em` |
| `.t-h1` | sans | 600 | `--fs-48` | `--lh-tight` | `--tracking-tight` |
| `.t-h2` | sans | 600 | `--fs-38` | `--lh-snug` | `--tracking-tight` |
| `.t-h3` | sans | 600 | `--fs-30` | `--lh-snug` | `--tracking-snug` |
| `.t-h4` | sans | 600 | `--fs-24` | `--lh-snug` | `--tracking-snug` |
| `.t-h5` | sans | 600 | `--fs-20` | `--lh-snug` | — |
| `.t-lead` | sans | 400 | `--fs-20` | `--lh-relaxed` | — |
| `.t-body` | sans | 400 | `--fs-16` | `--lh-relaxed` | — |
| `.t-body-sm` | sans | 400 | `--fs-14` | `--lh-base` | — |
| `.t-caption` | sans | 400 | `--fs-13` | `--lh-base` | — |
| `.t-label` | sans | 500 | `--fs-12` | `1.3` | `--tracking-wide` + uppercase |
| `.t-code` / `.t-mono` | mono | 400 | `--fs-14` | `--lh-base` | `--tracking-mono` |
| `.t-code-inline` | mono | 400 | `0.92em` | — | — (has bg + padding) |

---

## 4. Responsive Breakpoints

The CSS files do not define named breakpoint tokens. Breakpoints are used implicitly in a handful of places. The project is predominantly desktop-first for the dashboard and the marketing page is designed for a 1200px max-width container.

Breakpoints observed in the codebase:

| Context | Breakpoint | Behavior |
|---|---|---|
| Marketing container | `max-width: 1200px` | Content is constrained at 1200px, centered with `margin: 0 auto` and `padding: 0 32px` |
| Marketing hero grid | `grid-template-columns: 1.05fr 1fr` | Side-by-side at all widths currently (no collapse rule written yet) |
| Dashboard shell | `grid-template-columns: 244px 1fr` | Sidebar is always 244px wide; no mobile collapse written yet |
| Auth shell | `max-width: 440px` | Auth form constrained to 440px, no media query needed |
| Authorize shell | `max-width: 600px` | Authorize card constrained to 600px |

The project is at an early stage. Responsive media queries for the dashboard sidebar collapse and marketing hero stacking have not yet been added. When adding them, follow a mobile-first approach: base styles for small screens, then `@media (min-width: 768px)` and `@media (min-width: 1024px)` overrides.

---

## 5. Primitive Components (Primitives.jsx)

File: `apps/web/components/Primitives.jsx`

These are dashboard-context primitives. They are marked `'use client'` and export named functions. They do not carry state — they are pure rendering wrappers around CSS class names.

### 5.1 Icon

Renders an inline SVG icon from a built-in glyph map.

```jsx
<Icon name="mail" size={16} color="currentColor" strokeWidth={1.75} className="" />
```

**Props:**

| Prop | Type | Default | Description |
|---|---|---|---|
| `name` | string | required | Key from the glyph map (see list below) |
| `size` | number | `16` | Width and height in pixels |
| `color` | string | `"currentColor"` | SVG stroke color |
| `strokeWidth` | number | `1.75` | SVG stroke width |
| `className` | string | `""` | Extra CSS classes on the `<svg>` |

All icons are `fill="none"` stroke-based, `viewBox="0 0 24 24"`, with `strokeLinecap="round"` and `strokeLinejoin="round"`.

**Available icons (dashboard set):**

`mail`, `inbox`, `key`, `activity`, `settings`, `search`, `plus`, `check`, `x`, `chevron`, `copy`, `shield`, `trash`, `refresh`, `bell`, `download`, `zap`, `eye`, `eyeoff`

**Usage example:**

```jsx
// In a nav item
<Icon name="inbox" size={16} className="icon" />

// With explicit color
<Icon name="check" size={14} color="var(--mint-600)" />
```

### 5.2 Badge

Renders a styled pill badge.

```jsx
<Badge tone="live" dot="live">Connected</Badge>
```

**Props:**

| Prop | Type | Default | Description |
|---|---|---|---|
| `tone` | string | `"neutral"` | Visual style variant |
| `dot` | string | `undefined` | If set, renders a `.dot` span with this class |
| `children` | ReactNode | required | Badge label text |

**Tone variants** (maps to `.b-{tone}` CSS class):

| Tone | Background | Text | Border | Use |
|---|---|---|---|---|
| `live` | `--mint-50` | `--mint-700` | `rgba(31,203,139,0.25)` | Connected, active |
| `brand` | `--cobalt-50` | `--cobalt-700` | `rgba(37,71,229,0.18)` | Cobalt-tinted status |
| `neutral` | `--ink-100` | `--ink-700` | `--border-1` | Default, inactive |
| `amber` | `--amber-100` | `--amber-700` | `rgba(240,165,62,0.25)` | Warning |
| `red` | `--red-100` | `--red-700` | `rgba(229,72,77,0.25)` | Error, danger |

**Dot variants** (maps to `.dot.{class}`):

| Class | Color | Animation |
|---|---|---|
| `live` | `--mint-500` with halo | Pulse via `@keyframes livepulse` |
| `amber` | `--amber-500` | None |
| `red` | `--red-500` | None |
| `gray` | `--ink-300` | None |

**Usage examples:**

```jsx
<Badge tone="live" dot="live">Connected</Badge>
<Badge tone="neutral">Inactive</Badge>
<Badge tone="amber" dot="amber">Rate limited</Badge>
<Badge tone="red">Error</Badge>
```

### 5.3 Btn

Dashboard button component.

```jsx
<Btn variant="primary" size="md" icon="plus" onClick={handleClick}>
  Connect account
</Btn>
```

**Props:**

| Prop | Type | Default | Description |
|---|---|---|---|
| `variant` | string | `"primary"` | Button visual style |
| `size` | string | `"md"` | `"md"` or `"sm"` |
| `icon` | string | `undefined` | Icon name (from `Icon` glyph map) — renders before children |
| `children` | ReactNode | required | Button label |
| `onClick` | function | `undefined` | Click handler |
| `type` | string | `"button"` | HTML button type attribute |
| `className` | string | `""` | Additional classes |
| `disabled` | boolean | `false` | Applies `btn-disabled` class and `disabled` attribute |

**Variant styles** (all from `dashboard.css`):

| Variant | Background | Text | Border | Hover |
|---|---|---|---|---|
| `primary` | `--brand` | `--fg-on-brand` | transparent | `--brand-hover` background |
| `secondary` | `--bg-surface` | `--fg-1` | `--border-1` | `--ink-50` bg, `--border-2` border |
| `ghost` | transparent | `--fg-2` | transparent | `--ink-100` background |
| `danger` | transparent | `--red-700` | `--border-1` | `--red-100` bg, reddish border |

**Size dimensions:**

| Size | Height | Padding | Font size |
|---|---|---|---|
| `md` | `34px` | `0 14px` | `13.5px` |
| `sm` | `28px` | `0 10px` | `12.5px` |

All buttons: `border-radius: 8px`, `font-weight: 500`, `font-family: --font-sans`, focus ring via `--shadow-focus` on `:focus-visible`.

**Usage examples:**

```jsx
<Btn variant="primary" icon="plus">Connect account</Btn>
<Btn variant="secondary" size="sm" icon="refresh">Sync</Btn>
<Btn variant="ghost" icon="settings">Settings</Btn>
<Btn variant="danger" icon="trash">Disconnect</Btn>
<Btn variant="primary" disabled>Saving…</Btn>
```

### 5.4 Avatar

Renders the user's initials in a circular cobalt-tinted chip.

```jsx
<Avatar initials="JR" />
```

**Props:**

| Prop | Type | Default | Description |
|---|---|---|---|
| `initials` | string | `"JR"` | Up to 2 characters shown in the avatar |

Dimensions: `28px × 28px`, `border-radius: 999px`, background `--cobalt-100`, color `--cobalt-700`, font weight 600, font size 12px.

### 5.5 ProviderLogo

Renders a brand glyph for an email provider.

```jsx
<ProviderLogo kind="gmail" size={22} />
<ProviderLogo kind="outlook" size={22} />
<ProviderLogo kind="imap" size={22} />
```

**Props:**

| Prop | Type | Default | Description |
|---|---|---|---|
| `kind` | string | required | `"gmail"`, `"outlook"`, or `"imap"` |
| `size` | number | `22` | Width and height in pixels |

These are purpose-built inline SVGs, not from the icon glyph map. Gmail uses a red envelope stroke. Outlook uses a blue rectangle with "O". IMAP uses a neutral server-rack icon. Returns `null` for unknown `kind` values.

---

## 6. Marketing Primitives (MarketingPrimitives.jsx)

File: `apps/web/components/MarketingPrimitives.jsx`

These are for the marketing site and auth pages. Also marked `'use client'`. Exports `MIcon`, `MBtn`, and `ThemeToggle`.

### 6.1 MIcon

The marketing-context equivalent of `Icon`. Backed by a separate glyph map `MI` that includes additional icons not in the dashboard set, plus the multi-color Google icon.

```jsx
<MIcon name="shield" size={18} color="currentColor" strokeWidth={1.75} />
```

**Props:**

| Prop | Type | Default | Description |
|---|---|---|---|
| `name` | string | required | Key from `MI` glyph map |
| `size` | number | `18` | Width and height in pixels |
| `color` | string | `"currentColor"` | SVG stroke color (ignored for `google`) |
| `strokeWidth` | number | `1.75` | Stroke width (ignored for `google`) |

**Available icons (marketing set):**

`shield`, `zap`, `plug`, `ghost`, `eu`, `globe`, `check`, `arrow`, `mail`, `inbox`, `cpu`, `server`, `moon`, `sun`, `github`, `google`, `lock`, `refresh`, `trash`

The `google` icon is special: it renders filled multi-color paths without stroke. All other icons follow the same `fill="none"` + stroke pattern as `Icon`.

**Default size is 18px** (vs 16px in the dashboard `Icon`) to match marketing's looser layout density.

### 6.2 MBtn

Marketing-context button. Supports both `<button>` and `<a>` rendering. Includes an additional `btn-on-dark` variant for use on the hero's dark sections.

```jsx
<MBtn variant="primary" size="lg" href="/signup">Get started free</MBtn>
<MBtn variant="secondary" onClick={handleLearnMore}>Learn more</MBtn>
```

**Props:**

| Prop | Type | Default | Description |
|---|---|---|---|
| `variant` | string | `"primary"` | Visual variant |
| `size` | string | `"md"` | `"sm"`, `"md"`, or `"lg"` |
| `icon` | string | `undefined` | Icon name from `MI` map — renders after children (trailing icon) |
| `children` | ReactNode | required | Button label |
| `href` | string | `undefined` | If provided, renders as `<a>` instead of `<button>` |
| `onClick` | function | `undefined` | Click handler |
| `type` | string | `"button"` | HTML button type (ignored when `href` is set) |
| `className` | string | `""` | Additional classes |

**Note on icon position:** In `MBtn`, the icon appears after the label (trailing). In `Btn`, the icon appears before the label (leading). This is intentional — marketing CTAs use trailing arrow icons, dashboard actions use leading action icons.

**Variant styles** (from `marketing.css`):

| Variant | Background | Text | Border | Hover |
|---|---|---|---|---|
| `primary` | `--brand` | `--fg-on-brand` | transparent | `--brand-hover` |
| `secondary` | `--bg-surface` | `--fg-1` | `--border-1` | `--ink-50` bg |
| `ghost` | transparent | `--fg-1` | transparent | `--ink-100` bg |
| `on-dark` | `rgba(255,255,255,0.1)` | `#fff` | `rgba(255,255,255,0.18)` | `rgba(255,255,255,0.16)` bg |

**Size dimensions:**

| Size | Height | Padding | Font size |
|---|---|---|---|
| `sm` | inherits base | base padding | `14px` |
| `md` | `36px` | `0 14px` | `14px` |
| `lg` | `44px` | `0 18px` | `15px` |

SVG icons inside `MBtn` are set to `16×16` via CSS `.btn svg { width: 16px; height: 16px; }`.

**Usage examples:**

```jsx
// Hero CTA
<MBtn variant="primary" size="lg" href="/signup" icon="arrow">Get started free</MBtn>

// Secondary alongside primary
<MBtn variant="secondary" href="/docs">Read the docs</MBtn>

// On a dark background section
<MBtn variant="on-dark" href="/contact">Talk to us</MBtn>
```

### 6.3 ThemeToggle

A floating fixed-position button that toggles between light and dark theme.

```jsx
<ThemeToggle />
```

No props. Internally reads `document.documentElement.getAttribute("data-theme")` on mount to hydrate initial state, and writes back to `data-theme` on `<html>` plus `localStorage["mcpe-theme"]` on every toggle.

Renders as `.theme-toggle` (fixed, top-right, 36×36, pill-shaped). Shows the `moon` icon in light mode and `sun` icon in dark mode.

---

## 7. Component Creation Rules

### When to add a new primitive

Add to `Primitives.jsx` or `MarketingPrimitives.jsx` when:

- The element is used in 3+ places across different page sections, or
- The element has interactive state (hover, focus, disabled) that must be consistent, or
- The element encapsulates a token combination that would otherwise be repeated inline.

Do not add a primitive for:
- One-off layout elements with no variant logic.
- Elements that are simple semantic HTML with a single class (write the class directly).
- Page-specific compound components (put these in the page's own component file).

### Composition vs new primitive

Compose from existing primitives first. Example: a "Connect" button row in a modal is a `<div>` with `<Btn>` and `<Badge>` components — it does not need its own primitive.

Only create a new primitive if the composition itself is repeated across screens or if it carries behavior (e.g. `ProviderLogo` encapsulates three brand SVGs behind a unified prop API).

### File location convention

```
apps/web/
  components/
    Primitives.jsx           — dashboard-context primitives (Icon, Badge, Btn, Avatar, ProviderLogo)
    MarketingPrimitives.jsx  — marketing/auth-context primitives (MIcon, MBtn, ThemeToggle)
    auth/
      AuthorizeApp.jsx       — page-level components for the /authorize route
      SignupApp.jsx          — page-level components for the /signup route
    dashboard/
      App.jsx                — dashboard shell
      ConnectModal.jsx       — compound component: connect email modal
      Pages.jsx              — per-page content components
      Sidebar.jsx            — sidebar nav
    marketing/
      App.jsx                — marketing page shell
      Sections.jsx           — marketing section components
```

New page-level compound components belong in the subfolder matching their context (`auth/`, `dashboard/`, or `marketing/`). They import from `Primitives.jsx` or `MarketingPrimitives.jsx` as appropriate to their context.

---

## 8. CSS Architecture

### Structure overview

The system is three CSS files, each consumed by import:

```
colors_and_type.css   — tokens (:root), semantic type classes, base reset
  ↑ imported by
dashboard.css         — layout shell, sidebar, nav, cards, tables, forms, badges, modals
marketing.css         — nav, hero, sections, pricing, footer for the marketing site
  ↑ also imported by
theme.css             — dark-mode overrides (html[data-theme="dark"] blocks)
```

`theme.css` is not imported by the stylesheet chain. It must be loaded globally in the HTML alongside the others, because its selectors target `html[data-theme="dark"]` which is document-wide.

### No scoping, no CSS Modules

All class names are global. Scoping is achieved by context: dashboard components only appear inside `.shell`, marketing components only appear inside a marketing layout. There is no naming conflict risk in practice because the two contexts do not overlap in the DOM.

### Naming conventions

The naming is BEM-adjacent but informal:

- Block: `.card`, `.modal`, `.sidebar`, `.nav`
- Element: `.card-h`, `.card-body`, `.modal-h`, `.modal-foot`, `.modal-body`, `.nav-item`
- Modifier: `.btn-primary`, `.btn-sm`, `.b-live`, `.badge`, `.nav-item.active`

Avoid abbreviations unless they are already established: `.crumbs`, `.grow`, `.act-row`, `.tbl`.

### Adding styles for a new page

1. Determine context: is the new page part of the dashboard, the marketing site, or a standalone auth page?
2. Ensure the correct CSS file is imported by the page's layout or HTML file:
   - Dashboard pages: import `dashboard.css` (which already imports `colors_and_type.css`)
   - Marketing pages: import `marketing.css` (same chain)
   - Auth pages: import `theme.css` (which also needs `colors_and_type.css` in scope)
3. Add new class blocks at the bottom of the relevant CSS file. Do not add page-specific rules to `colors_and_type.css` — that file is tokens and semantic type classes only.
4. Name your new classes after the page or section: `.billing-grid`, `.key-row`, `.key-row .secret`. Keep nesting depth to two levels.
5. Use only design tokens — no hardcoded colors, no arbitrary pixel values outside the spacing grid.

### CSS already defined for common auth patterns

`theme.css` contains pre-built styles for:
- `.auth-shell`, `.auth-wrap`, `.auth-card`, `.auth-back`, `.auth-brand` — page scaffolding
- `.auth-providers`, `.auth-prov-btn`, `.auth-divider` — OAuth provider button list
- `.auth-fields`, `.auth-submit`, `.auth-footer`, `.auth-microcopy` — form fields and footer
- `.step-pip` — multi-step progress indicators
- `.input.err`, `.field .err-msg` — validation states
- `.az-*` classes — the agent authorization screen

---

## 9. Icon System

### Icon set

Icons are hand-crafted Feather-style SVG paths, defined inline as JSX constants inside `Primitives.jsx` (`I` object) and `MarketingPrimitives.jsx` (`MI` object). There is no external icon library dependency — no Heroicons, no Lucide, no Font Awesome.

All icons are 24×24 viewBox, `fill="none"`, stroke-based, with `strokeLinecap="round"` and `strokeLinejoin="round"`. Default stroke width is 1.75.

### Adding a new icon

To add an icon to the dashboard set, open `apps/web/components/Primitives.jsx` and add an entry to the `I` object:

```js
const I = {
  // existing icons...
  filter: <g><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></g>,
};
```

The key becomes the `name` prop value: `<Icon name="filter" />`.

To add an icon to the marketing set, add it to `MI` in `MarketingPrimitives.jsx` the same way.

### Rules for icons

- Source the path data from Feather Icons (feathericons.com) or draw compatible stroke-based paths at 24×24. Do not use filled icons — only stroke.
- If an icon uses multiple child elements, wrap them in `<g>...</g>`.
- The `google` icon in `MarketingPrimitives.jsx` is an exception — it uses filled color paths and is handled with a special case in `MIcon`. Any future multi-color brand icon should follow the same pattern.
- Do not import an icon library. Keep icons inline to avoid bundle overhead and ensure full control over stroke properties.

### ProviderLogo vs Icon

`ProviderLogo` is separate from `Icon` because email provider logos are brand assets with specific colors and shapes that should not be overridden via the `color` prop. Use `ProviderLogo` for Gmail, Outlook, and IMAP; use `Icon` for all UI iconography.

---

## 10. Do-and-Don't Rules

### Colors

**Do:**
- Use semantic tokens: `var(--fg-1)`, `var(--bg-surface)`, `var(--brand)`, `var(--border-1)`.
- Use raw scale tokens only when the color is intentionally independent of theme (e.g., `--cobalt-500` on a brand hero element that is always cobalt regardless of theme). Even then, prefer the semantic alias.
- For transparent overlays, use `rgba()` with the base ink value: `rgba(11, 16, 32, 0.34)` for modal scrims.

**Don't:**
- Hardcode hex values in component CSS. `color: #2547E5` instead of `color: var(--brand)` breaks dark mode.
- Use raw scale tokens for text or background on elements that appear in both themes without checking the dark-mode override map.
- Use `--ink-*` tokens for anything other than the ink scale. Do not reach for `--ink-200` as a "light gray" — use `--border-1` or `--bg-sunken` as appropriate.

### Spacing

**Do:**
- Use `--space-*` tokens for gaps, padding, and margin.
- Stick to the 4px grid for any value not covered by a token: `6px`, `10px`, `14px`, `18px`, `22px`, `28px` are all multiples of 2px or 4px and are acceptable as long as they appear in existing CSS patterns.

**Don't:**
- Use arbitrary pixel values like `padding: 11px 17px`. Round to the nearest 4px increment or match an established pattern.
- Use percentage-based padding/margin for layout spacing — use fixed tokens or grid gaps.

### Typography

**Do:**
- Apply semantic type classes (`.t-h1`, `.t-body`, `.t-label`, etc.) on elements.
- Use `--font-sans` for all UI text, `--font-mono` for code and monospace data.
- Use `--font-display` (Instrument Serif italic) for a maximum of one or two words in a heading to add editorial flair.

**Don't:**
- Set `font-family` to a literal string. Always use the font tokens.
- Use `font-size` pixel values directly. Use `--fs-*` tokens or the semantic type classes.
- Apply `--font-display` to paragraphs, labels, or any text block. It is an accent only.

### Design tokens

**Do:**
- Override tokens in `html[data-theme="dark"]` in `theme.css` when a semantic token does not correctly handle the dark variant automatically.
- Use `--shadow-focus` exclusively for focus states on interactive elements. Do not use it decoratively.

**Don't:**
- Add new tokens to `colors_and_type.css` for one-off uses. If you need a value that is not in the token system, first check whether a composition of existing tokens covers it.
- Override `--bg-surface` or `--fg-1` on a per-component basis with `style={{ "--bg-surface": "#something" }}` — this breaks the theme cascade.

### Component variants

**Do:**
- Extend an existing component by adding a new CSS class and wiring it via a `variant` or `tone` prop.
- Use `className` passthrough on primitives for one-off adjustments (e.g., `<Btn className="auth-submit">`).

**Don't:**
- Create a visually distinct button style by wrapping `<Btn>` in a `<div>` with overriding styles. Add a variant to `Btn` instead.
- Apply `!important` anywhere. If you need to override a style, you are likely composing components incorrectly.

### Icons

**Do:**
- Use `<Icon name="..." />` for all dashboard UI icons and `<MIcon name="..." />` for marketing icons.
- Use `size` prop to control dimensions. Do not apply CSS `width`/`height` to override the SVG externally.

**Don't:**
- Use emoji as icons.
- Import SVG files as React components — keep icon paths inline in the glyph maps.
- Mix `Icon` and `MIcon` in the same context (dashboard vs marketing).
