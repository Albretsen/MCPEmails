import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin/require-admin';
import { getExperimentRecord, updateExperiment } from '@/lib/experiments/admin';
import type { RetentionGoal } from '@/lib/experiments/constants';

/**
 * POST /admin/growth/experiments/[key]/update
 *
 * One route for every edit an experiment card can make, selected by a hidden
 * `intent` field. Six small routes would each need the same admin check, the
 * same 303 back to the same page, and the same error handling, and the thing
 * that actually differs between them is two lines.
 *
 * Every branch ends in a redirect, including the failures: a form post that
 * rendered its own error page would lose the rest of the panel, and the
 * operator would have to navigate back to see whether anything else changed.
 * The message is carried in `?error=` and printed at the top of the page.
 *
 * WHAT THIS ROUTE DOES NOT DECIDE. Which status transitions are legal, and
 * whether a set of weights is valid, both live in lib/experiments/admin.ts
 * next to the writes they guard. This file parses strings and nothing else.
 */

const PAGE = '/admin/growth/experiments';
const GOALS: RetentionGoal[] = ['mailbox_activity', 'any_tool_call', 'value_activation'];

function text(form: FormData, field: string): string {
  const value = form.get(field);
  return typeof value === 'string' ? value.trim() : '';
}

/** Number() with a message a human can act on, because the panel prints it. */
function count(raw: string, field: string): number {
  const parsed = Number(raw);
  if (raw === '' || Number.isNaN(parsed)) throw new Error(`${field} must be a whole number.`);
  return parsed;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
): Promise<NextResponse> {
  await requireAdmin();
  const { key } = await params;
  try {
    const form = await request.formData();
    const intent = text(form, 'intent');

    if (intent === 'weights') {
      // The variant ids come from the stored row, never from the form, so a
      // hand-edited post cannot introduce a variant that does not exist.
      const experiment = await getExperimentRecord(key);
      if (!experiment) throw new Error(`No experiment with the key "${key}".`);
      const variants = experiment.variants.map((variant) => ({
        ...variant,
        weight: count(text(form, `weight_${variant.id}`), `Weight for "${variant.label}"`),
      }));
      await updateExperiment(key, { variants });
    } else if (intent === 'details') {
      const name = text(form, 'name');
      if (!name) throw new Error('A name is required.');
      const goal = text(form, 'retention_goal');
      if (!GOALS.includes(goal as RetentionGoal)) throw new Error(`Unknown retention goal "${goal}".`);
      const description = text(form, 'description');
      await updateExperiment(key, {
        name,
        description: description || null,
        retention_goal: goal as RetentionGoal,
        retention_window_days: count(text(form, 'retention_window_days'), 'Retention window'),
      });
    } else if (intent === 'start' || intent === 'reopen') {
      await updateExperiment(key, { status: 'running' });
    } else if (intent === 'pause') {
      await updateExperiment(key, { status: 'draft' });
    } else if (intent === 'conclude') {
      const winner = text(form, 'winner_variant_id');
      if (!winner) throw new Error('Pick the winning variant before concluding.');
      await updateExperiment(key, { status: 'concluded', winner_variant_id: winner });
    } else {
      throw new Error(`Unknown action "${intent}".`);
    }

    return NextResponse.redirect(new URL(`${PAGE}?ok=${encodeURIComponent(intent)}#${key}`, request.url), {
      status: 303,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not update the experiment.';
    return NextResponse.redirect(
      new URL(`${PAGE}?error=${encodeURIComponent(message)}#${key}`, request.url),
      { status: 303 },
    );
  }
}
