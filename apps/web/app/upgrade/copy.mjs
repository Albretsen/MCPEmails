/**
 * Copy for /upgrade/done and /upgrade/expired, the two pages a chat checkout
 * link (app/u/[token]/route.ts) can land on, in every locale.
 *
 * A module next to the pages rather than a `messages/` namespace, per
 * apps/web/CLAUDE.md: every `messages/` namespace is serialised into marketing
 * pages, and these strings are read by two small pages only. They are picked
 * on the server and handed to the one client component as plain props.
 *
 * WHICH LANGUAGE. These routes are outside app/[locale] and the buyer was never
 * signed in, so there is no stored choice to read. The browser's
 * Accept-Language decides, matched the way LocaleCore.jsx matches
 * navigator.languages, and anything unrecognised is English.
 *
 * WHAT IT SAYS. Status only: whether Personal is active, and what to do next
 * (go back to the chat and say continue). No price, no plan details, no email,
 * nothing about the workspace: the success page is public and its URL carries
 * a session id. The word to say is localized; the model in the chat reads it in
 * any language.
 *
 * STYLE. Straight quotes, no em dashes, no angle brackets.
 */

export const UPGRADE_LOCALES = /** @type {const} */ (['en', 'nb', 'es', 'fr', 'de', 'pt', 'ja', 'zh']);

