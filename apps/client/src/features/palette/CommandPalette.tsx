import { Folder, Mailbox, Search, Sparkles } from "lucide-react";
import { type KeyboardEvent, useEffect, useId,useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFolders, useInboxes } from "../../data/hooks";
import { cx } from "../../lib/cx";
import { useSelectionStore } from "../../state/selection-store";
import { useUiStore } from "../../state/ui-store";
import { FOLDER_ROLE_ICON, Kbd } from "../../ui";
import { useModalFocus } from "../shell/focus-trap";
import { paletteActions, shortcutHint, shortcutKeys } from "../shell/shortcuts";
import s from "./Palette.module.css";
import { clearPending, takePending } from "./pending";
import { type PaletteItem, SECTION_LABEL, actionItems, buildSections, flatten, gotoItems } from "./items";

/* The command palette (⌘K / Ctrl+K). Loaded on demand (see ./index.tsx).
 *
 * ARIA: the combobox-with-listbox pattern. Focus never leaves the input; the
 * highlighted row is exposed through aria-activedescendant, so a screen reader
 * announces it while the user keeps typing. The input is the only tab stop,
 * which is what traps focus; closing gives focus back to where it was.
 *
 * It opens and filters with no animation and no debounce: every keystroke
 * re-ranks a few dozen strings synchronously. The result area has a fixed
 * height, so nothing on the page moves while typing.
 */

function ItemIcon({ item }: { item: PaletteItem }) {
  if (item.section === "actions") return null;
  const size = 15;
  if (item.icon === "search") return <Search size={size} aria-hidden="true" />;
  if (item.icon === "ask") return <Sparkles size={size} aria-hidden="true" />;
  if (item.icon === "mailbox") return <Mailbox size={size} aria-hidden="true" />;
  const Cmp = (item.icon && FOLDER_ROLE_ICON[item.icon]) || Folder;
  return <Cmp size={size} aria-hidden="true" />;
}

export default function CommandPalette() {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const uid = useId();
  const listId = `${uid}-list`;
  const optionId = (i: number) => `${uid}-opt-${i}`;

  // What was typed (and what had focus) while this chunk was still loading.
  const [pending] = useState(takePending);
  const [query, setQuery] = useState(pending.query);
  const [active, setActive] = useState(0);

  const scope = useSelectionStore((x) => x.scope);
  const { data: inboxes } = useInboxes();
  const { folders } = useFolders(scope);

  // What applies is decided once, when the palette opens: the mail state
  // cannot change underneath a modal the user is typing in.
  const actions = useMemo(() => actionItems(paletteActions(), (k) => shortcutKeys(k)[0] ?? ""), []);
  const gotos = useMemo(() => gotoItems(inboxes ?? [], folders), [inboxes, folders]);
  const sections = useMemo(() => buildSections(query, actions, gotos), [query, actions, gotos]);
  const items = useMemo(() => flatten(sections), [sections]);
  const current = Math.min(active, Math.max(0, items.length - 1));

  useModalFocus(rootRef, inputRef, pending.returnTo);
  useEffect(clearPending, []);

  // Keep the highlighted row in view when moving with the keyboard.
  useLayoutEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${current}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [current, items]);

  const close = () => useUiStore.getState().setMenu(null);

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    close();
    // After the palette has unmounted and given focus back, so an action that
    // moves focus (search, the assistant) is not undone by that restore.
    setTimeout(item.run, 0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    const n = items.length;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (n) setActive((current + 1) % n);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (n) setActive((current - 1 + n) % n);
        break;
      case "Home":
        e.preventDefault();
        setActive(0);
        break;
      case "End":
        e.preventDefault();
        setActive(Math.max(0, n - 1));
        break;
      case "PageDown":
        e.preventDefault();
        setActive(Math.min(n - 1, current + 8));
        break;
      case "PageUp":
        e.preventDefault();
        setActive(Math.max(0, current - 8));
        break;
      case "Enter":
        e.preventDefault();
        choose(items[current]);
        break;
      case "Tab":
        // The input is the only tab stop: Tab stays put.
        e.preventDefault();
        break;
      // Escape is handled by the global Esc ladder (it closes the open menu).
    }
  };

  let index = -1;

  return (
    <>
      <div className={s.scrim} onPointerDown={close} aria-hidden="true" />
      <div ref={rootRef} role="dialog" aria-modal="true" aria-label="Command palette" className={s.palette} onKeyDown={onKeyDown}>
        <div className={s.inputRow}>
          <Search size={16} aria-hidden="true" className={s.inputIcon} />
          <input
            ref={inputRef}
            className={s.input}
            type="text"
            role="combobox"
            aria-label="Command, folder, search or question"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={items.length ? optionId(current) : undefined}
            placeholder="Type a command, a folder, or a question"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="go"
            value={query}
            onChange={(e) => {
              setQuery(e.currentTarget.value);
              setActive(0);
            }}
          />
          <Kbd>Esc</Kbd>
        </div>

        <div ref={listRef} id={listId} role="listbox" aria-label="Results" className={s.results} data-scroller="">
          {sections.map((section) => {
            const headingId = `${uid}-h-${section.id}`;
            return (
              <div key={section.id} role="group" aria-labelledby={headingId} className={s.section}>
                <div id={headingId} className={s.sectionLabel}>
                  {SECTION_LABEL[section.id]}
                </div>
                {section.items.map((item) => {
                  index += 1;
                  const i = index;
                  return (
                    <div
                      key={item.id}
                      id={optionId(i)}
                      data-index={i}
                      role="option"
                      aria-selected={i === current}
                      className={cx(s.row, i === current && s.rowActive)}
                      // Keep focus in the input: a mouse press must not blur it.
                      onMouseDown={(e) => e.preventDefault()}
                      onPointerMove={() => {
                        if (i !== current) setActive(i);
                      }}
                      onClick={() => choose(item)}
                    >
                      <span className={s.rowIcon}>
                        <ItemIcon item={item} />
                      </span>
                      <span className={s.rowLabel}>{item.label}</span>
                      {item.hint ? item.hintIsKey ? <Kbd>{item.hint}</Kbd> : <span className={s.rowCount}>{item.hint}</span> : null}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div className={s.foot} aria-hidden="true">
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> to move
          </span>
          <span>
            <Kbd>Enter</Kbd> to run
          </span>
          <span className={s.footSpacer} />
          <span>
            <Kbd>{shortcutHint("palette")}</Kbd> to close
          </span>
        </div>
      </div>
    </>
  );
}
