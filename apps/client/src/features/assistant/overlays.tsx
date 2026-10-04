import { useId } from "react";
import { cx } from "../../lib/cx";
import { useAssistantStore } from "../../state/assistant-store";
import { READ_ONLY_EXPLANATION, useCanWrite } from "../../state/permissions";
import { selectIsPhone, useUiStore } from "../../state/ui-store";
import { LogoMark } from "../../ui";
import s from "./Assistant.module.css";

/** Assistant UI that floats above the app (the in-app "wants to send" notice). */
export function AssistantOverlays() {
  return <PushCard />;
}

/* In-app version of the "assistant wants to send" push notification. Shown
 * when a send is waiting for approval and the user is not looking at the draft.
 * It never takes focus: it is announced, and reachable by Tab, but typing is
 * not interrupted. Unanswered means not sent. */
function PushCard() {
  const push = useAssistantStore((a) => a.push);
  const phone = useUiStore(selectIsPhone);
  const titleId = useId();
  const textId = useId();
  const mayWrite = useCanWrite();
  if (!push) return null;
  const a = useAssistantStore.getState();
  const approve = () => {
    if (!mayWrite) return;
    if (push.approval_id) void a.resolveApproval("approve");
    else a.setPush(null);
  };
  return (
    <div role="alertdialog" aria-modal="false" aria-labelledby={titleId} aria-describedby={textId} className={cx(s.push, phone && s.pushPhone)}>
      <div className={s.pushTop}>
        <div className={s.pushIcon}>
          <LogoMark size={22} />
        </div>
        <div className={s.pushBody}>
          <div className={s.pushHead}>
            <h2 id={titleId} className={s.pushTitle}>
              Assistant wants to send
            </h2>
            <span className={s.pushWhen}>now</span>
          </div>
          <p id={textId} className={s.pushText}>
            {push.text}
          </p>
        </div>
      </div>
      <div className={s.pushActions}>
        <button type="button" className={s.pushButton} onClick={a.reviewPush}>
          Review
        </button>
        <button
          type="button"
          className={cx(s.pushButton, s.pushApprove)}
          onClick={approve}
          disabled={!mayWrite}
          title={mayWrite ? undefined : READ_ONLY_EXPLANATION}
        >
          Approve
        </button>
      </div>
    </div>
  );
}
