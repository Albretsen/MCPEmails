// RFC 9728 permits protected-resource metadata to be discovered at a
// path-specific URL such as
// `/.well-known/oauth-protected-resource/api/mcp`. Several MCP clients use
// that form even when the resource server also advertises the root document.
// Both paths intentionally serve identical metadata for `/api/mcp`.
export { GET, OPTIONS } from '../route';
