/**
 * A visibly dead panel.
 *
 * A failed read must degrade to something that says so, never to a missing
 * card. A gap in a grid reads as a zero, and a zero beside revenue sends
 * somebody off to investigate a query timeout as though it were a collapse in
 * demand. The raw Supabase or Stripe message is printed rather than a polite
 * apology because this page is operator-only, and "something went wrong" just
 * costs whoever reads it a debugging session.
 */

export function Dead({ what, error }: { what: string; error: string }) {
  return (
    <p className="bd-dead" role="status">
      <b>{what} could not be read</b>
      <span>{error}</span>
    </p>
  );
}
