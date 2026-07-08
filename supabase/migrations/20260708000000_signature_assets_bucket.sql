-- ============================================================
-- MCPEmails — Storage bucket for signature assets (logos/images)
-- 20260708000000_signature_assets_bucket
-- ============================================================
--
-- The rich signature editor lets users host a logo/image and reference it by
-- https URL inside signature_html (no base64/CID, per deliverability + XSS
-- decisions). Images are uploaded server-side by the web app using the
-- service-role Supabase client, then served publicly.
--
-- This migration creates a PUBLIC-READ bucket `signature-assets` and ensures a
-- public SELECT policy on storage.objects scoped to that bucket.
--
-- Uploads go through the service-role client, which BYPASSES RLS, so we
-- deliberately grant NO anon/authenticated INSERT/UPDATE/DELETE policy — only
-- public read. This keeps the bucket write-closed to clients while readable to
-- mail recipients and the dashboard preview.
--
-- Object key convention (enforced in the app, Phase 1):
--   signature-assets/{workspace_id}/{inbox_id}/{uuid}.{ext}
-- Intended limits (enforced in the app upload route, Phase 1):
--   max 2 MB per file; raster formats only (png, jpeg, gif, webp); no SVG.
--
-- Idempotent: bucket insert is ON CONFLICT DO NOTHING; the policy is created
-- inside a guard that skips if it already exists. Safe to re-run.
-- ============================================================

-- 1. Create the public bucket (no-op if it already exists).
insert into storage.buckets (id, name, public)
values ('signature-assets', 'signature-assets', true)
on conflict (id) do nothing;

-- 2. Public read for objects in this bucket only. Guarded so re-runs skip.
--    (Service-role uploads bypass RLS, so no write policy is defined here.)
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Public read signature-assets'
  ) then
    create policy "Public read signature-assets"
      on storage.objects
      for select
      to public
      using (bucket_id = 'signature-assets');
  end if;
end $$;
