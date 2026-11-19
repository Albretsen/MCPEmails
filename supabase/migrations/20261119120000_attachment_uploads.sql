-- ============================================================
-- MCPEmails: upload slots for email attachments
-- 20261119120000_attachment_uploads
-- ============================================================
--
-- A file on the user's own device used to reach a draft only as base64 the
-- model wrote out in a tool call. An upload slot lets the user (in a browser)
-- or an agent with a shell (curl -T) put the file straight into storage; the
-- model then passes `attachments: [{ upload_id }]`.
-- supabase/functions/mcp-server/attachment-uploads.ts is the only user.
--
-- The bucket is PRIVATE with no storage.objects policies: writes go through
-- one-write signed upload URLs the server issues, reads through the
-- service-role client. 10 MB per object, the send limit for one email.
--
-- The table has RLS on and no policies: only the service role reads or
-- writes it. Slots live two hours, the life of a signed upload token. Expired
-- slots are removed by the server when it issues a new one (objects through
-- the Storage API, then rows); purge_attachment_upload_rows() is a nightly
-- backstop for rows whose objects were never written.
--
-- Idempotent.
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit)
values ('attachment-uploads', 'attachment-uploads', false, 10485760)
on conflict (id) do update set public = false, file_size_limit = 10485760;

create table if not exists public.attachment_uploads (
  id                  uuid primary key,
  workspace_id        uuid not null references public.workspaces(id) on delete cascade,
  api_key_id          uuid references public.api_keys(id) on delete set null,
  inbox_id            uuid references public.inboxes(id) on delete set null,
  filename            text not null check (char_length(filename) between 1 and 255),
  mime_type           text not null,
  declared_size_bytes bigint check (declared_size_bytes is null or declared_size_bytes between 0 and 10485760),
  storage_path        text not null unique,
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null default now() + interval '2 hours',
  consumed_at         timestamptz
);

create index if not exists attachment_uploads_expires_idx on public.attachment_uploads (expires_at);
create index if not exists attachment_uploads_workspace_idx on public.attachment_uploads (workspace_id);

alter table public.attachment_uploads enable row level security;
revoke all on public.attachment_uploads from anon, authenticated;

-- Rows expired a day ago. Their objects, if any, were removed by the server or
-- go with the bucket's own cleanup; a row this old is never usable.
create or replace function public.purge_attachment_upload_rows()
returns integer
language sql
security definer
set search_path = public
as $$
  with gone as (
    delete from public.attachment_uploads
     where expires_at < now() - interval '1 day'
    returning 1
  )
  select count(*)::integer from gone;
$$;

revoke all on function public.purge_attachment_upload_rows() from public, anon, authenticated;
grant execute on function public.purge_attachment_upload_rows() to service_role;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.schedule(
      'attachment-uploads-retention',
      '45 2 * * *',
      'select public.purge_attachment_upload_rows()'
    );
  end if;
end $$;