const COPY = {
  en: {
    doneMetaTitle: 'Upgrade',
    expiredMetaTitle: 'Checkout link expired',
    activeTitle: 'Personal is active',
    activeBody: 'Go back to your chat and say "continue". The request that was stopped will run now.',
    activatingTitle: 'Payment received, activating...',
    activatingBody: 'This usually takes a few seconds. When Personal is active, go back to your chat and say "continue".',
    slowBody: 'This is taking longer than usual. Refresh the page in a minute, or sign in to check your plan.',
    signIn: 'Sign in to your dashboard',
    expiredTitle: 'This checkout link has expired',
    expiredBody: 'Checkout links from a chat work for 30 minutes. All plans are on the pricing page, and you can upgrade from your dashboard.',
    subscribedTitle: 'This account already has a plan',
    subscribedBody: 'Sign in to manage it from your dashboard.',
    errorTitle: 'This checkout could not be opened',
    errorBody: 'Something went wrong on our side. Plans are on the pricing page, or sign in and upgrade from your dashboard.',
    seePlans: 'See plans',
  },
  nb: {
    doneMetaTitle: 'Oppgradering',
    expiredMetaTitle: 'Betalingslenken har utløpt',
    activeTitle: 'Personal er aktivert',
    activeBody: 'Gå tilbake til chatten og skriv "fortsett". Forespørselen som ble stoppet, kjøres nå.',
    activatingTitle: 'Betaling mottatt, aktiverer...',
    activatingBody: 'Dette tar vanligvis noen sekunder. Når Personal er aktivert, går du tilbake til chatten og skriver "fortsett".',
    slowBody: 'Dette tar lengre tid enn vanlig. Last inn siden på nytt om et minutt, eller logg inn for å se planen din.',
    signIn: 'Logg inn på dashbordet',
    expiredTitle: 'Denne betalingslenken har utløpt',
    expiredBody: 'Betalingslenker fra en chat virker i 30 minutter. Alle planene står på prissiden, og du kan oppgradere fra dashbordet.',
    subscribedTitle: 'Denne kontoen har allerede en plan',
    subscribedBody: 'Logg inn for å administrere den fra dashbordet.',
    errorTitle: 'Vi fikk ikke åpnet betalingen',
    errorBody: 'Noe gikk galt hos oss. Planene står på prissiden, eller du kan logge inn og oppgradere fra dashbordet.',
    seePlans: 'Se planer',
  },
  es: {
    doneMetaTitle: 'Cambio de plan',
    expiredMetaTitle: 'Enlace de pago caducado',
    activeTitle: 'Personal está activo',
    activeBody: 'Vuelve a tu chat y escribe "continuar". La solicitud que se detuvo se ejecutará ahora.',
    activatingTitle: 'Pago recibido, activando...',
    activatingBody: 'Suele tardar unos segundos. Cuando Personal esté activo, vuelve a tu chat y escribe "continuar".',
    slowBody: 'Está tardando más de lo habitual. Recarga la página dentro de un minuto o inicia sesión para ver tu plan.',
    signIn: 'Iniciar sesión en el panel',
    expiredTitle: 'Este enlace de pago ha caducado',
    expiredBody: 'Los enlaces de pago que llegan por un chat funcionan durante 30 minutos. Todos los planes están en la página de precios, y puedes mejorar tu plan desde el panel.',
    subscribedTitle: 'Esta cuenta ya tiene un plan',
    subscribedBody: 'Inicia sesión para gestionarlo desde el panel.',
    errorTitle: 'No se pudo abrir el pago',
    errorBody: 'Algo ha fallado por nuestra parte. Los planes están en la página de precios, o puedes iniciar sesión y mejorar tu plan desde el panel.',
    seePlans: 'Ver planes',
  },
  fr: {
    doneMetaTitle: "Changement d'offre",
    expiredMetaTitle: 'Lien de paiement expiré',
    activeTitle: 'Personal est actif',
    activeBody: 'Retournez dans votre chat et écrivez "continuer". La demande qui a été bloquée va maintenant s\'exécuter.',
    activatingTitle: 'Paiement reçu, activation en cours...',
    activatingBody: 'Cela prend généralement quelques secondes. Une fois Personal actif, retournez dans votre chat et écrivez "continuer".',
    slowBody: "Cela prend plus de temps que d'habitude. Actualisez la page dans une minute, ou connectez-vous pour vérifier votre offre.",
    signIn: 'Se connecter au tableau de bord',
    expiredTitle: 'Ce lien de paiement a expiré',
    expiredBody: "Les liens de paiement envoyés dans un chat sont valables 30 minutes. Toutes les offres figurent sur la page des tarifs, et vous pouvez passer à une offre supérieure depuis votre tableau de bord.",
    subscribedTitle: 'Ce compte a déjà une offre',
    subscribedBody: 'Connectez-vous pour la gérer depuis votre tableau de bord.',
    errorTitle: "Impossible d'ouvrir le paiement",
    errorBody: 'Un problème est survenu de notre côté. Les offres figurent sur la page des tarifs, ou connectez-vous pour changer d\'offre depuis votre tableau de bord.',
    seePlans: 'Voir les offres',
  },
  de: {
    doneMetaTitle: 'Upgrade',
    expiredMetaTitle: 'Bezahllink abgelaufen',
    activeTitle: 'Personal ist aktiv',
    activeBody: 'Kehren Sie zu Ihrem Chat zurück und schreiben Sie "weiter". Die angehaltene Anfrage wird jetzt ausgeführt.',
    activatingTitle: 'Zahlung erhalten, wird aktiviert...',
    activatingBody: 'Das dauert meist nur wenige Sekunden. Sobald Personal aktiv ist, kehren Sie zu Ihrem Chat zurück und schreiben Sie "weiter".',
    slowBody: 'Das dauert länger als üblich. Laden Sie die Seite in einer Minute neu oder melden Sie sich an, um Ihren Tarif zu prüfen.',
    signIn: 'Im Dashboard anmelden',
    expiredTitle: 'Dieser Bezahllink ist abgelaufen',
    expiredBody: 'Bezahllinks aus einem Chat gelten 30 Minuten. Alle Tarife finden Sie auf der Preisseite, und im Dashboard können Sie jederzeit upgraden.',
    subscribedTitle: 'Dieses Konto hat bereits einen Tarif',
    subscribedBody: 'Melden Sie sich an, um ihn im Dashboard zu verwalten.',
    errorTitle: 'Der Bezahlvorgang konnte nicht geöffnet werden',
    errorBody: 'Bei uns ist etwas schiefgelaufen. Alle Tarife finden Sie auf der Preisseite, oder Sie melden sich an und upgraden im Dashboard.',
    seePlans: 'Tarife ansehen',
  },
  pt: {
    doneMetaTitle: 'Upgrade',
    expiredMetaTitle: 'Link de pagamento expirado',
    activeTitle: 'Personal está ativo',
    activeBody: 'Volte para o seu chat e escreva "continuar". A solicitação que foi interrompida vai rodar agora.',
    activatingTitle: 'Pagamento recebido, ativando...',
    activatingBody: 'Isso costuma levar alguns segundos. Quando o Personal estiver ativo, volte para o seu chat e escreva "continuar".',
    slowBody: 'Está demorando mais que o normal. Atualize a página daqui a um minuto ou entre na sua conta para conferir o seu plano.',
    signIn: 'Entrar no painel',
    expiredTitle: 'Este link de pagamento expirou',
    expiredBody: 'Links de pagamento enviados em um chat valem por 30 minutos. Todos os planos estão na página de preços, e você pode fazer o upgrade pelo painel.',
    subscribedTitle: 'Esta conta já tem um plano',
    subscribedBody: 'Entre na sua conta para gerenciá-lo pelo painel.',
    errorTitle: 'Não foi possível abrir o pagamento',
    errorBody: 'Algo deu errado do nosso lado. Os planos estão na página de preços, ou entre na sua conta e faça o upgrade pelo painel.',
    seePlans: 'Ver planos',
  },
  ja: {
    doneMetaTitle: 'アップグレード',
    expiredMetaTitle: 'お支払いリンクの有効期限切れ',
    activeTitle: 'Personalが有効になりました',
    activeBody: 'チャットに戻って「続けて」と入力してください。止まっていたリクエストがこれで実行されます。',
    activatingTitle: 'お支払いを確認しました。有効化しています...',
    activatingBody: '通常は数秒で完了します。Personalが有効になったら、チャットに戻って「続けて」と入力してください。',
    slowBody: '通常より時間がかかっています。1分ほどしてからページを再読み込みするか、ログインしてプランを確認してください。',
    signIn: 'ダッシュボードにログイン',
    expiredTitle: 'このお支払いリンクは有効期限が切れています',
    expiredBody: 'チャットから届くお支払いリンクの有効期間は30分です。すべてのプランは料金ページに掲載しており、ダッシュボードからアップグレードできます。',
    subscribedTitle: 'このアカウントにはすでにプランがあります',
    subscribedBody: 'ログインして、ダッシュボードから管理してください。',
    errorTitle: 'お支払いページを開けませんでした',
    errorBody: '当社側で問題が発生しました。プランは料金ページでご確認いただけます。ログインしてダッシュボードからアップグレードすることもできます。',
    seePlans: 'プランを見る',
  },
  zh: {
    doneMetaTitle: '升级',
    expiredMetaTitle: '付款链接已过期',
    activeTitle: 'Personal 已开通',
    activeBody: '请回到聊天中并输入"继续"。刚才被拦下的请求现在会执行。',
    activatingTitle: '已收到付款，正在开通...',
    activatingBody: '通常只需几秒钟。Personal 开通后，请回到聊天中并输入"继续"。',
    slowBody: '这次比平常慢。请一分钟后刷新页面，或登录查看你的套餐。',
    signIn: '登录控制台',
    expiredTitle: '此付款链接已过期',
    expiredBody: '聊天中的付款链接有效期为 30 分钟。所有套餐都在价格页面上，你也可以在控制台中升级。',
    subscribedTitle: '此账户已有套餐',
    subscribedBody: '请登录，在控制台中管理。',
    errorTitle: '无法打开付款页面',
    errorBody: '我们这边出了点问题。套餐信息在价格页面上，你也可以登录后在控制台中升级。',
    seePlans: '查看套餐',
  },
};

