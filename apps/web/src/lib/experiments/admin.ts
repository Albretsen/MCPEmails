/**
 * Everything the admin panel does to an experiment. Service-role, server only.
 *
 * All validation lives here rather than in the route handlers, so the panel
 * and any future caller get the same rules and the same plain-language errors.
 * Every write ends by clearing the read memo, otherwise starting an experiment
 * would appear to do nothing for up to thirty seconds.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { validateVariants } from './bucketing.ts';
import { clearExperimentCache } from './store.ts';
import type {
  ExperimentRecord,
  ExperimentStatus,
  ExperimentVariant,
  ExperimentVariantStats,
  RetentionGoal,
} from './constants.ts';

const COLUMNS =
  'key, name, description, status, variants, winner_variant_id, retention_goal, retention_window_days, created_at, updated_at, started_at, concluded_at';

const KEY_PATTERN = /^[a-z0-9_]{2,64}$/;
const RETENTION_GOALS: RetentionGoal[] = ['mailbox_activity', 'any_tool_call', 'value_activation'];

// Generated database types can lag migrations; these server-only tables are
// intentionally cast locally rather than weakening the application client.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function table(db: SupabaseClient): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (db as any).from('experiments');
}

export async function listExperiments(client?: SupabaseClient): Promise<ExperimentRecord[]> {
  const db = client ?? createServiceRoleClient();
  const { data, error } = await table(db).select(COLUMNS).order('created_at', { ascending: false });
  if (error) throw new Error(`Could not read the experiments: ${error.message}`);
  return (data ?? []) as ExperimentRecord[];
}

export async function getExperimentRecord(
  key: string,
  client?: SupabaseClient,
): Promise<ExperimentRecord | null> {
  const db = client ?? createServiceRoleClient();
  const { data, error } = await table(db).select(COLUMNS).eq('key', key).maybeSingle();
  if (error) throw new Error(`Could not read experiment "${key}": ${error.message}`);
  return (data as ExperimentRecord | null) ?? null;
}

export interface CreateExperimentInput {
  key: string;
  name: string;
  description?: string | null;
  variants: ExperimentVariant[];
  retention_goal?: RetentionGoal;
  retention_window_days?: number;
}

export async function createExperiment(
  input: CreateExperimentInput,
  client?: SupabaseClient,
): Promise<ExperimentRecord> {
  if (!KEY_PATTERN.test(input.key ?? '')) {
    throw new Error('The key must be 2 to 64 characters of lowercase letters, digits or underscores.');
  }
  if (!input.name || input.name.trim() === '') throw new Error('The experiment needs a name.');

  const variantError = validateVariants(input.variants);
  if (variantError) throw new Error(variantError);

  const goal = input.retention_goal ?? 'mailbox_activity';
  if (!RETENTION_GOALS.includes(goal)) throw new Error(`"${goal}" is not a retention goal.`);

  const days = input.retention_window_days ?? 7;
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new Error('The retention window must be a whole number of days between 1 and 90.');
  }

  const db = client ?? createServiceRoleClient();
  const { data, error } = await table(db)
    .insert({
      key: input.key,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      variants: input.variants,
      retention_goal: goal,
      retention_window_days: days,
    })
    .select(COLUMNS)
    .single();

  if (error) {
    if (error.code === '23505') throw new Error(`An experiment named "${input.key}" already exists.`);
    throw new Error(`Could not create the experiment: ${error.message}`);
  }
  clearExperimentCache(input.key);
  return data as ExperimentRecord;
}

export type ExperimentPatch = Partial<
  Pick<
    ExperimentRecord,
    'name' | 'description' | 'variants' | 'status' | 'winner_variant_id' | 'retention_goal' | 'retention_window_days'
  >
>;

/**
 * Which status moves are allowed, and what each one means.
 *
 *   draft -> running     start. Stamps started_at the first time only.
 *   running -> draft     pause. Assignments are kept, so resuming does not
 *                        re-bucket anyone who was already in.
 *   running -> concluded ship. Needs a winner, which everyone then sees.
 *   concluded -> running reopen. Clears the winner and the conclusion date.
 *
 * Anything else (draft straight to concluded, concluded back to draft) is a
 * mistake with no honest meaning, so it throws instead of being tolerated.
 */
