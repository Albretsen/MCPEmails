import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  classifyProviderError,
  providerErrorAuditDetails,
  type ProviderErrorReason,
  providerErrorLogCode,
  providerErrorSignals,
} from "./provider-error.ts";

/**
 * The exact strings pulled out of the Supabase edge function console on
 * 2026-09-01, while working out what the 538 `provider_error` rows of the
 * previous 28 days actually were. Every one of them is a real failure a paying
 * customer's inbox produced, not a constructed example, which is why they are
 * quoted here verbatim rather than paraphrased.
 */
const PRODUCTION_ERRORS: [string, ProviderErrorReason][] = [
  // OVH, host ex4.mail.ovh.net, 8 occurrences inside one 8 minute burst.
  ["UID SEARCH failed: Command Error. 11", "search_rejected"],
  // 7 in one day, across IONOS and Yahoo. Thrown by imap-client's per-command
  // withTimeout at 15s, NOT by the 30s search race in executeSearchEmails.
  ["IMAP read timeout", "read_timeout"],
  // A folder the mailbox has not got. Both spellings were in the same window.
  ["Mailbox not found: Junk", "folder_missing"],
  ["Mailbox not found: Drafts", "folder_missing"],
  // Yahoo refusing the charset the search was issued in.
  [
    "UID SEARCH failed: [BADCHARSET] UID SEARCH Unsupported text encoding",
    "search_charset_unsupported",
  ],
  // 10 rows over 28 days, and this one was leaking into error_code ITSELF
  // through the automation runner rather than into error_details.
  [
    "UID COPY failed: [NONEXISTENT] Mailbox does not exist",
    "folder_missing",
  ],
];

/** An Error carrying a constructor name, the way the real classes do. */
function named(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

Deno.test("every real production error string classifies to its intended reason", () => {
  for (const [message, expected] of PRODUCTION_ERRORS) {
    assertEquals(
      classifyProviderError(new Error(message)),
      expected,
      `"${message}" should classify as ${expected}`,
    );
  }
});

Deno.test("the typed provider errors classify by class name, not by message text", () => {
  // ImapConnectionLimitError, imap-client.ts. Yahoo caps an account at 5.
  assertEquals(
    classifyProviderError(
      named("ImapConnectionLimitError", "IMAP connection refused at greeting: * BYE [LIMIT]"),
    ),
    "connection_limit",
  );
  // MailHostBlockedError, host-guard.ts. The SSRF guard refused the stored host.
  assertEquals(
    classifyProviderError(
      named("MailHostBlockedError", "IMAP host refused (dns_private): mail.example.com:993"),
    ),
    "host_blocked",
  );
  assertEquals(
    classifyProviderError(named("ImapAuthError", "IMAP authentication failed: NO")),
    "auth_failed",
  );
});

Deno.test("auth, network and HTTP failures are separated from the unknown bucket", () => {
  assertEquals(classifyProviderError(new Error("imap_auth_failed")), "auth_failed");
  assertEquals(classifyProviderError(new Error("gmail_auth_failed")), "auth_failed");
  assertEquals(classifyProviderError(new Error("connection refused")), "network_failed");
  assertEquals(classifyProviderError(new Error("Gmail modify failed: 400")), "http_error");
  assertEquals(classifyProviderError(new Error("CREATE failed: [ALREADYEXISTS]")), "folder_exists");
  // Explicit, so it can be counted and mined rather than silently absorbed.
  assertEquals(classifyProviderError(new Error("")), "unknown");
  assertEquals(classifyProviderError(null), "unknown");
});

// ---------------------------------------------------------------------------
// The two miscategorisation fixes
// ---------------------------------------------------------------------------

Deno.test("an IMAP read timeout on a search path logs search_timeout, not provider_error", () => {
  const reason = classifyProviderError(new Error("IMAP read timeout"));
  assertEquals(providerErrorLogCode(reason, "read"), "search_timeout");
  assert(
    providerErrorLogCode(reason, "read") !== "provider_error",
    "the whole point of the fix is that this stops being provider_error",
  );
});

Deno.test("a Mailbox not found on a read path logs folder_not_found, not provider_error", () => {
  const reason = classifyProviderError(new Error("Mailbox not found: Junk"));
  assertEquals(providerErrorLogCode(reason, "read"), "folder_not_found");
  // The same condition arriving as a UID COPY response code, which is the form
  // that was leaking into the error_code column through the automation runner.
  const copyReason = classifyProviderError(
    new Error("UID COPY failed: [NONEXISTENT] Mailbox does not exist"),
  );
  assertEquals(providerErrorLogCode(copyReason, "read"), "folder_not_found");
});

Deno.test("the other read-path narrowings land on codes the taxonomy already had", () => {
  assertEquals(
    providerErrorLogCode(classifyProviderError(new Error("imap_auth_failed")), "read"),
    "auth_failed",
  );
  assertEquals(
    providerErrorLogCode(
      classifyProviderError(named("MailHostBlockedError", "IMAP host refused (dns_private)")),
      "read",
    ),
    "mail_host_blocked",
  );
  assertEquals(
    providerErrorLogCode(classifyProviderError(new Error("CREATE failed: [ALREADYEXISTS]")), "read"),
    "folder_already_exists",
  );
  // A reason with no narrower code stays on provider_error even on a read path.
  assertEquals(
    providerErrorLogCode(classifyProviderError(new Error("UID SEARCH failed: Command Error. 11")), "read"),
    "provider_error",
  );
});

// ---------------------------------------------------------------------------
// IDEMPOTENCY LEDGER REGRESSION GUARDS
//
// `logErrorCode === "provider_error"` maps a send or mutation to ledger status
// "unknown" in completeOutboundIdempotency, and only "unknown" lets a retry
// carrying the same idempotency_key replay. If any of these three tests fails,
// the failure mode is mail that is either stranded or sent twice.
// ---------------------------------------------------------------------------

const INDEX_SOURCE = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));

