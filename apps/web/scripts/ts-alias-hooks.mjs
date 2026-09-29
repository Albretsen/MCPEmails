// Module resolution hooks so `node --test --experimental-strip-types` can run
// source files that use the app's `@/*` -> `src/*` tsconfig path alias.
//
// Next resolves that alias through its bundler; the bare node runner does not,
// so any test importing a module that itself imports `@/...` dies on
// ERR_MODULE_NOT_FOUND. This hook performs exactly the rewrite tsconfig
// declares and nothing else: anything that is not a `@/` specifier, and any
// `@/` specifier with no file behind it, falls through to the default resolver.
import { statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const SRC = path.resolve(fileURLToPath(import.meta.url), '../../src');

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

// `next` ships no `exports` map, so plain Node ESM cannot resolve an
// extensionless subpath like `next/server` (the bundler adds the `.js`). Route
// handler tests import that, usually to mock it. Only the extensionless form of
// a `next/<name>` subpath is rewritten, and only when the default resolver
// fails, so a Next that gains an exports map is left alone.
const NEXT_SUBPATH = /^next\/[a-z-]+$/;

export async function resolve(specifier, context, nextResolve) {
  if (NEXT_SUBPATH.test(specifier)) {
    try {
      return await nextResolve(specifier, context);
    } catch {
      return nextResolve(`${specifier}.js`, context);
    }
  }
  if (!specifier.startsWith('@/')) return nextResolve(specifier, context);
  const base = path.join(SRC, specifier.slice(2));
  const hit = firstFile([
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    path.join(base, 'index.ts'),
  ]);
  if (!hit) return nextResolve(specifier, context);
  return { url: pathToFileURL(hit).href, shortCircuit: true };
}
