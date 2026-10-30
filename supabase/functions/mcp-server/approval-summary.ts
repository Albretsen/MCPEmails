// ---------------------------------------------------------------------------
// `send_approvals.summary` at rest.
//
// The summary is the reviewer-facing projection of a held send: recipients,
// subject, Bcc and attachment counts. Since 2026-10-30 it is stored as the same
// AES-256-GCM wrapper `{ v: 1, data }` the payload uses, so the database holds
// no recipient address or subject in clear.
//
// Rows written before that hold the plain object. Every reader goes through
// `openApprovalSummary`, which accepts both shapes, so no backfill is needed:
// the plaintext rows age out with the 90-day approval retention
// (purge_send_history(), migration 20261030120000).
//
// The web app has the mirror of this reader in
// apps/web/src/lib/approvals/payload.ts#readSummary.
// ---------------------------------------------------------------------------

export interface SealedSummary {
  v: 1;
  data: string;
}

/** True for the encrypted wrapper `{ v: 1, data: "<base64url>" }` and nothing else. */
export function isSealedSummary(value: unknown): value is SealedSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === 2 && record.v === 1 && typeof record.data === "string" && record.data.length > 0;
}

/** Encrypt a summary for storage. */
export async function sealApprovalSummary(
  summary: Record<string, unknown>,
  encrypt: (plaintext: string) => Promise<string>,
): Promise<SealedSummary> {
  return { v: 1, data: await encrypt(JSON.stringify(summary)) };
}

/**
 * Read a stored summary in either shape. A wrapper that does not decrypt (a
 * rotated key, a damaged row) reads as an empty summary, which every renderer
 * already handles: it falls back to the payload's own recipients and subject.
 */
export async function openApprovalSummary(
  stored: unknown,
  decrypt: (ciphertext: string) => Promise<string>,
): Promise<Record<string, unknown>> {
  if (isSealedSummary(stored)) {
    try {
      const parsed = JSON.parse(await decrypt(stored.data));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch (error) {
      console.error("[mcp-server] approval_summary_decrypt_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    return stored as Record<string, unknown>;
  }
  return {};
}
