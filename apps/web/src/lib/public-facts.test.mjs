// ---------------------------------------------------------------------------
// Public copy states one tool count, and it is the server's.
//
// WHY. The site said "seventeen" on the homepage, "17" in the docs and "23" on
// the self-host page while the server listed 19 tools to the model, and AI
// answer engines quoted all three. This test reads every public copy surface
// as text, finds each "<number> ... tools" phrase in the five site languages
// (digits or spelled out), and fails unless the number is
// MODEL_VISIBLE_TOOL_COUNT. The one other number allowed is LISTED_TOOL_COUNT,
// and only in a sentence that names `tools/list`, where the full-scope listing
// (model tools plus app-only card tools) is what is being counted.
//
// Changelog entries are not scanned: "22 tools in all" was true on its date.
//
// The constants themselves are checked against supabase/functions/mcp-server,
// read as source text (this suite runs under Node, the server under Deno, so it
// cannot be imported): the advertised list pinned by tool-surface.test.ts,
// minus the tools listed with `visibility: ["app"]` only.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODEL_VISIBLE_TOOL_COUNT,
  APP_ONLY_TOOL_COUNT,
  LISTED_TOOL_COUNT,
} from './public-facts.mjs';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(webRoot, '../..');
const server = path.join(repoRoot, 'supabase/functions/mcp-server');

const read = (file) => readFileSync(file, 'utf8');

function walk(dir, exts) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((ext) => name.endsWith(ext))) out.push(full);
  }
  return out;
}

// ── What the server lists ─────────────────────────────────────────────────

