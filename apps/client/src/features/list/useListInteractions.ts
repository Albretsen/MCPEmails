import { type MouseEvent, type PointerEvent, type TouchEvent, useEffect, useMemo, useRef } from "react";
import type { MessageKey, MessageRow } from "../../api/types";
import type { PrefetchHandlers } from "../../data";
import { conversationKeys, conversationStarred, mailActions } from "../../data";
import { useLatest } from "../../lib/hooks";
import { getPlatform } from "../../platform";
import { revealAssistant, useAssistantStore } from "../../state/assistant-store";
import { useSelectionStore } from "../../state/selection-store";
import { canWrite, refuseWrite } from "../../state/permissions";
import { openRow } from "./open-row";
import { type SwipeAllowed, swipeAllowed, swipeArmed, swipeDirection, swipeIntent, swipeOffset, swipeOutcome, swipeVelocity } from "./swipe";

/* Every pointer, touch and click on the list is handled HERE, by delegation
 * from the scroller, so rows carry no handlers of their own (they stay cheap
 * to render and the handlers are stable for the life of the pane).
 *
 * Rows mark themselves with data-row="<key>"; the small controls inside a row
 * with data-act="check" | "star" | "trace"; the part that slides with
 * data-body. */

export const LONG_PRESS_MS = 450;
/** Finger travel (px) that cancels a long press. */
const LONG_PRESS_SLOP = 8;
const SETTLE_MS = 160;
const COMMIT_MS = 120;

interface Gesture {
  key: MessageKey;
  rowEl: HTMLElement;
  body: HTMLElement | null;
  x0: number;
  y0: number;
  width: number;
  allowed: SwipeAllowed;
  intent: "horizontal" | "vertical" | null;
  dx: number;
  /** Two samples for the release velocity. */
  px: number;
  pt: number;
  lx: number;
  lt: number;
}

export interface ListInteractionOptions {
  getRow: (key: MessageKey) => MessageRow | undefined;
  prefetch: PrefetchHandlers;
  /** Phone layout: taps open, long-press ticks, rows swipe. */
  phone: boolean;
  /** The single row ticked before a second one makes it a multi-selection. */
  anchor: MessageKey | null;
  setAnchor: (key: MessageKey | null) => void;
}

export interface ListInteractions {
  handlers: {
    onPointerDown: (e: PointerEvent<HTMLElement>) => void;
    onPointerUp: () => void;
    onPointerOver: (e: PointerEvent<HTMLElement>) => void;
    onPointerLeave: () => void;
    onClick: (e: MouseEvent<HTMLElement>) => void;
    onTouchStart: (e: TouchEvent<HTMLElement>) => void;
    onTouchMove: (e: TouchEvent<HTMLElement>) => void;
    onTouchEnd: () => void;
    onTouchCancel: () => void;
  };
  /** The key last selected with the pointer (the list must not scroll to it). */
  pointerSelected: { current: MessageKey | null };
}

const rowOf = (target: EventTarget | null): HTMLElement | null =>
  target instanceof Element ? target.closest<HTMLElement>("[data-row]") : null;
const actOf = (target: EventTarget | null): string | null =>
  target instanceof Element ? (target.closest<HTMLElement>("[data-act]")?.dataset.act ?? null) : null;
const keyOf = (el: HTMLElement | null): MessageKey | null => (el?.dataset.row as MessageKey | undefined) ?? null;

const reducedMotion = (): boolean =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Opens the assistant on the call that touched a row. */
function showCall(call_id: string): void {
  useAssistantStore.getState().setLinkCall(call_id);
  revealAssistant();
  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-call="${CSS.escape(call_id)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  });
}

const traceOf = (key: MessageKey) => {
  const a = useAssistantStore.getState();
  return a.aiTouch[key] ?? a.lastTrace[key];
};

