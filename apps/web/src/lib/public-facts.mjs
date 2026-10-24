// ---------------------------------------------------------------------------
// Facts the public site states about the MCP server, in one place.
//
// The tool count drifted for weeks: the homepage said seventeen, the self-host
// page 23, the docs 17, while the server listed 19 to the model. Copy that can
// read these constants interpolates them (docs tool reference, connect pages).
// Copy that cannot, such as message strings quoted verbatim into JSON-LD or
// blog posts, is checked against them by public-facts.test.mjs, which also
// derives the numbers from supabase/functions/mcp-server so a new tool fails
// the test until this file and the copy move with it.
// ---------------------------------------------------------------------------

/** Tools the model is shown in `tools/list` (docs/LISTINGS.md "Tools"). */
export const MODEL_VISIBLE_TOOL_COUNT = 21;

/** Card plumbing listed with `visibility: ["app"]`: approval_*, bulk_*, draft_editor_save. */
export const APP_ONLY_TOOL_COUNT = 7;

/** What a full-scope key sees in `tools/list`. */
export const LISTED_TOOL_COUNT = MODEL_VISIBLE_TOOL_COUNT + APP_ONLY_TOOL_COUNT;
