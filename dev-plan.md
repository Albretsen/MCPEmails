# Dev Plan — Command Palette / Global Search (⌘K)

## Problem
The dashboard Topbar (`components/dashboard/Sidebar.jsx`) has a decorative search box
with a `⌘K` hint, but there is no handler. Pressing ⌘K does nothing and the input
does not open any popup. There is no global search anywhere in the app.

## Goal
A working command palette that:
- Opens on `⌘K` (mac) / `Ctrl+K` (win/linux), and when the topbar search box is clicked.
- Closes on `Esc` / backdrop click / after selecting a result.
- Lets you search and navigate **anywhere**: all dashboard pages (Overview, Inboxes,
  API keys, Members, Usage, Settings, Security), plus actions (Connect inbox).
- Surfaces **inboxes** (by label / address / provider) and **members** (by name / email)
  and **API keys** (by name) as searchable, selectable results that jump to their page.
- Keyboard navigable: ↑/↓ to move, Enter to select, with mouse hover support.

## Architecture
The dashboard is a client-side route-state app (`DashboardInner` in `App.jsx`),
not URL routing. Navigation = `setRoute(id)`. So the palette selects an item and
calls a handler (`setRoute`, or open connect modal).

## Steps
1. **Create `components/dashboard/CommandPalette.jsx`**
   - Props: `open`, `onClose`, `setRoute`, `inboxes`, `members`, `keys`, `onConnect`.
   - Build a flat list of searchable items from: static pages, the connect action,
     inboxes, members, keys.
   - Fuzzy-ish substring filter (case-insensitive across label + keywords).
   - Keyboard: ↑/↓/Enter/Esc; auto-focus input on open; reset query on open.
   - Grouped rendering (Pages, Actions, Inboxes, Members, API keys).
2. **Wire into `App.jsx`**
   - Add `showCommand` state + global keydown listener for ⌘K/Ctrl+K (preventDefault).
   - Render `<CommandPalette ... />`. Selecting an inbox/member routes to that page.
   - Pass an `onOpenSearch` callback down to `Topbar`.
3. **Make the Topbar search open the palette** (`Sidebar.jsx`)
   - Make the input `readOnly` + clickable; clicking (or focusing) calls `onOpenSearch`.
4. **CSS** in `styles/dashboard.css`
   - `.cmdk-*` styles for the palette overlay, input, result rows, groups, kbd hints,
     active/hover row, empty state. Reuse existing `.scrim` backdrop.
5. **Verify** with the dev server: open via ⌘K and via click, type queries for a page,
   an inbox, a member; arrow-key + Enter navigates; Esc closes. Screenshot proof.

## Out of scope
Searching email message contents (that's an MCP tool, not a UI surface) and full-text
server search. This palette is for navigation + entity lookup within the dashboard.
