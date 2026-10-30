/**
 * SupportHelpLink: the "Help & support" link to /help on the error pages
 * (app/error.js, app/not-found.js, app/global-error.js).
 *
 * No next-intl here on purpose: global-error.js replaces the root layout and
 * has no providers, so the label comes in as a prop (English by default, which
 * matches the English-only error pages). `LinkComponent` lets a caller pass a
 * locale-aware Link instead of a plain anchor.
 */

export function SupportHelpLink({
  href = '/help',
  label = 'Help & support',
  className,
  style,
  LinkComponent = 'a',
}) {
  return (
    <LinkComponent href={href} className={className} style={style}>
      {label}
    </LinkComponent>
  );
}

export default SupportHelpLink;
