// ---------------------------------------------------------------------------
// The sentinel that marks an MCP client's cached tool listing stale is written
// by two codebases that cannot import from one another: this Next.js app, and
// the Deno edge function in supabase/functions/mcp-server/ (deployed on its own
// with `supabase functions deploy`, which bundles only what lives under
// supabase/functions/).
//
// Until now the value existed three times — once as an exported constant in the
// edge function, and twice as a bare 'stale' literal inside these route
// handlers — with nothing relating them. Renaming the constant would have left
// the dashboard writing a value the server no longer recognises: hiding the
// draft editor card would have gone on "working", written its row, and never
// reached a single connected client, with every test still green.
//
// So the relationship is enforced rather than conventional, and from BOTH
// sides, so that whichever suite a change happens to run catches it. The mirror
// of this file is the "the dashboard's copy of the sentinel agrees with this
// one" test in supabase/functions/mcp-server/card-build-notify.test.ts.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CARD_LISTING_STALE } from './card-listing.ts';

// src/lib/mcp/ -> apps/web/ -> apps/ -> repo root
const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

test('the edge function and the dashboard agree on the sentinel', () => {
  const source = readFileSync(
    `${repoRoot}supabase/functions/mcp-server/card-build-notify.ts`,
    'utf8',
  );
  const match = source.match(/export const CARD_LISTING_STALE = "([^"]*)";/);
  assert.ok(
    match,
    'supabase/functions/mcp-server/card-build-notify.ts no longer exports a CARD_LISTING_STALE literal',
  );
  assert.equal(
    match[1],
    CARD_LISTING_STALE,
    'the two copies of the tool-listing sentinel have drifted; make them the same string again',
  );
});

test('the sentinel can never be mistaken for a review-card build id', () => {
  // The server compares this column against REVIEW_CARD_BUILD_ID, which is 12
  // lowercase hex. A sentinel that could equal one would be overwritten by a
  // deploy and stop invalidating anything.
  assert.equal(/^[0-9a-f]{12}$/.test(CARD_LISTING_STALE), false);
});

