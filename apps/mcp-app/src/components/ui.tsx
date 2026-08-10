import type { ComponentChildren, JSX } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { sanitizeEmailHtml } from "../sanitize";

type Variant = "default" | "primary" | "danger" | "quiet";

export function Btn(props: {
  children: ComponentChildren;
  onClick?: () => void;
  variant?: Variant;
  disabled?: boolean;
  busy?: boolean;
  title?: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      class="btn"
      type={props.type ?? "button"}
      data-variant={props.variant ?? "default"}
      disabled={props.disabled || props.busy}
      title={props.title}
      aria-busy={props.busy ? "true" : undefined}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export function Segmented(props: {
  label: string;
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div class="segmented" role="tablist" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={props.value === o.value}
          tabIndex={props.value === o.value ? 0 : -1}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Notice(props: {
  tone?: "default" | "danger" | "warning" | "success";
  children: ComponentChildren;
}) {
  return (
    <div class="notice" data-tone={props.tone ?? "default"} role="status">
      {props.children}
    </div>
  );
}

export function Fields(props: { rows: Array<[string, ComponentChildren]> }) {
  return (
    <dl class="fields">
      {props.rows.map(([k, v], i) => (
        <>
          <dt key={`k${i}`}>{k}</dt>
          <dd key={`v${i}`}>{v}</dd>
        </>
      ))}
    </dl>
  );
}

export function Skeleton(props: { style?: JSX.CSSProperties; h?: string }) {
  return <div class="sk" data-h={props.h} style={props.style} />;
}

export function CardSkeleton() {
  return (
    <div class="stack" aria-busy="true" aria-live="polite">
      <span class="sr-only">Loading review</span>
      <Skeleton style={{ width: "40%" }} />
      <Skeleton h="lg" style={{ width: "75%" }} />
      <Skeleton style={{ width: "90%" }} />
      <Skeleton style={{ width: "60%" }} />
      <div class="actions">
        <Skeleton h="btn" style={{ flex: "1 1 auto" }} />
        <Skeleton h="btn" style={{ flex: "1 1 auto" }} />
      </div>
    </div>
  );
}

/**
 * Renders hostile email HTML.
 *
 * The sanitizer returns a live DocumentFragment, which is adopted straight into
 * this node. There is no innerHTML and no dangerouslySetInnerHTML anywhere in
 * this app — nothing is ever serialised back to a string and re-parsed.
 */
export function HtmlBody(props: { html: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.textContent = "";
    node.appendChild(sanitizeEmailHtml(props.html).fragment);
  }, [props.html]);
  return <div class="body-full body-html" ref={ref} />;
}
