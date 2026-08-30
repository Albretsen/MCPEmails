/**
 * The MCP scope vocabulary, in one place.
 *
 * WHY THIS MODULE EXISTS. These two lists were copy-pasted into
 * app/api/api-keys/route.ts (key creation) and app/api/api-keys/[id]/route.ts
 * (scope editing), each carrying a comment saying it was "kept in sync with"
 * the other. A third consumer arrived when demoting a member to `viewer` had to
 * bring that member's existing keys back inside the read-only allow-list
 * (app/api/workspaces/members/[userId]/route.ts), and a third hand-maintained
 * copy is where the drift would finally have happened: the demotion path and
 * the creation path disagreeing about what a viewer may hold is exactly the
 * kind of gap that leaves a demoted admin still sending mail.
 */

/**
 * Every scope the MCP server recognises.
 *
 * Must match the scopes the edge function enforces (supabase/functions/
 * mcp-server gates each tool on a requiredScope) and the OAuth authorize
 * flow's own VALID_SCOPES, so dashboard-issued and OAuth-issued keys behave
 * identically.
 *
 * search:email is vestigial (no tool requires it: read:email already gates
 * email_read's search action) but is retained for parity and backward
 * compatibility with keys and consents already issued carrying it.
 */
export const VALID_SCOPES = [
  'read:email',
  'search:email',
  'send:email',
  'manage:folders',
  'delete:email',
  'manage:drafts',
  'manage:contacts',
  'schedule:email',
  'manage:automations',
] as const;

export type Scope = (typeof VALID_SCOPES)[number];

export function isValidScope(s: unknown): s is Scope {
  return typeof s === 'string' && (VALID_SCOPES as readonly string[]).includes(s);
}

/**
 * Scopes available to workspace viewers (read-only).
 *
 * manage:automations is deliberately NOT here. An automation is a standing,
 * unattended write capability: it moves, labels, marks read, forwards or drafts
 * on a schedule with nobody watching. That is strictly more power than any
 * interactive write scope, not less, so it cannot belong to the read-only tier.
 */
export const VIEWER_SCOPES: ReadonlySet<string> = new Set(['read:email', 'search:email']);

/** Human-readable list of the viewer allow-list, for error copy. */
export function viewerScopeList(): string {
  return [...VIEWER_SCOPES].join(', ');
}

/**
 * True when `scopes` contains anything a workspace viewer may not hold.
 *
 * Used both to refuse a key creation/edit up front and, after the fact, to
 * decide whether an already-issued key survives its holder's demotion.
 */
export function exceedsViewerScopes(scopes: readonly string[] | null | undefined): boolean {
  if (!scopes) return false;
  return scopes.some((s) => !VIEWER_SCOPES.has(s));
}
