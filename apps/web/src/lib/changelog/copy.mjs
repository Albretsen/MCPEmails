/**
 * Page chrome for /changelog, in every locale.
 *
 * Deliberately not a next-intl namespace, for the same reason the provider
 * pages keep their copy in src/lib/connect/content: the root layout hands every
 * loaded namespace to NextIntlClientProvider, so anything under `messages/` is
 * serialised into the HTML of every marketing page. This bundle is read on the
 * server by the one page that needs it.
 *
 * Only the chrome is translated. The entries themselves stay in English (see
 * ./entries.mjs) because they are terse notes about a product that ships several
 * times a week, and a stale machine translation of a line about SMTP
 * authentication is worse than the English line.
 *
 * No angle brackets anywhere in here. These strings are rendered as plain text
 * today, but next-intl unescapes a literal `'<'` in development and renders it
 * literally in production, and the cheapest way never to meet that again is to
 * word around it.
 */

const COPY = {
  en: {
    meta: {
      title: 'Changelog',
      description:
        'Everything that has shipped in MCP Emails, newest first: new capabilities, provider fixes, and billing and pricing changes, with the date each one went live.',
    },
    eyebrow: 'Changelog',
    title: 'What has shipped',
    lead: 'Every user-visible change, newest first, dated the day it went live. Internal work is left out.',
    kinds: { added: 'New', improved: 'Improved', fixed: 'Fixed', changed: 'Changed' },
    footnote: 'Something missing or broken? Write to',
  },
  nb: {
    meta: {
      title: 'Endringslogg',
      description:
        'Alt som er lansert i MCP Emails, nyeste først: nye funksjoner, rettelser hos e-postleverandører og endringer i pris og fakturering, med datoen hver enkelt gikk live.',
    },
    eyebrow: 'Endringslogg',
    title: 'Dette er lansert',
    lead: 'Alle endringer brukerne merker, nyeste først, datert dagen de gikk live. Internt arbeid er utelatt.',
    kinds: { added: 'Nytt', improved: 'Forbedret', fixed: 'Rettet', changed: 'Endret' },
    footnote: 'Mangler noe, eller er noe ødelagt? Skriv til',
  },
  es: {
    meta: {
      title: 'Novedades',
      description:
        'Todo lo que se ha publicado en MCP Emails, lo más reciente primero: nuevas funciones, correcciones por proveedor y cambios de precio y facturación, con la fecha en que se activó cada uno.',
    },
    eyebrow: 'Novedades',
    title: 'Lo que hemos publicado',
    lead: 'Cada cambio visible para el usuario, lo más reciente primero, con la fecha en que se activó. El trabajo interno no aparece.',
    kinds: { added: 'Nuevo', improved: 'Mejorado', fixed: 'Corregido', changed: 'Cambiado' },
    footnote: '¿Falta algo o algo no funciona? Escribe a',
  },
  fr: {
    meta: {
      title: 'Journal des versions',
      description:
        'Tout ce qui a été livré dans MCP Emails, du plus récent au plus ancien : nouvelles fonctions, correctifs par fournisseur et changements de tarif et de facturation, avec la date de mise en ligne.',
    },
    eyebrow: 'Journal des versions',
    title: 'Ce qui a été livré',
    lead: 'Chaque changement visible pour les utilisateurs, du plus récent au plus ancien, daté du jour de sa mise en ligne. Le travail interne est exclu.',
    kinds: { added: 'Nouveau', improved: 'Amélioré', fixed: 'Corrigé', changed: 'Modifié' },
    footnote: 'Il manque quelque chose, ou quelque chose ne marche pas ? Écrivez à',
  },
  zh: {
    meta: {
      title: '更新日志',
      description:
        'MCP Emails 已上线的全部更新，按时间倒序排列：新增功能、各邮箱服务商的修复，以及价格与账单方面的调整，并标注每项更新的上线日期。',
    },
    eyebrow: '更新日志',
    title: '已经上线的更新',
    lead: '所有用户可见的变更，按时间倒序排列，日期为实际上线当天。内部工作不在此列。',
    kinds: { added: '新增', improved: '改进', fixed: '修复', changed: '调整' },
    footnote: '有遗漏或发现问题？请联系',
  },
};

/** Chrome copy for a locale, falling back to English for anything unknown. */
export function getChangelogCopy(locale) {
  return COPY[locale] ?? COPY.en;
}
