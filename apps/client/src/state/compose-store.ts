import { create } from "zustand";
import { isOpenInReader } from "./conversation-store";
import { getRoute, navigate } from "../app/router";
import type { DiffSegment } from "../api/assistant-api";
import type { MessageKey } from "../api/types";
import { useUiStore } from "./ui-store";

/* The one compose surface. A reply renders inline under the email it answers;
 * anything else takes over the main pane. The assistant drafts into this same
 * state (`ai`, `streaming`, `segments`, `held`), so its drafts are ordinary
 * drafts the user can edit.
 *
 * This store only holds the form. Saving, sending and discarding on the server
 * are in data/mail-actions.ts (`saveDraft`, `send`, `discardDraft`).
 */

export type ComposeMode = "new" | "reply" | "reply_all" | "forward";

export interface ComposeHeld {
  approval_id: string;
  /** The email being answered came from outside the user's organisation. */
  external: boolean;
}

export interface ComposeState {
  mode: ComposeMode;
  /** The mailbox it is sent from. */
  inbox_id: string;
  /** Comma-separated addresses, exactly as typed. Parsed at send time. */
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  /** The message being answered or forwarded. */
  replyTo?: MessageKey;
  /** Latest draft id on the server. IMAP changes it on every save: always overwrite. */
  draft_id?: string;
  /** The assistant wrote (or is writing) this. */
  ai?: boolean;
  /** The assistant's last version, to tell whether the user edited it since. */
  aiOriginal?: string;
  streaming?: "writing" | "editing" | null;
  /** While `streaming === "editing"`: the word diff being shown. */
  segments?: DiffSegment[];
  /** Body before an assistant edit started, restored if the run is stopped. */
  preEdit?: string;
  /** Set while an assistant send waits for approval. */
  held?: ComposeHeld;
  /** The tool call that produced the draft ("Show steps"). */
  draftCall?: { call_id: string; message_id: string };
  /** Epoch ms of the last successful draft save. */
  savedAt?: number;
  /** Files picked in the form. Held locally: nothing is uploaded yet. */
  attachments?: ComposeAttachment[];
  /** `composeSignature` of a reply / forward as it was opened: closing it
   *  unchanged leaves no draft behind. */
  pristine?: string;
  /** Idempotency key of the last send attempt and the content it was for.
   *  Sending the same content again (after a failure) reuses the key, so a
   *  send whose answer was lost cannot go out twice. */
  sendKey?: { key: string; signature: string };
}

export interface ComposeAttachment {
  id: string;
  name: string;
  size: number;
  type: string;
  file?: File;
}

export type ComposeInit = Partial<ComposeState> & { inbox_id: string };

export interface ComposeStore {
  compose: ComposeState | null;
  /** Counts `open` calls, so the form can tell "a new form opened" (focus the
   *  first field, restart autosave) from an edit of the one on screen. */
  openSeq: number;
  /** Opens (or replaces) the compose surface. */
  open(init: ComposeInit): void;
  patch(patch: Partial<ComposeState>): void;
  /** Hides the form and returns what was in it, so the caller can save it. */
  close(): ComposeState | null;
  /** Same as close, for callers that throw the content away. */
  discard(): ComposeState | null;
}

/** Inline (under the email) when it answers the open message, else full pane. */
export function isInlineCompose(c: ComposeState | null, selectedKey: MessageKey | null): boolean {
  return !!c && !!c.replyTo && isOpenInReader(c.replyTo, selectedKey);
}

/** Everything the user can type, as one comparable string. */
export function composeSignature(c: Pick<ComposeState, "to" | "cc" | "bcc" | "subject" | "body">): string {
  return [c.to, c.cc, c.bcc, c.subject, c.body].join("\u0000");
}

/** Nothing worth saving: no content, or a reply / forward nobody touched
 *  (its prefilled recipient and subject are not the user's work). */
export function isComposeEmpty(c: ComposeState): boolean {
  if (!c.body.trim() && !c.to.trim() && !c.cc.trim() && !c.bcc.trim()) return true;
  return c.pristine != null && !c.draft_id && !c.ai && !c.attachments?.length && composeSignature(c) === c.pristine;
}

/** True when the user changed an assistant draft after it finished. */
export function isAiDraftEdited(c: ComposeState): boolean {
  return !!c.ai && c.aiOriginal != null && c.body !== c.aiOriginal && !c.streaming;
}

export const useComposeStore = create<ComposeStore>((set, get) => {
  const leave = (): ComposeState | null => {
    const c = get().compose;
    if (!c) return null;
    set({ compose: null });
    if (getRoute().compose) navigate({ compose: false }, { replace: true });
    const ui = useUiStore.getState();
    if (ui.viewport === "phone" && ui.screen === "compose") ui.setScreen("list");
    return c;
  };

  return {
    compose: null,
    openSeq: 0,
    open: (init) => {
      const compose: ComposeState = {
        mode: "new",
        to: "",
        cc: "",
        bcc: "",
        subject: "",
        body: "",
        ...init,
      };
      set({ compose, openSeq: get().openSeq + 1 });
      const ui = useUiStore.getState();
      if (ui.menu) ui.setMenu(null);
      if (compose.replyTo) {
        // Inline under the email: the reader stays on screen.
        if (ui.viewport === "phone") ui.setScreen("reader");
      } else {
        navigate({ compose: true });
        if (ui.viewport === "phone") ui.setScreen("compose");
      }
    },
    patch: (patch) => {
      const c = get().compose;
      if (c) set({ compose: { ...c, ...patch } });
    },
    close: leave,
    discard: leave,
  };
});
