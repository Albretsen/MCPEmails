import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EMAIL_FRAME_SANDBOX, buildEmailSrcdoc } from "../../lib/sanitize-email-html";
import s from "./Reader.module.css";

/* An HTML email body in a sandboxed iframe that is as tall as its content.
 *
 * THE TRADE-OFF (read before touching `sandbox`):
 *
 * The frame has to grow to the height of the email, or the reader would have
 * a scroller inside a scroller. A fully sandboxed frame (`sandbox=""`) is a
 * unique origin: the parent cannot read its height, and without scripts the
 * frame cannot report it. Measuring the HTML in a hidden container of the app
 * document is not acceptable either: the email's inline styles would apply to
 * (and its layout could be probed against) the app itself.
 *
 * So the frame is `sandbox="allow-same-origin allow-popups
 * allow-popups-to-escape-sandbox"`, WITHOUT `allow-scripts`. What that costs
 * and why it is acceptable:
 *
 *   - allow-same-origin only matters to code running INSIDE the frame, and no
 *     code can run there: scripts are disabled by the sandbox itself (not by
 *     the sanitizer), event-handler attributes included. The combination that
 *     is dangerous is allow-same-origin + allow-scripts; that must never be
 *     added here (a test pins the flag list).
 *   - The markup is already reduced to an inert allow-list by
 *     sanitizeEmailHtml (no script, no handlers, no forms, no remote URLs
 *     except <a href> to http/https/mailto), and the document carries
 *     `default-src 'none'`, so nothing loads either.
 *   - Without allow-forms and allow-top-navigation the frame cannot submit or
 *     navigate the app. Links open a new tab (allow-popups, rel=noopener).
 *
 * What we gain: `contentDocument` is readable, so a ResizeObserver on the
 * frame's <body> keeps the height exact, and keystrokes made while the frame
 * has focus can be handed to the app's shortcut handler.
 *
 * `html` MUST be the output of sanitizeEmailHtml.
 */

export interface EmailFrameProps {
  html: string;
  title: string;
}

const MIN_HEIGHT = 40;

/** A first guess, so the page does not jump far when the real height arrives. */
function estimateHeight(html: string): number {
  // Length only: markup is counted along with the text, which is close enough
  // for a guess and avoids anything that looks like tag stripping.
  const text = html.length * 0.6;
  const blocks = (html.match(/<(p|div|tr|li|br|h[1-6])\b/gi) ?? []).length;
  return Math.max(120, Math.min(640, Math.round(text / 80) * 24 + blocks * 12));
}

export function EmailFrame({ html, title }: EmailFrameProps) {
  const ref = useRef<HTMLIFrameElement>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const [height, setHeight] = useState(() => estimateHeight(html));
  const srcDoc = useMemo(() => buildEmailSrcdoc(html), [html]);

  const attach = useCallback(() => {
    cleanup.current?.();
    cleanup.current = null;
    const frame = ref.current;
    const doc = frame?.contentDocument;
    const body = doc?.body;
    if (!frame || !doc || !body) return;

    const measure = () => {
      const root = doc.documentElement;
      // A horizontal scrollbar (wide tables) takes room inside the frame.
      const scrollbar = root.scrollWidth > root.clientWidth ? 16 : 0;
      const next = Math.max(MIN_HEIGHT, Math.ceil(Math.max(body.scrollHeight, body.offsetHeight)) + scrollbar);
      setHeight((h) => (Math.abs(h - next) > 1 ? next : h));
    };
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(body);

    // Keys pressed while the email has focus still drive the app (j/k, e, r, Esc).
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const forwarded = new KeyboardEvent("keydown", {
        key: e.key,
        code: e.code,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        repeat: e.repeat,
        bubbles: true,
        cancelable: true,
      });
      if (!frame.dispatchEvent(forwarded)) e.preventDefault();
    };
    doc.addEventListener("keydown", onKeyDown);

    cleanup.current = () => {
      ro?.disconnect();
      doc.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => () => cleanup.current?.(), []);

  return (
    <iframe
      ref={ref}
      className={s.frame}
      title={title}
      sandbox={EMAIL_FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      onLoad={attach}
      // Dynamic value: the measured content height.
      style={{ height }}
    />
  );
}
