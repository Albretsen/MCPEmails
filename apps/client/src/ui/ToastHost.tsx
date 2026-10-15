import { cx } from "../lib/cx";
import { useToastStore } from "../state/toast-store";
import { selectIsPhone, useUiStore } from "../state/ui-store";
import s from "./ui.module.css";

/** Renders the single live toast. The region is always mounted so screen
 *  readers announce changes; it never takes focus. Hover or focus pauses the
 *  timer. */
export function ToastHost() {
  const toast = useToastStore((t) => t.toast);
  const pause = useToastStore((t) => t.pause);
  const resume = useToastStore((t) => t.resume);
  const runUndo = useToastStore((t) => t.runUndo);
  const runAction = useToastStore((t) => t.runAction);
  const phone = useUiStore(selectIsPhone);

  return (
    <div className={cx(s.toastHost, phone && s.toastHostPhone)} role="status" aria-live="polite" aria-atomic="true">
      {toast ? (
        <div
          key={toast.id}
          className={cx(s.toast, toast.kind === "error" && s.toastError)}
          onPointerEnter={pause}
          onPointerLeave={resume}
          onFocus={pause}
          onBlur={resume}
        >
          <span className={s.toastText}>{toast.text}</span>
          {toast.undo ? (
            <button type="button" className={s.toastUndo} onClick={runUndo} aria-keyshortcuts="Z">
              Undo
            </button>
          ) : toast.action ? (
            <button type="button" className={s.toastUndo} onClick={runAction}>
              {toast.action.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
