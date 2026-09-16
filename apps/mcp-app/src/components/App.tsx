import type { VNode } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { HostBridge } from "../bridge";
import {
  isSupportedVersion,
  SCHEMA_VERSION,
  type Envelope,
  type Receipt as ReceiptData,
} from "../contract";
import { bulkVerb, draftSavedContextLine } from "../format";
import { lastDashboardUrl } from "../persist";
import { envelopeFrom, getState, setState, subscribe } from "../store";
import { BulkPlan } from "./BulkPlan";
import { DraftEditor, type DraftPatch } from "./DraftEditor";
import { OutboundReview } from "./OutboundReview";
import { Receipt } from "./Receipt";
import { Loading, Notice, TextLink } from "./ui";

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

/**
 * One line of protocol facts at the bottom of every card. INTERNAL v1 ONLY.
 *
 * It exists because the remount bug is not reproducible from here: the card
 * runs inside claude.ai's sandbox, we cannot read the host's logs, and the one
 * question that decides whether the fix is right — does a re-mounted view get
 * tool-input, tool-result, or neither, and does `toolInfo` survive — can only
 * be answered by looking at a card in the real host. `result late` in
 * particular would say the host does deliver and the watchdog is simply too
 * short.
 *
 * Never carries content: host name and version, display mode, and four
 * yes/no/none facts about what arrived. Delete this and `.diag` together once
 * the answer is known.
 */
function Diagnostics(props: { bridge: HostBridge }) {
  const s = getState();
  const h = props.bridge.hostInfo ?? {};
  const line = [
    `host ${h.name ?? "?"} ${h.version ?? "?"}`,
    `mode ${props.bridge.hostContext.displayMode ?? "?"}`,
    `result ${
      s.resultArrival === "ontime"
        ? "yes"
        : s.resultArrival === "late"
          ? "late"
          : "none"
    }${s.resultAfterMs === null ? "" : ` ${s.resultAfterMs}ms`}`,
    `input ${s.toolInput ? "yes" : "no"}`,
    `restored ${s.restored === "storage" ? "storage" : "none"}`,
    `toolInfo ${s.toolInfo ? "yes" : "no"}`,
    // Handshake facts. `hs` is how many ui/initialize requests it took; `rx` is
    // accepted/foreign JSON-RPC messages. On a card that never connects these
    // are the whole diagnosis: rx 0/0 means the host never spoke, and a
    // non-zero foreign count would mean it spoke and we dropped it.
    `hs ${props.bridge.initializeAttempts}`,
    `rx ${props.bridge.rxAccepted}/${props.bridge.rxForeign}`,
  ].join(" · ");
  return <p class="diag">{line}</p>;
}

