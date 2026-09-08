// ---------------------------------------------------------------------------
// The one place the server's own version is written down.
//
// `serverInfo.version` in the initialize result used to be a literal "1.0.0"
// in index.ts while /server.json (the MCP registry manifest) had moved on to
// 1.0.4, so every client that showed the version showed a stale one.
// server-version.test.ts reads server.json and fails the suite the moment this
// constant and its top-level `version` disagree.
//
// Bump this together with server.json. The npm stdio bridge
// (packages/mcpemails) has its own version, which is whatever is actually
// published on npm; it is not required to match this constant.
// ---------------------------------------------------------------------------

export const SERVER_VERSION = "1.0.5";
