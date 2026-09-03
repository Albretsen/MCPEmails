import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin/require-admin';
import { OVERRIDE_COOKIE, SUBJECT_COOKIE_MAX_AGE_SECONDS } from '@/lib/experiments/constants';
import { parseOverrideCookie, serializeOverrideCookie } from '@/lib/experiments/cookies';

/**
 * POST /admin/growth/experiments/override
 *
 * Pins THIS browser to one variant of one experiment, or clears the pin.
 *
 * The override is a cookie and only a cookie. It is read by resolveVariant
 * ahead of the hash, and it is deliberately never written to
 * experiment_assignments: an operator checking what the video variant looks
 * like must not appear in the counts as a visitor who was shown it. That is
 * also why this is a separate route from the ones that edit the experiment
 * itself, and why the panel says so next to the control.
 *
 * The map is merged rather than replaced, so pinning one experiment does not
 * silently release another.
 */

const PAGE = '/admin/growth/experiments';

export async function POST(request: NextRequest): Promise<NextResponse> {
  await requireAdmin();
  let key = '';
  try {
    const form = await request.formData();
    const rawKey = form.get('key');
    const rawVariant = form.get('variant_id');
    key = typeof rawKey === 'string' ? rawKey.trim() : '';
    const variantId = typeof rawVariant === 'string' ? rawVariant.trim() : '';
    if (!key) throw new Error('An experiment key is required.');

    const map = parseOverrideCookie(request.cookies.get(OVERRIDE_COOKIE)?.value);
    if (variantId) {
      map[key] = variantId;
    } else {
      // The empty option is "follow the public split", which is the absence of
      // an entry rather than an entry meaning nothing.
      delete map[key];
    }

    const response = NextResponse.redirect(
      new URL(`${PAGE}?ok=${variantId ? 'override' : 'override-cleared'}#${key}`, request.url),
      { status: 303 },
    );
    response.cookies.set(OVERRIDE_COOKIE, serializeOverrideCookie(map), {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SUBJECT_COOKIE_MAX_AGE_SECONDS,
      secure: request.nextUrl.protocol === 'https:',
    });
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not set the override.';
    return NextResponse.redirect(
      new URL(`${PAGE}?error=${encodeURIComponent(message)}${key ? `#${key}` : ''}`, request.url),
      { status: 303 },
    );
  }
}
