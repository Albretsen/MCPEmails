import {
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cx } from "../../lib/cx";
import { useViewportWidth } from "../../lib/hooks";
import { useAssistantStore } from "../../state/assistant-store";
import { useComposeStore } from "../../state/compose-store";
import { isOpenInReader, useThreadStore } from "../../state/conversation-store";
import { useSelectionStore } from "../../state/selection-store";
import { type PaneKind, useUiStore } from "../../state/ui-store";
import { LogoMark, Spinner, ToastHost } from "../../ui";
import s from "./AppShell.module.css";
import { HelpDialog } from "./HelpDialog";
import { NotificationSettings } from "./NotificationSettings";
import { InstallPrompt } from "./InstallPrompt";
import { Splitter } from "./Splitter";
import { KeyHint, OfflineIndicator, ShellEffects } from "./effects";
import { LAYOUT, type SplitterKind, clampPaneWidth, computeLayout, stepPaneWidth } from "./layout";
import { PANE_ID, SHELL_MENU, ShellContext, type ShellInfo, focusPane } from "./shell-context";
import { shortcutAria, shortcutHint, useGlobalShortcuts } from "./shortcuts";

export interface AppShellProps {
  /** Pane slots. Each is rendered inside its landmark; the shell owns the
   *  frame (widths, splitters, phone switching), the panes own their content. */
  sidebar: ReactNode;
  list: ReactNode;
  /** Shown in <main> when an email is open or nothing is. Renders a reply
   *  inline under the email itself. */
  reader: ReactNode;
  /** Shown in <main> instead of the reader for a new message / forward. */
  compose: ReactNode;
  assistant: ReactNode;
  /** Anything that floats above the app (push notice, command palette, dev menus). */
  overlays?: ReactNode;
}

const SHRINK_MS = 170;

interface SplitterOptions {
  invert?: boolean;
  onToggle?: () => void;
  toggleHint?: string;
}

