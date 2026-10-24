/**
 * Words a video may not say, on screen, in the voiceover or in the post copy.
 *
 * Plain .mjs for the same reason as storyboard-schema.mjs: the validator, the
 * voice script and verify all load it. Every rule is a public-copy rule from
 * the repo's CLAUDE.md, enforced here because an automated routine writes
 * these storyboards and nobody reads them before the render.
 *
 * Returns a list of problems, empty when the text is clean. Callers decide
 * whether a problem is fatal (it always is, today).
 */

const RULES = [
  {
    test: /—/,
    why: 'contains an em dash. House style forbids them. Use a comma, colon or full stop.',
  },
  {
    // The product is one word. "MCP Emails" (two words) and "Mcpemails" both
    // read as a different brand. Lower-case survives only inside the domain.
    test: /\bMCP[\s-]+E-?mails\b|\bMcpemails\b|\bMcpEmails\b|\bMCPemails\b/,
    why: 'misspells the product. It is "MCPEmails", one word, camel case ("mcpemails.com" for the domain).',
  },
  {
    test: /\bSOC[\s-]?2\b/i,
    why: 'mentions SOC 2. Never claim it, not even as in progress.',
  },
  {
    // Plans, prices and caps belong on the pricing page, where they are kept
    // current. A video lives for years.
    test: /\$\s?\d|\b\d+\s?(?:kr|nok|eur|usd)\b|\bper month\b|\/mo\b|\bpricing\b|\bupgrade\b|\b(?:free|personal|pro|team|business|paid) (?:plan|tier)\b|\baction caps?\b|\busage (?:cap|limit)s?\b|\b30 days\b/i,
    why: 'talks about plans, prices or caps. Short-form videos never do.',
  },
];

/** @param {string} text @param {string} where */
export function lintCopy(text, where) {
  if (typeof text !== 'string') return [];
  const problems = [];
  for (const rule of RULES) {
    if (rule.test.test(text)) problems.push(`${where} ${rule.why}`);
  }
  return problems;
}
