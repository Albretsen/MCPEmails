// ---------------------------------------------------------------------------
// Static map of "which message namespaces does each route's client code read"
// against "which namespaces does that route's provider hand to the browser".
//
// WHY THIS EXISTS. next-intl serialises whatever `messages` a
// NextIntlClientProvider receives into the HTML of every page below it. Handing
// a route fewer namespaces makes its HTML smaller, and handing it one too few
// makes `useTranslations` render a raw key path (or throw) in front of a
// visitor. This module answers, from the source alone, whether every namespace
// a route can reach is still provided, so the set can be narrowed without
// guessing.
//
// HOW A ROUTE'S PROVIDER IS FOUND. Only layout files may declare a provider.
// For a route file the nearest layout above it that declares one wins, because
// a nested next-intl provider REPLACES the messages of the one above it (it
// does not merge). Three declarations are understood, and anything else is
// reported as a violation rather than guessed at:
//
//   <AppLocaleProvider>                    the namespaces bundled into
//                                          components/i18n/AppLocaleProvider.jsx
//   <ClientMessages namespaces={[...]}>    exactly the listed namespaces
//   <NextIntlClientProvider messages={X}>  X = `await getMessages()` (or the
//                                          attribute omitted, which next-intl
//                                          fills the same way): every namespace
//                                          src/i18n/request.ts loads.
//                                          X = null: none.
//
// WHAT COUNTS AS A READ. `useTranslations('<ns>...')` anywhere in the import
// closure of the route file (static imports, re-exports, `import()` and
// `require()`), which over-approximates: a component that is imported but never
// rendered still counts. A call whose namespace is not a string literal, a bare
// `useTranslations()`, and `useMessages()` are all reported, since none of them
// can be proven to stay inside a narrowed set.
//
// Regex over source rather than a parser, on purpose: the suite must run under
// a bare `node --test` with no build and no extra dependency. The price is that
// a `useTranslations('x')` mentioned in a comment is counted as a read, which
// errs on the safe side.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const SOURCE_EXT = ['.js', '.jsx', '.ts', '.tsx', '.mjs'];
const ROUTE_FILE = /^(page|layout|not-found|error|global-error|loading|template|default)\.(js|jsx|ts|tsx)$/;
const LAYOUT_FILE = /^layout\.(js|jsx|ts|tsx)$/;

