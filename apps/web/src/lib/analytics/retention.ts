export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_SESSION_GAP_MS = 30 * 60 * 1000;

// These calls prove that the MCP endpoint is reachable, but they do not prove
// that a user received value from a connected mailbox.
export const CONNECTIVITY_ONLY_TOOLS = new Set([
  'inbox_list',
  'list_inbox',
  'list_inboxes',
]);

export type SuccessfulActivity = {
  workspace_id: string;
  tool_name: string | null;
  created_at: string;
};

export type Session = {
  start: number;
  end: number;
  calls: number;
};

export function utcDayStart(value: Date | string | number): number {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function isValueActivity(activity: Pick<SuccessfulActivity, 'tool_name'>): boolean {
  return Boolean(activity.tool_name && !CONNECTIVITY_ONLY_TOOLS.has(activity.tool_name));
}

export function groupSuccessfulActivities(activities: SuccessfulActivity[]) {
  const byWorkspace = new Map<string, SuccessfulActivity[]>();
  for (const activity of activities) {
    const rows = byWorkspace.get(activity.workspace_id) ?? [];
    rows.push(activity);
    byWorkspace.set(activity.workspace_id, rows);
  }
  for (const rows of byWorkspace.values()) {
    rows.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }
  return byWorkspace;
}

export function buildSessions(timestamps: number[], gapMs = DEFAULT_SESSION_GAP_MS): Session[] {
  const sessions: Session[] = [];
  for (const timestamp of [...timestamps].sort((a, b) => a - b)) {
    const current = sessions.at(-1);
    if (!current || timestamp - current.end >= gapMs) {
      sessions.push({ start: timestamp, end: timestamp, calls: 1 });
      continue;
    }
    current.end = timestamp;
    current.calls += 1;
  }
  return sessions;
}

export function firstActivityTimes(byWorkspace: Map<string, SuccessfulActivity[]>, valueOnly = false) {
  const first = new Map<string, number>();
  for (const [workspaceId, rows] of byWorkspace) {
    const activity = valueOnly ? rows.find(isValueActivity) : rows[0];
    if (activity) first.set(workspaceId, new Date(activity.created_at).getTime());
  }
  return first;
}

export function rollingReturn(
  firstByWorkspace: Map<string, number>,
  activitiesByWorkspace: Map<string, SuccessfulActivity[]>,
  windowStartDay: number,
  windowEndDay: number,
  asOfDay: number,
  valueOnly = false,
) {
  let eligible = 0;
  let retained = 0;
  for (const [workspaceId, firstAt] of firstByWorkspace) {
    const cohortDay = utcDayStart(firstAt);
    const windowStart = cohortDay + windowStartDay * DAY_MS;
    const windowEnd = cohortDay + (windowEndDay + 1) * DAY_MS;
    if (windowEnd > asOfDay) continue;
    eligible += 1;
    const returned = (activitiesByWorkspace.get(workspaceId) ?? []).some((activity) => {
      if (valueOnly && !isValueActivity(activity)) return false;
      const time = new Date(activity.created_at).getTime();
      return time >= windowStart && time < windowEnd;
    });
    if (returned) retained += 1;
  }
  return { eligible, retained };
}

export function twoDayValueWithinFirstWeek(
  firstValueByWorkspace: Map<string, number>,
  activitiesByWorkspace: Map<string, SuccessfulActivity[]>,
  asOfDay: number,
) {
  let eligible = 0;
  let retained = 0;
  for (const [workspaceId, firstAt] of firstValueByWorkspace) {
    const cohortDay = utcDayStart(firstAt);
    const windowEnd = cohortDay + 8 * DAY_MS;
    if (windowEnd > asOfDay) continue;
    eligible += 1;
    const activeDays = new Set(
      (activitiesByWorkspace.get(workspaceId) ?? [])
        .filter(isValueActivity)
        .map((activity) => utcDayStart(activity.created_at))
        .filter((day) => day >= cohortDay && day < windowEnd),
    );
    if (activeDays.size >= 2) retained += 1;
  }
  return { eligible, retained };
}

export function frequencyBand(value: number): '1' | '2–3' | '4–7' | '8+' {
  if (value <= 1) return '1';
  if (value <= 3) return '2–3';
  if (value <= 7) return '4–7';
  return '8+';
}
