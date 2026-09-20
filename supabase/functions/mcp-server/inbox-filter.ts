// ---------------------------------------------------------------------------
// inbox-filter.ts — what `inbox_list` filters on, and what it says when the
// filter matches nothing.
//
// ── The bug this exists to fix ──────────────────────────────────────────────
// A live functional test on 2026-09-20, against a key with SIX connected
// mailboxes, ran:
//
//     inbox_list {provider: "gmail", include_capabilities: false}
//
// and got back `{"inboxes": [], "setup_required": true, ...}` carrying the
// message "No mailbox is connected to this account yet, so there is nothing to
// read or send from. Tell the user this and give them the setup_url...".
//
// Every word of that is false, and it is phrased as an instruction, so an agent
// relays it verbatim: the user is told to go and connect a mailbox they
// connected weeks ago. The handler had exactly one empty-result branch and it
// was the ONBOARDING branch, so a filter that matched nothing was
// indistinguishable from an account with nothing in it.
//
// Two different facts were being conflated:
//
//   EMPTY ACCOUNT   No inbox is reachable by this key at all. This really is
//                   the first run of a user who installed the connector before
//                   connecting a mailbox — the order the connector directories
//                   impose — and the setup prompt is the right answer.
//   EMPTY MATCH     Inboxes exist; this filter selected none of them. Nothing
//                   needs connecting. What the caller needs is the filter it
//                   used, the fact that the account is NOT empty, and what is
//                   actually there.
//
// ── Why the filter matched nothing, which is the interesting part ───────────
// The account in the reproduction has a Gmail mailbox. `provider: "gmail"`
// missed it anyway — because that mailbox is connected with an app password
// over IMAP, so its `provider` is "imap" and its `service` is "gmail".
//
//   provider   the CONNECTOR this server speaks: gmail (Google API), outlook
//              (Graph), fastmail, or imap (plain IMAP/SMTP).
//   service    the BRAND of the account behind an IMAP connection: gmail,
//              fastmail, icloud, yahoo, zoho, yandex, generic.
//
// Those two axes are orthogonal and the tool only ever exposed the first, so
// "show me my Gmail" was inexpressible and `provider: "gmail"` silently
// answered a different question. `service` is now a filter of its own, and the
// no-match message says this out loud whenever a provider filter matched
// nothing but a same-named service is sitting right there. That sentence is
// the whole point of the fix: it turns a dead end into one retry.
//
// Pure and dependency-free, so both the matching and the wording can be tested
// without booting the server or touching a database — the same reason
// consolidated-arguments.ts and inbox-selector.ts are separate modules.
// ---------------------------------------------------------------------------

/** The connectors `inboxes.provider` can hold. */
export const INBOX_PROVIDER_VALUES = [
  "gmail",
  "outlook",
  "fastmail",
  "imap",
] as const;

/**
 * The brands `inboxes.service` can hold.
 *
 * Kept in step with the CHECK constraint on `public.inboxes.service`, last
 * widened by 20260901140000_inboxes_gmail_service.sql. `service` is null for
 * every inbox connected through a first-party provider rather than a branded
 * IMAP host.
 */
export const INBOX_SERVICE_VALUES = [
  "gmail",
  "fastmail",
  "icloud",
  "yahoo",
  "zoho",
  "yandex",
  "generic",
] as const;

/** The columns this module needs. A row carries far more; none of it matters here. */
export interface FilterableInbox {
  email_address: string;
  provider: string;
  service: string | null;
}

/** The two filters `inbox_list` accepts. `null` means the caller omitted it. */
export interface InboxListFilter {
  provider: string | null;
  service: string | null;
}

/** Whether any filter was supplied at all. */
export function hasInboxFilter(filter: InboxListFilter): boolean {
  return filter.provider !== null || filter.service !== null;
}

/**
 * Whether one inbox satisfies the filter.
 *
 * The two axes are ANDed, because a caller that names both means both:
 * `{provider: "imap", service: "gmail"}` is "the Gmail accounts I connected
 * with an app password", which is a real and useful question and not the same
 * as either half. Comparison is case-insensitive; both columns are stored
 * lowercase, but the filter arrives from a model.
 */
export function matchesInboxFilter(
  inbox: FilterableInbox,
  filter: InboxListFilter,
): boolean {
  if (filter.provider !== null) {
    if (inbox.provider.toLowerCase() !== filter.provider.toLowerCase()) return false;
  }
  if (filter.service !== null) {
    const service = (inbox.service ?? "").toLowerCase();
    if (service !== filter.service.toLowerCase()) return false;
  }
  return true;
}

/** One entry per inbox for the payload, deliberately without capabilities. */
export interface AvailableInbox {
  email_address: string;
  provider: string;
  service: string | null;
}

export interface FilteredNoMatchReport {
  /** Every inbox the key can reach, so the caller can retry without a second call. */
  available: AvailableInbox[];
  /** The agent-facing sentence. Never mentions connecting a mailbox. */
  message: string;
}

