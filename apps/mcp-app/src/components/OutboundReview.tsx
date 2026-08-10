import { useMemo, useState } from "preact/hooks";
import type { Envelope, Outbound, Provider } from "../contract";
import {
  formatBytes,
  formatDateTime,
  operationLabel,
  relativeExpiry,
  summarizeRecipients,
} from "../format";
import { Btn, Fields, HtmlBody, Notice, Segmented } from "./ui";

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

  const [bodyMode, setBodyMode] = useState<"text" | "html">("text");
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
  const caveats = provider?.caveats ?? [];
  const inlineCaveats = fullscreen ? caveats : caveats.slice(0, 2);
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
    <div class="head">
      <div class="grow">
        <p class="eyebrow">
          <span
            class="status-dot"
            data-tone={pending ? "warning" : "neutral"}
            aria-hidden="true"
          />
          {operationLabel(o.operation)} · awaiting approval
        </p>
      </div>
      {fullscreen ? (
        <Btn variant="quiet" onClick={() => actions.setFullscreen(false)}>
          Close details
        </Btn>
      ) : props.canExpand ? (
        <Btn
          variant="quiet"
          onClick={() => actions.setFullscreen(true)}
          title="Full message, edit and send later"
        >
          Details
        </Btn>
      ) : null}
    </div>
  );

  const primaryActions = (
    <>
      <div class="actions">
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
      <p class="tiny">
        Approval happens on mcpemails.com in your own browser session. That step
        is deliberate: no agent, including this one, can approve a send.
      </p>
    </>
  );

  const providerBlock = provider ? (
    <div class="provider">
      <div class="route">
        <b>{provider.label}</b>
        {provider.route ? ` · ${provider.route}` : ""}
      </div>
      {inlineCaveats.length > 0 && (
        <ul class="caveats">
          {inlineCaveats.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      )}
    </div>
  ) : null;

  const attachmentChips =
    attachments.length > 0 ? (
      <ul class="chips" aria-label={`${attachments.length} attachments`}>
        {attachments.slice(0, fullscreen ? 20 : 3).map((a, i) => (
          <li class="chip" key={i}>
            <span class="name">{a.filename || "(unnamed)"}</span>
            <span class="tiny">{formatBytes(a.size_bytes)}</span>
          </li>
        ))}
        {!fullscreen && attachments.length > 3 && (
          <li class="chip">
            <span class="name">+{attachments.length - 3} more</span>
          </li>
        )}
      </ul>
    ) : null;

  // ---- inline -------------------------------------------------------------

  if (!fullscreen) {
    return (
      <>
        {header}
        <h2 class="subject">{o.subject || "(no subject)"}</h2>
        <Fields
          rows={[
            ["From", identityLine(o)],
            [
              "To",
              <>
                {recipients.primary}
                {recipients.extra && (
                  <span class="muted"> · {recipients.extra}</span>
                )}
              </>,
            ],
          ]}
        />
        {o.body?.text ? <p class="preview">{o.body.text}</p> : null}
        {attachmentChips}
        {providerBlock}
        {o.send_at && (
          <Notice>Scheduled to send {formatDateTime(o.send_at)} once approved.</Notice>
        )}
        {blockedReason && <Notice tone="warning">{blockedReason}</Notice>}
        {props.error && <Notice tone="danger">{props.error}</Notice>}
        {primaryActions}
        <p class="tiny">{expiry}</p>
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
          ["From", identityLine(o)],
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

      {attachmentChips}

      {hasHtml && (
        <Segmented
          label="Body format"
          value={bodyMode}
          onChange={(v) => setBodyMode(v as "text" | "html")}
          options={[
            { value: "text", label: "Plain text" },
            { value: "html", label: "Show original formatting" },
          ]}
        />
      )}

      {bodyMode === "html" && hasHtml ? (
        <HtmlBody html={o.body.html as string} />
      ) : (
        <p class="body-full">{o.body?.text || "(empty message)"}</p>
      )}

      {o.body?.truncated && (
        <Notice tone="warning">
          This message was clipped for review.
          <Btn variant="quiet" onClick={actions.openDashboard}>
            View full message in dashboard
          </Btn>
        </Notice>
      )}

      {o.signature?.will_append && (
        <div class="stack">
          <span class="field-label">Signature appended at send time</span>
          <p class="body-full tiny">{o.signature.preview_text || "(signature)"}</p>
        </div>
      )}

      {providerBlock}

      {blockedReason && <Notice tone="warning">{blockedReason}</Notice>}
      {props.error && <Notice tone="danger">{props.error}</Notice>}

      <hr class="divider" />

      <div class="row">
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
          <div>
            <label class="field-label" for="edit-subject">
              Subject
            </label>
            <input
              id="edit-subject"
              class="input"
              value={subject}
              disabled={!canDecide}
              onInput={(e) => setSubject((e.target as HTMLInputElement).value)}
            />
          </div>
          <div>
            <label class="field-label" for="edit-body">
              Message
            </label>
            <textarea
              id="edit-body"
              class="textarea"
              value={bodyText}
              disabled={!canDecide}
              onInput={(e) =>
                setBodyText((e.target as HTMLTextAreaElement).value)
              }
            />
          </div>
          {hasHtml && (
            <p class="tiny">
              Saving replaces the plain-text body. The HTML version is kept as is.
            </p>
          )}
          <div class="actions">
            <Btn
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
          <p class="tiny">
            Saving does not send anything. The message still needs the browser
            approval step.
          </p>
        </div>
      )}

      {panel === "schedule" && (
        <div class="stack">
          <span class="field-label">Send later</span>
          <div class="row">
            {quickSlots().map((s) => (
              <Btn key={s.iso} onClick={() => setSendAt(isoToLocalInput(s.iso))}>
                {s.label}
              </Btn>
            ))}
          </div>
          <div>
            <label class="field-label" for="send-at">
              Or pick a time
            </label>
            <input
              id="send-at"
              class="input"
              type="datetime-local"
              value={sendAt}
              disabled={!canDecide}
              onInput={(e) => setSendAt((e.target as HTMLInputElement).value)}
            />
          </div>
          <div class="actions">
            <Btn onClick={() => setPanel("none")}>Cancel</Btn>
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
          <p class="tiny">
            Scheduling does not send anything either. The message is queued for
            that time and still needs the browser approval step.
          </p>
        </div>
      )}

      {primaryActions}
      <p class="tiny">
        {expiry}
        {o.approval_id ? ` · ${o.approval_id}` : ""}
      </p>
    </>
  );
}
