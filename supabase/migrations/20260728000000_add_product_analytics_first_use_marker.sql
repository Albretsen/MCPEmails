-- A one-time, aggregate funnel marker. It deliberately holds no user, inbox,
-- request, or mailbox identifier; the dashboard emits only these enum values.
ALTER TABLE public.workspaces
  ADD COLUMN analytics_first_tool_name text,
  ADD COLUMN analytics_first_tool_provider text,
  ADD COLUMN analytics_first_tool_client text,
  ADD COLUMN analytics_first_tool_path text,
  ADD COLUMN analytics_first_tool_reported_at timestamptz;
