-- ============================================================
-- MCPEmails — Add inboxes.service column
-- 20260530130000_inboxes_service_column
-- ============================================================
--
-- Phase 0 of the multi-provider IMAP rollout (Documents/provider-support.md).
--
-- All new IMAP providers (iCloud, Yahoo, Zoho, Yandex, and the generic
-- connector) share a single transport discriminator: provider = 'imap'
-- (already permitted by inboxes_provider_check). The per-row imap_host /
-- imap_port / smtp_host / smtp_port columns carry everything the edge function
-- needs at serve-time, so the branded identity is purely UX metadata.
--
-- `service` records that brand for the dashboard label/icon and to drive
-- host-preset selection at connect-time. It is NULL for OAuth providers and for
-- existing Fastmail app-password rows.
--
-- Additive and nullable: does NOT touch inboxes_provider_check.
-- ============================================================

ALTER TABLE public.inboxes
  ADD COLUMN service text;

COMMENT ON COLUMN public.inboxes.service IS
  'Branded IMAP service for UX/host-preset selection when provider = ''imap'': '
  '''icloud'' | ''yahoo'' | ''zoho'' | ''yandex'' | ''generic''. '
  'NULL for OAuth providers and Fastmail.';

ALTER TABLE public.inboxes
  ADD CONSTRAINT inboxes_service_check
    CHECK (service IS NULL OR service IN ('icloud', 'yahoo', 'zoho', 'yandex', 'generic'));
