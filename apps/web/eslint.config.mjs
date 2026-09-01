import { defineConfig, globalIgnores } from 'eslint/config';
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypeScript from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextCoreWebVitals,
  ...nextTypeScript,
  globalIgnores([
    '.next/**',
    '.next-compat/**',
    'node_modules/**',
    // Standalone design prototype, not part of the Next build. It is a
    // Babel-standalone <script> loaded by the stale index.html harness, so it
    // relies on browser globals (React, ReactDOM) and on sibling scripts
    // declaring Nav/Hero/Features/... The live equivalent is
    // components/marketing/HomeClient.jsx.
    'components/marketing/App.jsx',
  ]),
  {
    // `no-html-link-for-pages` is a Pages Router rule: it assumes every
    // in-app href should become a `next/link`. This app is App Router only
    // (there is no pages/ directory) and is localised with next-intl, where
    // the locale-aware Link lives in src/i18n/navigation.ts rather than
    // next/link. Rewriting these anchors would change navigation and locale
    // resolution, so the rule is off rather than mass-applied.
    rules: { '@next/next/no-html-link-for-pages': 'off' },
  },
  {
    // Every image in the app is a local .svg (logos, blog covers, avatars).
    // next/image does not optimise SVG -- it passes it through, and refuses to
    // serve it at all unless `dangerouslyAllowSVG` is set -- so converting
    // these buys nothing. The one exception, the OAuth client logo in
    // components/auth/AuthorizeApp.jsx, is an arbitrary third-party URL that
    // could never be enumerated in `images.remotePatterns`.
    rules: { '@next/next/no-img-element': 'off' },
  },
  {
    // next.config.js is CommonJS by design (Next loads it with require).
    files: ['next.config.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Honour the `_` prefix the codebase already uses to mark a binding that
    // is deliberately unused (`_request` on route handlers whose signature is
    // fixed by Next, `_warnings`, `_plan`), and the `{ secret, ...rest }`
    // idiom for stripping a field.
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
    },
  },
]);
