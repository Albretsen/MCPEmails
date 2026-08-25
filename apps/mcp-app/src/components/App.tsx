import { useEffect, useState } from "preact/hooks";
import type { HostBridge } from "../bridge";
import {
  isSupportedVersion,
  SCHEMA_VERSION,
  type Envelope,
  type Receipt as ReceiptData,
} from "../contract";
import { bulkVerb } from "../format";
import { envelopeFrom, getState, setState, subscribe } from "../store";
import { BulkPlan } from "./BulkPlan";
import { OutboundReview } from "./OutboundReview";
import { Receipt } from "./Receipt";
import { Btn, CardSkeleton, Notice } from "./ui";

/**
 * `ui/open-link` requires an absolute URL, so the server sends one: contract §4
 * `receipt.dashboard_url`, built from its own APP_URL. Deliberately not resolved
 * against a hardcoded origin here — that would bake deployment config into a
 * bundle that ships inside the edge function and silently duplicate
 * NEXT_PUBLIC_APP_URL.
 *
 * Only https is accepted. The field is server-authored, but it is the argument
 * to a host navigation, so it gets validated like any other untrusted input.
 */
function absoluteUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string" || !/^https:\/\//i.test(url)) return null;
  return url;
}

export function App(props: { bridge: HostBridge }) {
  const { bridge } = props;
  const [, force] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approveOpened, setApproveOpened] = useState(false);

  // The store is the single source of truth for the envelope. Keeping a copy in
  // component state looks harmless and is not: the host pushes
  // host-context-changed on every iframe resize, that writes to the store, and
  // the resulting sync would clobber a post-decision envelope with the original
  // one from the tool result.
  useEffect(() => subscribe(() => force((n) => n + 1)), []);

  const store = getState();
  const envelope = store.envelope;
  const setEnvelope = (next: Envelope) => setState({ envelope: next });
  const ctx = bridge.hostContext;
  const fullscreen = ctx.displayMode === "fullscreen";
  const canExpand = (ctx.availableDisplayModes ?? ["inline"]).includes(
    "fullscreen",
  );

  // The root element carries the display mode so the CSS can widen padding and
  // cap the measure without any JS-driven layout.
  useEffect(() => {
    document
      .getElementById("root")
      ?.setAttribute("data-mode", fullscreen ? "fullscreen" : "inline");
  }, [fullscreen]);

  const setFullscreen = (on: boolean) => {
    bridge
      .requestDisplayMode(on ? "fullscreen" : "inline")
      .then(() => force((n) => n + 1))
      .catch(() => force((n) => n + 1));
  };

  const run = async (
    key: string,
    tool: string,
    args: Record<string, unknown>,
    contextLine?: string,
  ) => {
    setBusy(key);
    setError(null);
    try {
      const result = await bridge.callServerTool(tool, args);
      const next = envelopeFrom(result);
      if (next) {
        setEnvelope(next);
      } else {
        setError("The server sent a response this card could not read.");
      }
      if (contextLine) void bridge.updateModelContext(contextLine);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const openDashboard = (path: string | null | undefined) => {
    const url = path ? absoluteUrl(path) : null;
    if (!url) return;
    setBusy("dashboard");
    bridge
      .openLink(url)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };

  // ---- connection / loading ----------------------------------------------

  if (store.connectError) {
    return (
      <Notice tone="danger">
        This card could not reach the app host. The same information is in the
        message above.
      </Notice>
    );
  }

  if (!envelope) {
    // NOT OUR PAYLOAD -> SILENCE. `_meta.ui` is per-tool, so the host renders
    // this card for every result of a UI-bearing tool, including ones that were
    // never going to produce an envelope: a delete on an inbox that has not
    // opted into bulk previews, or `email_organize` doing copy_batch / flag /
    // archive. Those operations succeeded. The host is already showing their
    // text result. A warning underneath it would invent a problem, so the card
    // renders nothing at all and lets the text stand.
    //
    // (`.card:empty` in styles.css collapses the shell so this leaves no empty
    // box and reports a zero height to the host's auto-fit.)
    //
    // The same judgement covers the two ways there is no payload at all:
    //
    //   cancelled — the host sent tool-cancelled. The call was abandoned and
    //               the host is already telling the user so. Adding our own
    //               notice under it would just be a second voice.
    //   absent    — the watchdog fired: connect() resolved and nothing
    //               followed. On Claude this is almost always a re-mount of an
    //               old conversation cell, where the tool call succeeded days
    //               ago and the spec simply owes a late-mounting view nothing
    //               (see store.ts). The send happened. Announcing "this review
    //               could not be displayed" over a send that went through is
    //               the exact scare this card refuses to raise. Silence.
    //
    // Three separate statuses, one rendering, on purpose: the distinction is
    // real and is kept where it is still known, and the fact that it does not
    // change what the user sees is the point rather than a redundancy.
    if (
      store.resultStatus === "foreign" ||
      store.resultStatus === "cancelled" ||
      store.resultStatus === "absent"
    ) {
      return null;
    }

    // OUR PAYLOAD, UNREADABLE -> LOUD. Something that identified itself as our
    // envelope could not be parsed. That is a real defect and a reviewer who
    // was expecting to see a send needs to know they are not seeing it.
    if (store.resultStatus === "malformed") {
      return (
        <Notice tone="warning">
          This review could not be displayed. Use the summary in the message
          above, or open the dashboard.
        </Notice>
      );
    }
    return <CardSkeleton />;
  }

  // ---- version gate -------------------------------------------------------

  if (!isSupportedVersion(envelope.schema_version)) {
    return (
      <>
        <p class="eyebrow">
          <span class="status-dot" data-tone="neutral" aria-hidden="true" />
          Unsupported card
        </p>
        <h2 class="headline">Update the MCP Emails connector</h2>
        <p class="muted" style={{ margin: 0 }}>
          This card understands <span class="mono">{SCHEMA_VERSION}</span>, but
          the server sent{" "}
          <span class="mono">{String(envelope.schema_version).slice(0, 40)}</span>
          . Rather than guess at the contents, it will not render them.
        </p>
        <div class="actions">
          <Btn
            busy={busy === "dashboard"}
            onClick={() => openDashboard(envelope.dashboard_url)}
          >
            Open dashboard
            <span aria-hidden="true">&#8599;</span>
          </Btn>
        </div>
      </>
    );
  }

  // ---- variants -----------------------------------------------------------

  if (envelope.card === "outbound_review" && envelope.outbound) {
    const o = envelope.outbound;
    return (
      <>
        <OutboundReview
          env={envelope}
          outbound={o}
          provider={envelope.provider}
          fullscreen={fullscreen}
          canExpand={canExpand}
          busy={busy}
          error={error}
          actions={{
            reject: () =>
              run(
                "reject",
                "approval_decide",
                { approval_id: o.approval_id, decision: "reject" },
                `The user rejected the queued send to ${(o.recipients?.to ?? []).length} recipient(s). Nothing was sent.`,
              ),
            approve: () => {
              const url = o.review_url;
              if (!url || !/^https:\/\//i.test(url)) {
                setError("This send has no valid approval link.");
                return;
              }
              setBusy("approve");
              setError(null);
              bridge
                .openLink(url)
                .then(() => {
                  setApproveOpened(true);
                  void bridge.updateModelContext(
                    "The user opened the approval page in their browser. The send is still pending until they approve it there; an agent cannot approve it.",
                  );
                })
                .catch((e) =>
                  setError(e instanceof Error ? e.message : String(e)),
                )
                .finally(() => setBusy(null));
            },
            update: (patch) =>
              run("update", "approval_update", {
                approval_id: o.approval_id,
                ...patch,
              }),
            schedule: (sendAtIso) =>
              run("schedule", "approval_schedule", {
                approval_id: o.approval_id,
                send_at: sendAtIso,
              }),
            openDashboard: () => openDashboard(envelope.dashboard_url),
            setFullscreen,
          }}
        />
        {approveOpened && (
          <Notice tone="success">
            Approval page opened in your browser. This card updates the next time
            the agent checks.
          </Notice>
        )}
      </>
    );
  }

  if (envelope.card === "bulk_plan" && envelope.plan) {
    const plan = envelope.plan;
    return (
      <BulkPlan
        env={envelope}
        plan={plan}
        provider={envelope.provider}
        fullscreen={fullscreen}
        canExpand={canExpand}
        busy={busy}
        error={error}
        actions={{
          execute: () =>
            run(
              "execute",
              "bulk_execute",
              { plan_id: plan.plan_id },
              `The user confirmed the bulk ${bulkVerb(plan.action).toLowerCase()} of ${plan.match_count} messages.`,
            ),
          cancel: () => {
            // Contract v1 has no bulk_cancel tool: plans are server-held and
            // expire on their own (15 min TTL). Cancelling is therefore purely
            // local — we simply stop offering the button.
            const receipt: ReceiptData = {
              outcome: "cancelled",
              headline: "Cancelled. Nothing was changed.",
              detail: `The plan to ${bulkVerb(plan.action).toLowerCase()} ${plan.match_count} messages was not run. It expires on its own.`,
              affected_count: 0,
              dashboard_url: null,
            };
            setEnvelope({
              schema_version: envelope.schema_version,
              card: "receipt",
              state: "rejected",
              receipt,
            });
            void bridge.updateModelContext(
              `The user cancelled the bulk ${bulkVerb(plan.action).toLowerCase()} plan. Nothing was changed.`,
            );
          },
          setFullscreen,
        }}
      />
    );
  }

  if (envelope.card === "receipt" && envelope.receipt) {
    return (
      <Receipt
        receipt={envelope.receipt}
        busy={busy}
        onOpenDashboard={() => openDashboard(envelope.receipt?.dashboard_url ?? envelope.dashboard_url)}
      />
    );
  }

  // Known schema version, but the payload does not match its own discriminator.
  return (
    <Notice tone="warning">
      This review is missing its details. Open the dashboard to see the full
      request.
    </Notice>
  );
}