export function AppShell({ sidebar, list, reader, compose, assistant, overlays }: AppShellProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const vw = useViewportWidth();

  const sideW = useUiStore((u) => u.sideW);
  const listW = useUiStore((u) => u.listW);
  const panelW = useUiStore((u) => u.panelW);
  const panelOpen = useUiStore((u) => u.panelOpen);
  const panelForced = useUiStore((u) => u.panelForced);
  const screen = useUiStore((u) => u.screen);
  const chatFull = useUiStore((u) => u.chatFull);
  const setPaneWidth = useUiStore((u) => u.setPaneWidth);
  const resetLayout = useUiStore((u) => u.resetLayout);

  // The slots are stable elements, so re-rendering the frame on a selection
  // change costs nothing below it.
  const selectedKey = useSelectionStore((x) => x.selectedKey);
  const hasSelection = selectedKey != null;
  // Primitive selectors: typing in the editor must not re-render the frame.
  const hasCompose = useComposeStore((x) => x.compose != null);
  const composeReplyTo = useComposeStore((x) => x.compose?.replyTo ?? null);
  // A reply sits inline under its email; anything else takes over <main>.
  // A reply to any message of the open conversation is written under it.
  // (The thread's messages are subscribed to so this follows them.)
  useThreadStore((t) => t.order);
  const fullCompose = hasCompose && !(composeReplyTo != null && isOpenInReader(composeReplyTo, selectedKey));

  const busy = useAssistantStore((a) => a.busy);
  const helpOpen = useUiStore((u) => u.menu === SHELL_MENU.help);
  const notificationsOpen = useUiStore((u) => u.menu === SHELL_MENU.notifications);

  const layout = useMemo(
    () => computeLayout(vw, { sideW, listW, panelW }, { panelOpen, panelForced, hasSelection }),
    [vw, sideW, listW, panelW, panelOpen, panelForced, hasSelection],
  );
  const { phone } = layout;

  // The viewport class lives in the store so non-React code can branch on it.
  useEffect(() => {
    useUiStore.getState().setViewport(phone ? "phone" : "desktop");
  }, [phone]);

  useGlobalShortcuts();

  /* Pane widths are CSS variables on the root. Written imperatively (not via
   * the style prop) because splitters also write them, per frame, mid-drag. */
  const applyVars = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    el.style.setProperty("--side-w", `${layout.side}px`);
    el.style.setProperty("--list-w", `${layout.list}px`);
    el.style.setProperty("--panel-w", `${layout.panel}px`);
  }, [layout.side, layout.list, layout.panel]);
  useLayoutEffect(applyVars, [applyVars]);

  /* Phone: keep the shell exactly over the VISUAL viewport, so the assistant's
   * composer stays above the on-screen keyboard. iOS neither resizes the
   * layout viewport for the keyboard nor keeps it still (it scrolls it), hence
   * the offset as well as the height. */
  useEffect(() => {
    const el = rootRef.current;
    const vv = window.visualViewport;
    if (!el || !vv || !phone) return;
    const sync = () => {
      el.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
      el.style.setProperty("--vvt", `${Math.max(0, Math.round(vv.offsetTop))}px`);
    };
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
      el.style.removeProperty("--vvh");
      el.style.removeProperty("--vvt");
    };
  }, [phone]);

  /* Phone: the dock grows to full screen and shrinks back. The shrink plays
   * before the full-screen layer is removed. */
  const [fullShown, setFullShown] = useState(chatFull);
  const shrinking = fullShown && !chatFull;
  useEffect(() => {
    if (chatFull) {
      setFullShown(true);
      return;
    }
    if (!fullShown) return;
    const t = setTimeout(() => setFullShown(false), SHRINK_MS);
    return () => clearTimeout(t);
  }, [chatFull, fullShown]);

  /* Enter on a splitter collapses or restores its pane. The sidebar collapses
   * to the icon rail and comes back at the width it had. */
  const lastSideW = useRef<number | null>(null);
  const stripRef = useRef<HTMLButtonElement>(null);
  const toggleSidebar = () => {
    if (layout.rail) setPaneWidth("side", lastSideW.current ?? LAYOUT.SIDE_DEFAULT);
    else {
      lastSideW.current = layout.side;
      setPaneWidth("side", LAYOUT.SIDE_RAIL);
    }
  };
  const collapsePanel = () => {
    useUiStore.getState().setPanelOpen(false);
    // The splitter goes away with the panel: hand focus to the strip button
    // that replaces it, where Enter restores the panel.
    setTimeout(() => stripRef.current?.focus(), 0);
  };

  const splitter = (kind: SplitterKind, label: string, controls: string, cssVar: string, opts: SplitterOptions = {}) => {
    const value = kind === "side" ? layout.side : kind === "list" ? layout.list : layout.panel;
    return (
      <Splitter
        label={label}
        controls={controls}
        value={value}
        min={layout.bounds[kind].min}
        max={layout.bounds[kind].max}
        invert={opts.invert}
        rootRef={rootRef}
        cssVar={cssVar}
        clamp={(raw) => clampPaneWidth(kind, raw, layout)}
        step={(dir) => stepPaneWidth(kind, value, dir, layout)}
        onCommit={(w) => setPaneWidth(kind as PaneKind, w)}
        onReset={() => resetLayout([kind as PaneKind])}
        onToggle={opts.onToggle}
        toggleHint={opts.toggleHint}
        onDragEnd={applyVars}
      />
    );
  };

  const onListEnter = (e: PointerEvent) => {
    if (e.pointerType === "mouse") useUiStore.getState().setListHover(true);
  };
  const onListLeave = () => useUiStore.getState().setListHover(false);

  const info = useMemo<ShellInfo>(
    () => ({
      layout,
      phone,
      rail: layout.rail,
      toolbarLabels: layout.toolbarLabels,
      assistantWidth: phone ? vw : layout.panel,
    }),
    [layout, phone, vw],
  );

  /* Phone shows one screen at a time. The list stays MOUNTED under the reader
   * (hidden and inert), so Back returns to it at once with its scroll position
   * and virtual window exactly as they were. */
  const listHidden = phone && screen !== "list";
  const showMain = !phone || screen !== "list";
  const phoneFull = phone && fullShown;

  const onStrip = () => {
    const ui = useUiStore.getState();
    if (layout.panelSqueezed) ui.forcePanel();
    else ui.togglePanel();
  };

  const onSkip = (e: MouseEvent<HTMLAnchorElement>) => {
    // Not a real hash navigation: that would add a history entry.
    e.preventDefault();
    focusPane(listHidden ? PANE_ID.reader : PANE_ID.list);
  };

  return (
    <ShellContext.Provider value={info}>
      <div ref={rootRef} className={cx(s.shell, phone && s.phone)}>
        <a className={s.skipLink} href={`#${PANE_ID.list}`} onClick={onSkip}>
          Skip to messages
        </a>
        <ShellEffects />

        {!phone ? (
          <>
            <nav id={PANE_ID.sidebar} tabIndex={-1} aria-label="Mailboxes and folders" className={cx(s.pane, s.sidebar)}>
              {sidebar}
            </nav>
            {splitter("side", "Resize sidebar", PANE_ID.sidebar, "--side-w", {
              onToggle: toggleSidebar,
              toggleHint: layout.rail ? "expand the sidebar" : "collapse the sidebar",
            })}
          </>
        ) : null}

        <section
          id={PANE_ID.list}
          tabIndex={-1}
          aria-label="Messages"
          aria-hidden={listHidden || undefined}
          inert={listHidden}
          className={cx(s.pane, s.list, listHidden && s.paneHidden)}
          onPointerEnter={onListEnter}
          onPointerLeave={onListLeave}
        >
          {list}
        </section>
        {!phone ? splitter("list", "Resize message list", PANE_ID.list, "--list-w") : null}

        {showMain ? (
          <main id={PANE_ID.reader} tabIndex={-1} aria-label={fullCompose ? "New message" : "Email"} className={cx(s.pane, s.main)}>
            {fullCompose ? compose : reader}
            {!phone ? <InstallPrompt /> : null}
          </main>
        ) : null}

        {phone && !listHidden && !phoneFull ? <InstallPrompt /> : null}

        {layout.panelStrip ? (
          <aside className={s.strip} aria-label="Assistant (collapsed)">
            <button
              ref={stripRef}
              type="button"
              className={s.stripButton}
              onClick={onStrip}
              title={`Show assistant (${shortcutHint("assistant")})`}
              aria-label="Show assistant"
              aria-keyshortcuts={shortcutAria("assistant")}
            >
              <LogoMark size={22} />
            </button>
            {busy ? <Spinner label="Assistant is working" /> : null}
          </aside>
        ) : null}

        {layout.panelShown ? (
          <>
            {!phone
              ? splitter("panel", "Resize assistant", PANE_ID.assistant, "--panel-w", {
                  invert: true,
                  onToggle: collapsePanel,
                  toggleHint: "collapse the assistant",
                })
              : null}
            <aside
              id={PANE_ID.assistant}
              tabIndex={-1}
              aria-label="Assistant"
              className={cx(s.pane, s.panel, phoneFull && s.panelFull, phone && shrinking && s.panelShrinking)}
            >
              {assistant}
            </aside>
          </>
        ) : null}

        <OfflineIndicator />
        <KeyHint />
        {helpOpen ? <HelpDialog /> : null}
        {notificationsOpen ? <NotificationSettings /> : null}
        {/* Phone: a zero-height slot at the bottom of the list / reader row, so
            the toast sits above the dock (and the notice) whatever their height. */}
        <div className={cx(s.toastSlot, phone && showMain && s.toastSlotReader)}>
          <ToastHost />
        </div>
        {overlays}
      </div>
    </ShellContext.Provider>
  );
}
