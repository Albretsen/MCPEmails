import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import type { Provider } from "../contract";
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

/**
 * A button that looks like a link.
 *
 * Exists because the redesign has three affordances that must not carry a
 * control's weight: Expand, "Cc Bcc" and "Show formatting". The last one used
 * to be a two-option segmented control, which gave a formatting preview the
 * same visual authority as Send.
 */
export function TextLink(props: {
  children: ComponentChildren;
  onClick: () => void;
  title?: string;
  tone?: "danger";
}) {
  return (
    <button
      type="button"
      class="link"
      data-tone={props.tone}
      title={props.title}
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

/**
 * Contract §5: which capability will actually be used, and what that costs the
 * user to know.
 *
 * Was a bordered, filled block with a bulleted caveat list. It is now one muted
 * line, because it is reference information that every card repeats and it was
 * taking the visual weight of a warning. `extra` is the card-specific tail (the
 * draft editor's "saving gives the draft a new id"); caveats are capped inline
 * for the same reason the block was capped before, that an inline card must
 * auto-fit without pushing its buttons off a phone screen.
 */
export function ProviderLine(props: {
  provider?: Provider;
  fullscreen: boolean;
  extra?: string | null;
  lead?: string | null;
}) {
  const p = props.provider;
  const caveats = p?.caveats ?? [];
  const parts = [
    props.lead,
    p ? (p.route ? `${p.label} · ${p.route}` : p.label) : null,
    ...(props.fullscreen ? caveats : caveats.slice(0, 1)),
    props.extra,
  ].filter((s): s is string => !!s && s.trim().length > 0);
  if (parts.length === 0) return null;
  return <p class="line">{parts.join(" · ")}</p>;
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

/**
 * The entire loading state: one pulsing line.
 *
 * It is reached for at most `RESULT_WATCHDOG_MS`, because the watchdog now ends
 * in a restored envelope or a one-line placeholder rather than in silence. The
 * old six-bar skeleton was the founder's first complaint ("the loading is super
 * ugly and far too big"), and it was doubly wrong: ~150px of grey under the
 * host's own header, for a state that in the remount case never resolved.
 */
export function Loading() {
  return (
    <div class="loading" aria-busy="true" aria-live="polite">
      Loading&#8230;
    </div>
  );
}

/**
 * A body textarea that grows to its content instead of holding a fixed block of
 * empty space.
 *
 * `maxRows` keeps an inline card auto-fitting without internal scrolling: past
 * the cap the textarea does scroll, which is the lesser evil against a card
 * that pushes the conversation's own scroll around. In fullscreen the cap is
 * lifted and the element fills the height it is given.
 */
export function AutoTextarea(props: {
  id: string;
  value: string;
  disabled?: boolean;
  maxRows: number;
  ariaLabel: string;
  onInput: (v: string) => void;
  onFocus?: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const fit = () => {
      // Measured, never assumed: the line height comes from a host variable and
      // the font from the host's stack, so a hardcoded px-per-row would be wrong
      // on exactly the hosts this is meant to look native in.
      const cs = getComputedStyle(el);
      const line = parseFloat(cs.lineHeight) || 18;
      const chrome =
        parseFloat(cs.paddingTop) +
        parseFloat(cs.paddingBottom) +
        parseFloat(cs.borderTopWidth) +
        parseFloat(cs.borderBottomWidth);
      el.style.height = "auto";
      const wanted = el.scrollHeight;
      const max = line * props.maxRows + chrome;
      el.style.height = `${Math.min(wanted, max)}px`;
      el.style.overflowY = wanted > max ? "auto" : "hidden";
    };

    fit();

    // ── Why a width observer, and not just [props.value] ──────────────────
    // How tall wrapped text is depends on how wide it is allowed to be, and in
    // this host the width is not settled when the first measurement runs. A
    // re-mounted card lays out before the host has sized its iframe, so
    // `scrollHeight` comes back as a single line, the body is pinned at ~18px,
    // and nothing ever re-measures because the value has not changed. That is
    // the sliver of clipped text the founder caught on 2026-09-16: a card that
    // "loads a broken UI" and then stays broken.
    //
    // Only WIDTH is acted on. We set height inside this callback, so reacting
    // to height would be a feedback loop; the last observed width is kept so a
    // height-only notification is a no-op.
    let lastWidth = el.clientWidth;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w === lastWidth) return;
      lastWidth = w;
      fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [props.value, props.maxRows]);

  return (
    <textarea
      id={props.id}
      ref={ref}
      class="textarea"
      rows={1}
      aria-label={props.ariaLabel}
      value={props.value}
      disabled={props.disabled}
      onInput={(e) => props.onInput((e.target as HTMLTextAreaElement).value)}
      onFocus={props.onFocus}
    />
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
