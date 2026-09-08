/**
 * The only ports a mail host may be dialled on.
 *
 * ── Why this is its own file ────────────────────────────────────────────────
 *
 * This list was born inside `host-guard.ts` and is still the same policy it has
 * always been. It moved out because the CONNECT FORM has to offer exactly these
 * ports and nothing else, and the form is a client component: importing
 * host-guard from the browser would pull `node:dns` into the client bundle,
 * which does not build.
 *
 * The alternative was a second copy of the numbers in the form, which is the
 * bug that was actually shipped: the client's port field promised 1 to 65535
 * (and said so in `connect.errorPortRange`), the server accepted five ports,
 * and a user who typed 2525 passed every check the browser made, waited out a
 * full IMAP-then-SMTP verification, and was answered with a refusal the modal
 * had no string for. One list, imported by both sides, is what stops that from
 * coming back.
 *
 * `host-guard.ts` re-exports both symbols, so every existing import of them
 * from there still resolves and the guard's own rule 4 is unchanged.
 *
 * ── The mirror ──────────────────────────────────────────────────────────────
 *
 * A line-for-line Deno mirror of the host policy lives at
 * `supabase/functions/mcp-server/host-guard.ts` and carries its own copy of
 * this table (the two runtimes cannot share a module). A change to the values
 * below MUST be made there in the same commit. Splitting the Node side into two
 * files does not change the policy, only where it is declared.
 *
 * ── The values ──────────────────────────────────────────────────────────────
 *
 * IMAP: 993 implicit TLS, 143 STARTTLS.
 * SMTP: 465 implicit TLS, 587 submission STARTTLS, 25 legacy submission (kept
 * because a handful of small hosts still only offer it, and because
 * transport-autodetect tries it).
 *
 * Anything else is refused. A user with a genuinely non-standard mail port is a
 * support ticket; an unrestricted port field is an internal port scanner.
 * Verified against production before it was narrowed: of 216 live inboxes,
 * every IMAP row is on 993 and every SMTP row is on 465 or 587.
 *
 * Dependency-free on purpose, like the guard it came out of: no node built-ins
 * and no app-alias imports, so it is safe in a browser bundle and testable
 * under a plain `node --test`.
 */

export type MailProtocol = 'imap' | 'smtp';

export const ALLOWED_MAIL_PORTS: Readonly<Record<MailProtocol, ReadonlySet<number>>> = {
  imap: new Set([143, 993]),
  smtp: new Set([25, 465, 587]),
};

export function isAllowedMailPort(protocol: MailProtocol, port: unknown): boolean {
  return typeof port === 'number' && Number.isInteger(port) && ALLOWED_MAIL_PORTS[protocol].has(port);
}

/**
 * The allowed ports for one protocol, ascending, as an array.
 *
 * The set above is the authority; this is the shape a `<select>` needs. Sorted
 * so the options do not depend on the order the set happens to iterate in.
 */
export function allowedMailPorts(protocol: MailProtocol): number[] {
  return Array.from(ALLOWED_MAIL_PORTS[protocol]).sort((a, b) => a - b);
}
