// ---------------------------------------------------------------------------
// The one place the server's own version is written down.
//
// `serverInfo.version` in the initialize result used to be a literal "1.0.0"
// in index.ts while /server.json (the MCP registry manifest) and the npm
// package had moved on to 1.0.4, so every client that showed the version
// showed a stale one. server-version.test.ts reads both of those files and
// fails the suite the moment this constant and either of them disagree, which
// is what stops the three from drifting apart again without anyone noticing.
//
// Bump this together with server.json and packages/mcpemails/package.json.
// ---------------------------------------------------------------------------

export const SERVER_VERSION = "1.0.5";