// ---------------------------------------------------------------------------
// Every writer of the sentinel goes through the constant
//
// The first version of this check had three holes, each of which let a
// hardcoded sentinel back in with the suite green:
//
//  1. The negative check was /card_build_notified:\s*['"`]/, which a writer
//     spelled `['card_build_notified']: 'stale'` — or with a space before the
//     colon — walks straight past. So it now looks for a quoted literal equal
//     to the SENTINEL VALUE anywhere in the file, whatever the property is
//     spelled like, and runs on the RAW source so comment-stripping cannot hide
//     one.
//  2. The positive check was `source.includes(...)` on the raw file, which a
//     COMMENT satisfies: delete the real write, leave a comment mentioning it,
//     green. It now runs on the source with comments and only comments removed.
//  3. Coverage was two hardcoded route paths, so a third writer added later was
//     not checked at all. Writers are now DISCOVERED by walking the source.
//
// The DISCOVERY was the real problem, and it was attacked five times. Every
// round it was a hand-maintained list of top-level roots, and every round a
// verifier found a tree that was not on it — `.jsx` under apps/web; then
// apps/web itself rather than app/ + src/; then the whole edge-function
// RUNTIME; then the other four edge functions plus packages/, scripts/,
// tools/, self-host/ and apps/mcp-app. The fifth round found six more, all
// reproduced GREEN on 2026-09-17 against the round-4 checker (1164 passed / 0
// failed in the Deno mirror and 8/8 here, identical to the clean-tree control,
// with each probe live in the tree):
//
//   * `docs/` was not a root, and it is a live source tree —
//     docs/token-cost/measure.mjs is 213 lines of executable Node with a
//     shebang;
//   * the repo ROOT was not a root, so `./probe.ts` passed;
//   * `.sql` lived outside SQL_ROOTS in three places: supabase/tests/ (4 live
//     files), supabase/verify_rls_production.sql sitting directly beside
//     functions/ and migrations/, and docs/usage-based-pricing/*.sql;
//   * a symlinked DIRECTORY inside a walked root was invisible, because
//     `Dirent.isDirectory()` and Deno's `DirEntry.isDirectory` are both lstat
//     semantics: such an entry is neither recursed into nor extension-matched,
//     so it fell through both branches silently;
//   * `packages/mcpemails/fixtures.test.helper.ts` was skipped by the
//     `!/\.test\./` filter — precisely the fixture-a-refactor-promotes-to-real-
//     code case, and the name never has to change;
//   * out/ and build/ are gitignored but were NOT skipped (only node_modules
//     and dot-prefixed names were), so a bundle emitted there could be read and
//     FALSE-FAIL on a bundled 'stale'.
//   * and one the fifth round did not name: the walk skipped every entry whose
//     NAME starts with a dot, which excluded apps/web/app/.well-known/ — SEVEN
//     live Next.js route handlers, four of them the OAuth metadata routes. A
//     writer planted there passed 1164/0 and 8/8 on 2026-09-17. That skip is
//     also exactly how the 623-file figure reconciles: 623 tracked source files
//     sit under the old roots once .test.-named files and dot-prefixed paths are
//     removed, and the new list is 759.
//
// So the root list is gone, and nothing replaces it. The file list is
// `git ls-files --cached --others --exclude-standard`, which IS the repo:
// every tracked file, plus every untracked file the repo does not ignore. That
// closes all six at once and permanently. node_modules/, .next/, out/, build/
// and .claude/ are excluded by the repo's own .gitignore instead of by a second
// hand-maintained list; git does not descend a symlinked directory, so a
// symlink's target is enumerated at its real path or not at all; and a new
// top-level directory is covered the day it is committed, by someone who has
// never heard of this file. `--others` keeps the property the filesystem walk
// had, that an uncommitted writer is still caught.
//
// The `.test.` skip went with it: a filename-shaped skip is the same mistake one
// level down. Every source file is read now, and the four files ALLOWED to
// contain a bare sentinel literal are listed by path in SENTINEL_EXEMPT — the
// two modules that declare the constant, and these two drift checks, which
// quote every evasion they pin.
//
// SQL is checked too, because the sentinel IS a database value and a migration
// or PL/pgSQL function is a plausible writer no TypeScript walk can see. That
// check used to be shape-matching — `set card_build_notified = '…'` and a DDL
// `default '…'`, over a source with SQL comments stripped — and it was defeated
// in its own home directory: one planted migration under supabase/migrations/
// carried three real writes and passed both suites. Ten assignment shapes
// passed in all: `$$stale$$` and `$tag$stale$tag$`, `INSERT … VALUES`,
// `ON CONFLICT DO UPDATE SET … = excluded.…`, a PL/pgSQL `:=` through a
// variable, a trigger's `NEW.col :=`, MIXED CASE (unquoted SQL identifiers are
// case-insensitive; the `includes()` early return was not, so such a file was
// never even considered), `CASE WHEN … THEN 'stale'`,
// `EXECUTE format('… = %L', 'stale')`, and `concat('sta','le')` / `chr(115)||…`.
//
// The comment stripper was broken in both directions on top of that. False
// pass: a `--` inside a string literal ate the rest of the line, write included
// (`set note = 'a -- b', card_build_notified = 'stale'`). False FAILURE, twice,
// which defeats the stripper's own stated purpose of not tripping over
// `comment on column`: documenting the forbidden shape in the column comment
// turned the suite RED, both as `… is 'do not write: set card_build_notified =
// ''stale'''` and as `… is 'never give this column a default ''stale'''`. And
// PostgreSQL NESTS block comments while `/\/\*[\s\S]*?\*\//` stops at the first
// `*/`, so `/* outer /* inner */ update … 'stale'; */` — entirely a comment to
// PostgreSQL — was a third false failure, not the false pass it looks like.
//
// Every fix for those is a step toward a SQL parser, which is how this checker's
// TypeScript half acquired its own documented-not-closed evasions. So the rule
// is blunt and the stripper is DELETED: no `.sql` file may NAME
// `card_build_notified` at all, case-insensitively, except the two migrations in
// SQL_ALLOWED. There is no shape to evade, because nothing but the identifier is
// matched. The value does not enter into it, which also catches a migration
// writing this column some value OTHER than the sentinel — the same drift, and
// invisible to any quoted-'stale' rule. The one false-failure mode is a
// migration that genuinely has to touch the column, and the fix is a one-line
// SQL_ALLOWED edit with a reason beside it.
//
// Two evasions are still DOCUMENTED rather than closed on the TypeScript side,
// because closing them means parsing rather than matching: a column name
// assembled from fragments (`['card_build' + '_notified']`) is invisible to a
// check keyed on the literal column name, and a sentinel value assembled from
// fragments (`'sta' + 'le'`) is invisible to the quoted-literal check. Both look
// deliberate enough that a reviewer would stop them, which is not true of a
// `.jsx` file. The SQL rule above has no such gap, because it matches the
// identifier and nothing else.
//
// The checker is pinned against synthetic evasions below: a check asserted only
// against files that already pass proves nothing about what it rejects.
//
// The twin of all of this is in supabase/functions/mcp-server/
// card-build-notify.test.ts, duplicated for the same reason the constant is.
// ---------------------------------------------------------------------------