const ALLOWED_TRANSITIONS: Record<ExperimentStatus, ExperimentStatus[]> = {
  draft: ['running'],
  running: ['draft', 'concluded'],
  concluded: ['running'],
};

export async function updateExperiment(
  key: string,
  patch: ExperimentPatch,
  client?: SupabaseClient,
): Promise<ExperimentRecord> {
  const db = client ?? createServiceRoleClient();
  const current = await getExperimentRecord(key, db);
  if (!current) throw new Error(`There is no experiment named "${key}".`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const update: Record<string, any> = {};

  if (patch.name !== undefined) {
    if (!patch.name || patch.name.trim() === '') throw new Error('The experiment needs a name.');
    update.name = patch.name.trim();
  }
  if (patch.description !== undefined) {
    update.description = patch.description?.trim() || null;
  }
  if (patch.retention_goal !== undefined) {
    if (!RETENTION_GOALS.includes(patch.retention_goal)) {
      throw new Error(`"${patch.retention_goal}" is not a retention goal.`);
    }
    update.retention_goal = patch.retention_goal;
  }
  if (patch.retention_window_days !== undefined) {
    const days = patch.retention_window_days;
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      throw new Error('The retention window must be a whole number of days between 1 and 90.');
    }
    update.retention_window_days = days;
  }

  const variants = patch.variants ?? current.variants;
  if (patch.variants !== undefined) {
    const variantError = validateVariants(patch.variants);
    if (variantError) throw new Error(variantError);
    update.variants = patch.variants;
  }

  if (patch.status !== undefined && patch.status !== current.status) {
    const allowed = ALLOWED_TRANSITIONS[current.status] ?? [];
    if (!allowed.includes(patch.status)) {
      throw new Error(`An experiment cannot go from ${current.status} to ${patch.status}.`);
    }
    update.status = patch.status;

    if (patch.status === 'running') {
      if (current.status === 'draft' && !current.started_at) update.started_at = new Date().toISOString();
      if (current.status === 'concluded') {
        update.winner_variant_id = null;
        update.concluded_at = null;
      }
    }

    if (patch.status === 'concluded') {
      const winner = patch.winner_variant_id ?? current.winner_variant_id;
      if (!winner) throw new Error('Concluding an experiment needs a winning variant.');
      if (!variants.some((variant) => variant.id === winner)) {
        throw new Error(`"${winner}" is not one of this experiment's variants.`);
      }
      update.winner_variant_id = winner;
      update.concluded_at = new Date().toISOString();
    }
  } else if (patch.winner_variant_id !== undefined) {
    if (patch.winner_variant_id && !variants.some((variant) => variant.id === patch.winner_variant_id)) {
      throw new Error(`"${patch.winner_variant_id}" is not one of this experiment's variants.`);
    }
    update.winner_variant_id = patch.winner_variant_id;
  }

  if (Object.keys(update).length === 0) return current;

  const { data, error } = await table(db).update(update).eq('key', key).select(COLUMNS).single();
  if (error) throw new Error(`Could not save the experiment: ${error.message}`);
  clearExperimentCache(key);
  return data as ExperimentRecord;
}

/** Per-variant counts from the database. One row per variant, in array order. */
export async function fetchExperimentStats(
  key: string,
  client?: SupabaseClient,
): Promise<ExperimentVariantStats[]> {
  const db = client ?? createServiceRoleClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any).rpc('experiment_stats', { p_key: key });
  if (error) throw new Error(`Could not read the results for "${key}": ${error.message}`);
  return (data ?? []) as ExperimentVariantStats[];
}
