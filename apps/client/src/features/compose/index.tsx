import { ChevronLeft, X } from "lucide-react";
import { cx } from "../../lib/cx";
import { useComposeStore } from "../../state/compose-store";
import { IconButton } from "../../ui";
import { useShell } from "../shell";
import { useAutosaveStatus } from "./autosave";
import s from "./Compose.module.css";
import { ComposeCard, closeCompose } from "./ComposeCard";

export { ComposeCard, closeCompose } from "./ComposeCard";
export { scheduleOptions } from "./schedule";
export type { ScheduleOption } from "./schedule";

/* The full-pane composer (a new message, or a saved draft). A reply or
 * forward is NOT shown here: the reader renders <ComposeCard inline /> under
 * the email it belongs to. Content of <main> (the shell owns it). */

export function ComposePane() {
  const { phone } = useShell();
  const saved = useComposeStore((x) => !!x.compose?.draft_id || !!x.compose?.savedAt);
  const hasDraftId = useComposeStore((x) => !!x.compose?.draft_id);
  const mode = useComposeStore((x) => x.compose?.mode);
  const status = useAutosaveStatus((x) => x.status);
  const title = mode === "forward" ? "Forward" : hasDraftId ? "Draft" : "New message";
  const note = status === "saving" ? "Saving…" : status === "error" ? "Not saved" : saved ? "Saved to Drafts" : "";

  return (
    <div className={cx(s.pane, phone && s.phone)}>
      <div className={s.bar}>
        {phone ? (
          <button type="button" className={s.back} onClick={() => void closeCompose({ silent: true })}>
            <ChevronLeft size={20} aria-hidden="true" />
            Back
          </button>
        ) : null}
        <h1 className={s.barTitle}>{title}</h1>
        {/* Quiet on purpose: not a live region, it changes every few seconds while typing. */}
        <span className={s.barSaved}>{note}</span>
        <span className={s.barSpacer} />
        {!phone ? (
          <IconButton
            label="Close and save draft"
            hint="Esc"
            shortcut="Escape"
            size="sm"
            className={s.close}
            onClick={() => void closeCompose()}
          >
            <X size={16} aria-hidden="true" />
          </IconButton>
        ) : null}
      </div>
      <div className={s.body}>
        <ComposeCard />
      </div>
    </div>
  );
}

export default ComposePane;
