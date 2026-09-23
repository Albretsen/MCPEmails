/**
 * Chrome strings for the client setup pages: section headings, table labels
 * and link text that repeat on every page and are not worth restating in each
 * client's content file.
 *
 * Kept here rather than in messages/, for the same reason the copy is (see
 * content.mjs): a next-intl namespace ships to every marketing page, and these
 * strings are read by two routes. Keyed by locale so adding a language is
 * adding a key, with `en` as the fallback until one exists.
 *
 * House style, enforced by hand: no em dashes, and no angle brackets. RichText
 * renders the inline subset (b, code) that the content files use; anything
 * else in these strings would reach the DOM as literal text.
 */
const EN = {
  hub: {
    eyebrow: 'MCP clients',
    title: 'Connect your inbox to any MCP client',
    lead: 'One hosted MCP server, {count} setup guides. Pick the client you actually use and follow the steps written for it, not a generic template.',
    answer: 'mcpemails is a hosted MCP server for email. You connect a mailbox once, then paste one URL into the client you already work in. {oauth} of the {count} clients here run the OAuth browser flow and need no API key at all; the rest take a scoped API key in an Authorization header.',
    meta: {
      title: 'Connect Email to Claude, Cursor, ChatGPT and {count} MCP Clients',
      description: 'Per-client setup guides for the mcpemails MCP server. Connect a real inbox to Claude, Claude Code, Cursor, VS Code, ChatGPT, Cline, Windsurf, Gemini CLI, Zed, JetBrains, Raycast, Warp or curl.',
    },
    genericTitle: 'Client not listed?',
    genericSub: 'Any client that speaks Streamable HTTP MCP works. The endpoint, the handshake and the tool catalogue are in the docs.',
    genericCta: 'Read the docs',
    breadcrumb: 'MCP clients',
    authOauth: 'OAuth',
    authKey: 'API key',
  },
  page: {
    breadcrumb: 'MCP clients',
    ctaPrimary: 'Connect your inbox',
    ctaSecondary: 'Read the docs',
    endpoint: {
      title: 'The one value you need',
      sub: 'Everything on this page is a way of getting this URL into {client}.',
      colField: 'Field',
      colValue: 'Value',
      fieldUrl: 'MCP server URL',
      fieldTransport: 'Transport',
      transport: 'Streamable HTTP (MCP 2025-06-18)',
      fieldAuth: 'Authentication',
      authOauth: 'OAuth 2.1, authorization code with PKCE. No API key.',
      authKey: 'Authorization: Bearer, using a scoped API key from your dashboard.',
    },
    how: {
      eyebrow: 'Setup',
      title: 'How to connect {client} to your inbox',
      sub: 'Four steps. The first two are the same for every client, the rest are specific to this one.',
    },
    config: {
      title: 'Configuration',
      terminal: 'terminal',
      json: 'json',
    },
    gotchas: {
      eyebrow: 'Before you start',
      title: 'What trips people up in {client}',
    },
    limits: {
      title: 'Limits worth knowing',
    },
    faq: {
      eyebrow: 'FAQ',
      title: '{client} and email, answered',
    },
    related: {
      title: 'Set up another client',
      sub: 'The same inbox, the same URL. Connect as many clients as you like.',
      link: 'Connect {client}',
      all: 'All MCP client setup guides',
    },
    guideLink: {
      intro: 'Official {client} documentation for remote MCP servers:',
    },
    providers: {
      intro: 'Wondering which mailbox to connect first?',
      label: 'See the provider compatibility matrix',
    },
    connect: {
      intro: 'Connecting a specific mailbox?',
      label: 'Provider setup guides',
    },
  },
};