/** Files that are allowed to contain a provider element without being a layout. */
const PROVIDER_MODULES = ['components/i18n/AppLocaleProvider.jsx', 'components/i18n/ClientMessages.jsx'];

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Every specifier a source file imports, statically or dynamically. */
export function importSpecifiers(source) {
  const found = new Set();
  const patterns = [
    /\bimport\s+(?:[^'"()]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

/** Translation reads in one source file. */
export function translationUses(source) {
  const uses = [];
  for (const match of source.matchAll(/\buseTranslations\s*\(\s*([^)]*)\)/g)) {
    const arg = match[1].trim();
    const literal = /^(['"])([A-Za-z0-9_.]+)\1$/.exec(arg);
    if (literal) uses.push({ kind: 'namespace', namespace: literal[2].split('.')[0], index: match.index });
    else uses.push({ kind: 'unprovable', detail: `useTranslations(${arg})`, index: match.index });
  }
  for (const match of source.matchAll(/\buseMessages\s*\(/g)) {
    uses.push({ kind: 'unprovable', detail: 'useMessages()', index: match.index });
  }
  return uses;
}

/**
 * Literal message keys a file reads, as full dotted paths.
 *
 * Follows `const t = useTranslations('ns')` to the `t('key')`, `t.rich('key')`,
 * `t.raw('key')` and `t.markup('key')` calls that use it; a call is attributed
 * to the nearest binding of that name above it in the file. Keys built at
 * runtime (template literals, variables) are not literals and are skipped.
 */
export function literalKeys(source) {
  const bindings = [];
  for (const match of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*useTranslations\s*\(\s*(['"])([A-Za-z0-9_.]+)\2\s*\)/g)) {
    bindings.push({ name: match[1], prefix: match[3], index: match.index });
  }
  const keys = [];
  const names = [...new Set(bindings.map((b) => b.name))];
  for (const name of names) {
    const escaped = name.replace(/[\\$]/g, '\\$&');
    const call = new RegExp(`(?<![\\w$.])${escaped}(?:\\.(?:rich|raw|markup))?\\s*\\(\\s*(['"])([A-Za-z0-9_.-]+)\\1\\s*[,)]`, 'g');
    for (const match of source.matchAll(call)) {
      const binding = bindings.filter((b) => b.name === name && b.index < match.index).pop();
      if (binding) keys.push(`${binding.prefix}.${match[2]}`);
    }
  }
  return [...new Set(keys)];
}

export function hasKey(messages, dotted) {
  let node = messages;
  for (const part of dotted.split('.')) {
    if (node === null || typeof node !== 'object' || !(part in node)) return false;
    node = node[part];
  }
  return true;
}

/**
 * @param {string} webRoot  the app root: holds app/, components/, src/, messages/
 */
export function analyze(webRoot) {
  const appDir = path.join(webRoot, 'app');
  const rel = (file) => path.relative(webRoot, file).split(path.sep).join('/');
  const sources = new Map();
  const read = (file) => {
    if (!sources.has(file)) sources.set(file, readFileSync(file, 'utf8'));
    return sources.get(file);
  };

  function resolve(fromFile, specifier) {
    let base;
    if (specifier.startsWith('@/')) base = path.join(webRoot, 'src', specifier.slice(2));
    else if (specifier.startsWith('.')) base = path.resolve(path.dirname(fromFile), specifier);
    else return null; // a package
    const candidates = [base, ...SOURCE_EXT.map((ext) => base + ext), ...SOURCE_EXT.map((ext) => path.join(base, `index${ext}`))];
    for (const candidate of candidates) {
      if (isFile(candidate) && SOURCE_EXT.includes(path.extname(candidate))) return candidate;
    }
    return null;
  }

  const closures = new Map();
  function closure(entry) {
    if (closures.has(entry)) return closures.get(entry);
    const seen = new Set([entry]);
    const queue = [entry];
    while (queue.length) {
      const file = queue.pop();
      for (const specifier of importSpecifiers(read(file))) {
        const target = resolve(file, specifier);
        if (target && !seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
    }
    closures.set(entry, seen);
    return seen;
  }

  // ---- what the server loads, and what each provider kind hands on ---------
  const violations = [];
  const requestSource = read(path.join(webRoot, 'src/i18n/request.ts'));
  const requestList = /MARKETING_NAMESPACES\s*=\s*\[([^\]]*)\]/.exec(requestSource);
  if (!requestList) throw new Error('src/i18n/request.ts: could not find the MARKETING_NAMESPACES list');
  const requestNamespaces = [...requestList[1].matchAll(/['"]([A-Za-z0-9_]+)['"]/g)].map((m) => m[1]);

  const localesDir = path.join(webRoot, 'messages');
  const locales = readdirSync(localesDir).filter((name) => statSync(path.join(localesDir, name)).isDirectory());
  const messages = {};
  for (const locale of locales) {
    messages[locale] = {};
    for (const file of readdirSync(path.join(localesDir, locale))) {
      if (file.endsWith('.json')) {
        messages[locale][file.slice(0, -5)] = JSON.parse(readFileSync(path.join(localesDir, locale, file), 'utf8'));
      }
    }
  }
  for (const namespace of requestNamespaces) {
    for (const locale of locales) {
      if (!(namespace in messages[locale])) {
        violations.push({ type: 'missing-file', detail: `messages/${locale}/${namespace}.json is loaded by src/i18n/request.ts but does not exist` });
      }
    }
  }

  let appNamespaces = null;
  const appProviderFile = path.join(webRoot, 'components/i18n/AppLocaleProvider.jsx');
  if (existsSync(appProviderFile)) {
    const table = /const MESSAGES\s*=\s*\{([\s\S]*?)\n\};/.exec(read(appProviderFile));
    if (!table) throw new Error('AppLocaleProvider.jsx: could not find the MESSAGES table');
    const rows = [...table[1].matchAll(/^\s*([a-z]{2}):\s*\{([^}]*)\}/gm)];
    const perLocale = rows.map((row) => ({ locale: row[1], keys: [...row[2].matchAll(/([A-Za-z0-9_]+)\s*:/g)].map((m) => m[1]).sort() }));
    if (perLocale.length === 0) throw new Error('AppLocaleProvider.jsx: the MESSAGES table has no locale rows');
    appNamespaces = perLocale[0].keys;
    for (const row of perLocale) {
      if (row.keys.join() !== appNamespaces.join()) {
        violations.push({ type: 'app-provider-uneven', detail: `AppLocaleProvider MESSAGES.${row.locale} has [${row.keys}] but MESSAGES.${perLocale[0].locale} has [${appNamespaces}]` });
      }
    }
    for (const locale of locales) {
      if (!perLocale.some((row) => row.locale === locale)) {
        violations.push({ type: 'app-provider-uneven', detail: `AppLocaleProvider MESSAGES has no row for locale ${locale}` });
      }
    }
  }

  /** The provider a layout file declares, or null. */
  function providerOf(layoutFile) {
    const source = read(layoutFile);
    const declared = [];
    if (/<AppLocaleProvider[\s>]/.test(source)) {
      if (!appNamespaces) throw new Error(`${rel(layoutFile)} uses AppLocaleProvider, which was not found`);
      declared.push({ kind: 'AppLocaleProvider', namespaces: appNamespaces });
    }
    for (const match of source.matchAll(/<ClientMessages\b([^>]*)>/g)) {
      const list = /namespaces=\{\s*\[([^\]]*)\]\s*\}/.exec(match[1]);
      if (!list) {
        violations.push({ type: 'unrecognised-provider', file: rel(layoutFile), detail: '<ClientMessages> without a literal namespaces={[...]} list' });
        declared.push({ kind: 'ClientMessages', namespaces: [] });
        continue;
      }
      const namespaces = [...list[1].matchAll(/['"]([A-Za-z0-9_]+)['"]/g)].map((m) => m[1]);
      for (const namespace of namespaces) {
        if (!requestNamespaces.includes(namespace)) {
          violations.push({ type: 'unknown-namespace', file: rel(layoutFile), detail: `<ClientMessages> lists "${namespace}", which src/i18n/request.ts does not load` });
        }
      }
      declared.push({ kind: 'ClientMessages', namespaces: namespaces.filter((n) => requestNamespaces.includes(n)) });
    }
    for (const match of source.matchAll(/<NextIntlClientProvider\b([^>]*)>/g)) {
      const attr = /\bmessages=\{([^}]*)\}/.exec(match[1]);
      const value = attr ? attr[1].trim() : undefined;
      if (value === undefined) {
        declared.push({ kind: 'NextIntlClientProvider(inherit)', namespaces: requestNamespaces });
      } else if (value === 'null') {
        declared.push({ kind: 'NextIntlClientProvider(null)', namespaces: [] });
      } else if (/^[A-Za-z_$][\w$]*$/.test(value) && new RegExp(`\\b${value}\\s*=\\s*await\\s+getMessages\\s*\\(\\s*\\)`).test(source)) {
        declared.push({ kind: 'NextIntlClientProvider(getMessages)', namespaces: requestNamespaces });
      } else {
        violations.push({ type: 'unrecognised-provider', file: rel(layoutFile), detail: `<NextIntlClientProvider messages={${value}}> is not a form this analysis can prove` });
        declared.push({ kind: 'NextIntlClientProvider(?)', namespaces: [] });
      }
    }
    if (declared.length > 1) {
      violations.push({ type: 'unrecognised-provider', file: rel(layoutFile), detail: 'more than one provider declared in a single layout' });
    }
    return declared[0] ?? null;
  }

  // ---- routes ---------------------------------------------------------------
  const routeFiles = walk(appDir).filter((file) => ROUTE_FILE.test(path.basename(file)));
  const layouts = new Map();
  for (const file of routeFiles) {
    if (LAYOUT_FILE.test(path.basename(file))) layouts.set(path.dirname(file), file);
  }
  const providers = new Map();
  for (const file of layouts.values()) providers.set(file, providerOf(file));

  /** Nearest provider at or above `dir`. */
  function scopeFrom(dir) {
    let current = dir;
    for (;;) {
      const layout = layouts.get(current);
      if (layout && providers.get(layout)) return { layout: rel(layout), ...providers.get(layout) };
      if (current === appDir) return { layout: null, kind: 'none', namespaces: [] };
      current = path.dirname(current);
    }
  }

  // A provider element anywhere except a layout (or the provider modules
  // themselves) would not be seen by scopeFrom(), so it is refused outright.
  const allSource = [appDir, path.join(webRoot, 'components'), path.join(webRoot, 'src')]
    .filter((dir) => existsSync(dir))
    .flatMap((dir) => walk(dir))
    .filter((file) => SOURCE_EXT.includes(path.extname(file)) && !/\.test\.[a-z]+$/.test(file));
  for (const file of allSource) {
    if (layouts.get(path.dirname(file)) === file) continue;
    if (PROVIDER_MODULES.includes(rel(file))) continue;
    if (/<(NextIntlClientProvider|ClientMessages|AppLocaleProvider)[\s>]/.test(read(file))) {
      violations.push({ type: 'provider-outside-layout', file: rel(file), detail: 'a message provider is rendered outside a layout file, where this analysis cannot place it' });
    }
  }

  const routes = [];
  for (const file of routeFiles) {
    const name = path.basename(file);
    const isLayout = LAYOUT_FILE.test(name);
    const own = isLayout ? providers.get(file) : null;
    // global-error replaces the root layout, so nothing above it applies. A
    // layout's own imports render outside the provider it declares.
    let scope;
    if (/^global-error\./.test(name)) scope = { layout: null, kind: 'none', namespaces: [] };
    else if (isLayout && own) scope = file === layouts.get(appDir) ? { layout: null, kind: 'none', namespaces: [] } : scopeFrom(path.dirname(path.dirname(file)));
    else scope = scopeFrom(path.dirname(file));

    const needs = new Map(); // namespace -> files that read it
    const keys = new Map(); // dotted key -> file
    for (const member of closure(file)) {
      const source = read(member);
      for (const use of translationUses(source)) {
        if (use.kind === 'unprovable') {
          violations.push({ type: 'unprovable-read', route: rel(file), file: rel(member), detail: use.detail });
        } else {
          if (!needs.has(use.namespace)) needs.set(use.namespace, []);
          needs.get(use.namespace).push(rel(member));
        }
      }
      for (const key of literalKeys(source)) if (!keys.has(key)) keys.set(key, rel(member));
    }

    if (isLayout && own && needs.size > 0) {
      // Fail closed: what a provider-declaring layout renders itself could sit
      // inside or outside its own provider, and this analysis does not look.
      violations.push({ type: 'layout-reads-messages', route: rel(file), detail: `a layout that declares a provider also imports code reading [${[...needs.keys()]}]` });
    }
    for (const [namespace, files] of needs) {
      if (!scope.namespaces.includes(namespace)) {
        violations.push({
          type: 'namespace-not-provided',
          route: rel(file),
          namespace,
          file: files[0],
          detail: `${rel(file)} can reach useTranslations('${namespace}') in ${files[0]}, but its provider (${scope.kind}${scope.layout ? ` in ${scope.layout}` : ''}) only hands on [${scope.namespaces}]`,
        });
      }
    }
    for (const [key, member] of keys) {
      const namespace = key.split('.')[0];
      const rest = key.slice(namespace.length + 1);
      for (const locale of locales) {
        const tree = messages[locale][namespace];
        if (tree === undefined || (rest && !hasKey(tree, rest))) {
          violations.push({ type: 'missing-key', route: rel(file), file: member, locale, key, detail: `${member} reads "${key}", which messages/${locale}/${namespace}.json does not define` });
        }
      }
    }
    routes.push({ file: rel(file), provider: scope.kind, providerLayout: scope.layout, provided: [...scope.namespaces].sort(), needs: [...needs.keys()].sort(), keyCount: keys.size });
  }

  // De-duplicate: the same missing key is reachable from many routes.
  const seen = new Set();
  const unique = violations.filter((v) => {
    const id = v.type === 'missing-key' ? `${v.type}|${v.locale}|${v.key}` : `${v.type}|${v.route ?? ''}|${v.file ?? ''}|${v.detail}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  return { requestNamespaces, appNamespaces, locales, routes, violations: unique };
}
