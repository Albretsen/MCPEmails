import { X } from "lucide-react";
import { useId, useRef } from "react";
import { cx } from "../../lib/cx";
import { isMac } from "../../lib/platform";
import { useUiStore } from "../../state/ui-store";
import { IconButton, Kbd } from "../../ui";
import s from "./AppShell.module.css";
import { trapTab, useModalFocus } from "./focus-trap";
import { HELP_COLUMNS, isSingleKeyOnly } from "./keymap";
import { SHORTCUTS, shortcutHint, shortcutKeys } from "./shortcuts";

/** The keyboard shortcuts dialog (?). Generated from the shortcut registry, so
 *  it lists exactly what the key handler does. Mounted only while open. */
export function HelpDialog() {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const noteId = useId();
  const enabled = useUiStore((u) => u.settings.shortcutsEnabled);
  useModalFocus(ref, closeRef);

  const close = () => useUiStore.getState().setMenu(null);
  const rows = SHORTCUTS.filter((k) => k.help !== false);

  return (
    <>
      <div className={s.scrim} onPointerDown={close} aria-hidden="true" />
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className={s.dialog} onKeyDown={trapTab}>
        <header className={s.dialogHead}>
          <h2 id={titleId} className={s.dialogTitle}>
            Keyboard shortcuts
          </h2>
          <IconButton ref={closeRef} label="Close" hint="Esc" size="sm" onClick={close}>
            <X size={16} aria-hidden="true" />
          </IconButton>
        </header>

        <div className={s.dialogBody} data-scroller="">
          {HELP_COLUMNS.map((column, i) => (
            <div key={i}>
              {column.map((group) => {
                const items = rows.filter((k) => k.group === group);
                if (!items.length) return null;
                return (
                  <section key={group} className={s.helpGroup} aria-label={group}>
                    <h3 className={s.helpGroupTitle}>{group}</h3>
                    <dl className={s.helpList}>
                      {items.map((k) => (
                        <div key={k.id} className={cx(s.helpRow, !enabled && isSingleKeyOnly(k) && s.helpRowOff)}>
                          <dt>{k.label}</dt>
                          <dd>
                            {shortcutKeys(k).map((keys, n) => (
                              <span key={keys} className={s.helpKeys}>
                                {n > 0 ? <span className={s.helpOr}>or</span> : null}
                                {/* Kbd is aria-hidden (decorative on controls); here the keys ARE the content. */}
                                <span className="sr-only">{keys}</span>
                                <Kbd>{keys}</Kbd>
                              </span>
                            ))}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                );
              })}
            </div>
          ))}
        </div>

        <footer className={s.dialogFoot}>
          <label className={s.switchRow}>
            <input
              type="checkbox"
              role="switch"
              className={s.switch}
              checked={enabled}
              aria-describedby={noteId}
              onChange={(e) => useUiStore.getState().setSetting("shortcutsEnabled", e.currentTarget.checked)}
            />
            <span>Single-key shortcuts</span>
          </label>
          <p id={noteId} className={s.dialogNote}>
            {enabled
              ? "Keys like e, r and # act on the open email. Turn this off if they get in your way."
              : `Off. Shortcuts with ${isMac ? "⌘" : "Ctrl"}, Esc and F6 still work, and ${shortcutHint("palette")} opens every action.`}
          </p>
        </footer>
      </div>
    </>
  );
}
