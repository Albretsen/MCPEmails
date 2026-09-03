/**
 * Names, shapes and one experiment definition, shared by every layer of the
 * experiments system: the proxy (which only ever sees the cookie names), the
 * server components that ask for a variant, the admin panel, and the tests.
 *
 * Nothing here imports anything. The proxy runs in the Next.js middleware
 * runtime, so the modules it pulls in must stay free of Node and Supabase.
 */

/** First-party cookie holding the anonymous visitor id. 32 lowercase hex. */
export const SUBJECT_COOKIE = 'mx_subject';
/** Admin-only cookie pinning specific experiments to a chosen variant. */
export const OVERRIDE_COOKIE = 'mx_exp_override';
/**
 * Request header the proxy uses to hand the subject id to the render on the
 * very first request, before the browser has echoed the cookie back.
 */
export const SUBJECT_HEADER = 'x-experiment-subject';
/** One year. A visitor who returns in March is still the same subject. */
export const SUBJECT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
/** The only shape a subject id is ever allowed to have. */
export const SUBJECT_ID_PATTERN = /^[a-f0-9]{32}$/;
/** The only shape a variant id is ever allowed to have. */
export const VARIANT_ID_PATTERN = /^[a-z0-9_]{1,32}$/;

/** The first experiment. Keys are referenced from code, so they get a constant. */
export const HOMEPAGE_DEMO_VIDEO = {
  key: 'homepage_demo_video',
  variants: { control: 'control', video: 'video' },
} as const;

export interface ExperimentVariant {
  id: string;
  label: string;
  weight: number;
}

export type ExperimentStatus = 'draft' | 'running' | 'concluded';

export type RetentionGoal = 'mailbox_activity' | 'any_tool_call' | 'value_activation';

export interface ExperimentRecord {
  key: string;
  name: string;
  description: string | null;
  status: ExperimentStatus;
  variants: ExperimentVariant[];
  winner_variant_id: string | null;
  retention_goal: RetentionGoal;
  retention_window_days: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  concluded_at: string | null;
}

export interface ExperimentVariantStats {
  variant_id: string;
  assigned: number;
  signed_up: number;
  converted: number;
  retention_eligible: number;
  retained: number;
}

/**
 * What a variant lookup decided, and why. The reason is what makes the admin
 * panel honest: "you are seeing control because the experiment is a draft" is
 * a different fact from "you are seeing control because you were bucketed".
 */
export interface VariantDecision {
  variantId: string;
  reason: 'winner' | 'override' | 'draft' | 'assigned' | 'unknown';
}
