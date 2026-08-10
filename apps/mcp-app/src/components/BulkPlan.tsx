import type { Envelope, Plan, Provider } from "../contract";
import {
  bulkVerb,
  bulkVerbProgressive,
  formatDate,
  plural,
  relativeExpiry,
} from "../format";
import { Btn, Fields, Notice } from "./ui";

export interface BulkActions {
  execute: () => void;
  cancel: () => void;
  setFullscreen: (on: boolean) => void;
}

interface Props {
  env: Envelope;
  plan: Plan;
  provider?: Provider;
  fullscreen: boolean;
  canExpand: boolean;
  busy: string | null;
  error: string | null;
  actions: BulkActions;
}

export function BulkPlan(props: Props) {
  const { env, plan, provider, fullscreen, busy, actions } = props;
  const pending = env.state === "pending";
  const canDecide = env.actor?.can_decide !== false && pending;

  const verb = bulkVerb(plan.action);
  const count = typeof plan.match_count === "number" ? plan.match_count : 0;
  const samples = plan.sample ?? [];
  // An inline card must auto-fit without internal scrolling. At 320px each
  // sample row wraps to two lines, so five of them push the card past 800px and
  // the conversation scroll swallows the action row. Three inline, all five
  // behind Details.
  const shown = fullscreen ? samples.slice(0, 5) : samples.slice(0, 3);
  const hiddenSamples = Math.min(samples.length, 5) - shown.length;
  const caveats = provider?.caveats ?? [];
  const shownCaveats = fullscreen ? caveats : caveats.slice(0, 2);
  const expiry = relativeExpiry(plan.expires_at);

  const blockedReason =
    env.actor?.can_decide === false
      ? env.actor?.reason === "viewer_role"
        ? "Your role can view this plan but not run it."
        : "This plan is no longer available."
      : !pending
        ? "This plan is no longer available."
        : expiry === "expired"
          ? "This plan expired. Nothing was changed."
          : null;

  return (
    <>
      <div class="head">
        <div class="grow">
          <p class="eyebrow">
            <span
              class="status-dot"
              data-tone={pending ? "warning" : "neutral"}
              aria-hidden="true"
            />
            {verb} · awaiting confirmation
          </p>
        </div>
        {fullscreen ? (
          <Btn variant="quiet" onClick={() => actions.setFullscreen(false)}>
            Close details
          </Btn>
        ) : props.canExpand && (hiddenSamples > 0 || caveats.length > 2) ? (
          <Btn variant="quiet" onClick={() => actions.setFullscreen(true)}>
            Details
          </Btn>
        ) : null}
      </div>

      <h2 class="headline">
        <span class="count">{count.toLocaleString()}</span>{" "}
        {plural(count, "message", "messages")} to {verb.toLowerCase()}
        {plan.scope?.destination ? ` into ${plan.scope.destination}` : ""}
      </h2>

      <Fields
        rows={[
          ["Inbox", plan.inbox?.email_address ?? "unknown"],
          [
            "Matching",
            <>
              {plan.scope?.description || "(no description)"}
              {plan.scope?.folder && (
                <span class="muted"> · in {plan.scope.folder}</span>
              )}
            </>,
          ],
        ]}
      />

      {shown.length > 0 && (
        <>
          <span class="field-label">
            Sample of what matches
            {plan.sample_truncated ? ` (${shown.length} of ${count})` : ""}
          </span>
          <ul class="samples">
            {shown.map((s, i) => (
              <li key={i}>
                <span class="s-from">{s.from || "(unknown sender)"}</span>
                <span class="s-subject">{s.subject || "(no subject)"}</span>
                <span class="s-date">{formatDate(s.date)}</span>
              </li>
            ))}
          </ul>
          {hiddenSamples > 0 && (
            <p class="tiny" style={{ margin: 0 }}>
              {hiddenSamples} more in the sample. Open Details for the rest.
            </p>
          )}
        </>
      )}

      {provider && (
        <div class="provider">
          <div class="route">
            <b>{provider.label}</b>
            {provider.route ? ` · ${provider.route}` : ""}
          </div>
          {shownCaveats.length > 0 && (
            <ul class="caveats">
              {shownCaveats.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {blockedReason && <Notice tone="warning">{blockedReason}</Notice>}
      {props.error && <Notice tone="danger">{props.error}</Notice>}

      <div class="actions">
        <Btn disabled={!canDecide} onClick={actions.cancel}>
          Cancel
        </Btn>
        <Btn
          variant="danger"
          disabled={!canDecide}
          busy={busy === "execute"}
          onClick={actions.execute}
        >
          {busy === "execute"
            ? bulkVerbProgressive(plan.action)
            : `${verb} ${count.toLocaleString()}`}
        </Btn>
      </div>
      <p class="tiny">{expiry}</p>
    </>
  );
}