Deno.test("REGRESSION GUARD: a send-path provider failure still logs exactly provider_error", () => {
  const everyReason: ProviderErrorReason[] = [
    "read_timeout",
    "connection_limit",
    "host_blocked",
    "auth_failed",
    "folder_missing",
    "folder_exists",
    "search_charset_unsupported",
    "search_rejected",
    "command_rejected",
    "network_failed",
    "http_error",
    "unknown",
  ];
  for (const reason of everyReason) {
    assertEquals(
      providerErrorLogCode(reason, "ledger"),
      "provider_error",
      `${reason} must not narrow the code on a path that settles the outbound ledger`,
    );
  }
  // Including, specifically, the two conditions this change reclassifies
  // elsewhere. A send that dies on a read timeout is still "we do not know
  // whether this was delivered".
  for (const message of ["IMAP read timeout", "Mailbox not found: Junk"]) {
    assertEquals(
      providerErrorLogCode(classifyProviderError(new Error(message)), "ledger"),
      "provider_error",
    );
  }
});

Deno.test("REGRESSION GUARD: every send and mutation call site in index.ts passes boundary ledger", () => {
  // The operations that accept an idempotency_key, read out of index.ts rather
  // than restated, so that adding one to either set without revisiting the call
  // sites fails here instead of in production.
  const ledgerOperations = new Set<string>();
  for (const setName of ["IDEMPOTENT_OUTBOUND_OPERATIONS", "IDEMPOTENT_MUTATION_OPERATIONS"]) {
    const block = INDEX_SOURCE.match(
      new RegExp(`const ${setName} = new Set\\(\\[([^\\]]*)\\]`),
    );
    assert(block, `${setName} not found in index.ts`);
    for (const name of block[1].matchAll(/"([a-z_]+)"/g)) ledgerOperations.add(name[1]);
  }
  // Sanity: the sets were found and are not empty or truncated.
  assert(ledgerOperations.has("email_send"), "outbound set did not parse");
  assert(ledgerOperations.has("email_move"), "mutation set did not parse");

  const calls = [...INDEX_SOURCE.matchAll(/providerFailure\(\{([\s\S]*?)\n( *)\}\);/g)];
  assert(calls.length >= 30, `expected the sweep's call sites, found ${calls.length}`);

  let checkedLedgerSites = 0;
  for (const call of calls) {
    const body = call[1];
    const boundary = body.match(/boundary: "(read|ledger)"/);
    assert(boundary, `a providerFailure call site declares no boundary:\n${body}`);
    const tool = body.match(/tool: "([a-z_]+)"/);
    // A dynamic `tool:` (handleFlagError, folderProviderError) cannot be checked
    // by name here; both are covered by the two dedicated tests below.
    if (!tool) continue;
    if (ledgerOperations.has(tool[1])) {
      assertEquals(
        boundary[1],
        "ledger",
        `${tool[1]} settles the outbound idempotency ledger and must pass boundary "ledger"`,
      );
      checkedLedgerSites++;
    }
  }
  assert(checkedLedgerSites >= 10, `expected the ledger sites, checked ${checkedLedgerSites}`);
});

Deno.test("REGRESSION GUARD: the shared mutation helpers stay pinned to the ledger boundary", () => {
  // handleFlagError serves email_move, email_copy, email_delete, email_archive
  // and email_flag, every one of which is in IDEMPOTENT_MUTATION_OPERATIONS.
  const flagHelper = INDEX_SOURCE.slice(
    INDEX_SOURCE.indexOf("function handleFlagError("),
    INDEX_SOURCE.indexOf("// ── Top-level execute functions"),
  );
  assert(flagHelper.length > 0, "handleFlagError not found");
  assert(
    flagHelper.includes('boundary: "ledger"'),
    "handleFlagError must not narrow the code: it serves five ledger operations",
  );

  // formatBulkResult derives a total-failure code from the per-item strings and
  // feeds the same ledger for every bulk tool.
  const bulkFormatter = INDEX_SOURCE.slice(INDEX_SOURCE.indexOf("function formatBulkResult("));
  assert(
    bulkFormatter.includes('bulkFailureErrorCode(failed[0].error, "ledger")'),
    "formatBulkResult must classify at the ledger boundary",
  );
});

