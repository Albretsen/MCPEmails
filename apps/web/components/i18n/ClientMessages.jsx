import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';

/**
 * Hands the browser only the message namespaces a part of the marketing site
 * actually reads on the client.
 *
 * WHY. Whatever a NextIntlClientProvider receives as `messages` is serialised
 * into the HTML of every page below it. The root layout used to pass all
 * twelve marketing namespaces to every route in the app, about 180 KB of JSON
 * per document, although most of that copy is rendered by Server Components
 * (which read it on the server through getTranslations and need nothing sent)
 * and the app and auth screens read none of it at all.
 *
 * This is a Server Component: it picks the listed namespaces out of the
 * request's messages, the same object the root layout used to pass on, and
 * renders the provider with just those. Locale, time zone and formats are
 * resolved exactly as before.
 *
 * RULES, enforced by scripts/i18n-coverage (npm run test:i18n-coverage):
 *
 *  - Use it only in a layout file, with a literal `namespaces={[...]}` list.
 *  - A nested provider REPLACES the one above it, it does not add to it. A
 *    layout that needs `docs` on top of the shared `home` and `compare` must
 *    list all three.
 *  - Every namespace that client code under the layout can reach through
 *    the useTranslations hook must be listed. A missing one renders
 *    the raw key ("pricing.hero.title") in front of the visitor; the coverage
 *    test fails the build before that can happen.
 *
 * Server Components are unaffected by any of this: getTranslations() always
 * sees every namespace src/i18n/request.ts loads.
 *
 * @param {{ namespaces: string[], children: import('react').ReactNode }} props
 */
export default async function ClientMessages({ namespaces, children }) {
  const all = await getMessages();
  const messages = {};
  for (const namespace of namespaces) {
    if (!(namespace in all)) {
      throw new Error(`ClientMessages: "${namespace}" is not a namespace src/i18n/request.ts loads`);
    }
    messages[namespace] = all[namespace];
  }
  return <NextIntlClientProvider messages={messages}>{children}</NextIntlClientProvider>;
}