/**
 * Remove `//` and block comments, leaving string and template literals intact.
 *
 * Deliberately not a parser: it does not know regex literals, so a regex
 * containing an unbalanced quote would confuse it. Neither writer contains one,
 * and the failure mode is a FALSE FAILURE on the positive check, never a false
 * pass — the negative check runs on the raw source so it cannot be fooled this
 * way.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (quote !== null) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Everything wrong with one file that writes `card_build_notified`. */
function sentinelWriterProblems(source: string): string[] {
  const code = stripComments(source);
  // A file that only MENTIONS the column in prose is not a writer.
  if (!code.includes('card_build_notified')) return [];

  const problems: string[] = [];
  // Whitespace-tolerant: prettier is free to break this property across lines
  // (`card_build_notified:\n  CARD_LISTING_STALE`) and a substring match would
  // then FALSE-FAIL on a correct writer, which teaches people to delete the
  // check. The negative check below is what has to be strict.
  if (!/card_build_notified\s*:\s*CARD_LISTING_STALE\b/.test(code)) {
    problems.push('does not write `card_build_notified: CARD_LISTING_STALE` in code');
  }
  if (!code.includes('CARD_LISTING_STALE')) {
    problems.push('does not reference the shared constant at all');
  }
  const literal = new RegExp(`['"\`]${CARD_LISTING_STALE}['"\`]`);
  if (literal.test(source)) {
    problems.push(`hardcodes a ${JSON.stringify(CARD_LISTING_STALE)} literal`);
  }
  return problems;
}

/**
 * Every extension a module in this repo can be written in. `.jsx` and `.cjs`
 * were the gap: `.jsx` is live under apps/web (46 files) and a `.jsx` writer
 * passed the whole suite before this list was widened.
 */
const SOURCE_EXTENSIONS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** `.sql` has its own, blunter rule — see `sqlSentinelProblems`. */
const SQL_EXTENSION = /\.sql$/;

/**
 * Every file in the repo, repo-relative, from git.
 *
 * This replaces a hand-maintained list of top-level roots that was defeated in
 * five straight rounds. `git ls-files` cannot be defeated by putting a file
 * somewhere new, because "somewhere new" is still in the repo — and the repo's
 * own .gitignore, not a second list, is what keeps node_modules/, .next/, out/,
 * build/ and .claude/ out.
 *
 * Failing to run git THROWS. A discovery step that quietly finds nothing reads
 * as green, which is exactly how this check kept being wrong.
 */
