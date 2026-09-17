// ---------------------------------------------------------------------------
// The invite-accept sentinel mapping.
//
// WHY THESE CASES. Two of the seven branches (workspace_seat_limit -> 403 and
// workspace_unavailable -> 410) were unreachable dead code from 2026-08-30
// until 2026-09-17: the route handled them, but the migration teaching
// `accept_workspace_invite` to raise P0006/P0007 was never applied to
// production. Nothing failed, because nothing tested the mapping. These cases
// exist so that the next time a branch here and the database disagree, a test
// says so instead of a customer seeing a 500.
//
// Each case is written as the thing a real person is told:
//
//   1. Every sentinel the RPC can raise maps to a real status, never 500. A
//      person whose workspace downgraded off Team must read "no seat
//      available", not "Failed to accept invite."
//   2. The seat refusal carries error_code + upgrade_url. The client renders
//      the upgrade prompt off those; a 403 without them is a dead end.
//   3. A dead workspace is 410 GONE, not 404. 404 reads as a bad link, which
//      sends the person back to ask for another invite that also cannot work.
//   4. Matching survives the PostgREST envelope. The client rarely sees the
//      bare sentinel: it sees the RAISE message plus whatever context
//      PostgREST appends, and a mapping written against equality rather than
//      substring would refuse every real error.
//   5. An unknown message maps to null, so the route keeps its 500 for real
//      bugs rather than inventing a friendly explanation for one.
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        src/lib/workspace/invite-accept-error.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INVITE_ACCEPT_SENTINELS,
  mapInviteAcceptError,
  type InviteAcceptSentinel,
} from './invite-accept-error.ts';

/** The sentinel as it arrives once PostgREST has appended PL/pgSQL context. */
function wrapped(sentinel: string): string {
  return `${sentinel}\nCONTEXT: PL/pgSQL function accept_workspace_invite(text) line 42 at RAISE`;
}

test('every sentinel the RPC can raise maps to a real status, never a 500', () => {
  for (const sentinel of INVITE_ACCEPT_SENTINELS) {
    const mapped = mapInviteAcceptError(sentinel);
    assert.notEqual(mapped, null, `${sentinel} fell through to the generic 500`);
    assert.ok(
      mapped!.status >= 400 && mapped!.status < 500,
      `${sentinel} mapped to ${mapped!.status}, which is not a client error`,
    );
    assert.ok(mapped!.body.error.length > 0, `${sentinel} mapped to an empty message`);
  }
});

test('the mapping is total over the declared sentinel list', () => {
  // A migration that adds an eighth sentinel without adding a branch here
  // fails this, rather than shipping a new 500.
  const unmapped = INVITE_ACCEPT_SENTINELS.filter(
    (s: InviteAcceptSentinel) => mapInviteAcceptError(s) === null,
  );
  assert.deepEqual(unmapped, []);
});

test('seat limit is 403 and carries what the upgrade prompt needs', () => {
  const mapped = mapInviteAcceptError(wrapped('workspace_seat_limit'));
  assert.notEqual(mapped, null);
  assert.equal(mapped!.status, 403);
  assert.equal(mapped!.body.error_code, 'member_limit_reached');
  assert.equal(mapped!.body.upgrade_url, '/pricing');
  assert.match(mapped!.body.error, /Team plan/);
});

test('a deleted workspace is 410 GONE, not 404', () => {
  const mapped = mapInviteAcceptError(wrapped('workspace_unavailable'));
  assert.notEqual(mapped, null);
  assert.equal(mapped!.status, 410);
  assert.equal(mapped!.body.error_code, 'workspace_unavailable');
});

test('the other five sentinels keep the statuses the client already handles', () => {
  const expected: Record<string, number> = {
    invite_not_found:        404,
    invite_already_accepted: 409,
    invite_expired:          410,
    invite_email_mismatch:   403,
    already_a_member:        409,
  };

  for (const [sentinel, status] of Object.entries(expected)) {
    const mapped = mapInviteAcceptError(wrapped(sentinel));
    assert.notEqual(mapped, null, `${sentinel} fell through`);
    assert.equal(mapped!.status, status, `${sentinel} changed status`);
  }

  // The mismatch case is the one that names a fixable user mistake, so it
  // carries a code the client branches on.
  assert.equal(
    mapInviteAcceptError(wrapped('invite_email_mismatch'))!.body.error_code,
    'invite_email_mismatch',
  );
});

test('matching survives the PostgREST envelope', () => {
  // Same sentinel, bare and wrapped, must produce the identical response.
  for (const sentinel of INVITE_ACCEPT_SENTINELS) {
    assert.deepEqual(
      mapInviteAcceptError(wrapped(sentinel)),
      mapInviteAcceptError(sentinel),
      `${sentinel} matched differently once wrapped`,
    );
  }
});

test('an unrecognised error stays a 500 for the route to log', () => {
  assert.equal(mapInviteAcceptError('deadlock detected'), null);
  assert.equal(mapInviteAcceptError(''), null);
  // A near miss must not be waved through as a seat refusal.
  assert.equal(mapInviteAcceptError('workspace_seat_limi'), null);
});
