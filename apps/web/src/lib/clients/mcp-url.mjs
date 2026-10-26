/**
 * The MCP endpoint every setup page, guide and install link points at.
 *
 * Built from NEXT_PUBLIC_APP_URL so staging points at staging; production sets
 * it to the apex, which gives https://mcpemails.com/api/mcp. Its own tiny file
 * so the dashboard and /onboarding can import it without the whole client
 * roster in clients.mjs. clients.mjs re-exports it.
 *
 * `typeof process` guards a browser bundle that has no `process`; Next inlines
 * NEXT_PUBLIC_* at build time either way.
 */
const APP_URL = (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_APP_URL) || 'https://mcpemails.com';

export const MCP_URL = `${APP_URL.replace(/\/+$/, '')}/api/mcp`;

/** Production's endpoint, whatever this build's APP_URL is. The drift check compares against it. */
export const PRODUCTION_MCP_URL = 'https://mcpemails.com/api/mcp';
