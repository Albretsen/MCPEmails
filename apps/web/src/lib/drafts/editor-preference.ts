/**
 * The draft editor card preference, resolved once for every surface that shows
 * a control for it.
 *
 * THREE SWITCHES, NOT ONE. The card a host renders under a draft result is
 * decided by three independent values, and every one of them can turn it off:
 *
 *   workspaces.draft_editor_enabled   OUR rollout gate. False means the feature
 *                                     is not offered to this workspace at all,
 *                                     and the `draft` tool is byte-identical to
 *                                     its pre-MCP-Apps shape.
 *   workspaces.draft_editor_hidden    The customer's workspace-wide opt-out.
 *   inboxes.draft_editor_hidden       The customer's opt-out for ONE mailbox.
 *
 * The edge function ANDs them (see `workspaceDraftEditorEnabled` and the
 * per-inbox check in supabase/functions/mcp-server/index.ts). This module is
 * the dashboard's copy of exactly that arithmetic, kept in one place so the
 * screen can never disagree with the server about whether a card will appear.
 *
 * THE INVERSION, STATED ONCE. The column is `*_hidden`: `true` means the card
 * is OFF. Nobody thinks in those terms, so every control on screen is phrased
 * positively ("Show the draft editor card") and `shown` below is the value the
 * checkbox binds to. `hiddenFromShown` is the single place the sense flips on
 * the way to the PATCH body. No component should write `!checked` by hand.
 *
 * NOT A PERMISSION. Hiding the card changes what is RENDERED, never what the
 * assistant may do: the same draft tools remain callable either way
 * (docs/mcp-apps/contract.md §6). The copy in messages/ is written to that
 * line, and it must stay written to it.
 */

/** Why a control is present but refuses input. */
export type DraftEditorLockReason =
  /** The viewer is a workspace member or viewer, not an owner or admin. */
  | 'role'
  /** The workspace-wide switch is off, so this inbox's switch cannot matter. */
  | 'workspace_hidden';

export interface DraftEditorControlState {
  /** Render the control at all. False when the workspace is not rolled out. */
  visible: boolean;
  /** What the checkbox shows: true = "the card is shown". */
  shown: boolean;
  /** Whether the control accepts input. */
  editable: boolean;
  /** Why it does not accept input, or null when it does. */
  lockedBy: DraftEditorLockReason | null;
}

/** `*_hidden` column -> the positive sense the UI binds to. */
export function shownFromHidden(hidden: unknown): boolean {
  return hidden !== true;
}

/** The positive sense the UI binds to -> the `*_hidden` value to persist. */
export function hiddenFromShown(shown: boolean): boolean {
  return !shown;
}

/**
 * True when a draft in this inbox would actually render as a card.
 *
 * Mirrors the edge function: rolled out AND not hidden at the workspace AND not
 * hidden at the inbox.
 *
 * NO CALLER IN THE DASHBOARD, and the note you may be looking for is not this.
 * The inbox control's "the workspace turned this off" line is driven by
 * `inboxDraftEditorControl(...).lockedBy === 'workspace_hidden'`, which is a
 * different question: whether the CONTROL is overridden, not whether a card
 * would appear. This function exists as the single written-down statement of
 * the server's AND, and its test is what holds the dashboard's arithmetic to
 * the same shape. If a surface ever needs "would a card appear right now", call
 * this rather than re-ANDing the three flags at the call site; if none ever
 * does, delete it rather than leaving it to drift.
 */
export function draftEditorCardVisible(input: {
  rolledOut: boolean;
  workspaceHidden: boolean;
  inboxHidden: boolean;
}): boolean {
  return input.rolledOut && !input.workspaceHidden && !input.inboxHidden;
}

/**
 * The workspace-wide control.
 *
 * Role gate: PATCH /api/workspaces/[id] refuses anyone below admin, so the
 * control is rendered read-only with a reason for a member or viewer rather
 * than failing on submit. It is still SHOWN to them: the preference is a fact
 * about the workspace they are working in, and hiding it would make the card's
 * absence unexplainable.
 */
export function workspaceDraftEditorControl(input: {
  rolledOut: boolean;
  hidden: boolean;
  canManage: boolean;
}): DraftEditorControlState {
  return {
    visible: input.rolledOut,
    shown: shownFromHidden(input.hidden),
    editable: input.rolledOut && input.canManage,
    lockedBy: input.rolledOut && !input.canManage ? 'role' : null,
  };
}

/**
 * The per-inbox control.
 *
 * No role gate, deliberately: PATCH /api/inboxes/[id] puts this field on the
 * operator side of its own gate (any owner, admin or member may set it, a
 * viewer may not edit inbox settings at all), because hiding one mailbox's card
 * affects only that mailbox.
 *
 * The workspace switch WINS. With the workspace hidden, an inbox set to "shown"
 * still renders nothing, so the control reports itself as locked rather than
 * offering a toggle that does nothing. The stored inbox value is still
 * surfaced, so turning the workspace back on restores what the user chose here.
 */
export function inboxDraftEditorControl(input: {
  rolledOut: boolean;
  workspaceHidden: boolean;
  inboxHidden: boolean;
  canManage?: boolean;
}): DraftEditorControlState {
  const canManage = input.canManage ?? true;
  const overridden = input.workspaceHidden;
  return {
    visible: input.rolledOut,
    shown: shownFromHidden(input.inboxHidden),
    editable: input.rolledOut && !overridden && canManage,
    lockedBy: !input.rolledOut ? null : overridden ? 'workspace_hidden' : canManage ? null : 'role',
  };
}
