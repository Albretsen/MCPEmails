import type { Envelope, Plan, Provider } from "../contract";
import {
  bulkVerb,
  CARD_LANGUAGE,
  bulkVerbProgressive,
  formatDate,
  plural,
  relativeExpiry,
} from "../format";
import { Btn, FsLink, Head, Line, Notice, ProviderLine } from "./ui";

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
      <Head
        tone={pending ? "warning" : "neutral"}
        title={
          <>
            <span class="count">{count.toLocaleString(CARD_LANGUAGE)}</span>{" "}
            {plural(count, "message", "messages")} to {verb.toLowerCase()}
            {plan.scope?.destination ? ` into ${plan.scope.destination}` : ""}
          </>
        }
      >
        <FsLink
          on={fullscreen}
          can={props.canExpand && (hiddenSamples > 0 || caveats.length > 2)}
          set={actions.setFullscreen}
          label="Details"
        />
        <span class="muted">{expiry}</span>
      </Head>

      <Line>
        {plan.inbox?.email_address ?? "unknown"} ·{" "}
        {plan.scope?.description || "(no description)"}
        {plan.scope?.folder ? ` · in ${plan.scope.folder}` : ""}
      </Line>

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
          <Line>
            Sample of what matches
            {plan.sample_truncated ? ` (${shown.length} of ${count})` : ""}
            {hiddenSamples > 0
              ? `. ${hiddenSamples} more in the sample, open Details for the rest.`
              : ""}
          </Line>
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
            : `${verb} ${count.toLocaleString(CARD_LANGUAGE)}`}
        </Btn>
      </div>
    </>
  );
}
