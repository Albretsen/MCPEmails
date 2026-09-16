import type { Envelope, Plan, Provider } from "../contract";
import {
  bulkVerb,
  bulkVerbProgressive,
  formatDate,
  plural,
  relativeExpiry,
} from "../format";
import { Btn, Notice, ProviderLine, TextLink } from "./ui";

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
      <div class="hdr">
        <div class="hdr-l">
          <span
            class="dot"
            data-tone={pending ? "warning" : "neutral"}
            aria-hidden="true"
          />
          <b>
            <span class="count">{count.toLocaleString()}</span>{" "}
            {plural(count, "message", "messages")} to {verb.toLowerCase()}
            {plan.scope?.destination ? ` into ${plan.scope.destination}` : ""}
          </b>
        </div>
        <div class="hdr-r">
          {fullscreen ? (
            <TextLink onClick={() => actions.setFullscreen(false)}>
              Collapse
            </TextLink>
          ) : props.canExpand && (hiddenSamples > 0 || caveats.length > 2) ? (
            <TextLink onClick={() => actions.setFullscreen(true)}>
              Details
            </TextLink>
          ) : null}
          <span class="muted">{expiry}</span>
        </div>
      </div>

      <p class="line">
        {plan.inbox?.email_address ?? "unknown"} ·{" "}
        {plan.scope?.description || "(no description)"}
        {plan.scope?.folder ? ` · in ${plan.scope.folder}` : ""}
      </p>

      {shown.length > 0 && (
        <>
          <ul class="samples">
            {shown.map((s, i) => (
              <li key={i}>
                <span class="s-from">{s.from || "(unknown sender)"}</span>
                <span class="s-subject">{s.subject || "(no subject)"}</span>
                <span class="s-date">{formatDate(s.date)}</span>
              </li>
            ))}
          </ul>
          <p class="line">
            Sample of what matches
            {plan.sample_truncated ? ` (${shown.length} of ${count})` : ""}
            {hiddenSamples > 0
              ? `. ${hiddenSamples} more in the sample, open Details for the rest.`
              : ""}
          </p>
        </>
      )}

      <ProviderLine provider={provider} fullscreen={fullscreen} />

      {blockedReason && <Notice tone="warning">{blockedReason}</Notice>}
      {props.error && <Notice tone="danger">{props.error}</Notice>}

      {/* The destructive action is the filled one here, not a danger outline:
          on this card it IS the primary action and hiding it as a text link
          would be worse than owning it. */}
      <div class="acts">
        <Btn variant="quiet" disabled={!canDecide} onClick={actions.cancel}>
          Cancel
        </Btn>
        <Btn
          variant="primary"
          disabled={!canDecide}
          busy={busy === "execute"}
          onClick={actions.execute}
        >
          {busy === "execute"
            ? bulkVerbProgressive(plan.action)
            : `${verb} ${count.toLocaleString()}`}
        </Btn>
      </div>
    </>
  );
}