let cachedRepoFiles: string[] | null = null;
function repoFiles(): string[] {
  if (cachedRepoFiles) return cachedRepoFiles;
  let stdout: string;
  try {
    stdout = execFileSync(
      'git',
      // --cached: tracked. --others --exclude-standard: untracked and not
      // ignored, which keeps the filesystem walk's property that a writer is
      // caught before anyone commits it. -z: paths with spaces or newlines.
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (cause) {
    throw new Error(
      `the sentinel drift check could not run \`git ls-files\` in ${repoRoot}; ` +
        'it needs a git checkout to know what the repo contains',
      { cause },
    );
  }
  const files = stdout.split('\0').filter((p) => p !== '');
  assert.ok(files.length > 0, `git listed no files under ${repoRoot}`);
  cachedRepoFiles = files;
  return files;
}

/** The repo files with one of these extensions, repo-relative. */
function repoFilesMatching(match: RegExp): string[] {
  return repoFiles().filter((p) => match.test(p));
}

/**
 * Read one repo-relative path.
 *
 * A path git listed that cannot be read — a symlink pointing at a directory, a
 * staged deletion — is a LOUD failure NAMING the file, never a silent skip. The
 * bare errno does not say which file it was.
 */
function readRepoFile(path: string): string {
  try {
    return readFileSync(`${repoRoot}${path}`, 'utf8');
  } catch (cause) {
    throw new Error(`the sentinel drift check could not read ${path}`, { cause });
  }
}

/**
 * The only files allowed to contain a bare sentinel literal.
 *
 * The first two DECLARE the constant, one per runtime. The last two are these
 * drift checks themselves, which quote every evasion they pin. They used to be
 * excluded by a `!/\.test\./` filename filter, which also excluded
 * `fixtures.test.helper.ts` — a fixture a refactor promotes to real code
 * without the name ever changing. A path list cannot make that mistake.
 */
const SENTINEL_EXEMPT = new Set([
  'apps/web/src/lib/mcp/card-listing.ts',
  'apps/web/src/lib/mcp/card-listing.test.ts',
  'supabase/functions/mcp-server/card-build-notify.ts',
  'supabase/functions/mcp-server/card-build-notify.test.ts',
]);

/**
 * The only `.sql` files allowed to NAME `card_build_notified`.
 *
 * One creates the column and one re-comments it; neither writes it. Adding a
 * path here is the only way to make a migration that touches this column pass,
 * and it should carry a reason.
 */
const SQL_ALLOWED = new Set([
  'supabase/migrations/20260916160000_card_build_notified.sql',
  'supabase/migrations/20260916180000_card_build_notified_comment.sql',
]);

/**
 * Everything wrong with one `.sql` file.
 *
 * Not a shape match and not a value match: NAMING the column is the problem,
 * because SQL cannot import `CARD_LISTING_STALE` and therefore has no correct
 * way to write this column at all. Case-insensitive, because unquoted SQL
 * identifiers are — a `NEW.CARD_BUILD_NOTIFIED := 'stale'` trigger slipped the
 * old check on nothing more than that.
 *
 * There is no comment stripper any more, and no double-dash, block-comment,
 * dollar-quote or string-literal awareness, because nothing needs protecting:
 * a `comment on column` inside one of the two allow-listed migrations passes on
 * its PATH, whatever it says, and the same text in any other `.sql` file is a
 * new file touching this column, which is exactly what should be reviewed.
 */
function sqlSentinelProblems(path: string, source: string): string[] {
  if (SQL_ALLOWED.has(path)) return [];
  if (!/card_build_notified/i.test(source)) return [];
  return [
    'names card_build_notified. SQL cannot import CARD_LISTING_STALE, so no ' +
      '.sql file may read or write this column — write it from TypeScript. If a ' +
      'migration genuinely has to touch it, add its path to SQL_ALLOWED in this ' +
      'test, with a reason.',
  ];
}

test('every writer of the sentinel goes through the constant', () => {
  // The whole repo, from git. There is no root list to be outside of.
  const writers: string[] = [];
  for (const path of repoFilesMatching(SOURCE_EXTENSIONS)) {
    if (SENTINEL_EXEMPT.has(path)) continue;
    const source = readRepoFile(path);
    if (!source.includes('card_build_notified')) continue;
    writers.push(path);
    const problems = sentinelWriterProblems(source);
    assert.deepEqual(problems, [], `${path}: ${problems.join('; ')}`);
  }

  // A discovery step that silently found nothing would read as green. All
  // THREE writers must be among what was found — the third, the edge
  // function's own invalidateCardListings(), is the one "both dashboard
  // routes" leaves out and the one a web-rooted walk structurally could not
  // reach.
  for (const known of [
    'apps/web/app/api/inboxes/[id]/route.ts',
    'apps/web/app/api/workspaces/[id]/route.ts',
    'supabase/functions/mcp-server/index.ts',
  ]) {
    assert.ok(
      writers.includes(known),
      `the discovery step missed ${known}; it found ${writers.length} file(s)`,
    );
  }

  // And the exemption list must not rot into a set of paths that no longer
  // exist, which would quietly stop excusing anything while looking deliberate.
  const all = new Set(repoFiles());
  for (const exempt of SENTINEL_EXEMPT) {
    assert.ok(all.has(exempt), `SENTINEL_EXEMPT lists ${exempt}, which is not in the repo`);
  }
});

test('no SQL names the sentinel column outside the two migrations that own it', () => {
  // The column is a database value, so a migration or PL/pgSQL function is a
  // plausible writer no TypeScript walk can see. The rule is not "must not
  // assign a quoted literal" any more — ten assignment shapes beat that — it is
  // "must not name the column", with two migrations allow-listed by path.
  const named: string[] = [];
  for (const path of repoFilesMatching(SQL_EXTENSION)) {
    const source = readRepoFile(path);
    if (/card_build_notified/i.test(source)) named.push(path);
    const problems = sqlSentinelProblems(path, source);
    assert.deepEqual(problems, [], `${path}: ${problems.join('; ')}`);
  }

  // Anti-silence and anti-rot in one: each allow-listed path must actually be
  // in the repo AND actually still name the column. An allow-list entry for a
  // deleted or rewritten migration is a hole nobody would notice.
  for (const allowed of SQL_ALLOWED) {
    assert.ok(
      named.includes(allowed),
      `SQL_ALLOWED lists ${allowed}, which the enumeration did not find naming ` +
        `the column; it found ${named.length} file(s) that do. Is the allow-list stale?`,
    );
  }
});

test('the SQL rule is a path allow-list, not a shape match', () => {
  const other = 'supabase/migrations/29990101000000_new.sql';
  const owned = 'supabase/migrations/20260916180000_card_build_notified_comment.sql';
  const red = (sql: string) => sqlSentinelProblems(other, sql).length > 0;

  // The ten assignment shapes that passed the old shape-matching rule, each
  // reproduced green on 2026-09-17 as a live migration under
  // supabase/migrations/ — the checker's own home directory.
  assert.ok(
    red("update public.api_keys set card_build_notified = $$stale$$ where id = p_key;"),
    'dollar-quoting must be rejected',
  );
  assert.ok(
    red("update public.api_keys set card_build_notified = $tag$stale$tag$ where id = $1;"),
    'tagged dollar-quoting must be rejected',
  );
  assert.ok(
    red("insert into public.api_keys (id, card_build_notified) values ($1, 'stale');"),
    'INSERT ... VALUES must be rejected',
  );
  assert.ok(
    red(
      "insert into public.api_keys (id, card_build_notified) values ($1, 'stale')\n" +
        'on conflict (id) do update set card_build_notified = excluded.card_build_notified;',
    ),
    'ON CONFLICT DO UPDATE SET ... = excluded... must be rejected',
  );
  assert.ok(
    red("v := 'stale';\nupdate public.api_keys set card_build_notified = v;"),
    "a PL/pgSQL := through a variable must be rejected",
  );
  assert.ok(
    red("NEW.card_build_notified := 'stale';"),
    "a trigger's NEW.col := must be rejected",
  );
  assert.ok(
    red("NEW.CARD_BUILD_NOTIFIED := 'stale';"),
    'MIXED CASE must be rejected: unquoted SQL identifiers are case-insensitive, ' +
      'and the old includes() early return was not, so such a file was never considered',
  );
  assert.ok(
    red("update public.api_keys set card_build_notified = case when true then 'stale' end;"),
    'CASE WHEN ... THEN must be rejected',
  );
  assert.ok(
    red("execute format('update public.api_keys set card_build_notified = %L', 'stale');"),
    'EXECUTE format(... %L ...) must be rejected',
  );
  assert.ok(
    red("update public.api_keys set card_build_notified = concat('sta', 'le');"),
    'a value assembled from fragments must be rejected; no rule keyed on a quoted ' +
      'sentinel can see this one, which is why the value does not enter into it at all',
  );
  assert.ok(
    red('update public.api_keys set card_build_notified = chr(115)||chr(116);'),
    'chr() assembly must be rejected for the same reason',
  );

  // Both directions the deleted comment stripper was broken in.
  assert.ok(
    red("update public.api_keys set note = 'a -- b', card_build_notified = 'stale';"),
    "a double dash inside a string literal used to eat the write; there is no stripper now",
  );
  assert.ok(
    red("/* outer /* inner */ update public.api_keys set card_build_notified = 'stale'; */"),
    'PostgreSQL nests block comments and the stripper did not; the nesting made this a ' +
      'false FAILURE rather than the false pass it looks like. Either way a new .sql ' +
      'file naming this column is reviewable, so it is rejected on the name alone',
  );

  // And a value OTHER than the sentinel, which is the same drift and which no
  // quoted-'stale' rule could ever see.
  assert.ok(
    red("update public.api_keys set card_build_notified = 'abc123456789';"),
    'writing this column any value at all from SQL must be rejected',
  );

  // The two false FAILURES the stripper produced, both now green, because the
  // path is what excuses them and the two live migrations are on the list.
  assert.deepEqual(
    sqlSentinelProblems(
      owned,
      "comment on column public.api_keys.card_build_notified is\n" +
        "  'do not write: set card_build_notified = ''stale''';",
    ),
    [],
    'documenting the forbidden shape in the column comment must not turn the suite red',
  );
  assert.deepEqual(
    sqlSentinelProblems(
      owned,
      "comment on column public.api_keys.card_build_notified is\n" +
        "  'never give this column a default ''stale''; TypeScript owns the write.';",
    ),
    [],
    'and neither must documenting the DDL half of it',
  );

  // A `.sql` file that does not name the column is not the SQL rule's business,
  // wherever it lives and whatever it quotes.
  assert.deepEqual(
    sqlSentinelProblems(other, "update public.api_keys set note = 'stale';"),
    [],
    'the rule is keyed on the column, not on the word',
  );
});

test("the file list is git's, not a hand-maintained root list", () => {
  for (const name of ['x.ts', 'x.tsx', 'x.mts', 'x.cts', 'x.js', 'x.jsx', 'x.mjs', 'x.cjs']) {
    assert.ok(SOURCE_EXTENSIONS.test(name), `${name} must be checked`);
  }
  assert.equal(SOURCE_EXTENSIONS.test('x.json'), false, 'data files are not sources');
  assert.equal(SOURCE_EXTENSIONS.test('x.css'), false, 'stylesheets are not sources');
  assert.equal(SOURCE_EXTENSIONS.test('x.sql'), false, 'SQL has its own rule');
  assert.ok(SQL_EXTENSION.test('x.sql'), 'and that rule must actually see .sql');

  const files = repoFiles();
  const has = (p: string) => files.includes(p);

  // The six holes the fifth round found, each pinned against a file that is
  // really there rather than against a directory name.
  assert.ok(
    has('docs/token-cost/measure.mjs'),
    'docs/ is a live source tree (213 lines of executable Node here) and was not a root',
  );
  assert.ok(
    files.some((f) => !f.includes('/')),
    'the repo ROOT itself must be in the list; ./probe.ts passed before',
  );
  assert.ok(
    has('supabase/tests/usage_based_pricing.sql'),
    'supabase/tests/ holds live .sql and was outside SQL_ROOTS',
  );
  assert.ok(
    has('supabase/verify_rls_production.sql'),
    'this .sql sits directly beside functions/ and migrations/ and was outside SQL_ROOTS',
  );
  assert.ok(
    has('docs/usage-based-pricing/internal-reports.sql'),
    'docs/ holds live .sql too',
  );
  assert.ok(
    has('apps/web/app/.well-known/oauth-protected-resource/route.ts'),
    'a dot-prefixed DIRECTORY is not a hidden file: the old walk skipped every ' +
      'entry whose name starts with a dot and lost seven live route handlers here',
  );
  assert.ok(
    has('apps/web/src/lib/mcp/card-listing.test.ts'),
    'test files are in the list now; SENTINEL_EXEMPT excuses them by path, not a ' +
      'filename pattern, so fixtures.test.helper.ts is checked',
  );
  // Symlinked directories: git does not descend them, so a symlink cannot hide a
  // tree. Its contents are enumerated at their real path, or they are not in the
  // repo at all. There is nothing to assert about the symlink itself.

  // .gitignore does the excluding, so there is no second hand-maintained list.
  assert.ok(
    !files.some((f) => f.includes('node_modules/')),
    'node_modules must be excluded — by .gitignore, not by a skip list',
  );
  assert.ok(
    !files.some((f) => f.startsWith('.claude/')),
    '.claude/ (worktrees and local config) must be excluded the same way',
  );

  // Everything the four earlier rounds had to widen the roots to reach, still
  // reached — now for free, because none of it is a root any more.
  for (const path of [
    'apps/web/proxy.ts',
    'apps/web/app/invite/[token]/InviteAcceptUI.jsx',
    'supabase/functions/mcp-server/index.ts',
  ]) {
    assert.ok(has(path), `the list must reach ${path}`);
  }
  for (
    const tree of [
      'apps/web/components/',
      'supabase/functions/gmail-token-refresh/',
      'supabase/functions/outlook-token-refresh/',
      'supabase/functions/synthetic-monitor/',
      'supabase/functions/system-notify/',
      'apps/mcp-app/',
      'packages/',
      'scripts/',
      'self-host/',
      'tools/',
    ]
  ) {
    assert.ok(files.some((f) => f.startsWith(tree)), `the list must reach ${tree}`);
  }
});

test('the writer check rejects the evasions the old one allowed', () => {
  const ok = [
    "import { CARD_LISTING_STALE } from '@/lib/mcp/card-listing';",
    "await db.from('api_keys').update({ card_build_notified: CARD_LISTING_STALE });",
  ].join('\n');
  assert.deepEqual(sentinelWriterProblems(ok), [], 'the real shape passes');

  // Gap 1: bracket notation puts the quote before the colon.
  assert.ok(
    sentinelWriterProblems(
      `${ok}\nawait db.update({ ['card_build_notified']: 'stale' });`,
    ).length > 0,
    'bracket-notation literal must be rejected',
  );

  // Gap 1 again: one space before the colon defeats /card_build_notified:/.
  assert.ok(
    sentinelWriterProblems(
      "import { CARD_LISTING_STALE } from '@/lib/mcp/card-listing';\n" +
        "await db.update({ card_build_notified : 'stale' });",
    ).length > 0,
    'a space before the colon must be rejected',
  );

  // Gap 2: a comment satisfying the positive check while the real write is gone.
  assert.ok(
    sentinelWriterProblems(
      '// we write card_build_notified: CARD_LISTING_STALE here\n' +
        'const x = { card_build_notified: buildId };',
    ).length > 0,
    'a comment must not satisfy the positive check',
  );
  assert.ok(
    sentinelWriterProblems(
      '/* card_build_notified: CARD_LISTING_STALE */\n' +
        'const x = { card_build_notified: buildId };',
    ).length > 0,
    'a block comment must not satisfy it either',
  );

  assert.deepEqual(
    sentinelWriterProblems('// card_build_notified is set by the edge function.\n'),
    [],
    'prose-only mentions are not writers',
  );

  // The positive check must survive a formatter: a prettier line break between
  // the key and the constant used to FALSE-FAIL a correct writer, and a check
  // that fails on correct code is a check people delete.
  assert.deepEqual(
    sentinelWriterProblems(
      "import { CARD_LISTING_STALE } from '@/lib/mcp/card-listing';\n" +
        "await db.from('api_keys').update({\n" +
        '  card_build_notified:\n' +
        '    CARD_LISTING_STALE,\n' +
        '});',
    ),
    [],
    'a prettier line break between the key and the constant is still a real write',
  );
  assert.deepEqual(
    sentinelWriterProblems(
      "import { CARD_LISTING_STALE } from '@/lib/mcp/card-listing';\n" +
        'await db.update({ card_build_notified : CARD_LISTING_STALE });',
    ),
    [],
    'a space before the colon is still a real write',
  );

  // Documented, NOT closed: fragments defeat both halves. Pinned so the gap is
  // visible rather than folklore.
  assert.deepEqual(
    sentinelWriterProblems(
      "const k = 'card_build' + '_notified';\nawait db.update({ [k]: 'stale' });",
    ),
    [],
    'a column name assembled from fragments is invisible: the file never contains ' +
      'the literal column name, so it is not even seen as a writer',
  );
  assert.ok(
    sentinelWriterProblems(
      "const v = 'sta' + 'le';\nawait db.update({ card_build_notified: v });",
    ).every((p) => !p.includes('hardcodes')),
    'a sentinel value assembled from fragments slips the quoted-literal check ' +
      '(the positive check is the backstop that still catches it)',
  );
});

test('stripComments leaves string literals alone', () => {
  assert.equal(
    stripComments("const a = 'http://x//y'; // gone\nconst b = 1;"),
    "const a = 'http://x//y'; \nconst b = 1;",
    'a URL inside a string survives; the trailing comment does not',
  );
  assert.equal(
    stripComments('const a = "it\'s /* not */ a comment";'),
    'const a = "it\'s /* not */ a comment";',
    'comment markers inside a string survive',
  );
  assert.equal(stripComments('a/* x */b'), 'ab', 'block comments are removed');
});
