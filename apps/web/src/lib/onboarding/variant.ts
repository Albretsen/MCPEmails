/**
 * Which onboarding a workspace gets: the 2x2 of `onb_flow` (control | new) and
 * `onb_convert` (off | on). Server only. Plan section 8, report 06.
 *
 * THE ONE ENTRY POINT. `getOnboardingVariant(workspaceId, ctx?)`. Call it
 * anywhere on the server; it is idempotent and cheap after the first call per
 * workspace (one workspace+owner read, the experiments cache, one assignment
 * read). Hand the result to the browser with `clientOnboardingVariant()`,
 * which is `{ flow, convert }` and nothing else.
 *
 * WHERE ASSIGNMENT HAPPENS. When a workspace is created, on both entry paths:
 *   - web signup: /auth/callback (Google, GitHub, magic link) and the first
 *     dashboard render (password signup, whose signUp() never touches our
 *     server first). See `assignOnboardingAtSignup`.
 *   - connector-first: app/authorize/page.js, after the login/signup detour.
 * Workspaces are created by the auth.users trigger, so "at creation" means the
 * first server request that sees the new account. Every later read returns the
 * stored arm.
 *
 * THE v1 GATE. In this order:
 *   1. Internal accounts (internal-accounts.ts: our domains,
 *      GROWTH_INTERNAL_EMAILS, public.internal_accounts, plus-tag aliases) get
 *      { new, on }. They are NEVER enrolled: no assignment row, so they can
 *      never pollute the read-out.
 *   2. Everyone else gets { control, off } and is not enrolled, unless BOTH
 *      ONBOARDING_EXPERIMENT_PUBLIC=1 is set on Vercel AND the experiment row
 *      is `running` in /admin/growth/experiments (seeded `draft` by
 *      20261026152301). Two switches on purpose: flipping the admin panel
 *      early must not show customers an unfinished flow. Both switched on
 *      2026-10-27 16:04 UTC (the test start).
 *   3. When both are on, a workspace younger than ENROLL_WINDOW_MS is bucketed
 *      and stored through the experiments system (cyrb53 on key:subject, so
 *      the two keys are independent splits). An older workspace is only READ:
 *      if it has no stored assignment it is control/off and stays out of the
 *      test, so a returning customer's dashboard load never enrolls them.
 *   4. A concluded experiment serves its winner to everyone (how it ships).
 *
 * Unit and subject: the workspace uuid without dashes (32 lowercase hex), the
 * same pattern as billing/pass-offer.ts and email/activation-help.ts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database.types';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { isInternalAccount } from '@/lib/analytics/internal-accounts';
import { createExperimentStore } from '@/lib/experiments/store';
import { resolveVariant, type ExperimentStore } from '@/lib/experiments/resolve';
import {
  CONTROL_VARIANT,
  INTERNAL_VARIANT,
  ONB_CONVERT_KEY,
  ONB_FLOW_KEY,
  type OnboardingVariant,
} from './flow.ts';

type Db = SupabaseClient<Database>;

export { ONB_FLOW_KEY, ONB_CONVERT_KEY, CONTROL_VARIANT, INTERNAL_VARIANT };
export type { OnboardingVariant };

/** A workspace this young may still be enrolled. Older ones are read only. */
export const ENROLL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** What the server knows; `clientOnboardingVariant` strips it to the client prop. */
export interface OnboardingAssignment extends OnboardingVariant {
  /** The owner is an internal account (v1: the only people who see the new flow). */
  internal: boolean;
  /** An experiment assignment row exists (or was just written) for this workspace. */
  enrolled: boolean;
}

/** The store the resolver uses, plus a read that never writes. */
export interface OnboardingExperimentStore extends ExperimentStore {
  readAssignment(key: string, subjectId: string): Promise<string | null>;
}

export interface OnboardingVariantContext {
  /** The workspace OWNER's address. Looked up when absent. */
  ownerEmail?: string | null;
  /** workspaces.created_at. Looked up when absent. */
  workspaceCreatedAt?: string | null;
  /** Service-role client. Created when absent. */
  db?: Db;
  /** Tests inject these. */
  store?: OnboardingExperimentStore;
  internalEmails?: ReadonlySet<string>;
  publicEnrollment?: boolean;
  now?: number;
}

/** The workspace uuid as an experiment subject, or null when it is not a uuid. */
export function onboardingSubject(workspaceId: string | null | undefined): string | null {
  if (typeof workspaceId !== 'string') return null;
  const hex = workspaceId.replace(/-/g, '').toLowerCase();
  return /^[a-f0-9]{32}$/.test(hex) ? hex : null;
}

/** ONBOARDING_EXPERIMENT_PUBLIC=1: customers may be enrolled (still needs `running`). */
export function onboardingPublicEnrollment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ONBOARDING_EXPERIMENT_PUBLIC === '1';
}

/** The browser-safe prop: `{ flow, convert }`, nothing about who or why. */
export function clientOnboardingVariant(assignment: OnboardingVariant | null | undefined): OnboardingVariant {
  return {
    flow: assignment?.flow === 'new' ? 'new' : 'control',
    convert: assignment?.convert === 'on' ? 'on' : 'off',
  };
}

// ── internal_accounts, cached ───────────────────────────────────────────────

const INTERNAL_TTL_MS = 60_000;
let internalCache: { emails: Set<string>; at: number } | null = null;

async function internalEmailsFromTable(db: Db): Promise<Set<string>> {
  if (internalCache && Date.now() - internalCache.at < INTERNAL_TTL_MS) return internalCache.emails;
  const { data, error } = await db.from('internal_accounts').select('email');
  if (error) {
    console.error('[onboarding] internal_accounts read failed', error.message);
    return internalCache?.emails ?? new Set();
  }
  const emails = new Set((data ?? []).map((row) => row.email.toLowerCase()));
  internalCache = { emails, at: Date.now() };
  return emails;
}

