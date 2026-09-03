import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin/require-admin';
import { createExperiment } from '@/lib/experiments/admin';
import type { ExperimentVariant, RetentionGoal } from '@/lib/experiments/constants';

/**
 * POST /admin/growth/experiments/create
 *
 * A plain form target, not a Server Action: the action-ID lookup failed on
 * every submission in production on this app (verified 2026-08-30), and the
 * whole experiments panel is built on route handlers for that reason.
 *
 * The variant rows arrive as three parallel repeated fields, which is what a
 * form without JavaScript can send. Rows whose id is blank are the empty
 * spares on the form and are dropped before anything is validated, so the
 * operator does not have to delete the rows they did not use.
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

function goal(raw: string): RetentionGoal {
  if (!GOALS.includes(raw as RetentionGoal)) throw new Error(`Unknown retention goal "${raw}".`);
  return raw as RetentionGoal;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  await requireAdmin();
  let key = '';
  try {
    const form = await request.formData();
    key = text(form, 'key');
    const name = text(form, 'name');
    const description = text(form, 'description');
    if (!key) throw new Error('A key is required.');
    if (!name) throw new Error('A name is required.');

    const ids = form.getAll('variant_id[]').map((value) => String(value).trim());
    const labels = form.getAll('variant_label[]').map((value) => String(value).trim());
    const weights = form.getAll('variant_weight[]').map((value) => String(value).trim());

    const variants: ExperimentVariant[] = [];
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      // An empty id is an unused spare row on the form, not a mistake.
      if (!id) continue;
      const label = labels[index] ?? '';
      if (!label) throw new Error(`Variant "${id}" needs a label.`);
      variants.push({ id, label, weight: count(weights[index] ?? '', `Weight for "${id}"`) });
    }
    if (variants.length === 0) throw new Error('At least one variant is required.');

    await createExperiment({
      key,
      name,
      description: description || undefined,
      variants,
      retention_goal: goal(text(form, 'retention_goal') || 'mailbox_activity'),
      retention_window_days: count(text(form, 'retention_window_days') || '7', 'Retention window'),
    });

    return NextResponse.redirect(new URL(`${PAGE}?ok=create#${key}`, request.url), { status: 303 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not create the experiment.';
    return NextResponse.redirect(
      new URL(`${PAGE}?error=${encodeURIComponent(message)}`, request.url),
      { status: 303 },
    );
  }
}
