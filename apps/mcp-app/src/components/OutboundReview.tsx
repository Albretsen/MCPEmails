import { useMemo, useState } from "preact/hooks";
import type { Envelope, Outbound, Provider } from "../contract";
import {
  formatBytes,
  formatDateTime,
  operationLabel,
  relativeExpiry,
  summarizeRecipients,
} from "../format";
import {
  AutoTextarea,
  Btn,
  Fields,
  FsLink,
  Head,
  HtmlBody,
  Line,
  Notice,
  ProviderLine,
  Segmented,
  TextLink,
} from "./ui";

export interface OutboundActions {
  reject: (note?: string) => void;
  approve: () => void;
  update: (patch: { subject?: string; body_text?: string }) => void;
  schedule: (sendAtIso: string) => void;
  openDashboard: () => void;
  setFullscreen: (on: boolean) => void;
}

interface Props {
  env: Envelope;
  outbound: Outbound;
  provider?: Provider;
  fullscreen: boolean;
  canExpand: boolean;
  busy: string | null;
  error: string | null;
  actions: OutboundActions;
}

function identityLine(o: Outbound): string {
  const name = o.identity?.display_name?.trim();
  const addr = o.identity?.email_address ?? "unknown sender";
  return name ? `${name} · ${addr}` : addr;
}

/** Local datetime-local value -> ISO, without pulling in a date library. */
function localInputToIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function quickSlots(): Array<{ label: string; iso: string }> {
  const now = new Date();
  const inAnHour = new Date(now.getTime() + 3600_000);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const monday = new Date(now);
  const daysToMonday = (8 - monday.getDay()) % 7 || 7;
  monday.setDate(monday.getDate() + daysToMonday);
  monday.setHours(9, 0, 0, 0);
  return [
    { label: "In 1 hour", iso: inAnHour.toISOString() },
    { label: "Tomorrow 09:00", iso: tomorrow.toISOString() },
    { label: "Monday 09:00", iso: monday.toISOString() },
  ];
}

