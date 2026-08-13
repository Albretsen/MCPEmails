/**
 * InfoDot: a question mark that reveals an explanation on hover or focus.
 *
 * This page carries a lot of definitional weight. "Active workspace", "value
 * activation", "one and done" and "comped" all mean something specific, and
 * getting one of them wrong leads to a wrong decision. Printing every caveat
 * as body text made the page a wall of prose that nobody reads twice, so the
 * explanations moved in here: available at the moment of doubt, invisible the
 * rest of the time.
 *
 * No JavaScript. The tooltip is a sibling element shown by `:hover` and
 * `:focus-within` on the wrapper. The trigger is a real `<button>` so it is
 * keyboard reachable, and the panel is linked with `aria-describedby` so a
 * screen reader gets the text without needing the hover at all.
 *
 * `align="end"` pins the panel to the right edge, for triggers near the right
 * of the viewport where a left-aligned panel would overflow the page.
 */

/** `Active days` to `active-days`. Keeps generated ids readable and stable. */
function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'info';
}

export function InfoDot({
  label,
  children,
  align = 'start',
  id,
}: {
  /** What the explanation is about, used for the accessible name. */
  label: string;
  children: React.ReactNode;
  align?: 'start' | 'end';
  /** Override when two dots on one page would otherwise share a label. */
  id?: string;
}) {
  // Derived from the label rather than a counter: a module-level counter is
  // mutable state shared across concurrent renders, and these components are
  // server-rendered into a streaming response where render order is not
  // something to rely on. Two dots with the same label would share an id,
  // which costs a duplicate `aria-describedby` target and nothing else.
  const describedBy = id ?? `growth-info-${slugify(label)}`;
  return (
    <span className={`growth-info growth-info-${align}`}>
      <button type="button" className="growth-info-dot" aria-label={`About ${label}`} aria-describedby={describedBy}>
        ?
      </button>
      <span role="tooltip" id={describedBy} className="growth-info-panel">
        {children}
      </span>
    </span>
  );
}

/**
 * A section heading with its explanation tucked behind the dot.
 *
 * Replaces the `<h2>` plus paragraph pattern the page used everywhere, which
 * cost four lines of prose per section before a single number appeared.
 */
export function SectionHeading({
  title,
  children,
  aside,
}: {
  title: string;
  /** The explanation. Goes in the tooltip, not on the page. */
  children: React.ReactNode;
  /** Rare short text that genuinely has to stay visible, such as a warning. */
  aside?: React.ReactNode;
}) {
  return (
    <div className="growth-heading">
      <h2>{title}</h2>
      <InfoDot label={title}>{children}</InfoDot>
      {aside && <span className="growth-heading-aside">{aside}</span>}
    </div>
  );
}