// ---------------------------------------------------------------------------
// PRIVACY
//
// error_details is persisted and read by operators. validation-observability.ts
// states the contract for the schema-validation payload and provider-error.ts
// takes the same one: no argument values, no error messages, no addresses, no
// search text, no message content.
// ---------------------------------------------------------------------------

/**
 * Provider messages built to carry exactly what must never be persisted. Each
 * is a real shape: an IMAP server naming the mailbox it could not select, one
 * echoing the failing command line (which holds the caller's search terms),
 * one quoting an address, and Yahoo's BADCHARSET reply with its session id.
 */
const HOSTILE_MESSAGES = [
  'Mailbox not found: Client Invoices/Q3 Renewals',
  'UID SEARCH failed: BAD Command Error. 11 (UID SEARCH CHARSET UTF-8 TEXT "severance agreement")',
  'UID COPY failed: NO [NONEXISTENT] no such mailbox "Confidential/Board"',
  'UID SEARCH failed: [BADCHARSET] Unsupported text encoding sid=3f9a17c4bb0e42 host=ex4.mail.ovh.net',
  'IMAP command failed for alice.hansen@example.com: LOGIN rejected',
  'SELECT failed: mailbox "INBOX.Legal.Settlement" is locked',
];

/** The secrets each of the above is carrying. None may survive into a payload. */
const FORBIDDEN_SUBSTRINGS = [
  "Client Invoices",
  "Q3 Renewals",
  "severance agreement",
  "Confidential",
  "Board",
  "3f9a17c4bb0e42",
  "ex4.mail.ovh.net",
  "alice.hansen@example.com",
  "alice.hansen",
  "example.com",
  "INBOX.Legal.Settlement",
  "Settlement",
];

Deno.test("a provider error carrying a folder name or a search term cannot reach the persisted payload", () => {
  for (const message of HOSTILE_MESSAGES) {
    const details = providerErrorAuditDetails("email_search", "imap", new Error(message));
    const persisted = JSON.stringify(details);
    for (const secret of FORBIDDEN_SUBSTRINGS) {
      assert(
        !persisted.includes(secret),
        `"${secret}" reached the persisted payload from "${message}":\n${persisted}`,
      );
    }
    // And it is not empty theatre: the payload still says something useful.
    assert(details.reason.length > 0);
    assertEquals(details.phase, "provider_call");
  }
});

Deno.test("signals carry protocol constants only, never anything a user can name", () => {
  assertEquals(
    providerErrorSignals(new Error("UID SEARCH failed: [BADCHARSET] Unsupported text encoding")),
    ["[BADCHARSET]", "UID SEARCH"],
  );
  assertEquals(
    providerErrorSignals(new Error("UID COPY failed: [NONEXISTENT] Mailbox does not exist")),
    ["[NONEXISTENT]", "UID COPY"],
  );
  // A mailbox the user named after an IMAP verb is the case a free text scan
  // would have leaked. The command match is anchored, so it does not fire.
  assertEquals(providerErrorSignals(new Error("Mailbox not found: DELETE")), []);
  assertEquals(providerErrorSignals(new Error("Mailbox not found: Junk")), []);
  // A bracketed token that is not an RFC response code is not a response code.
  assertEquals(providerErrorSignals(new Error("Mailbox not found: [PROJECT-ORION]")), []);
  // An HTTP status only in the shape a Gmail or Graph helper produces.
  assertEquals(providerErrorSignals(new Error("Gmail modify failed: 400")), ["http_400"]);
  assertEquals(providerErrorSignals(new Error("Mailbox not found: 404 Reports")), []);
});

Deno.test("the audit payload holds no field that could carry free text", () => {
  const details = providerErrorAuditDetails(
    "email_search",
    "imap",
    new Error('UID SEARCH failed: TEXT "quarterly bonus"'),
  );
  assertEquals(Object.keys(details).sort(), ["phase", "provider", "reason", "signals", "tool"]);
  // `provider` is collapsed to a known member so a database column that somehow
  // held free text cannot become the leak.
  assertEquals(providerErrorAuditDetails("email_read", "imap", null).provider, "imap");
  assertEquals(
    providerErrorAuditDetails("email_read", "alice@example.com", null).provider,
    "other",
  );
});

Deno.test("signals are bounded, whatever the server chose to say", () => {
  const noisy = new Error(
    "UID SEARCH failed: [BADCHARSET] [NONEXISTENT] [TRYCREATE] [LIMIT] [OVERQUOTA] [INUSE]",
  );
  assert(providerErrorSignals(noisy).length <= 4, "a payload must not grow without bound");
});