const NB = {
  hub: {
    eyebrow: 'MCP-klienter',
    title: 'Koble innboksen din til hvilken som helst MCP-klient',
    lead: 'Én hostet MCP-server, {count} oppsettsguider. Velg klienten du faktisk bruker og følg stegene som er skrevet for den, ikke en generell mal.',
    answer: 'mcpemails er en hostet MCP-server for e-post. Du kobler til en postkasse én gang, og limer så inn én URL i klienten du allerede jobber i. {oauth} av de {count} klientene her bruker OAuth-flyten i nettleseren og trenger ingen API-nøkkel i det hele tatt; resten bruker en avgrenset API-nøkkel i en Authorization-header.',
    meta: {
      title: 'Koble e-post til Claude, Cursor, ChatGPT og {count} MCP-klienter',
      description: 'Oppsettsguider per klient for MCP-serveren til mcpemails. Koble en ekte innboks til Claude, Claude Code, Cursor, VS Code, ChatGPT, Cline, Windsurf, Gemini CLI, Zed, JetBrains, Raycast, Warp eller curl.',
    },
    genericTitle: 'Står ikke klienten din på listen?',
    genericSub: 'Alle klienter som snakker Streamable HTTP MCP fungerer. Endepunktet, håndtrykket og verktøykatalogen står i dokumentasjonen.',
    genericCta: 'Les dokumentasjonen',
    breadcrumb: 'MCP-klienter',
    authOauth: 'OAuth',
    authKey: 'API-nøkkel',
  },
  page: {
    breadcrumb: 'MCP-klienter',
    ctaPrimary: 'Koble til innboksen din',
    ctaSecondary: 'Les dokumentasjonen',
    endpoint: {
      title: 'Den ene verdien du trenger',
      sub: 'Alt på denne siden er måter å få denne URL-en inn i {client} på.',
      colField: 'Felt',
      colValue: 'Verdi',
      fieldUrl: 'MCP-serverens URL',
      fieldTransport: 'Transport',
      transport: 'Streamable HTTP (MCP 2025-06-18)',
      fieldAuth: 'Autentisering',
      authOauth: 'OAuth 2.1, autorisasjonskode med PKCE. Ingen API-nøkkel.',
      authKey: 'Authorization: Bearer, med en avgrenset API-nøkkel fra dashbordet ditt.',
    },
    how: {
      eyebrow: 'Oppsett',
      title: 'Slik kobler du {client} til innboksen din',
      sub: 'Fire steg. De to første er like for alle klienter, resten gjelder bare denne.',
    },
    config: {
      title: 'Konfigurasjon',
      terminal: 'terminal',
      json: 'json',
    },
    gotchas: {
      eyebrow: 'Før du starter',
      title: 'Dette snubler folk i med {client}',
    },
    limits: {
      title: 'Begrensninger verdt å vite om',
    },
    faq: {
      eyebrow: 'Vanlige spørsmål',
      title: '{client} og e-post, besvart',
    },
    related: {
      title: 'Sett opp en annen klient',
      sub: 'Samme innboks, samme URL. Koble til så mange klienter du vil.',
      link: 'Koble til {client}',
      all: 'Alle oppsettsguider for MCP-klienter',
    },
    guideLink: {
      intro: 'Offisiell dokumentasjon fra {client} for eksterne MCP-servere:',
    },
    providers: {
      intro: 'Lurer du på hvilken postkasse du bør koble til først?',
      label: 'Se kompatibilitetsoversikten for leverandører',
    },
    connect: {
      intro: 'Kobler du til en bestemt postkasse?',
      label: 'Oppsettsguider for leverandører',
    },
  },
};

const ES = {
  hub: {
    eyebrow: 'Clientes MCP',
    title: 'Conecta tu bandeja a cualquier cliente MCP',
    lead: 'Un servidor MCP alojado, {count} guías de configuración. Elige el cliente que de verdad usas y sigue los pasos escritos para él, no una plantilla genérica.',
    answer: 'mcpemails es un servidor MCP alojado para el correo. Conectas un buzón una vez y luego pegas una URL en el cliente con el que ya trabajas. {oauth} de los {count} clientes de aquí usan el flujo OAuth en el navegador y no necesitan ninguna clave de API; el resto usa una clave de API con permisos limitados en un encabezado Authorization.',
    meta: {
      title: 'Conecta el correo a Claude, Cursor, ChatGPT y {count} clientes MCP',
      description: 'Guías por cliente para el servidor MCP de mcpemails. Conecta una bandeja real a Claude, Claude Code, Cursor, VS Code, ChatGPT, Cline, Windsurf, Gemini CLI, Zed, JetBrains, Raycast, Warp o curl.',
    },
    genericTitle: '¿Tu cliente no aparece?',
    genericSub: 'Funciona cualquier cliente que hable MCP sobre Streamable HTTP. El endpoint, el handshake y el catálogo de herramientas están en la documentación.',
    genericCta: 'Lee la documentación',
    breadcrumb: 'Clientes MCP',
    authOauth: 'OAuth',
    authKey: 'Clave de API',
  },
  page: {
    breadcrumb: 'Clientes MCP',
    ctaPrimary: 'Conecta tu bandeja',
    ctaSecondary: 'Lee la documentación',
    endpoint: {
      title: 'El único valor que necesitas',
      sub: 'Todo en esta página es una forma de llevar esta URL a {client}.',
      colField: 'Campo',
      colValue: 'Valor',
      fieldUrl: 'URL del servidor MCP',
      fieldTransport: 'Transporte',
      transport: 'Streamable HTTP (MCP 2025-06-18)',
      fieldAuth: 'Autenticación',
      authOauth: 'OAuth 2.1, código de autorización con PKCE. Sin clave de API.',
      authKey: 'Authorization: Bearer, con una clave de API de permisos limitados de tu panel.',
    },
    how: {
      eyebrow: 'Configuración',
      title: 'Cómo conectar {client} a tu bandeja',
      sub: 'Cuatro pasos. Los dos primeros son iguales para todos los clientes, el resto son propios de este.',
    },
    config: {
      title: 'Configuración',
      terminal: 'terminal',
      json: 'json',
    },
    gotchas: {
      eyebrow: 'Antes de empezar',
      title: 'En qué suele tropezar la gente con {client}',
    },
    limits: {
      title: 'Límites que conviene conocer',
    },
    faq: {
      eyebrow: 'Preguntas frecuentes',
      title: '{client} y el correo: preguntas resueltas',
    },
    related: {
      title: 'Configura otro cliente',
      sub: 'La misma bandeja, la misma URL. Conecta todos los clientes que quieras.',
      link: 'Conecta {client}',
      all: 'Todas las guías de clientes MCP',
    },
    guideLink: {
      intro: 'Documentación oficial de {client} sobre servidores MCP remotos:',
    },
    providers: {
      intro: '¿No sabes qué buzón conectar primero?',
      label: 'Consulta la tabla de compatibilidad de proveedores',
    },
    connect: {
      intro: '¿Vas a conectar un buzón concreto?',
      label: 'Guías de configuración por proveedor',
    },
  },
};

