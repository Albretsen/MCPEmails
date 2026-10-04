import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

/** Subscribes to a CSS media query. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", cb);
      return () => mql.removeEventListener("change", cb);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}

/** A ref that always holds the latest value, for callbacks that must not change identity. */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

function subscribeResize(cb: () => void): () => void {
  window.addEventListener("resize", cb);
  window.visualViewport?.addEventListener("resize", cb);
  return () => {
    window.removeEventListener("resize", cb);
    window.visualViewport?.removeEventListener("resize", cb);
  };
}

/** Layout viewport width in CSS pixels. */
export function useViewportWidth(): number {
  return useSyncExternalStore(
    subscribeResize,
    () => window.innerWidth,
    () => 1440,
  );
}

/** True once `ms` has passed while `active` stayed true. Use to delay a
 *  skeleton or spinner so fast responses never flash one. */
export function useDelayedFlag(active: boolean, ms: number): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!active) {
      setOn(false);
      return;
    }
    const t = setTimeout(() => setOn(true), ms);
    return () => clearTimeout(t);
  }, [active, ms]);
  return active && on;
}

/** `value`, once it has stayed the same for `ms`. A value for which `atOnce`
 *  is true passes immediately (clearing a search must not wait). Use for
 *  input that causes requests: `useDeferredValue` only postpones rendering, so
 *  every keystroke would still be asked of the server. */
export function useDebouncedValue<T>(value: T, ms: number, atOnce?: (value: T) => boolean): T {
  const [settled, setSettled] = useState(value);
  const immediate = atOnce?.(value) ?? false;
  useEffect(() => {
    if (immediate) {
      setSettled(value);
      return;
    }
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms, immediate]);
  return immediate ? value : settled;
}

/** True once `value` has stayed the same for `ms`; false again the moment it
 *  changes (also when it changes back: the wait starts over). Use to hold a
 *  request back while the person is still moving. */
export function useRested<T>(value: T, ms: number): boolean {
  const [rested, setRested] = useState<{ value: T } | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setRested({ value }), ms);
    return () => {
      clearTimeout(t);
      setRested(null);
    };
  }, [value, ms]);
  return rested !== null && Object.is(rested.value, value);
}
