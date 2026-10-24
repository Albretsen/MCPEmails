import { useEffect, useState } from "preact/hooks";
import type {
  Envelope,
  SubscriptionResult,
  SubscriptionSender,
  Subscriptions,
} from "../contract";
import { CARD_LANGUAGE, plural, relativeExpiry } from "../format";
import { Btn, Notice, TextLink } from "./ui";

// §9 `subscription_plan`. Every name, address and `detail` here came from email
// or from the server's account of it: JSX text only, never innerHTML. The card
// sends back nothing but `plan_id` and sender keys taken from the plan itself.

export type Backlog = "archive" | "keep";

export interface SubscriptionActions {
  confirm: (senderKeys: string[], backlog: Backlog) => void;
  continueBacklog: () => void;
  openLink: (url: string) => void;
  setFullscreen: (on: boolean) => void;
}

const METHOD: Record<string, string> = {
  one_click: "One-click",
  mailto: "Draft for you to send",
  link: "Link to open",
  none: "No unsubscribe",
};

const UNSAFE: Record<string, string> = {
  in_junk: "in Junk",
  dkim_fail: "sender not verified",
  mixed_sender_domains: "mixed sender domains",
  auth_unverified: "sender not verified",
};

const STATUS: Record<string, [string, string]> = {
  requested: ["success", "Requested"],
  draft_ready: ["success", "Draft ready"],
  needs_user: ["warning", "Open link to finish"],
  failed: ["danger", "Failed"],
  filtered: ["neutral", "Future mail goes to Archive"],
  skipped_unsafe: ["neutral", "Skipped (not safe to unsubscribe)"],
  already_done: ["neutral", "Already done"],
};

const num = (n: unknown) => (typeof n === "number" && isFinite(n) ? n : 0);
const fmt = (n: unknown) => num(n).toLocaleString(CARD_LANGUAGE);

/** The host of an https link, or null when it is not one. */
function httpsHost(link: string | null | undefined): string | null {
  if (typeof link !== "string" || !/^https:\/\//i.test(link)) return null;
  try {
    return new URL(link).host;
  } catch {
    return null;
  }
}

interface Props {
  env: Envelope;
  sub: Subscriptions;
  fullscreen: boolean;
  canExpand: boolean;
  busy: string | null;
  error: string | null;
  actions: SubscriptionActions;
}

export function SubscriptionPlan(props: Props) {
  const { env, sub } = props;
  return env.state === "executed" && Array.isArray(sub.results) ? (
    <Results {...props} results={sub.results} />
  ) : (
    <Picker {...props} />
  );
}

/**
 * Suggested senders first, then the rest, each group by message volume. The
 * server orders by volume alone, which put a busy sender the user reads (and
 * the plan leaves unticked) above everything it actually proposes. Array sort is
 * stable, so equal counts keep the server's order.
 */
export function orderSenders(list: SubscriptionSender[]): SubscriptionSender[] {
  return [...list].sort(
    (a, b) =>
      +(b.suggested === true) - +(a.suggested === true) ||
      num(b.message_count) - num(a.message_count),
  );
}

function Picker(props: Props) {
  const { env, sub, actions } = props;
  const [senders] = useState<SubscriptionSender[]>(() =>
    orderSenders(Array.isArray(sub.senders) ? sub.senders : []),
  );
  // The label counts down from the plan's own expires_at; re-read it every
  // 30 s so "expires in N min" stays true and the card locks when it lapses.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  const [ticked, setTicked] = useState<Set<string>>(
    () => new Set(senders.filter((s) => s.suggested === true).map((s) => s.sender_key)),
  );
  const [backlog, setBacklog] = useState<Backlog>("archive");

  const pending = env.state === "pending";
  const expiry = relativeExpiry(sub.expires_at);
  const blocked =
    env.actor?.can_decide === false && env.actor?.reason === "viewer_role"
      ? "Your role can view this list but not act on it."
      : env.state === "expired" || expiry === "expired"
        ? "This list expired. Nothing was changed. Ask for a new scan."
        : env.actor?.can_decide === false || !pending
          ? "This list is no longer available. Nothing was changed."
          : null;
  const canDecide = !blocked;
  const n = senders.filter((s) => ticked.has(s.sender_key)).length;
  const busy = props.busy === "cleanup";

  // From the latest set, not the rendered one: two boxes ticked before a
  // re-render must both stick.
  const toggle = (key: string, on: boolean) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  return (
    <>
      <div class="hdr">
        <div class="hdr-l">
          <span class="dot" data-tone={pending ? "warning" : "neutral"} aria-hidden="true" />
          <b>
            {fmt(senders.length)} {plural(senders.length, "sender", "senders")},{" "}
            {fmt(sub.scanned)} messages scanned, last {fmt(sub.window_days)} days
          </b>
        </div>
        <div class="hdr-r">
          {props.fullscreen ? (
            <TextLink onClick={() => actions.setFullscreen(false)}>Collapse</TextLink>
          ) : props.canExpand && senders.length > 6 ? (
            <TextLink onClick={() => actions.setFullscreen(true)}>Expand</TextLink>
          ) : null}
          <span class="muted">{expiry}</span>
        </div>
      </div>
      <p class="line">
        {sub.inbox?.email_address ?? "unknown"}
        {sub.truncated ? ". Only the newest messages were scanned." : ""}
      </p>

      <div class="links line">
        <span>
          {n} of {senders.length} selected
        </span>
        <TextLink disabled={!canDecide} onClick={() => setTicked(new Set(senders.map((s) => s.sender_key)))}>
          Select all
        </TextLink>
        <TextLink disabled={!canDecide} onClick={() => setTicked(new Set())}>
          Select none
        </TextLink>
      </div>

      <ul class="subs" aria-label="Senders">
        {senders.map((s, i) => {
          const id = `sub-${i}`;
          // auth_unverified still gets a draft or a link, never one-click.
          const unverified = s.unsafe_reason === "auth_unverified";
          const unsafe = s.safe === false && !unverified;
          const why = UNSAFE[s.unsafe_reason ?? ""] ?? "not verified";
          const name = s.display_name || s.from_address || "(unknown sender)";
          return (
            <li key={s.sender_key}>
              <input
                type="checkbox"
                id={id}
                checked={ticked.has(s.sender_key)}
                disabled={!canDecide}
                onChange={(e) => toggle(s.sender_key, (e.currentTarget as HTMLInputElement).checked)}
              />
              <label for={id}>
                <span class="sub-name" title={name}>{name}</span>
                <span class="sub-meta">
                  {s.domain && `${s.domain}, `}
                  {fmt(s.message_count)} {plural(num(s.message_count), "message", "messages")},{" "}
                  {Math.round(num(s.read_share) * 100)}% read
                  {unsafe ? `. Not safe to unsubscribe (${why}): archive only.` : unverified ? `. ${UNSAFE.auth_unverified}.` : ""}
                </span>
              </label>
              <span class="pill" data-tone={unsafe ? "warning" : undefined}>
                {unsafe ? "Archive only" : (METHOD[s.method] ?? METHOD.none)}
              </span>
            </li>
          );
        })}
      </ul>

      <label class="line sub-backlog">
        Existing mail from these senders{" "}
        <select
          value={backlog}
          disabled={!canDecide}
          onChange={(e) => setBacklog((e.currentTarget as HTMLSelectElement).value === "keep" ? "keep" : "archive")}
        >
          <option value="archive">Archive existing mail</option>
          <option value="keep">Keep existing mail</option>
        </select>
      </label>

      <p class="line">
        Nothing is sent from your address. Senders that only take an email get a draft for you to send yourself.
      </p>

      {blocked && <Notice tone="warning">{blocked}</Notice>}
      {props.error && <Notice tone="danger">{props.error}</Notice>}

      <div class="acts sub-acts">
        <Btn
          variant="primary"
          disabled={!canDecide || n === 0}
          busy={busy}
          onClick={() =>
            actions.confirm(
              senders.filter((s) => ticked.has(s.sender_key)).map((s) => s.sender_key),
              backlog,
            )
          }
        >
          {busy ? "Cleaning up" : `Clean up ${n} ${plural(n, "sender", "senders")}`}
        </Btn>
      </div>
    </>
  );
}

