// Module hooks so a bare `node --test` run can import the dashboard's own
// `.jsx` components instead of a copy of them.
//
// WHY THIS EXISTS. `src/lib/drafts/editor-preference.ts` is pure arithmetic and
// a plain `node --test` file covers it. The bugs that actually reach a customer
// live one layer up, in how `Pages.jsx` and `App.jsx` WIRE that arithmetic to a
// checkbox and a PATCH body: an inverted `checked`, a `!` on the way into
// `hiddenFromShown`, a rollback that restores the value that just failed. None
// of those are visible to a test that imports the helper directly, and every
// one of them is a silently wrong preference in production.
//
// Node can strip TypeScript types on its own (`--experimental-strip-types`) but
// it cannot parse JSX, so importing `Pages.jsx` dies at the first `<div>`. This
// hook transpiles JSX with TypeScript's own `transpileModule` rather than adding
// a bundler to the test path. The transform is deliberately minimal: JSX to
// `react-jsx` calls, everything else left alone.
//
// It imports `typescript6`, an npm alias of typescript@6, not `typescript`.
// TypeScript 7 is the native compiler: its package ships the `tsc` binary and
// no JavaScript compiler API, so `ts.transpileModule` and `ts.JsxEmit` are
// simply absent under 7 and every JSX test died at its first import. The alias
// keeps the one API this hook needs, while `tsc`, `next build` and the editor
// all run on 7. Drop it once TypeScript 7 publishes a stable transpile API.
//
// `next/navigation` and `@/lib/supabase/client` are redirected to the stubs in
// `scripts/test-stubs/`, because the component tree reaches them through
// Sidebar and there is no Next request context or Supabase project behind a
// `node --test` process. Nothing else is substituted: `next-intl`, React and
// every dashboard component are the real modules, so a test failure here is a
// failure of the real code.
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import ts from 'typescript6';

const STUBS = path.resolve(fileURLToPath(import.meta.url), '../test-stubs');

/** Bare specifiers with no meaningful shape outside a Next server. */
const SUBSTITUTIONS = new Map([
  ['next/navigation', path.join(STUBS, 'next-navigation.mjs')],
  ['@/lib/supabase/client', path.join(STUBS, 'supabase-client.mjs')],
]);

/** What Next's bundler appends to an extensionless relative import. */
const EXTENSIONS = ['.jsx', '.tsx', '.ts', '.js', '.mjs'];

function firstFile(candidates) {
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not there; try the next extension.
    }
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  const stub = SUBSTITUTIONS.get(specifier);
  if (stub) return { url: pathToFileURL(stub).href, shortCircuit: true };

  // The components are written for a bundler, so `import { Icon } from
  // '../Primitives'` has no extension. Node requires one. Resolve it the way
  // Next does, and only for a relative specifier that has no extension of its
  // own, so nothing about package resolution changes.
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !path.extname(specifier)) {
    const parent = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : null;
    if (parent) {
      const base = path.resolve(parent, specifier);
      const hit = firstFile([
        ...EXTENSIONS.map((ext) => `${base}${ext}`),
        ...EXTENSIONS.map((ext) => path.join(base, `index${ext}`)),
      ]);
      if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
    }
  }

  // The bundler lets `import messages from '../../messages/en/dashboard.json'`
  // stand without an import attribute; Node requires `with { type: 'json' }`.
  // Supplying it here keeps the components' own import lines untouched, which
  // matters: AppLocaleProvider's five locale imports are part of what these
  // tests render.
  if (specifier.endsWith('.json') && !context.importAttributes?.type) {
    const resolved = await nextResolve(specifier, context);
    return { ...resolved, importAttributes: { type: 'json' }, shortCircuit: true };
  }

  // `next/link`, `next/image`: real files, but Next's package exports do not
  // map the extensionless form for a plain Node resolver.
  if (specifier.startsWith('next/') && !path.extname(specifier)) {
    try {
      return await nextResolve(`${specifier}.js`, context);
    } catch {
      // Fall through and let the default resolver report the real problem.
    }
  }

  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith('.jsx') && !url.endsWith('.tsx')) return nextLoad(url, context);
  const source = await readFile(fileURLToPath(url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    fileName: fileURLToPath(url),
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      // Keep every import specifier byte-identical so the resolve hook above
      // and the `@/` alias hook still see what the source actually wrote.
      verbatimModuleSyntax: false,
    },
  });
  return { format: 'module', source: outputText, shortCircuit: true };
}
