/**
 * GET /api/support/help-data?locale=xx: everything the dashboard's help
 * section (/dashboard/help) needs to render the help center client-side.
 *
 *   GET     200 { email, signedIn, signedInEmail, context, formToken, form,
 *                 ticketCategories, locale, index, categories, copy }
 *   other   405
 *
 * The dashboard's locale lives in the browser, not the URL, and a section
 * switch is a client-side render, so the section asks for its data here rather
 * than through the server page. `topic`, `provider`, `code` and `from` seed the
 * contact form exactly as they do on /help.
 */
import { getTicketContextPreview } from '@/lib/support/context';
import { issueSupportFormToken } from '@/lib/support/form-token';
import { getHelpCenterData, seedContactForm } from '@/lib/support/help-center-data.mjs';
import { SUPPORT_CATEGORIES } from '@/lib/support/help-content.mjs';
import { SUPPORT_EMAIL } from '@/lib/support/help-links.mjs';
import { supportJson, supportMethodNotAllowed } from '@/lib/support/http';
import { getSupportViewer } from '@/lib/support/viewer';

export async function GET(request: Request): Promise<Response> {
  const viewer = await getSupportViewer();
  const params = new URL(request.url).searchParams;
  const data = await getHelpCenterData(params.get('locale') ?? 'en', { inApp: true });
  const seed = seedContactForm(
    {
      topic: params.get('topic'),
      provider: params.get('provider'),
      code: params.get('code'),
      from: params.get('from'),
    },
    data.copy,
  );
  const baseContext = viewer.user ? await getTicketContextPreview(viewer.user.id) : null;
  const context = baseContext ? { ...baseContext, ...seed.meta } : null;

  return supportJson(
    {
      email: SUPPORT_EMAIL,
      signedIn: viewer.user !== null,
      signedInEmail: viewer.user?.email ?? null,
      context,
      formToken: issueSupportFormToken(),
      form: seed,
      ticketCategories: SUPPORT_CATEGORIES,
      locale: data.locale,
      index: data.index,
      categories: data.categories,
      copy: data.copy,
    },
    200,
  );
}

async function otherMethod(): Promise<Response> {
  return supportMethodNotAllowed('GET');
}

export const HEAD = otherMethod;
export const POST = otherMethod;
export const PUT = otherMethod;
export const PATCH = otherMethod;
export const DELETE = otherMethod;
export const OPTIONS = otherMethod;