/**
 * The first supported language in an Accept-Language header, in the header's
 * order (q-values are not re-sorted: browsers already send them descending).
 *
 * @param {string | null | undefined} header
 * @returns {(typeof UPGRADE_LOCALES)[number]}
 */
export function upgradeLocale(header) {
  for (const part of String(header ?? '').split(',')) {
    const low = part.split(';')[0].trim().toLowerCase();
    if (low.startsWith('nb') || low.startsWith('no') || low.startsWith('nn')) return 'nb';
    if (low.startsWith('es')) return 'es';
    if (low.startsWith('fr')) return 'fr';
    if (low.startsWith('de')) return 'de';
    if (low.startsWith('pt')) return 'pt';
    if (low.startsWith('ja')) return 'ja';
    if (low.startsWith('zh')) return 'zh';
    if (low.startsWith('en')) return 'en';
  }
  return 'en';
}

/** @param {string} locale */
export function upgradeCopy(locale) {
  return COPY[locale] ?? COPY.en;
}

/** The pricing page in the reader's language (en is unprefixed). */
export function pricingPath(locale) {
  return locale === 'en' ? '/pricing' : `/${locale}/pricing`;
}

/** Exported for the tests, which check every locale for banned wording and parity. */
export const UPGRADE_COPY = COPY;