export function useListInteractions(options: ListInteractionOptions): ListInteractions {
  const opts = useLatest(options);
  const pointerSelected = useRef<MessageKey | null>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending) clearTimeout(t);
      pending.clear();
    };
  }, []);

  const handlers = useMemo(() => {
    /** Row whose pointerdown already did the work: its click is ignored. */
    let downKey: MessageKey | null = null;
    let hoverKey: MessageKey | null = null;
    let gesture: Gesture | null = null;
    let longPress: ReturnType<typeof setTimeout> | null = null;
    /** The touch ended in a long press or a swipe: swallow the click that follows. */
    let swallowClick = false;

    const later = (fn: () => void, ms: number) => {
      const t = setTimeout(() => {
        timers.current.delete(t);
        fn();
      }, ms);
      timers.current.add(t);
    };

    /** Ticks a row for the assistant. The selection store only holds two or
     *  more ticked rows, so the first tick is kept here as the anchor. */
    const tick = (key: MessageKey) => {
      const o = opts.current;
      const sel = useSelectionStore.getState();
      if (sel.multiSel.length > 1) {
        sel.toggleMulti(key);
        return;
      }
      const base = o.anchor ?? (o.phone ? null : sel.selectedKey);
      if (base == null) o.setAnchor(key);
      else if (base === key) o.setAnchor(null);
      else {
        useSelectionStore.setState({ multiSel: [base, key], ctxOff: false });
        o.setAnchor(null);
      }
    };

    const open = (key: MessageKey) => {
      const o = opts.current;
      const row = o.getRow(key);
      if (!row) return;
      if (o.anchor) o.setAnchor(null);
      openRow(row);
    };

    const ticking = () => opts.current.anchor != null || useSelectionStore.getState().multiSel.length > 1;

    const act = (name: string, key: MessageKey) => {
      if (name === "check") tick(key);
      else if (name === "star") {
        if (refuseWrite()) return;
        // The star of a conversation row is the conversation's.
        if (opts.current.getRow(key)) void mailActions.star(conversationKeys(key), !conversationStarred(key));
      } else if (name === "trace") {
        const trace = traceOf(key);
        if (trace) showCall(trace.call_id);
      }
    };

    const cancelLongPress = () => {
      if (longPress) clearTimeout(longPress);
      longPress = null;
    };

    const clearSwipe = (g: Gesture) => {
      if (g.body) g.body.style.transform = "";
      delete g.rowEl.dataset.swipe;
      delete g.rowEl.dataset.dir;
      delete g.rowEl.dataset.armed;
    };

    const endGesture = (cancelled: boolean) => {
      cancelLongPress();
      const g = gesture;
      gesture = null;
      if (!g || g.intent !== "horizontal") return;
      swallowClick = true;
      later(() => {
        swallowClick = false;
      }, 400);
      const { body, rowEl, key, width } = g;
      const stale = performance.now() - g.lt > 100;
      const velocity = stale ? 0 : swipeVelocity(g.px, g.pt, g.lx, g.lt);
      const action = cancelled ? null : swipeOutcome(g.dx, width, velocity, g.allowed);
      if (!action) {
        // Spring back.
        rowEl.dataset.swipe = "settle";
        if (body) body.style.transform = "translateX(0)";
        later(() => clearSwipe(g), SETTLE_MS + 20);
        return;
      }
      getPlatform().haptics.tick();
      const run = () => {
        if (!canWrite()) return;
        const all = conversationKeys(key);
        void (action === "archive" ? mailActions.archive(all) : mailActions.trash(all));
        // The row normally unmounts with the cache write. If it stays (the
        // action did not remove it from this list), put it back.
        later(() => {
          if (rowEl.isConnected) clearSwipe(g);
        }, 250);
      };
      if (reducedMotion()) {
        run();
        return;
      }
      rowEl.dataset.swipe = "commit";
      rowEl.dataset.armed = "";
      if (body) body.style.transform = `translateX(${action === "archive" ? width : -width}px)`;
      later(run, COMMIT_MS);
    };

    return {
      /* Mouse: select on pointerdown, a frame earlier than click would. */
      onPointerDown: (e: PointerEvent<HTMLElement>) => {
        downKey = null;
        if (e.pointerType !== "mouse" || e.button !== 0) return;
        if (actOf(e.target)) return; // star / tick / trace act on click
        const key = keyOf(rowOf(e.target));
        if (!key) return;
        downKey = key;
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
          // No text selection, but the listbox still takes focus.
          e.preventDefault();
          e.currentTarget.focus({ preventScroll: true });
          tick(key);
        } else {
          pointerSelected.current = key;
          open(key);
        }
      },
      onPointerUp: () => {
        // Cleared after the click that belongs to this press has been seen.
        if (downKey) later(() => (downKey = null), 0);
      },

      /* Click: the small controls, plus touch, pen, keyboard and assistive tech. */
      onClick: (e: MouseEvent<HTMLElement>) => {
        const key = keyOf(rowOf(e.target));
        if (!key) return;
        const name = actOf(e.target);
        if (name) {
          e.stopPropagation();
          if (!swallowClick) act(name, key);
          return;
        }
        if (downKey === key) {
          downKey = null;
          return;
        }
        if (swallowClick) {
          swallowClick = false;
          return;
        }
        if (ticking()) tick(key);
        else {
          pointerSelected.current = key;
          open(key);
        }
      },

      /* Hover intent: prefetch the body, light up the call that touched the row. */
      onPointerOver: (e: PointerEvent<HTMLElement>) => {
        if (e.pointerType !== "mouse") return;
        const key = keyOf(rowOf(e.target));
        if (key === hoverKey) return;
        hoverKey = key;
        const o = opts.current;
        if (!key) {
          o.prefetch.onIntentEnd();
          useAssistantStore.getState().setLinkCall(null);
          return;
        }
        o.prefetch.onIntent(key);
        useAssistantStore.getState().setLinkCall(traceOf(key)?.call_id ?? null);
      },
      onPointerLeave: () => {
        if (hoverKey == null) return;
        hoverKey = null;
        opts.current.prefetch.onIntentEnd();
        useAssistantStore.getState().setLinkCall(null);
      },

      /* Touch: prefetch at once, long-press to tick, swipe to archive / trash. */
      onTouchStart: (e: TouchEvent<HTMLElement>) => {
        cancelLongPress();
        if (gesture) endGesture(true);
        swallowClick = false;
        const t = e.touches[0];
        const rowEl = rowOf(e.target);
        const key = keyOf(rowEl);
        if (!t || !rowEl || !key || e.touches.length > 1) return;
        const o = opts.current;
        o.prefetch.onTouch(key);
        const row = o.getRow(key);
        const isGhost = !!useAssistantStore.getState().ghosts[key];
        const now = performance.now();
        gesture = {
          key,
          rowEl,
          body: rowEl.querySelector<HTMLElement>("[data-body]"),
          x0: t.clientX,
          y0: t.clientY,
          // One layout read per touch, in the handler, never during render.
          width: rowEl.offsetWidth,
          allowed: swipeAllowed(row?.folder_role ?? null, !o.phone || isGhost || ticking() || !!actOf(e.target) || !canWrite()),
          intent: null,
          dx: 0,
          px: t.clientX,
          pt: now,
          lx: t.clientX,
          lt: now,
        };
        longPress = setTimeout(() => {
          longPress = null;
          if (!gesture || gesture.key !== key || gesture.intent) return;
          swallowClick = true;
          tick(key);
          getPlatform().haptics.tick();
        }, LONG_PRESS_MS);
      },
      onTouchMove: (e: TouchEvent<HTMLElement>) => {
        const g = gesture;
        const t = e.touches[0];
        if (!g || !t) return;
        const dx = t.clientX - g.x0;
        const dy = t.clientY - g.y0;
        if (longPress && (Math.abs(dx) > LONG_PRESS_SLOP || Math.abs(dy) > LONG_PRESS_SLOP)) cancelLongPress();
        if (g.intent === "vertical") return;
        if (!g.intent) {
          const intent = swipeIntent(dx, dy);
          if (!intent) return;
          g.intent = intent;
          cancelLongPress();
          // A swipe that can do nothing in either direction is left to the browser.
          if (intent === "horizontal" && !g.allowed.archive && !g.allowed.trash) g.intent = "vertical";
          if (g.intent === "vertical") return;
        }
        const now = performance.now();
        if (now - g.pt > 40) {
          g.px = g.lx;
          g.pt = g.lt;
        }
        g.lx = t.clientX;
        g.lt = now;
        g.dx = dx;
        const dir = swipeDirection(dx);
        // Transform only: the row's content follows the finger, the action sits under it.
        if (g.body) g.body.style.transform = `translateX(${swipeOffset(dx, g.width, g.allowed)}px)`;
        g.rowEl.dataset.swipe = "drag";
        if (dir && g.allowed[dir]) g.rowEl.dataset.dir = dir;
        else delete g.rowEl.dataset.dir;
        if (swipeArmed(dx, g.width, g.allowed)) g.rowEl.dataset.armed = "";
        else delete g.rowEl.dataset.armed;
      },
      onTouchEnd: () => endGesture(false),
      onTouchCancel: () => endGesture(true),
    };
  }, [opts]);

  return { handlers, pointerSelected };
}
