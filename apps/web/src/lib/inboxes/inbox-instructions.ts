// Per-inbox instructions (Pro feature `inbox_instructions`): the rules the
// dashboard route applies. Not restated here: imported from the edge
// function's pure module, the same file mcp-server serves them with, so the
// cap and the trimming are one rule. Dependency-free, imported web -> edge
// like folder-overrides.ts.
export {
  INBOX_INSTRUCTIONS_MAX_CHARS,
  normalizeInboxInstructionsInput,
  type InboxInstructionsInput,
} from '../../../../../supabase/functions/mcp-server/inbox-instructions.ts';
