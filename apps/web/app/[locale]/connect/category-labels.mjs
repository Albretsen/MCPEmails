/**
 * The section headings of the /connect hub, one per PROVIDER_CATEGORIES id in
 * src/lib/connect/providers.mjs, in every locale.
 *
 * A module next to the page rather than a `messages/` namespace, per
 * apps/web/CLAUDE.md: every `messages/` namespace is serialised into every
 * marketing page, and these ten strings are read by this one page. The ids and
 * anchors stay in providers.mjs (they are URLs); only the words live here.
 *
 * STYLE. No em dashes, no angle brackets. German uses "und" rather than "&",
 * which German copy on this site avoids.
 */

const LABELS = {
  en: {
    generic: 'Any IMAP mailbox',
    consumer: 'Consumer webmail',
    privacy: 'Privacy-focused mail',
    business: 'Business & hosted mail',
    hosting: 'Web hosts with mail',
    cpanel: 'cPanel & shared hosting',
    selfhost: 'Self-hosted mail servers',
    isp: 'Internet service providers',
    regional: 'Regional & international',
    blocked: 'Limited or unsupported',
  },
  nb: {
    generic: 'Enhver IMAP-postkasse',
    consumer: 'Webmail for privatpersoner',
    privacy: 'Personvernfokusert e-post',
    business: 'Bedrifts- og hostet e-post',
    hosting: 'Webhoteller med e-post',
    cpanel: 'cPanel og delt hosting',
    selfhost: 'Selvhostede e-postservere',
    isp: 'Internettleverandører',
    regional: 'Regionale og internasjonale',
    blocked: 'Begrenset eller ikke støttet',
  },
  es: {
    generic: 'Cualquier buzón IMAP',
    consumer: 'Webmail de consumo',
    privacy: 'Correo centrado en la privacidad',
    business: 'Correo empresarial y alojado',
    hosting: 'Hostings web con correo',
    cpanel: 'cPanel y hosting compartido',
    selfhost: 'Servidores de correo autoalojados',
    isp: 'Proveedores de internet',
    regional: 'Regionales e internacionales',
    blocked: 'Limitados o no compatibles',
  },
  fr: {
    generic: 'Toute boîte IMAP',
    consumer: 'Webmail grand public',
    privacy: 'Messageries axées sur la confidentialité',
    business: 'Messagerie pro et hébergée',
    hosting: 'Hébergeurs web avec messagerie',
    cpanel: 'cPanel et hébergement mutualisé',
    selfhost: 'Serveurs mail auto-hébergés',
    isp: "Fournisseurs d'accès à internet",
    regional: 'Régionaux et internationaux',
    blocked: 'Limités ou non pris en charge',
  },
  de: {
    generic: 'Beliebiges IMAP-Postfach',
    consumer: 'Webmail für Privatnutzer',
    privacy: 'Datenschutzorientierte Anbieter',
    business: 'Business- und gehostete E-Mail',
    hosting: 'Webhoster mit E-Mail',
    cpanel: 'cPanel und Shared Hosting',
    selfhost: 'Selbst gehostete Mailserver',
    isp: 'Internetanbieter',
    regional: 'Regionale und internationale Anbieter',
    blocked: 'Eingeschränkt oder nicht unterstützt',
  },
  pt: {
    generic: 'Qualquer caixa IMAP',
    consumer: 'Webmail para uso pessoal',
    privacy: 'E-mail com foco em privacidade',
    business: 'E-mail corporativo e hospedado',
    hosting: 'Hospedagens com e-mail',
    cpanel: 'cPanel e hospedagem compartilhada',
    selfhost: 'Servidores de e-mail próprios',
    isp: 'Provedores de internet',
    regional: 'Regionais e internacionais',
    blocked: 'Limitados ou sem suporte',
  },
  ja: {
    generic: '任意のIMAPメールボックス',
    consumer: '個人向けWebメール',
    privacy: 'プライバシー重視のメール',
    business: 'ビジネス・ホスティング型メール',
    hosting: 'メール付きWebホスティング',
    cpanel: 'cPanel・共用ホスティング',
    selfhost: 'セルフホスト型メールサーバー',
    isp: 'インターネットプロバイダー',
    regional: '地域・国際プロバイダー',
    blocked: '制限あり・非対応',
  },
  zh: {
    generic: '任意 IMAP 邮箱',
    consumer: '个人网页邮箱',
    privacy: '注重隐私的邮箱',
    business: '企业与托管邮箱',
    hosting: '提供邮箱的虚拟主机',
    cpanel: 'cPanel 与共享主机',
    selfhost: '自建邮件服务器',
    isp: '互联网服务提供商',
    regional: '区域与国际服务商',
    blocked: '受限或不支持',
  },
};

/** The locales this module is written in (for the parity test). */
export const CATEGORY_LABEL_LOCALES = Object.freeze(Object.keys(LABELS));

/** The heading for category `id` in `locale`; English when the locale has none. */
export function categoryLabel(id, locale) {
  return LABELS[locale]?.[id] ?? LABELS.en[id] ?? id;
}

/** The whole table for `locale`, for tests. */
export function categoryLabelsFor(locale) {
  return LABELS[locale] ?? LABELS.en;
}