/**
 * Whether an address is one of ours, by every rule internal-accounts.ts knows
 * plus the public.internal_accounts table. For the viewer-level gates (the
 * Settings reset button, POST /api/onboarding {reset}).
 */
export async function isInternalViewer(email: string | null, db?: Db): Promise<boolean> {
  if (!email) return false;
  if (isInternalAccount(email)) return true;
  try {
    return isInternalAccount(email, await internalEmailsFromTable(db ?? createServiceRoleClient()));
  } catch {
    return false;
  }
}

function createOnboardingStore(db: Db): OnboardingExperimentStore {
  const base = createExperimentStore(db);
  return {
    getExperiment: base.getExperiment.bind(base),
    assign: base.assign.bind(base),
    async readAssignment(key, subjectId) {
      const { data, error } = await db
        .from('experiment_assignments')
        .select('variant_id')
        .eq('experiment_key', key)
        .eq('subject_id', subjectId)
        .maybeSingle();
      if (error) {
        console.error('[onboarding] assignment read failed', { key, error: error.message });
        return null;
      }
      return data?.variant_id ?? null;
    },
  };
}

async function workspaceFacts(db: Db, workspaceId: string): Promise<{ ownerEmail: string | null; createdAt: string | null }> {
  const { data: workspace } = await db
    .from('workspaces')
    .select('owner_id, created_at')
    .eq('id', workspaceId)
    .maybeSingle();
  if (!workspace) return { ownerEmail: null, createdAt: null };
  const { data: owner } = await db.from('users').select('email').eq('id', workspace.owner_id).maybeSingle();
  return { ownerEmail: owner?.email ?? null, createdAt: workspace.created_at ?? null };
}

/**
 * One key's arm for a non-internal workspace with public enrollment on.
 * Returns [variantId, enrolled].
 */
async function armFor(
  key: string,
  subject: string,
  control: string,
  isNew: boolean,
  store: OnboardingExperimentStore,
): Promise<[string, boolean]> {
  let experiment = null;
  try {
    experiment = await store.getExperiment(key);
  } catch {
    experiment = null;
  }
  if (!experiment) return [control, false];
  if (experiment.status === 'concluded' && experiment.winner_variant_id) return [experiment.winner_variant_id, false];
  if (experiment.status !== 'running') return [control, false];
  if (isNew) {
    const decision = await resolveVariant({ experiment, subjectId: subject, fallback: control, assign: store.assign.bind(store) });
    return [decision.variantId, decision.reason === 'assigned'];
  }
  const stored = await store.readAssignment(key, subject);
  return stored ? [stored, true] : [control, false];
}

/**
 * The onboarding arms for a workspace. Never throws: any failure is the
 * control, which is today's product.
 */
export async function getOnboardingVariant(
  workspaceId: string | null | undefined,
  ctx: OnboardingVariantContext = {},
): Promise<OnboardingAssignment> {
  const control: OnboardingAssignment = { ...CONTROL_VARIANT, internal: false, enrolled: false };
  const subject = onboardingSubject(workspaceId);
  if (!subject || !workspaceId) return control;
  try {
    const db = ctx.db ?? createServiceRoleClient();
    let ownerEmail = ctx.ownerEmail ?? null;
    let createdAt = ctx.workspaceCreatedAt ?? null;
    if (ownerEmail === null || createdAt === null) {
      const facts = await workspaceFacts(db, workspaceId);
      ownerEmail = ownerEmail ?? facts.ownerEmail;
      createdAt = createdAt ?? facts.createdAt;
    }

    const internalEmails = ctx.internalEmails ?? (await internalEmailsFromTable(db));
    if (isInternalAccount(ownerEmail, internalEmails)) {
      return { ...INTERNAL_VARIANT, internal: true, enrolled: false };
    }

    const publicEnrollment = ctx.publicEnrollment ?? onboardingPublicEnrollment();
    if (!publicEnrollment) return control;

    const now = ctx.now ?? Date.now();
    const created = createdAt ? Date.parse(createdAt) : NaN;
    const isNew = Number.isFinite(created) && now - created >= 0 && now - created < ENROLL_WINDOW_MS;
    const store = ctx.store ?? createOnboardingStore(db);

    const [[flow, flowEnrolled], [convert, convertEnrolled]] = await Promise.all([
      armFor(ONB_FLOW_KEY, subject, CONTROL_VARIANT.flow, isNew, store),
      armFor(ONB_CONVERT_KEY, subject, CONTROL_VARIANT.convert, isNew, store),
    ]);
    return {
      flow: flow === 'new' ? 'new' : 'control',
      convert: convert === 'on' ? 'on' : 'off',
      internal: false,
      enrolled: flowEnrolled || convertEnrolled,
    };
  } catch (error) {
    console.error('[onboarding] variant lookup failed, serving control', error instanceof Error ? error.message : String(error));
    return control;
  }
}

/**
 * The creation-time call, for the signup and /authorize paths. Same as
 * getOnboardingVariant; named separately so the call sites read as "assign
 * here" and a grep finds every entry path. Only for the OWNER's own new
 * workspace: an invited member joining someone else's workspace is not a new
 * workspace and must not be passed here.
 */
export async function assignOnboardingAtSignup(
  workspaceId: string | null | undefined,
  ctx: OnboardingVariantContext = {},
): Promise<OnboardingAssignment> {
  return getOnboardingVariant(workspaceId, ctx);
}
