// ---------------------------------------------------------------------------
// Remedies for capability refusals.
//
// ── The problem this exists to solve ────────────────────────────────────────
// `unsupportedFeatureError` produced a correct, structured, parseable refusal
// that stopped one sentence short of being useful:
//
//   "The 'copy' feature is not supported for provider 'gmail'."
//
// True, and a dead end. The model is left to guess whether the operation is
// impossible, whether some other tool does it, or whether it should give up and
// tell the user Gmail cannot do this — which is the answer it usually reaches,
// and which is wrong. Gmail can do the thing the caller wanted; it just spells
// it differently.
//
// The connector already has a much better error of this shape: the
// permanent-delete refusal, which names the provider's actual limit AND the
// exact retry ("Retry with permanent: false ..."). This module holds the same
// closing move for capability refusals, so the enrichment lives in one place
// instead of being re-improvised at each of the twenty-odd call sites.
//
// ── Why a table, and why it is nearly empty ────────────────────────────────
// Most capability refusals genuinely have no remedy — an IMAP server without
// attachment search cannot be talked into one. A remedy is only added when
// there is a specific, correct, callable alternative. An entry that gestured
// vaguely at "try something else" would be worse than the bare refusal, which
// at least does not send the model down a path that fails again.
// ---------------------------------------------------------------------------

/**
 * Provider-and-feature specific "here is what to do instead", keyed by
 * `${provider}:${feature}`. Absent key means there is no honest remedy and the
 * caller gets the plain refusal.
 */
const FEATURE_REMEDIES: Record<string, string> = {
  // Gmail has no copy because it has no place to put a second copy: a Gmail
  // message exists once and appears under every label it carries. `move` is
  // additive there — it ADDS the destination label — so the message ends up
  // filed in the destination while keeping the labels it already had, which is
  // the outcome a copy produces on a folder-based provider. The one difference
  // worth stating is that a move also removes INBOX, so it is spelled out
  // rather than glossed over.
  "gmail:copy":
    "Gmail uses labels rather than folders, so one message can carry several " +
    "labels at once and there is no separate copy to create. Use " +
    "email_organize action: 'move' (or 'move_batch' for several message_ids) " +
    "with the same destination_folder_id: on Gmail a move ADDS the destination " +
    "label and leaves the message's other labels in place, which is what a " +
    "copy achieves on a folder-based provider. The only difference is that a " +
    "move also removes the INBOX label, so the message leaves the inbox.",
};

/**
 * The `message` field for an `unsupported_feature` refusal: the statement of
 * the limit, plus the remedy when one exists.
 *
 * The first sentence is byte-for-byte what it has always been, because clients
 * and the activity log both key off the structured `error` / `feature` /
 * `provider` fields and nothing about the refusal itself is changing — only
 * what follows it.
 */
export function unsupportedFeatureMessage(
  feature: string,
  provider: string,
): string {
  const base = `The '${feature}' feature is not supported for provider '${provider}'.`;
  const remedy = FEATURE_REMEDIES[`${provider}:${feature}`];
  return remedy ? `${base} ${remedy}` : base;
}