function Results(props: Props & { results: SubscriptionResult[] }) {
  const { sub, actions, results } = props;
  const b = sub.backlog;
  const busy = props.busy === "continue";
  return (
    <>
      <div class="hdr">
        <div class="hdr-l">
          <span class="dot" data-tone="success" aria-hidden="true" />
          <b>
            Cleaned up {fmt(results.length)} {plural(results.length, "sender", "senders")}
          </b>
        </div>
        {props.fullscreen ? (
          <div class="hdr-r">
            <TextLink onClick={() => actions.setFullscreen(false)}>Collapse</TextLink>
          </div>
        ) : null}
      </div>

      <ul class="subs" aria-label="Results">
        {results.map((r) => {
          const host = r.status === "needs_user" ? httpsHost(r.link) : null;
          const mail = r.status === "needs_user" && !host && typeof r.mailto_address === "string" ? r.mailto_address : null;
          const [tone, label] = mail ? ["warning", "Email to unsubscribe"] : (STATUS[r.status] ?? ["neutral", "Done"]);
          const extra = r.status === "draft_ready" ? "Draft saved in your Drafts folder." : mail ? "" : r.detail || "";
          return (
            <li key={r.sender_key} data-status={r.status}>
              <span class="dot" data-tone={tone} aria-hidden="true" />
              <span class="grow">
                <span class="sub-name" title={r.display_name}>
                  {r.display_name || "(unknown sender)"}
                </span>
                <span class="sub-meta">
                  {label}
                  {extra ? `. ${extra}` : ""}
                </span>
                {mail && (
                  <span class="sub-meta sub-mail">
                    Email <span class="sel">{mail}</span> to unsubscribe
                  </span>
                )}
              </span>
              {host && (
                <TextLink title={`Opens ${host}`} onClick={() => actions.openLink(r.link as string)}>
                  Open {host}
                </TextLink>
              )}
            </li>
          );
        })}
      </ul>

      {b && (
        <p class="line">
          {b.action === "archive"
            ? `${fmt(b.moved)} ${plural(num(b.moved), "message", "messages")} archived${b.has_more ? `, ${fmt(b.remaining)} left` : ""}.`
            : "Existing mail kept."}
        </p>
      )}
      <p class="line">Senders usually stop within 2 days. We check again in 3 days.</p>
      {props.error && <Notice tone="danger">{props.error}</Notice>}

      {b?.has_more && (
        <div class="acts sub-acts">
          <Btn variant="primary" busy={busy} onClick={actions.continueBacklog}>
            {busy ? "Archiving" : `Continue archiving (${fmt(b.remaining)} left)`}
          </Btn>
        </div>
      )}
    </>
  );
}
