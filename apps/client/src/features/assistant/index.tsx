import { Minimize2, PanelRightClose, RotateCcw } from "lucide-react";
import { cx } from "../../lib/cx";
import { modKey } from "../../lib/platform";
import { selectCanClear, selectHasGhosts, useAssistantStore } from "../../state/assistant-store";
import { useComposeStore } from "../../state/compose-store";
import { READ_ONLY_EXPLANATION, useCanWrite } from "../../state/permissions";
import { useUiStore } from "../../state/ui-store";
import { Button, IconButton, LogoMark } from "../../ui";
import { useShell } from "../shell";
import s from "./Assistant.module.css";
import { Composer } from "./Composer";
import { Transcript } from "./Transcript";
import { panelStatus } from "./model";

/* The assistant panel: header with the status line, the transcript (text, tool
 * steps, cards, chips) and the composer. Content of <aside> (the shell owns
 * the frame, its width and the phone grow/shrink animation).
 *
 * On phone the same component is the bottom dock: only the composer shows
 * until the dock is expanded (ui.chatFull).
 */
export function AssistantPane() {
  const { phone } = useShell();
  const chatFull = useUiStore((u) => u.chatFull);
  const showBody = !phone || chatFull;
  return (
    <div className={s.root}>
      {showBody ? (
        <>
          <Header phone={phone} />
          <Transcript />
        </>
      ) : null}
      <Composer phone={phone} compact={phone && !chatFull} />
    </div>
  );
}

function Header({ phone }: { phone: boolean }) {
  const busy = useAssistantStore((a) => a.busy);
  const status = useAssistantStore((a) => a.status);
  const progress = useAssistantStore((a) => a.progress);
  const canClear = useAssistantStore(selectCanClear);
  const hasGhosts = useAssistantStore(selectHasGhosts);
  const undoable = useAssistantStore((a) => !a.busy && !!a.lastSummary?.undoable);
  const pushPending = useAssistantStore((a) => !!a.push?.approval_id);
  const held = useComposeStore((x) => !!x.compose?.held) || pushPending;
  const a = useAssistantStore.getState();
  const mayWrite = useCanWrite();
  const sub = panelStatus({ held, busy, status, progress });

  return (
    <div className={s.head}>
      <LogoMark size={24} className={s.headLogo} />
      <div className={s.headText}>
        <h2 className={s.title}>Assistant</h2>
        <span className={cx(s.sub, sub.tone === "held" && s.subHeld, sub.tone === "busy" && s.subBusy)} role="status" aria-live="polite">
          {sub.text}
        </span>
      </div>
      {busy && !held ? (
        <Button size="sm" title="Stop (Esc)" shortcut="Escape" onClick={a.stop}>
          Stop
        </Button>
      ) : null}
      {undoable ? (
        <Button size="sm" disabled={!mayWrite} title={mayWrite ? undefined : READ_ONLY_EXPLANATION} onClick={() => void a.undoRun()}>
          Undo
        </Button>
      ) : null}
      {!busy && hasGhosts ? (
        <Button size="sm" title="Remove moved emails from the list" onClick={a.clearGhosts}>
          Hide moved
        </Button>
      ) : null}
      {canClear ? (
        <IconButton label="New conversation" size="sm" onClick={a.clear}>
          <RotateCcw size={15} aria-hidden="true" />
        </IconButton>
      ) : null}
      {phone ? (
        <IconButton label="Exit full screen" className={s.headBig} onClick={() => useUiStore.getState().setChatFull(false)}>
          <Minimize2 size={18} aria-hidden="true" />
        </IconButton>
      ) : (
        <IconButton label="Hide assistant" hint={modKey("J")} shortcut="Meta+J Control+J" size="sm" onClick={() => useUiStore.getState().setPanelOpen(false)}>
          <PanelRightClose size={16} aria-hidden="true" />
        </IconButton>
      )}
    </div>
  );
}

export default AssistantPane;
