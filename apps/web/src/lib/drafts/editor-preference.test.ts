// ---------------------------------------------------------------------------
// The draft editor control is the dashboard's copy of an arithmetic the edge
// function already does, and the three things that can go wrong with a copy
// are all pinned here:
//
//   1. The inversion. The column is `*_hidden`; the screen says "show". A
//      flipped sign would silently turn the card OFF for everyone who opens
//      the setting and saves it without touching anything.
//   2. The role gate. PATCH /api/workspaces/[id] refuses below admin, so the
//      control must be read-only for a member rather than failing on submit.
//   3. The override. The workspace switch wins over the inbox switch, exactly
//      as `workspaceDraftEditorEnabled` does in the edge function; the UI must
//      not imply an inbox "on" can beat a workspace "off".
//
// Run: node --test --experimental-strip-types src/lib/drafts/editor-preference.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  draftEditorCardVisible,
  hiddenFromShown,
  inboxDraftEditorControl,
  shownFromHidden,
  workspaceDraftEditorControl,
} from './editor-preference.ts';

/* ── 1. The inversion ──────────────────────────────────────────────────── */

test('hidden=false reads as shown, hidden=true reads as not shown', () => {
  assert.equal(shownFromHidden(false), true);
  assert.equal(shownFromHidden(true), false);
});

test('a missing hidden column reads as shown, never as hidden', () => {
  // The column is NOT NULL DEFAULT false, but a tolerant select that dropped it
  // yields undefined. Treating undefined as "hidden" would blank the card for a
  // workspace that never asked for that.
  assert.equal(shownFromHidden(undefined), true);
  assert.equal(shownFromHidden(null), true);
});

test('only a literal true counts as hidden', () => {
  assert.equal(shownFromHidden('true'), true);
  assert.equal(shownFromHidden(1), true);
});

test('what the UI shows round-trips to what the column stores', () => {
  assert.equal(hiddenFromShown(true), false);
  assert.equal(hiddenFromShown(false), true);
  for (const hidden of [true, false]) {
    assert.equal(hiddenFromShown(shownFromHidden(hidden)), hidden);
  }
});

/* ── 2. The role gate on the workspace control ─────────────────────────── */

test('an owner or admin gets an editable workspace control', () => {
  const state = workspaceDraftEditorControl({ rolledOut: true, hidden: false, canManage: true });
  assert.deepEqual(state, { visible: true, shown: true, editable: true, lockedBy: null });
});

test('a member sees the workspace control but cannot change it', () => {
  const state = workspaceDraftEditorControl({ rolledOut: true, hidden: false, canManage: false });
  assert.equal(state.visible, true, 'the preference stays explainable to a member');
  assert.equal(state.editable, false, 'the 403 is prevented, not merely reported');
  assert.equal(state.lockedBy, 'role');
});

test('a member still reads the true stored value, not a default', () => {
  const state = workspaceDraftEditorControl({ rolledOut: true, hidden: true, canManage: false });
  assert.equal(state.shown, false);
});

/* ── 3. The rollout gate ───────────────────────────────────────────────── */

test('a workspace that is not rolled out sees no control at either grain', () => {
  const ws = workspaceDraftEditorControl({ rolledOut: false, hidden: false, canManage: true });
  assert.equal(ws.visible, false);
  assert.equal(ws.editable, false);
  assert.equal(ws.lockedBy, null, 'absence needs no in-place explanation');

  const inbox = inboxDraftEditorControl({
    rolledOut: false, workspaceHidden: false, inboxHidden: false,
  });
  assert.equal(inbox.visible, false);
  assert.equal(inbox.editable, false);
  assert.equal(inbox.lockedBy, null);
});

/* ── 4. The workspace overrides the inbox ──────────────────────────────── */

test('an inbox control is editable when the workspace allows the card', () => {
  const state = inboxDraftEditorControl({
    rolledOut: true, workspaceHidden: false, inboxHidden: false,
  });
  assert.deepEqual(state, { visible: true, shown: true, editable: true, lockedBy: null });
});

test('a workspace-wide hide locks every inbox control and says why', () => {
  const state = inboxDraftEditorControl({
    rolledOut: true, workspaceHidden: true, inboxHidden: false,
  });
  assert.equal(state.visible, true, 'the inbox setting is still explained, not vanished');
  assert.equal(state.editable, false);
  assert.equal(state.lockedBy, 'workspace_hidden');
});

test('the inbox choice survives a workspace-wide hide', () => {
  // The two columns are independent, so turning the workspace back on has to
  // restore what the user picked per inbox rather than a default.
  const shownInbox = inboxDraftEditorControl({
    rolledOut: true, workspaceHidden: true, inboxHidden: false,
  });
  const hiddenInbox = inboxDraftEditorControl({
    rolledOut: true, workspaceHidden: true, inboxHidden: true,
  });
  assert.equal(shownInbox.shown, true);
  assert.equal(hiddenInbox.shown, false);
});

test('a viewer cannot edit an inbox control either', () => {
  const state = inboxDraftEditorControl({
    rolledOut: true, workspaceHidden: false, inboxHidden: false, canManage: false,
  });
  assert.equal(state.editable, false);
  assert.equal(state.lockedBy, 'role');
});

/* ── 5. The AND that decides whether a card actually appears ───────────── */

test('the card appears only when all three switches allow it', () => {
  const cases: Array<[boolean, boolean, boolean, boolean]> = [
    // rolledOut, workspaceHidden, inboxHidden, expected
    [true,  false, false, true],
    [true,  false, true,  false],
    [true,  true,  false, false],
    [true,  true,  true,  false],
    [false, false, false, false],
    [false, true,  true,  false],
  ];
  for (const [rolledOut, workspaceHidden, inboxHidden, expected] of cases) {
    assert.equal(
      draftEditorCardVisible({ rolledOut, workspaceHidden, inboxHidden }),
      expected,
      `rolledOut=${rolledOut} workspaceHidden=${workspaceHidden} inboxHidden=${inboxHidden}`,
    );
  }
});
