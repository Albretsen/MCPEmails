import { Search } from "lucide-react";
import { Suspense, lazy, useEffect, useLayoutEffect, useRef } from "react";
import { useUiStore } from "../../state/ui-store";
import { Kbd } from "../../ui";
import { SHELL_MENU } from "../shell/shell-context";
import s from "./Palette.module.css";
import { clearPending, setPending, takePending } from "./pending";

/* Mount point for the command palette (⌘K / Ctrl+K).
 *
 * The palette itself is a separate chunk: none of it is downloaded, parsed or
 * rendered at startup. It is fetched when the browser is idle after load, so
 * the first ⌘K is already instant; if ⌘K comes sooner, a placeholder with the
 * same frame and a focused input stands in until the chunk arrives.
 * Open state is `ui.menu === "palette"`, toggled by the shortcut registry.
 */

const load = () => import("./CommandPalette");
const CommandPalette = lazy(load);

/** Shown only if ⌘K beats the chunk: the palette's frame and input, already
 *  focused, so typing never lands in the field the user came from. What is
 *  typed here is handed to the real palette (./pending.ts). */
function PalettePlaceholder() {
  const inputRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    clearPending();
    setPending({ returnTo: document.activeElement as HTMLElement | null });
    inputRef.current?.focus();
    return () => {
      // Closed before the palette arrived: give focus back from here.
      if (useUiStore.getState().menu === SHELL_MENU.palette) return;
      const { returnTo } = takePending();
      clearPending();
      if (returnTo && returnTo !== document.body && document.contains(returnTo)) returnTo.focus();
    };
  }, []);
  return (
    <>
      <div className={s.scrim} onPointerDown={() => useUiStore.getState().setMenu(null)} aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-label="Command palette" aria-busy="true" className={s.palette}>
        <div className={s.inputRow}>
          <Search size={16} aria-hidden="true" className={s.inputIcon} />
          <input
            ref={inputRef}
            className={s.input}
            type="text"
            aria-label="Command, folder, search or question"
            placeholder="Type a command, a folder, or a question"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(e) => setPending({ query: e.currentTarget.value })}
            onKeyDown={(e) => {
              if (e.key === "Tab") e.preventDefault();
            }}
          />
          <Kbd>Esc</Kbd>
        </div>
        <div className={s.results} />
      </div>
    </>
  );
}

type IdleWindow = Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number };

export function PaletteHost() {
  const open = useUiStore((u) => u.menu === SHELL_MENU.palette);

  useEffect(() => {
    const w = window as IdleWindow;
    const warm = () => void load().catch(() => {});
    if (w.requestIdleCallback) w.requestIdleCallback(warm, { timeout: 5000 });
    else setTimeout(warm, 3000);
  }, []);

  if (!open) return null;
  return (
    <Suspense fallback={<PalettePlaceholder />}>
      <CommandPalette />
    </Suspense>
  );
}

/** Opens the palette from a button. */
export function openPalette(): void {
  useUiStore.getState().setMenu(SHELL_MENU.palette);
}