const FR = {
  hub: {
    eyebrow: 'Clients MCP',
    title: 'Connectez votre boîte à n’importe quel client MCP',
    lead: 'Un serveur MCP hébergé, {count} guides de configuration. Choisissez le client que vous utilisez vraiment et suivez les étapes écrites pour lui, pas un modèle générique.',
    answer: 'mcpemails est un serveur MCP hébergé pour l’e-mail. Vous connectez une boîte une seule fois, puis vous collez une URL dans le client où vous travaillez déjà. {oauth} des {count} clients présentés ici utilisent le flux OAuth dans le navigateur et n’ont besoin d’aucune clé API ; les autres utilisent une clé API à portée limitée dans un en-tête Authorization.',
    meta: {
      title: 'Connecter l’e-mail à Claude, Cursor, ChatGPT et {count} clients MCP',
      description: 'Guides par client pour le serveur MCP de mcpemails. Connectez une vraie boîte à Claude, Claude Code, Cursor, VS Code, ChatGPT, Cline, Windsurf, Gemini CLI, Zed, JetBrains, Raycast, Warp ou curl.',
    },
    genericTitle: 'Votre client n’est pas dans la liste ?',
    genericSub: 'Tout client compatible MCP en Streamable HTTP fonctionne. Le point de terminaison, la poignée de main et le catalogue d’outils sont dans la documentation.',
    genericCta: 'Lire la documentation',
    breadcrumb: 'Clients MCP',
    authOauth: 'OAuth',
    authKey: 'Clé API',
  },
  page: {
    breadcrumb: 'Clients MCP',
    ctaPrimary: 'Connecter votre boîte',
    ctaSecondary: 'Lire la documentation',
    endpoint: {
      title: 'La seule valeur dont vous avez besoin',
      sub: 'Tout ce qui figure sur cette page sert à faire entrer cette URL dans {client}.',
      colField: 'Champ',
      colValue: 'Valeur',
      fieldUrl: 'URL du serveur MCP',
      fieldTransport: 'Transport',
      transport: 'Streamable HTTP (MCP 2025-06-18)',
      fieldAuth: 'Authentification',
      authOauth: 'OAuth 2.1, code d’autorisation avec PKCE. Aucune clé API.',
      authKey: 'Authorization: Bearer, avec une clé API à portée limitée issue de votre tableau de bord.',
    },
    how: {
      eyebrow: 'Configuration',
      title: 'Comment connecter {client} à votre boîte',
      sub: 'Quatre étapes. Les deux premières sont les mêmes pour tous les clients, les suivantes sont propres à celui-ci.',
    },
    config: {
      title: 'Configuration',
      terminal: 'terminal',
      json: 'json',
    },
    gotchas: {
      eyebrow: 'Avant de commencer',
      title: 'Ce qui fait trébucher avec {client}',
    },
    limits: {
      title: 'Limites à connaître',
    },
    faq: {
      eyebrow: 'FAQ',
      title: '{client} et l’e-mail : vos questions',
    },
    related: {
      title: 'Configurer un autre client',
      sub: 'La même boîte, la même URL. Connectez autant de clients que vous voulez.',
      link: 'Connecter {client}',
      all: 'Tous les guides de configuration des clients MCP',
    },
    guideLink: {
      intro: 'Documentation officielle de {client} sur les serveurs MCP distants :',
    },
    providers: {
      intro: 'Vous ne savez pas quelle boîte connecter en premier ?',
      label: 'Voir le tableau de compatibilité des fournisseurs',
    },
    connect: {
      intro: 'Vous connectez une boîte précise ?',
      label: 'Guides de configuration par fournisseur',
    },
  },
};

