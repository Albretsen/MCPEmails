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
    // A Supabase client with no schema type argument is an `as any` that no
    // grep for "as any" will ever find.
    //
    // `SupabaseClient` alone resolves to `SupabaseClient<any, "public", any>`,
    // and every `.from()`, `.select()`, `.insert()` and `.rpc()` on it is
    // unchecked: a column that does not exist compiles clean. That is exactly
    // the hole that let the only writer of `billing_email_sends` sit outside
    // the generated schema while the schema itself was being corrected.
    //
    // These are SYNTACTIC selectors on purpose. The repo does not run
    // type-aware linting (no `parserOptions.project`), so the
    // `@typescript-eslint/no-unsafe-*` family is unavailable; a missing type
    // argument, happily, is visible in the AST without it. The cost is that
    // this catches the declaration, not a client that becomes `any` some other
    // way -- `(service as any).from(...)` is caught by
    // `@typescript-eslint/no-explicit-any` instead.
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSTypeReference[typeName.name="SupabaseClient"]:not([typeArguments])',
          message:
            'Write SupabaseClient<Database>. A bare SupabaseClient is SupabaseClient<any>: .from()/.select()/.rpc() stop being checked against the generated schema.',
        },
        {
          selector:
            'TSTypeReference[typeName.name="SupabaseClient"] > TSTypeParameterInstantiation > TSAnyKeyword',
          message:
            'Write SupabaseClient<Database>, not SupabaseClient<any>. <any> turns off schema checking for every query made through this client.',
        },
        {
          selector:
            'CallExpression[callee.name=/^(createServerClient|createBrowserClient)$/]:not([typeArguments])',
          message:
            'Pass the schema: createServerClient<Database>(...) / createBrowserClient<Database>(...). Without it the returned client is unchecked.',
        },
      ],
    },
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