/** The names in a `const NAME ... = [ ... ];` string-array literal. */
function stringArray(source, constName) {
  const start = source.indexOf(`export const ${constName}`);
  assert.ok(start >= 0, `${constName} not found`);
  const open = source.indexOf('[', source.indexOf('=', start));
  const close = source.indexOf('];', open);
  return [...source.slice(open, close).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

/** The top-level `name:` of each definition in a `*_TOOL_DEFINITIONS` array. */
function definitionNames(source, constName) {
  const start = source.indexOf(`export const ${constName}`);
  assert.ok(start >= 0, `${constName} not found`);
  const end = source.indexOf('\n];', start);
  return [...source.slice(start, end).matchAll(/^ {4}name: "([a-z_]+)",$/gm)].map((m) => m[1]);
}

function serverSurface() {
  const surfaceTest = read(path.join(server, 'tool-surface.test.ts'));
  const anchor = surfaceTest.indexOf('tools/list advertises exactly the post-split surface');
  assert.ok(anchor >= 0, 'the advertised-surface test in tool-surface.test.ts moved');
  const open = surfaceTest.indexOf('[', surfaceTest.indexOf('assertEquals', anchor));
  const close = surfaceTest.indexOf(']', open);
  const listed = [...surfaceTest.slice(open, close).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);

  const resources = read(path.join(server, 'mcp-app-resources.ts'));
  const editorTools = stringArray(resources, 'DRAFT_EDITOR_APP_TOOL_NAMES');
  const editorModelVisible = stringArray(resources, 'DRAFT_EDITOR_MODEL_VISIBLE_TOOL_NAMES');
  const appOnly = [
    ...definitionNames(read(path.join(server, 'mcp-app-approvals.ts')), 'APPROVAL_TOOL_DEFINITIONS'),
    ...definitionNames(read(path.join(server, 'mcp-app-bulk.ts')), 'BULK_TOOL_DEFINITIONS'),
    ...editorTools.filter((name) => !editorModelVisible.includes(name)),
  ];
  return { listed, appOnly, modelVisible: listed.filter((name) => !appOnly.includes(name)) };
}

test('the counts match what mcp-server lists', () => {
  const { listed, appOnly, modelVisible } = serverSurface();
  assert.equal(listed.length, LISTED_TOOL_COUNT, `tools/list: ${listed.join(', ')}`);
  assert.equal(appOnly.length, APP_ONLY_TOOL_COUNT, `app-only: ${appOnly.join(', ')}`);
  assert.equal(modelVisible.length, MODEL_VISIBLE_TOOL_COUNT, `model-visible: ${modelVisible.join(', ')}`);
  assert.equal(LISTED_TOOL_COUNT, MODEL_VISIBLE_TOOL_COUNT + APP_ONLY_TOOL_COUNT);
});

test('the docs tool reference documents every model-visible tool', () => {
  const docs = read(path.join(webRoot, 'components/marketing/DocsClient.jsx'));
  const start = docs.indexOf('const TOOLS = [');
  const end = docs.indexOf('\n];', start);
  const documented = [...docs.slice(start, end).matchAll(/^ {4}name: '([a-z_]+)',$/gm)].map((m) => m[1]);
  assert.deepEqual([...documented].sort(), [...serverSurface().modelVisible].sort());
});

test('llms.txt names every model-visible tool', () => {
  const llms = read(path.join(webRoot, 'public/llms.txt'));
  for (const name of serverSurface().modelVisible) {
    assert.ok(new RegExp(`\\b${name}\\b`).test(llms), `llms.txt does not mention ${name}`);
  }
});

// ── What the copy says ────────────────────────────────────────────────────

// Spelled-out numbers from 2 to 40 in the site's languages. A count of one
// tool is never claimed, and "one" would match "one of the tools".
const WORDS = {
  en: ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'twenty-one', 'twenty-two', 'twenty-three', 'twenty-four', 'twenty-five', 'twenty-six', 'twenty-seven', 'twenty-eight', 'twenty-nine', 'thirty'],
  es: ['dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve', 'treinta'],
  fr: ['deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'dix-sept', 'dix-huit', 'dix-neuf', 'vingt', 'vingt et un', 'vingt-deux', 'vingt-trois', 'vingt-quatre', 'vingt-cinq', 'vingt-six', 'vingt-sept', 'vingt-huit', 'vingt-neuf', 'trente'],
  nb: ['to', 'tre', 'fire', 'fem', 'seks', 'sju', 'åtte', 'ni', 'ti', 'elleve', 'tolv', 'tretten', 'fjorten', 'femten', 'seksten', 'sytten', 'atten', 'nitten', 'tjue', 'tjueen', 'tjueto', 'tjuetre', 'tjuefire', 'tjuefem', 'tjueseks', 'tjuesju', 'tjueåtte', 'tjueni', 'tretti'],
  zh: ['二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十', '二十一', '二十二', '二十三', '二十四', '二十五', '二十六', '二十七', '二十八', '二十九', '三十'],
};
// Each list starts at 2. Aliases: Norwegian has two words for 7, Chinese two for 2.
const VALUE = new Map();
for (const words of Object.values(WORDS)) words.forEach((word, i) => VALUE.set(word, i + 2));
VALUE.set('syv', 7);
VALUE.set('两', 2);

const byLength = (words) => [...words].sort((x, y) => y.length - x.length);
const alternation = (words) => byLength(words).map((w) => w.replace(/-/g, '[- ]')).join('|');

// Words that can sit between the number and "tools" in a real count
// ("19 action-based MCP tools") are adjectives and names. A function word in
// between means the number counts something else ("HTTP 200 with a normal
// tool result"), so those break the match.
const STOP = 'a|an|the|to|of|with|as|for|and|or|in|on|by|un|une|des|de|du|la|le|les|et|el|los|las|y|o|en|con|para|og|eller|med|til|på|som';
const BETWEEN = `(?:[\\s\\-]+(?!(?:${STOP})(?![\\p{L}]))[\\p{L}\\p{N}\\-/'’]+){0,2}?`;

// Each language's number words pair only with its own word for tools, so the
// Norwegian "to" (2) never pairs with an English "tool".
const LANGS = [
  { words: WORDS.en, tool: 'tools?' },
  { words: WORDS.es, tool: 'herramientas?' },
  { words: WORDS.fr, tool: 'outils?' },
  { words: [...WORDS.nb, 'syv'], tool: 'verktøy(?:et|ene)?' },
];
const LATIN = LANGS.map(
  ({ words, tool }) =>
    new RegExp(`(?<![\\p{L}\\p{N}.,\\-])(\\d{1,3}|${alternation(words)})${BETWEEN}[\\s\\-]+(?:${tool})(?![\\p{L}])`, 'giu'),
);
// "十九个基于动作的 MCP 工具", "23 个工具".
const ZH = new RegExp(`(\\d{1,3}|${byLength([...WORDS.zh, '两']).join('|')})\\s*个[^。，；：\\n]{0,14}?工具`, 'g');

function numberOf(token) {
  if (/^\d+$/.test(token)) return Number(token);
  return VALUE.get(token.toLowerCase().replace(/ /g, '-')) ?? VALUE.get(token.toLowerCase());
}

function publicCopyFiles() {
  const lib = path.join(webRoot, 'src/lib');
  return [
    // compare.json is skipped: PR #167 moves the /native-connectors-vs-mcp copy
    // (and its stale "seventeen") to src/lib/compare/native-connectors/, which
    // the src/lib/compare walk below scans.
    ...walk(path.join(webRoot, 'messages'), ['.json']).filter((f) => path.basename(f) !== 'compare.json'),
    ...walk(path.join(lib, 'blog/posts'), ['.js']),
    ...walk(path.join(lib, 'blog/translations'), ['.js']),
    ...walk(path.join(lib, 'connect/content'), ['.json']),
    ...walk(path.join(lib, 'clients/content'), ['.json']),
    ...walk(path.join(lib, 'compare'), ['.mjs', '.json']).filter((f) => !f.endsWith('.test.mjs')),
    path.join(lib, 'personas/business-copy.ts'),
    path.join(webRoot, 'src/i18n/seo.ts'),
    path.join(webRoot, 'public/llms.txt'),
    path.join(repoRoot, 'README.md'),
    path.join(repoRoot, 'packages/mcpemails/README.md'),
    path.join(repoRoot, 'self-host/README.md'),
    path.join(repoRoot, 'server.json'),
  ].filter((file) => {
    try {
      return statSync(file).isFile();
    } catch {
      return false;
    }
  });
}

// Phrases that match the pattern but count something other than our tools.
// Each needs a reason; keep this list short.
const NOT_OUR_TOOLS = [
  // A competitor's catalogue in the comparison listicle.
  /47 tools/,
];

export function toolCountClaims(text) {
  const claims = [];
  for (const re of [...LATIN, ZH]) {
    for (const match of text.matchAll(re)) {
      const value = numberOf(match[1]);
      if (value === undefined) continue;
      const after = text.slice(match.index, match.index + match[0].length + 40);
      claims.push({ phrase: match[0], value, namesToolsList: after.includes('tools/list') });
    }
  }
  return claims;
}

test('the scanner finds counts in every language, spelled out or not', () => {
  const values = (text) => toolCountClaims(text).map((c) => c.value);
  assert.deepEqual(values('Seventeen action-based MCP tools: send'), [17]);
  assert.deepEqual(values('all 23 tools are in both'), [23]);
  assert.deepEqual(values('Diecisiete herramientas basadas en acciones'), [17]);
  assert.deepEqual(values('Le serveur MCP et ses dix-sept outils'), [17]);
  assert.deepEqual(values('Samme MCP-server, samme sytten verktøy'), [17]);
  assert.deepEqual(values('同一个 MCP 服务器、同样十七个工具'), [17]);
  assert.deepEqual(values('全部 23 个工具'), [23]);
  assert.deepEqual(values('19 tools you call directly'), [19]);
  assert.deepEqual(values('one of the tools, a {toolCount} tools heading'), []);
  assert.deepEqual(values('HTTP 200 with a normal tool result, lean on two tools'), [2]);
  assert.deepEqual(values('Once a tool call returns, to verktøy'), [2]);
});

test(`public copy only ever claims ${MODEL_VISIBLE_TOOL_COUNT} tools`, () => {
  const wrong = [];
  for (const file of publicCopyFiles()) {
    const text = read(file);
    for (const claim of toolCountClaims(text)) {
      if (NOT_OUR_TOOLS.some((re) => re.test(claim.phrase))) continue;
      if (claim.value === MODEL_VISIBLE_TOOL_COUNT) continue;
      // "lean on two tools in order": a handful of tools named for one
      // workflow, not a claim about the whole surface.
      if (claim.value < 5) continue;
      if (claim.value === APP_ONLY_TOOL_COUNT && /app-only/.test(claim.phrase)) continue;
      if (claim.value === LISTED_TOOL_COUNT && claim.namesToolsList) continue;
      wrong.push(`${path.relative(repoRoot, file)}: "${claim.phrase}" (${claim.value})`);
    }
  }
  assert.deepEqual(wrong, [], `Tool counts must be ${MODEL_VISIBLE_TOOL_COUNT} (src/lib/public-facts.mjs):\n${wrong.join('\n')}`);
});
