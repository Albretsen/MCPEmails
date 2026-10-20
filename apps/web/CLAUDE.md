@AGENTS.md

# apps/web

Rules for the Next.js app. The root `CLAUDE.md` still applies. `AGENTS.md` here is written by `next dev` and is not committed.

- The request proxy (formerly middleware) is `apps/web/proxy.ts`, at the package root, never under `src/`.
- `NEXT_PUBLIC_APP_URL` must equal the Vercel primary domain, the apex `https://mcpemails.com`, or OAuth redirects break.
- Every user-facing copy change goes into en, nb, es and fr, translated idiomatically; CI fails if one is missing. de is scoped: provider pages and blog posts exist in German only where their `locales` list or translations folder says so, so a new provider or post may ship without de; any new `messages/` key still needs de (`test:i18n-de`). zh is frozen: add a zh translation when it is cheap, otherwise leave the key out and zh renders English (policy in `src/i18n/locale-policy.mjs`). Never hardcode English in a component.
- Copy used by one page lives in a module next to that page, not in `messages/`: every `messages/` namespace is serialised into every marketing page.
- Never put a literal `<` in a message string, and do not ICU-escape it: production renders it literally. Reword, then check with a real `npm run build`.
- Never import jsdom or isomorphic-dompurify at module scope in a Node route. It failed with ERR_REQUIRE_ESM and 500s on signature saves.
- Test API routes with every HTTP method, not only GET. Unmatched `/api/*` paths must 404 through `app/api/[[...unmatched]]/route.ts`.
- `Btn` (`components/Primitives.jsx`) drops `style`: use a variant or `className`. Use the design tokens (`--bg-surface`, `--red-500`, ...) and the shared `.scrim` + `.modal`.
- Dashboard counts come from the live client arrays already on the page, never from a second server query.
- React component tests: use `element.click()` rather than synthetic events, and assert scalars, not DOM nodes (`assert.equal(node, null)` can run the test runner out of memory). Check that a new test can fail.
- UI: keep it minimal. Rarely used options go under "Advanced", errors are one line, loading states are one text line tall, and no animation unless it informs.
- `preview_start` from a worktree can serve the parent repo with the production `.env.local`. Check the server's working directory before trusting what it shows.
