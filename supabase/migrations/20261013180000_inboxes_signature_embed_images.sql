-- ============================================================
-- MCPEmails — per-inbox opt-in: embed signature images in the message
-- 20261013180000_inboxes_signature_embed_images
-- ============================================================
--
-- A signature image is stored as an https URL (20260708000000). Desktop mail
-- clients do not load remote content until the reader allows it, so a draft
-- written by the MCP server opens with a blank box where the logo should be.
--
-- When this is true the edge function fetches the signature's images and sends
-- them inside the message (multipart/related, referenced by Content-ID), the
-- way Thunderbird and Outlook do when the user composes there. See
-- supabase/functions/mcp-server/signature-images.ts.
--
-- Default false: every existing mailbox keeps sending exactly what it sends
-- today. Read by the edge function in its own query (never through
-- INBOX_SELECT_COLUMNS), so deploy order cannot break the mail tools.
--
-- Idempotent.
-- ============================================================

alter table public.inboxes
  add column if not exists signature_embed_images boolean not null default false;

comment on column public.inboxes.signature_embed_images is
  'When true, signature images are sent inline (cid:) instead of as remote https URLs. Gmail and IMAP only.';
