import { requireAdmin } from '@/lib/admin/require-admin';

/**
 * Access control for the wall-mounted kiosk view of /admin/growth.
 *
 * The kiosk runs on a Raspberry Pi that boots straight into Chromium with no
 * keyboard attached, so it can never complete an interactive Supabase login.
 * `requireAdmin()` alone would make the display permanently 404, which is why
 * a second door exists: a single high-entropy shared secret in `KIOSK_TOKEN`,
 * presented as `?k=`.
 *
 * Three properties keep that door narrow.
 *
 * 1. IT IS OFF UNLESS CONFIGURED. An unset or empty `KIOSK_TOKEN` disables
 *    token access entirely rather than accepting an empty `?k=`, so a
 *    misconfigured preview deployment does not silently publish the numbers.
 * 2. IT ONLY OPENS THE KIOSK. Nothing else calls this helper; every other
 *    admin route still requires a real operator session.
 * 3. THE KIOSK SHOWS NO IDENTITY. The page this guards renders aggregates
 *    only, deliberately omitting the Active accounts roster that is the one
 *    part of /admin/growth carrying workspace names and owner email
 *    addresses. Someone holding the token learns counts, never customers.
 *
 * Comparison is constant time. The saving is theoretical at this traffic
 * level, but a token check that leaks its prefix through timing is the kind of
 * thing that gets copied into somewhere it matters.
 */
export async function requireKioskAccess(token: string | undefined): Promise<void> {
  const expected = process.env.KIOSK_TOKEN?.trim();

  if (expected && token && timingSafeEqual(token, expected)) return;

  // No usable token: fall back to a normal operator session, so an admin can
  // open the kiosk view in their own browser to check how it looks.
  // `requireAdmin()` calls notFound() itself when that fails.
  await requireAdmin();
}

/**
 * Constant-time string compare, in the sense that matters: the loop always
 * runs to the end rather than returning early at the first differing byte, so
 * response time does not reveal how much of the secret a guess got right.
 *
 * It does not hide the *length* of the supplied value, which is fine: the
 * length of the guess is the attacker's own input, and the length of the
 * secret is folded in by the initial XOR rather than by an early return.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}