export function OutboundReview(props: Props) {
  const { env, outbound: o, provider, fullscreen, busy, actions } = props;
  const pending = env.state === "pending";
  const canDecide = env.actor?.can_decide !== false && pending;

  const [showHtml, setShowHtml] = useState(false);
  const [panel, setPanel] = useState<"none" | "edit" | "schedule">("none");
  const [subject, setSubject] = useState(o.subject ?? "");
  const [bodyText, setBodyText] = useState(o.body?.text ?? "");
  const [sendAt, setSendAt] = useState(isoToLocalInput(o.send_at));

  const recipients = useMemo(
    () =>
      summarizeRecipients(
        o.recipients?.to ?? [],
        o.recipients?.cc ?? [],
        o.recipients?.bcc_count ?? 0,
      ),
    [o.recipients],
  );

  const attachments = o.attachments ?? [];
  const expiry = relativeExpiry(o.expires_at);
  const expired = expiry === "expired";

  const blockedReason =
    env.actor?.can_decide === false
      ? env.actor?.reason === "viewer_role"
        ? "Your role can view this send but not decide on it."
        : env.actor?.reason === "expired" || expired
          ? "This request has expired. Nothing was sent."
          : "This send is no longer awaiting a decision."
      : !pending
        ? "This send is no longer awaiting a decision."
        : null;

  const header = (
    <Head
      tone={pending ? "warning" : "neutral"}
      title={operationLabel(o.operation)}
      extra={<span class="muted">{identityLine(o)}</span>}
    >
      <FsLink
        on={fullscreen}
        can={props.canExpand}
        set={actions.setFullscreen}
        label="Details"
        title="Full message, edit and send later"
      />
      <span class="muted">{expiry}</span>
    </Head>
  );

  const primaryActions = (
    <>
      <Line>
        Approval happens on mcpemails.com in your own browser. No agent,
        including this one, can approve a send.
      </Line>
      <div class="acts">
        <Btn
          variant="danger"
          disabled={!canDecide}
          busy={busy === "reject"}
          onClick={() => actions.reject()}
        >
          {busy === "reject" ? "Rejecting" : "Reject"}
        </Btn>
        <Btn
          variant="primary"
          disabled={!canDecide || !o.review_url}
          busy={busy === "approve"}
          onClick={actions.approve}
          title="Opens mcpemails.com in your browser, where you sign in and approve"
        >
          Approve in browser
          <span aria-hidden="true">&#8599;</span>
        </Btn>
      </div>
    </>
  );

  const providerBlock = (
    <ProviderLine provider={provider} fullscreen={fullscreen} />
  );

  // One muted line, like the draft editor's: the card cannot open or change an
  // attachment, so a row of chips was spending height on read-only facts.
  const shownAttachments = attachments.slice(0, fullscreen ? 8 : 3);
  const attachmentLine =
    attachments.length > 0 ? (
      <Line>
        {attachments.length} attachment{attachments.length === 1 ? "" : "s"}:{" "}
        {shownAttachments
          .map((a) => `${a.filename || "(unnamed)"} ${formatBytes(a.size_bytes)}`)
          .join(", ")}
        {attachments.length > shownAttachments.length
          ? `, +${attachments.length - shownAttachments.length} more`
          : ""}
      </Line>
    ) : null;

  // ---- inline -------------------------------------------------------------

  if (!fullscreen) {
    return (
      <>
        {header}
        <div class="tight">
          <div class="row">
            <span class="lbl">To</span>
            <span class="val">
              {recipients.primary}
              {recipients.extra && (
                <span class="muted"> · {recipients.extra}</span>
              )}
            </span>
          </div>
          <h2 class="subject">{o.subject || "(no subject)"}</h2>
        </div>
        {o.body?.text ? <p class="preview">{o.body.text}</p> : null}
        {attachmentLine}
        {providerBlock}
        {o.send_at && (
          <Line>
            Scheduled to send {formatDateTime(o.send_at)} once approved.
          </Line>
        )}
        {blockedReason && <Notice tone="warning">{blockedReason}</Notice>}
        {props.error && <Notice tone="danger">{props.error}</Notice>}
        {primaryActions}
      </>
    );
  }

  // ---- fullscreen ---------------------------------------------------------

  const hasHtml = !!o.body?.html;

  return (
    <>
      {header}
      <h2 class="subject">{o.subject || "(no subject)"}</h2>
      <Fields
        rows={[
          ["To", (o.recipients?.to ?? []).join(", ") || "(none)"],
          ...((o.recipients?.cc ?? []).length
            ? ([["Cc", (o.recipients?.cc ?? []).join(", ")]] as Array<
                [string, string]
              >)
            : []),
          ...((o.recipients?.bcc_count ?? 0) > 0
            ? ([
                [
                  "Bcc",
                  `${o.recipients.bcc_count} recipient${o.recipients.bcc_count === 1 ? "" : "s"} (addresses hidden)`,
                ],
              ] as Array<[string, string]>)
            : []),
          ["Created", formatDateTime(o.created_at)],
          ...(o.requested_by?.api_key_name
            ? ([
                [
                  "Requested by",
                  `${o.requested_by.api_key_name}${o.requested_by.client_name ? ` · ${o.requested_by.client_name}` : ""}`,
                ],
              ] as Array<[string, string]>)
            : []),
        ]}
      />

      {attachmentLine}

      {showHtml && hasHtml ? (
        <HtmlBody html={o.body.html as string} />
      ) : (
        <p class="body-full">{o.body?.text || "(empty message)"}</p>
      )}

      {hasHtml && (
        <Line>
          <TextLink onClick={() => setShowHtml(!showHtml)}>
            {showHtml ? "Show plain text" : "Show original formatting"}
          </TextLink>
        </Line>
      )}

      {o.body?.truncated && (
        <Notice tone="warning">
          This message was clipped for review.{" "}
          <TextLink onClick={actions.openDashboard}>
            View the full message in the dashboard
          </TextLink>
        </Notice>
      )}

      {o.signature?.will_append && (
        <Line>
          Signature appended at send time:{" "}
          {o.signature.preview_text || "(signature)"}
        </Line>
      )}

      {providerBlock}

      {blockedReason && <Notice tone="warning">{blockedReason}</Notice>}
      {props.error && <Notice tone="danger">{props.error}</Notice>}

      <hr class="divider" />

      <div class="acts" style={{ justifyContent: "flex-start" }}>
        <Segmented
          label="Edit or schedule"
          value={panel}
          onChange={(v) => setPanel(v as "none" | "edit" | "schedule")}
          options={[
            { value: "none", label: "Review" },
            { value: "edit", label: "Edit message" },
            { value: "schedule", label: "Send later" },
          ]}
        />
      </div>

      {panel === "edit" && (
        <div class="stack">
          <input
            class="subj"
            aria-label="Subject"
            placeholder="Subject"
            value={subject}
            disabled={!canDecide}
            onInput={(e) => setSubject((e.target as HTMLInputElement).value)}
          />
          <AutoTextarea
            id="edit-body"
            ariaLabel="Message"
            value={bodyText}
            disabled={!canDecide}
            maxRows={40}
            onInput={setBodyText}
          />
          {hasHtml && (
            <Line>
              Saving replaces the plain-text body. The formatted version is
              regenerated from it.
            </Line>
          )}
          <Line>
            Saving does not send anything. The message still needs the browser
            approval step.
          </Line>
          <div class="acts">
            <Btn
              variant="quiet"
              onClick={() => {
                setSubject(o.subject ?? "");
                setBodyText(o.body?.text ?? "");
                setPanel("none");
              }}
            >
              Discard changes
            </Btn>
            <Btn
              variant="primary"
              disabled={
                !canDecide ||
                (subject === o.subject && bodyText === (o.body?.text ?? ""))
              }
              busy={busy === "update"}
              onClick={() =>
                actions.update({ subject, body_text: bodyText })
              }
            >
              {busy === "update" ? "Saving" : "Save changes"}
            </Btn>
          </div>
        </div>
      )}

      {panel === "schedule" && (
        <div class="stack">
          <div class="row">
            <span class="lbl">Send</span>
            <span class="val acts" style={{ justifyContent: "flex-start" }}>
              {quickSlots().map((s) => (
                <Btn key={s.iso} onClick={() => setSendAt(isoToLocalInput(s.iso))}>
                  {s.label}
                </Btn>
              ))}
              <input
                id="send-at"
                class="input"
                style={{ width: "auto" }}
                aria-label="Or pick a send time"
                type="datetime-local"
                value={sendAt}
                disabled={!canDecide}
                onInput={(e) => setSendAt((e.target as HTMLInputElement).value)}
              />
            </span>
          </div>
          <Line>
            Scheduling does not send anything either. The message is queued for
            that time and still needs the browser approval step.
          </Line>
          <div class="acts">
            <Btn variant="quiet" onClick={() => setPanel("none")}>
              Cancel
            </Btn>
            <Btn
              variant="primary"
              disabled={!canDecide || !localInputToIso(sendAt)}
              busy={busy === "schedule"}
              onClick={() => {
                const iso = localInputToIso(sendAt);
                if (iso) actions.schedule(iso);
              }}
            >
              {busy === "schedule" ? "Saving" : "Set send time"}
            </Btn>
          </div>
        </div>
      )}

      {primaryActions}
      <Line>
        {expiry}
        {o.approval_id ? ` · ${o.approval_id}` : ""}
      </Line>
    </>
  );
}
