'use client';

import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { Icon } from '../Primitives';

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Auto-dismiss duration per variant in milliseconds.
 * 0 means the toast never auto-dismisses; the user must close it explicitly.
 */
const DEFAULT_DURATION = {
  success: 4000,
  error:   0,       // errors must be acknowledged
  info:    5000,
  warning: 6000,
};

/** Dashboard Icon name per toast variant. */
const VARIANT_ICON = {
  success: 'check',
  error:   'x',
  info:    'bell',
  warning: 'zap',
};

// ─── Context ─────────────────────────────────────────────────────────────────

const ToastContext = createContext(null);

// ─── Provider ────────────────────────────────────────────────────────────────

/**
 * ToastProvider: must wrap the dashboard root.
 * Renders the ToastContainer (fixed, bottom-right) alongside its children.
 */
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  /**
   * timers: { [id: string]: ReturnType<typeof setTimeout> }
   *
   * Held in a ref so timer IDs persist across re-renders without causing
   * extra renders themselves. Pause/resume on hover mutates this object.
   */
  const timers = useRef({});

  /** Immediately remove a toast by ID. */
  const dismiss = useCallback((id) => {
    clearTimeout(timers.current[id]);
    delete timers.current[id];
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  /** Remove all toasts at once. */
  const dismissAll = useCallback(() => {
    Object.values(timers.current).forEach(clearTimeout);
    timers.current = {};
    setToasts([]);
  }, []);

  /**
   * Show a toast. Returns the toast ID so it can be dismissed programmatically.
   *
   * @param {object} options
   * @param {string}   options.message  - Display text. Plain English; no error codes.
   * @param {string}   options.variant  - 'success' | 'error' | 'info' | 'warning'
   * @param {number}  [options.duration] - Override auto-dismiss duration (ms). 0 = never.
   * @param {object}  [options.action]  - Optional { label: string, onClick: () => void }
   */
  const toast = useCallback(
    ({ message, variant = 'info', duration, action }) => {
      const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const ms = duration !== undefined ? duration : (DEFAULT_DURATION[variant] ?? 5000);

      setToasts((ts) => {
        const next = [...ts, { id, message, variant, action, ms }];
        // Maximum 3 toasts visible simultaneously.
        // Evict the oldest if we'd exceed the cap.
        if (next.length > 3) {
          const [evicted, ...rest] = next;
          clearTimeout(timers.current[evicted.id]);
          delete timers.current[evicted.id];
          return rest;
        }
        return next;
      });

      if (ms > 0) {
        timers.current[id] = setTimeout(() => dismiss(id), ms);
      }

      return id;
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ toast, dismiss, dismissAll }}>
      {children}
      <ToastContainer toasts={toasts} dismiss={dismiss} timers={timers} />
    </ToastContext.Provider>
  );
}

// ─── Hook ────────────────────────────────────────────────────────────────────

/**
 * useToast: returns { toast, dismiss, dismissAll }.
 * Must be called inside a component rendered within <ToastProvider>.
 */
export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be called inside <ToastProvider>');
  }
  return ctx;
}

// ─── Container ───────────────────────────────────────────────────────────────

function ToastContainer({ toasts, dismiss, timers }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" aria-label="Notifications">
      {toasts.map((t) => (
        <ToastItem key={t.id} t={t} dismiss={dismiss} timers={timers} />
      ))}
    </div>
  );
}

// ─── Individual toast ────────────────────────────────────────────────────────

function ToastItem({ t, dismiss, timers }) {
  const { id, message, variant, action, ms } = t;

  /**
   * Pause the dismiss countdown while the user hovers over the toast.
   * This prevents toasts from disappearing mid-read.
   */
  const handleMouseEnter = () => {
    if (timers.current[id]) {
      clearTimeout(timers.current[id]);
      delete timers.current[id];
    }
  };

  /**
   * Resume the dismiss countdown when the user stops hovering.
   * We restart with the original duration. A full reset is intentional
   * so the user always has the full window after moving away.
   */
  const handleMouseLeave = () => {
    if (ms > 0 && !timers.current[id]) {
      timers.current[id] = setTimeout(() => dismiss(id), ms);
    }
  };

  return (
    <div
      className={`toast toast-${variant}`}
      role={variant === 'error' ? 'alert' : 'status'}
      aria-live={variant === 'error' ? 'assertive' : 'polite'}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="toast-icon" aria-hidden="true">
        <Icon name={VARIANT_ICON[variant]} size={14} />
      </div>

      <span className="toast-msg">{message}</span>

      {action && (
        <button className="toast-action" onClick={action.onClick} type="button">
          {action.label}
        </button>
      )}

      <button
        className="toast-close"
        onClick={() => dismiss(id)}
        aria-label="Dismiss notification"
        type="button"
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}