const ZH = {
  hub: {
    eyebrow: 'MCP 客户端',
    title: '把你的收件箱连接到任意 MCP 客户端',
    lead: '一个托管的 MCP 服务器，{count} 份配置指南。选择你真正在用的客户端，按照专门为它编写的步骤操作，而不是套用通用模板。',
    answer: 'mcpemails 是一个托管的邮件 MCP 服务器。你只需连接一次邮箱，然后把一个 URL 粘贴到你已经在用的客户端中。这里的 {count} 个客户端中有 {oauth} 个使用浏览器 OAuth 流程，完全不需要 API 密钥；其余客户端则在 Authorization 标头中使用一个限定范围的 API 密钥。',
    meta: {
      title: '将邮件连接到 Claude、Cursor、ChatGPT 等 {count} 个 MCP 客户端',
      description: 'mcpemails MCP 服务器的分客户端配置指南。将真实收件箱连接到 Claude、Claude Code、Cursor、VS Code、ChatGPT、Cline、Windsurf、Gemini CLI、Zed、JetBrains、Raycast、Warp 或 curl。',
    },
    genericTitle: '没有找到你的客户端？',
    genericSub: '任何支持 Streamable HTTP MCP 的客户端都能使用。端点、握手流程和工具目录都在文档中。',
    genericCta: '阅读文档',
    breadcrumb: 'MCP 客户端',
    authOauth: 'OAuth',
    authKey: 'API 密钥',
  },
  page: {
    breadcrumb: 'MCP 客户端',
    ctaPrimary: '连接你的收件箱',
    ctaSecondary: '阅读文档',
    endpoint: {
      title: '你唯一需要的值',
      sub: '本页的所有内容，都是把这个 URL 填入 {client} 的方法。',
      colField: '字段',
      colValue: '值',
      fieldUrl: 'MCP 服务器 URL',
      fieldTransport: '传输方式',
      transport: 'Streamable HTTP (MCP 2025-06-18)',
      fieldAuth: '认证',
      authOauth: 'OAuth 2.1，带 PKCE 的授权码流程。无需 API 密钥。',
      authKey: 'Authorization: Bearer，使用你在仪表盘中创建的限定范围的 API 密钥。',
    },
    how: {
      eyebrow: '设置',
      title: '如何将 {client} 连接到你的收件箱',
      sub: '共四步。前两步对所有客户端都一样，其余步骤专门针对这个客户端。',
    },
    config: {
      title: '配置',
      terminal: '终端',
      json: 'json',
    },
    gotchas: {
      eyebrow: '开始之前',
      title: '使用 {client} 时容易踩的坑',
    },
    limits: {
      title: '值得了解的限制',
    },
    faq: {
      eyebrow: '常见问题',
      title: '{client} 与邮件：常见问题解答',
    },
    related: {
      title: '设置另一个客户端',
      sub: '同一个收件箱，同一个 URL。想连接多少个客户端都可以。',
      link: '连接 {client}',
      all: '所有 MCP 客户端配置指南',
    },
    guideLink: {
      intro: '{client} 关于远程 MCP 服务器的官方文档：',
    },
    providers: {
      intro: '不确定先连接哪个邮箱？',
      label: '查看邮箱服务商兼容性对照表',
    },
    connect: {
      intro: '要连接某个特定邮箱？',
      label: '邮箱服务商配置指南',
    },
  },
};

const UI = { en: EN, nb: NB, es: ES, fr: FR, zh: ZH };

export function clientUi(locale) {
  return UI[locale] ?? EN;
}

/** Tiny placeholder substitution, so these strings can hold {client} and {count}. */
export function fill(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(values, k) ? String(values[k]) : m,
  );
}