/** "provider 'gmail'" / "service 'yahoo'" / "provider 'imap' and service 'gmail'". */
function filterPhrase(filter: InboxListFilter): string {
  const clauses: string[] = [];
  if (filter.provider !== null) clauses.push(`provider '${filter.provider}'`);
  if (filter.service !== null) clauses.push(`service '${filter.service}'`);
  return clauses.join(" and ");
}

/** At most `cap` entries, then "and N more", so a large account cannot flood the message. */
function join(entries: readonly string[], cap: number, separator = ", "): string {
  const shown = entries.slice(0, cap);
  const rest = entries.length - shown.length;
  return rest > 0
    ? `${shown.join(separator)} and ${rest} more`
    : shown.join(separator);
}

/**
 * The sentence, and the roster, a filtered no-match returns.
 *
 * Three things have to be in it, in this order, because they answer the three
 * questions the caller has in the order it has them:
 *
 *   1. What was filtered on, and that the account is NOT empty. This is the
 *      correction to the falsehood that shipped: "N mailboxes are connected"
 *      forecloses the "tell the user to connect one" improvisation entirely.
 *   2. The provider-vs-service explanation, WHEN it applies. A `provider`
 *      filter that matched nothing while a same-named `service` exists is not a
 *      user error, it is the caller reasonably not knowing that this server
 *      draws a line between a connector and a brand. Naming the mailboxes and
 *      the exact retry (`service: 'gmail'`) is what makes it recoverable in one
 *      more call rather than abandoned.
 *   3. The roster. `inbox_list` exists to answer "which inboxes do I have?",
 *      and a filtered call is still that question with a wrong guess attached,
 *      so the answer belongs in the response rather than behind another call.
 *
 * Declarative about what happened, imperative only about the retry, for the
 * reason set out in consolidated-arguments.ts: prose addressed to a model from
 * inside a tool result is indistinguishable from an injected instruction, so it
 * stays confined to the mechanical next step and never tells the model what to
 * say to a person. The message the 2026-09-20 test caught did exactly that.
 */
export function buildFilteredNoMatchReport(
  filter: InboxListFilter,
  all: readonly FilterableInbox[],
): FilteredNoMatchReport {
  const available: AvailableInbox[] = all.map((ib) => ({
    email_address: ib.email_address,
    provider: ib.provider,
    service: ib.service ?? null,
  }));

  const count = all.length;
  const parts: string[] = [
    `No connected inbox matches ${filterPhrase(filter)}. ` +
      "This is a filter result, not an empty account: " +
      `${count} ${count === 1 ? "mailbox is" : "mailboxes are"} connected to this key.`,
  ];

  // The 2026-09-20 reproduction, stated in general: the name the caller
  // filtered on is a real thing here, just on the other axis.
  const wantedProvider = filter.provider;
  if (wantedProvider !== null && filter.service === null) {
    const byService = all.filter(
      (ib) => (ib.service ?? "").toLowerCase() === wantedProvider.toLowerCase(),
    );
    if (byService.length > 0) {
      parts.push(
        `'${wantedProvider}' is not the provider of any of them, but it IS the ` +
          `service of ${byService.length === 1 ? "one" : String(byService.length)}: ` +
          `${join(byService.map((ib) => ib.email_address), 8)}. ` +
          "provider is the CONNECTOR this server talks to (gmail, outlook, " +
          "fastmail, imap); service is the BRAND of the account behind it, so a " +
          "Gmail mailbox connected with an app password has provider 'imap' and " +
          `service 'gmail'. Retry with service: '${wantedProvider}'.`,
      );
    }
  }

  // The mirror image: `service: "fastmail"` matched nothing, but Fastmail is
  // also a first-party connector, so the mailbox is sitting under `provider`.
  const wantedService = filter.service;
  if (wantedService !== null && filter.provider === null) {
    const byProvider = all.filter(
      (ib) => ib.provider.toLowerCase() === wantedService.toLowerCase(),
    );
    if (byProvider.length > 0) {
      parts.push(
        `'${wantedService}' is not the service of any of them, but it IS the ` +
          `provider of ${byProvider.length === 1 ? "one" : String(byProvider.length)}: ` +
          `${join(byProvider.map((ib) => ib.email_address), 8)}. ` +
          "service is the BRAND of an account reached over plain IMAP; provider " +
          "is the CONNECTOR, and a first-party connector leaves service null. " +
          `Retry with provider: '${wantedService}'.`,
      );
    }
  }

  parts.push(
    "Connected: " +
      join(
        available.map(
          (ib) =>
            `${ib.email_address} (provider ${ib.provider}, service ${ib.service ?? "none"})`,
        ),
        12,
        "; ",
      ) +
      ". Call inbox_list with no filter for the same list with inbox_id and capabilities.",
  );

  return { available, message: parts.join(" ") };
}
