-- User opt-out for the draft editor card, at two grains.
--
-- DELIBERATELY SEPARATE from `workspaces.draft_editor_enabled`, which is the
-- internal ROLLOUT gate. Conflating the two would mean widening the rollout
-- silently un-hides the card for someone who turned it off, and the rollout
-- read-out (CONCEPT-draft-editor.md §10) could not tell "not enabled yet" from
-- "offered and refused". Two columns, ANDed: the card shows when the rollout
-- allows it AND the user has not hidden it.
--
-- Both default false, so nothing changes for anyone on deploy.

-- Grain 1: the whole workspace.
alter table public.workspaces
  add column if not exists draft_editor_hidden boolean not null default false;

comment on column public.workspaces.draft_editor_hidden is
  'User preference: hide the draft editor card in chat for every inbox in this workspace. Independent of draft_editor_enabled, which is the internal rollout gate. When true the `draft` tool is listed with no _meta.ui, which is byte-identical to the pre-MCP-Apps surface.';

-- Grain 2: one inbox.
alter table public.inboxes
  add column if not exists draft_editor_hidden boolean not null default false;

comment on column public.inboxes.draft_editor_hidden is
  'User preference: hide the draft editor card for drafts in THIS inbox. When every inbox a key can reach is hidden, _meta.ui is withheld at tools/list; when only some are, the tool keeps _meta.ui and a hidden inbox simply returns no envelope, which the card renders as nothing and collapses.';
