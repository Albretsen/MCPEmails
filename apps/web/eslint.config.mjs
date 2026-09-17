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
    //
    // Requiring `Database` as a type argument, rather than merely forbidding a
    // missing one and a literal `<any>`, is what closes `SupabaseClient<any |
    // Database>` (the `any` sits under a TSUnionType, not directly under the
    // type-argument list) and `type Any = any; SupabaseClient<Any>` (the alias
    // hides the keyword entirely). A purely syntactic rule cannot see through
    // either, so it asks for the thing it wants instead.
    //
    // KNOWN LIMIT, deliberately not closed by a selector: a selector matches on
    // the spelling at the use site, so `import { SupabaseClient as SB }` and
    // `import * as Supa; Supa.SupabaseClient` are invisible to it -- the first
    // has a different `typeName.name`, the second has a TSQualifiedName with no
    // `.name` at all. Rather than try to detect those uses, the import-shape
    // selectors below make them impossible to write: the binding must keep its
    // own name, and the namespace form is banned outright. Same idea for the
    // constructors: `const mk = createServerClient; mk(...)` cannot be detected
    // by `callee.name`, so `no-restricted-imports` keeps the raw constructors
    // out of every file except the wrappers in src/lib/supabase/, where all
    // four call sites are direct and the call selector does see them.
    //
    // Not scoped with `files`, so .js/.jsx/.mjs are covered too. JSDoc types in
    // a .js file are invisible to a syntactic selector (and .js is outside the
    // typechecked program: tsconfig has no `checkJs` and includes only
    // **/*.ts(x)), but the import and call restrictions are just as real there.
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'TSTypeReference[typeName.name="SupabaseClient"]:not(:has(TSTypeParameterInstantiation > TSTypeReference[typeName.name="Database"]))',
          message:
            'Write SupabaseClient<Database>. Without `Database` as the first type argument the client is SupabaseClient<any>: .from()/.select()/.rpc() stop being checked against the generated schema. `<any>`, `<any | Database>` and an alias for `any` are all the same hole.',
        },
        {
          selector:
            'CallExpression[callee.name=/^(createServerClient|createBrowserClient)$/]:not([typeArguments])',
          message:
            'Pass the schema: createServerClient<Database>(...) / createBrowserClient<Database>(...). Without it the returned client is unchecked.',
        },
        {
          selector:
            'ImportDeclaration[source.value="@supabase/supabase-js"] > ImportSpecifier[imported.name="SupabaseClient"]:not([local.name="SupabaseClient"])',
          message:
            'Import SupabaseClient under its own name. Renaming it hides every use from the no-restricted-syntax rule that requires SupabaseClient<Database>.',
        },
        {
          selector:
            'ImportDeclaration[source.value=/^@supabase\\/(supabase-js|ssr)$/] > ImportNamespaceSpecifier',
          message:
            'Import the named exports, not the whole namespace. `Supa.SupabaseClient` is a TSQualifiedName, which the SupabaseClient<Database> rule cannot see.',
        },
      ],
      // The raw constructors build an unchecked client unless every call site
      // remembers the type argument. Keep them in the wrappers that do
      // (src/lib/supabase/{server,client,middleware,service}.ts) and let
      // everything else import those. `createClient` is NOT in the call selector
      // above: the name is shared with the local wrapper `@/lib/supabase/server`,
      // whose 100+ `await createClient()` call sites are already typed.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@supabase/supabase-js',
              importNames: ['createClient'],
              message:
                'Use createServiceRoleClient() from @/lib/supabase/service, or createClient() from @/lib/supabase/server. A raw createClient(url, key) with no <Database> is an unchecked client.',
            },
            {
              name: '@supabase/ssr',
              importNames: ['createServerClient', 'createBrowserClient'],
              message:
                'Use the wrappers in @/lib/supabase/{server,client}. They pass <Database>; a raw constructor here would not have to.',
            },
          ],
        },
      ],
    },
  },
  {
    // The wrappers are the one place allowed to call the raw constructors --
    // they are what the restriction above points everyone else at. The call
    // selector still applies here, so a wrapper that forgot <Database> fails.
    files: ['src/lib/supabase/**'],
    rules: { 'no-restricted-imports': 'off' },
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