/** `email_compose` -> `Email compose`. Falls back to the product name. */
function toolLabel(tool: string | null | undefined): string {
  if (!tool) return "MCP Emails";
  const words = tool.replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "MCP Emails";
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

  /**
   * One tool call from the draft editor.
   *
   * Differs from `run` in two ways that matter, both from contract §8:
   *
   *  - it hands the resulting envelope back, because the editor's own flows
   *    need it. A save on IMAP returns a NEW draft_id, and the send that
   *    follows a save must use that one, not the id this card mounted with.
   *  - an error envelope must not take the editor away. `state: "error"` means
   *    the server changed nothing, and the user's unsaved text is still in the
   *    textarea, so if the error carries no `draft` the current one is kept and
   *    the editor renders the error as a notice around it. Replacing the
   *    envelope wholesale would answer "that address was rejected" by deleting
   *    the message the user was writing.
   */
  const callDraft = async (
    key: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<Envelope | null> => {
    setBusy(key);
    setError(null);
    try {
      const result = await bridge.callServerTool(tool, args);
      const next = envelopeFrom(result);
      if (!next) {
        setError("The server sent a response this card could not read.");
        return null;
      }
      const current = getState().envelope;
      const applied =
        next.card === "draft_editor" && !next.draft && current?.draft
          ? { ...next, draft: current.draft }
          : next;
      setEnvelope(applied);
      return applied;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(null);
    }
  };

  /** A save that actually stored something, as opposed to a refusal. */
  const draftStored = (env: Envelope | null): boolean =>
    !!env && env.card === "draft_editor" && env.state !== "error" && !!env.draft;

  const openDashboard = (path: string | null | undefined) => {
    const url = path ? absoluteUrl(path) : null;
    if (!url) return;
    setBusy("dashboard");
    bridge
      .openLink(url)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };

  // ---- restore recovery ---------------------------------------------------
  //
  // A card that restored its envelope from storage is showing a MEMORY of a
  // draft, and a draft is the one card kind whose contents can have moved on
  // since (an IMAP save retires the id, and the user may have edited or sent it
  // in a mail client). So it refreshes itself against the server exactly once,
  // adopting whatever id comes back, and falls back to what it restored if the
  // call fails — an offline memory of the draft still beats a blank card.
  const [draftGone, setDraftGone] = useState(false);
  const refreshed = useRef(false);
  useEffect(() => {
    if (store.restored !== "storage" || refreshed.current) return;
    const env = store.envelope;
    const d = env?.card === "draft_editor" ? env.draft : null;
    if (!d) return;
    refreshed.current = true;
    bridge
      .callServerTool("draft_read", {
        inbox_id: d.identity?.inbox_id,
        draft_id: d.draft_id,
      })
      .then((result) => {
        const next = envelopeFrom(result);
        if (!next) return;
        // `draft_not_found` gets its own one-line rendering rather than the
        // editor's Refresh notice: refreshing is what just failed, and a wall
        // of red over a draft the user deliberately sent or deleted elsewhere
        // is the scare this card refuses to raise.
        if (next.receipt?.error_code === "draft_not_found") {
          setDraftGone(true);
          return;
        }
        if (next.card === "draft_editor" && next.draft) setState({ envelope: next });
      })
      .catch(() => {
        /* keep the restored envelope: it is the best thing available */
      });
  }, [store.restored, store.envelope]);

  /** The last https dashboard URL any envelope carried. See persist.ts. */
  const fallbackDashboard = () => {
    const url = lastDashboardUrl();
    if (!url) return null;
    return (
      <div class="hdr-r">
        <TextLink onClick={() => openDashboard(url)}>Open dashboard</TextLink>
      </div>
    );
  };

  /** One line, a dot and a link. Never a wall, never a skeleton. */
  const oneLine = (text: string) => (
    <div class="hdr">
      <div class="hdr-l">
        <span class="dot" data-tone="neutral" aria-hidden="true" />
        <b>{text}</b>
      </div>
      {fallbackDashboard()}
    </div>
  );

  const body = ((): VNode | null => {
    // ---- connection / loading ----------------------------------------------

    // The host never completed `ui/initialize`, even across retries. The
    // message above this card already carries every fact, so this is a quiet
    // one-liner with a way out rather than a red block announcing a failure the
    // user cannot act on and that cost them nothing.
    if (store.connectError) {
      return oneLine(`${toolLabel(store.toolInfo?.tool)}: not shown here.`);
    }

    // A restored draft that the server says is gone. One line, not the editor's
    // Refresh notice: see the refresh effect above.
    if (draftGone) return oneLine("This draft is no longer in Drafts.");

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
        store.resultStatus === "cancelled"
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
      // NOTHING AT ALL, AND NOTHING REMEMBERED. `restored: "none"` is only set
      // once the watchdog has fired and the lookup has actually missed, so this
      // is a settled fact rather than "not yet". Before the storage cache this
      // path rendered silence, on the theory that a send which already happened
      // should not be second-guessed; with the cache in place, silence now
      // means "this host keeps nothing", and a user who scrolled back to a card
      // deserves to be told which tool it was and where the record lives.
      if (store.restored === "none") {
        return oneLine(`${toolLabel(store.toolInfo?.tool)}: nothing to show here.`);
      }

      // Still genuinely waiting. At most RESULT_WATCHDOG_MS of this.
      //
      // Gated on `connected`, which is the difference between "waiting" and
      // "never started". Measured in Claude on 2026-09-16: a RE-MOUNTED card
      // paints once and then never executes again — its diagnostics line reads
      // `hs 0`, and `initializeAttempts` is incremented synchronously inside
      // connect() in the same tick as this very render, so a painted 0 is the
      // pre-connect first paint and nothing after it ever ran. No microtask, no
      // timer, no handshake.
      //
      // A spinner is a promise that something is coming. In that frame nothing
      // is, and it is the only frame the user will ever see, so the promise is
      // a lie that sits on screen forever: "simply not loading". Rendering
      // nothing instead lets `.card:empty` collapse the shell, leaving the
      // host's own header and the message text below it to carry the result,
      // which they already do in full.
      //
      // This does not fix the remount. Nothing on this side can: the card is
      // not running. It stops the failure from being loud.
      return store.connected ? <Loading /> : null;
    }

    // ---- version gate -------------------------------------------------------

    if (!isSupportedVersion(envelope.schema_version)) {
      return (
        <>
          <div class="hdr">
            <div class="hdr-l">
              <span class="dot" data-tone="neutral" aria-hidden="true" />
              <b>Update the MCP Emails connector</b>
            </div>
            <div class="hdr-r">
              <TextLink onClick={() => openDashboard(envelope.dashboard_url)}>
                Open dashboard
              </TextLink>
            </div>
          </div>
          <p class="line">
            This card understands <span class="mono">{SCHEMA_VERSION}</span>, but
            the server sent{" "}
            <span class="mono">{String(envelope.schema_version).slice(0, 40)}</span>
            . Rather than guess at the contents, it will not render them.
          </p>
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

    if (envelope.card === "draft_editor" && envelope.draft) {
      const d = envelope.draft;
      // Read at call time, never closed over: on IMAP every save retires the id
      // and returns a new one, and the next call has to use the live one (§8,
      // `id_is_stable: false`). The store already holds whatever the last
      // response adopted.
      const target = () => ({
        inbox_id: d.identity?.inbox_id,
        draft_id: getState().envelope?.draft?.draft_id ?? d.draft_id,
      });

      const save = async (patch: DraftPatch): Promise<boolean> => {
        if (Object.keys(patch).length === 0) return true;
        const next = await callDraft("save", "draft_editor_save", {
          ...target(),
          ...patch,
        });
        if (!draftStored(next)) return false;
        void bridge.updateModelContext(draftSavedContextLine(next!.draft!));
        return true;
      };

      const announceReceipt = (env: Envelope | null) => {
        const headline = env?.receipt?.headline?.trim();
        if (headline) void bridge.updateModelContext(headline);
      };

      return (
        <DraftEditor
          env={envelope}
          draft={d}
          provider={envelope.provider}
          fullscreen={fullscreen}
          canExpand={canExpand}
          busy={busy}
          error={error}
          actions={{
            save,
            send: async (patch) => {
              // Unsaved changes are written first and the send is abandoned if
              // that write fails, so a send never puts the stored draft on the
              // wire when the user is looking at a newer one.
              if (patch && Object.keys(patch).length > 0) {
                const saved = await callDraft("send", "draft_editor_save", {
                  ...target(),
                  ...patch,
                });
                if (!draftStored(saved)) return;
                void bridge.updateModelContext(draftSavedContextLine(saved!.draft!));
              }
              announceReceipt(
                await callDraft("send", "draft", { action: "send", ...target() }),
              );
            },
            discard: async () => {
              announceReceipt(
                await callDraft("discard", "draft", {
                  action: "delete",
                  ...target(),
                }),
              );
            },
            refresh: () => void callDraft("refresh", "draft_read", target()),
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
  })();

  // The diagnostics line rides along with whatever the card rendered, and
  // never alone: the paths that render nothing (a foreign payload, a cancelled
  // call) must keep rendering nothing, or every successful delete on an
  // opted-out inbox grows a stray line of protocol trivia underneath it.
  if (body === null) return null;
  return (
    <>
      {body}
      <Diagnostics bridge={bridge} />
    </>
  );
}
