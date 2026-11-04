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
    answer: 'MCPEmails is a hosted MCP server for email. You connect a mailbox once, then paste one URL into the client you already work in. {oauth} of the {count} clients here run the OAuth browser flow and need no API key at all; the rest take a scoped API key in an Authorization header.',
    meta: {
      title: 'Connect Email to Claude, Cursor, ChatGPT and {count} MCP Clients',
      description: 'Per-client setup guides for the MCPEmails MCP server. Connect a real inbox to Claude, Claude Code, Cursor, VS Code, ChatGPT, Cline, Windsurf, Gemini CLI, Zed, JetBrains, Raycast, Warp, n8n or curl.',
    },
    genericTitle: 'Client not listed?',
    genericSub: 'Any client that speaks Streamable HTTP MCP works. The endpoint, the handshake and the tool catalogue are in the docs.',
    genericCta: 'Read the docs',
    breadcrumb: 'MCP clients',
    authOauth: 'OAuth',
    authKey: 'API key',
  },
  page: {
    // The one-click install in the hero (install-links.mjs), on pages whose client has one.
    install: {
      after: '{client} opens with MCPEmails filled in. Confirm it, then create your account and pick your inbox in the browser page that follows.',
      command: 'Or run this in your terminal',
      copy: 'Copy',
      copied: 'Copied',
    },
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
    postLink: {
      intro: 'Prefer a full walkthrough?',
      claude: 'How to connect Claude to your email',
      chatgpt: 'How to connect ChatGPT to your email',
      editors: 'Email for AI agents in Cursor, Cline and VS Code',
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
    answer: 'MCPEmails er en hostet MCP-server for e-post. Du kobler til en postkasse én gang, og limer så inn én URL i klienten du allerede jobber i. {oauth} av de {count} klientene her bruker OAuth-flyten i nettleseren og trenger ingen API-nøkkel i det hele tatt; resten bruker en avgrenset API-nøkkel i en Authorization-header.',
    meta: {
      title: 'Koble e-post til Claude, Cursor, ChatGPT og {count} MCP-klienter',
      description: 'Oppsettsguider per klient for MCP-serveren til MCPEmails. Koble en ekte innboks til Claude, Claude Code, Cursor, VS Code, ChatGPT, Cline, Windsurf, Gemini CLI, Zed, JetBrains, Raycast, Warp, n8n eller curl.',
    },
    genericTitle: 'Står ikke klienten din på listen?',
    genericSub: 'Alle klienter som snakker Streamable HTTP MCP fungerer. Endepunktet, håndtrykket og verktøykatalogen står i dokumentasjonen.',
    genericCta: 'Les dokumentasjonen',
    breadcrumb: 'MCP-klienter',
    authOauth: 'OAuth',
    authKey: 'API-nøkkel',
  },
  page: {
    // The one-click install in the hero (install-links.mjs), on pages whose client has one.
    install: {
      after: '{client} åpnes med MCPEmails ferdig utfylt. Bekreft, og opprett kontoen og velg innboksen på nettsiden som åpnes etterpå.',
      command: 'Eller kjør dette i terminalen',
      copy: 'Kopier',
      copied: 'Kopiert',
    },
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
    postLink: {
      intro: 'Vil du ha en fullstendig gjennomgang?',
      claude: 'Slik kobler du Claude til e-posten din',
      chatgpt: 'Slik kobler du ChatGPT til e-posten din',
      editors: 'E-post for AI-agenter i Cursor, Cline og VS Code',
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
    answer: 'MCPEmails es un servidor MCP alojado para el correo. Conectas un buzón una vez y luego pegas una URL en el cliente con el que ya trabajas. {oauth} de los {count} clientes de aquí usan el flujo OAuth en el navegador y no necesitan ninguna clave de API; el resto usa una clave de API con permisos limitados en un encabezado Authorization.',
    meta: {
      title: 'Conecta el correo a Claude, Cursor, ChatGPT y {count} clientes MCP',
      description: 'Guías por cliente para el servidor MCP de MCPEmails. Conecta una bandeja real a Claude, Claude Code, Cursor, VS Code, ChatGPT, Cline, Windsurf, Gemini CLI, Zed, JetBrains, Raycast, Warp, n8n o curl.',
    },
    genericTitle: '¿Tu cliente no aparece?',
    genericSub: 'Funciona cualquier cliente que hable MCP sobre Streamable HTTP. El endpoint, el handshake y el catálogo de herramientas están en la documentación.',
    genericCta: 'Lee la documentación',
    breadcrumb: 'Clientes MCP',
    authOauth: 'OAuth',
    authKey: 'Clave de API',
  },
  page: {
    // The one-click install in the hero (install-links.mjs), on pages whose client has one.
    install: {
      after: '{client} se abre con MCPEmails ya rellenado. Confírmalo y luego crea tu cuenta y elige tu bandeja en la página del navegador que aparece.',
      command: 'O ejecuta esto en tu terminal',
      copy: 'Copiar',
      copied: 'Copiado',
    },
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
    postLink: {
      intro: '¿Prefieres una guía completa?',
      claude: 'Cómo conectar Claude a tu correo',
      chatgpt: 'Cómo conectar ChatGPT a tu correo',
      editors: 'Correo para agentes de IA en Cursor, Cline y VS Code',
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
    answer: 'MCPEmails est un serveur MCP hébergé pour l’e-mail. Vous connectez une boîte une seule fois, puis vous collez une URL dans le client où vous travaillez déjà. {oauth} des {count} clients présentés ici utilisent le flux OAuth dans le navigateur et n’ont besoin d’aucune clé API ; les autres utilisent une clé API à portée limitée dans un en-tête Authorization.',
    meta: {
      title: 'Connecter l’e-mail à Claude, Cursor, ChatGPT et {count} clients MCP',
      description: 'Guides par client pour le serveur MCP de MCPEmails. Connectez une vraie boîte à Claude, Claude Code, Cursor, VS Code, ChatGPT, Cline, Windsurf, Gemini CLI, Zed, JetBrains, Raycast, Warp, n8n ou curl.',
    },
    genericTitle: 'Votre client n’est pas dans la liste ?',
    genericSub: 'Tout client compatible MCP en Streamable HTTP fonctionne. Le point de terminaison, la poignée de main et le catalogue d’outils sont dans la documentation.',
    genericCta: 'Lire la documentation',
    breadcrumb: 'Clients MCP',
    authOauth: 'OAuth',
    authKey: 'Clé API',
  },
  page: {
    // The one-click install in the hero (install-links.mjs), on pages whose client has one.
    install: {
      after: '{client} s\'ouvre avec MCPEmails déjà rempli. Confirmez, puis créez votre compte et choisissez votre boîte dans la page du navigateur qui suit.',
      command: 'Ou exécutez ceci dans votre terminal',
      copy: 'Copier',
      copied: 'Copié',
    },
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
    postLink: {
      intro: 'Vous préférez un guide complet ?',
      claude: 'Connecter Claude à vos e-mails',
      chatgpt: 'Connecter ChatGPT à vos e-mails',
      editors: 'L\'e-mail pour les agents IA dans Cursor, Cline et VS Code',
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
    answer: 'MCPEmails 是一个托管的邮件 MCP 服务器。你只需连接一次邮箱，然后把一个 URL 粘贴到你已经在用的客户端中。这里的 {count} 个客户端中有 {oauth} 个使用浏览器 OAuth 流程，完全不需要 API 密钥；其余客户端则在 Authorization 标头中使用一个限定范围的 API 密钥。',
    meta: {
      title: '将邮件连接到 Claude、Cursor、ChatGPT 等 {count} 个 MCP 客户端',
      description: 'MCPEmails MCP 服务器的分客户端配置指南。将真实收件箱连接到 Claude、Claude Code、Cursor、VS Code、ChatGPT、Cline、Windsurf、Gemini CLI、Zed、JetBrains、Raycast、Warp 或 curl。',
    },
    genericTitle: '没有找到你的客户端？',
    genericSub: '任何支持 Streamable HTTP MCP 的客户端都能使用。端点、握手流程和工具目录都在文档中。',
    genericCta: '阅读文档',
    breadcrumb: 'MCP 客户端',
    authOauth: 'OAuth',
    authKey: 'API 密钥',
  },
  page: {
    // The one-click install in the hero (install-links.mjs), on pages whose client has one.
    install: {
      after: '{client} 会打开并预先填好 MCPEmails。确认后，在随后打开的浏览器页面中创建账户并选择收件箱。',
      command: '或者在终端中运行',
      copy: '复制',
      copied: '已复制',
    },
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
    postLink: {
      intro: '想看完整教程？',
      claude: '如何将 Claude 连接到你的邮箱',
      chatgpt: '如何将 ChatGPT 连接到你的邮箱',
      editors: '在 Cursor、Cline 和 VS Code 中为 AI 智能体接入邮件',
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

const DE = {
  hub: {
    eyebrow: 'MCP-Clients',
    title: 'Verbinden Sie Ihr Postfach mit jedem MCP-Client',
    lead: 'Ein gehosteter MCP-Server, {count} Setup-Anleitungen. Wählen Sie den Client, den Sie wirklich nutzen, und folgen Sie den Schritten, die für ihn geschrieben sind, nicht einer allgemeinen Vorlage.',
    answer: 'MCPEmails ist ein gehosteter MCP-Server für E-Mail. Sie verbinden ein Postfach einmal und fügen dann eine URL in den Client ein, in dem Sie ohnehin arbeiten. {oauth} der {count} Clients hier nutzen den OAuth-Ablauf im Browser und brauchen gar keinen API-Schlüssel; die übrigen verwenden einen API-Schlüssel mit Scopes in einem Authorization-Header.',
    meta: {
      title: 'E-Mail mit Claude, Cursor, ChatGPT und {count} MCP-Clients verbinden',
      description: 'Setup-Anleitungen pro Client für den MCP-Server von MCPEmails. Verbinden Sie ein echtes Postfach mit Claude, Claude Code, Cursor, VS Code, ChatGPT, Cline, Windsurf, Gemini CLI, Zed, JetBrains, Raycast, Warp, n8n oder curl.',
    },
    genericTitle: 'Ihr Client fehlt?',
    genericSub: 'Jeder Client, der MCP über Streamable HTTP spricht, funktioniert. Endpunkt, Handshake und Tool-Katalog finden Sie in der Dokumentation.',
    genericCta: 'Zur Dokumentation',
    breadcrumb: 'MCP-Clients',
    authOauth: 'OAuth',
    authKey: 'API-Schlüssel',
  },
  page: {
    // The one-click install in the hero (install-links.mjs), on pages whose client has one.
    install: {
      after: '{client} öffnet sich mit MCPEmails bereits eingetragen. Bestätigen Sie, dann erstellen Sie Ihr Konto und wählen Ihr Postfach auf der folgenden Browserseite.',
      command: 'Oder im Terminal ausführen',
      copy: 'Kopieren',
      copied: 'Kopiert',
    },
    breadcrumb: 'MCP-Clients',
    ctaPrimary: 'Postfach verbinden',
    ctaSecondary: 'Zur Dokumentation',
    endpoint: {
      title: 'Der eine Wert, den Sie brauchen',
      sub: 'Alles auf dieser Seite dient dazu, diese URL in {client} einzutragen.',
      colField: 'Feld',
      colValue: 'Wert',
      fieldUrl: 'MCP-Server-URL',
      fieldTransport: 'Transport',
      transport: 'Streamable HTTP (MCP 2025-06-18)',
      fieldAuth: 'Authentifizierung',
      authOauth: 'OAuth 2.1, Autorisierungscode mit PKCE. Kein API-Schlüssel.',
      authKey: 'Authorization: Bearer, mit einem API-Schlüssel mit Scopes aus Ihrem Dashboard.',
    },
    how: {
      eyebrow: 'Setup',
      title: 'So verbinden Sie {client} mit Ihrem Postfach',
      sub: 'Vier Schritte. Die ersten beiden sind bei jedem Client gleich, die übrigen gelten speziell für diesen.',
    },
    config: {
      title: 'Konfiguration',
      terminal: 'terminal',
      json: 'json',
    },
    gotchas: {
      eyebrow: 'Bevor Sie beginnen',
      title: 'Typische Stolperfallen in {client}',
    },
    limits: {
      title: 'Wichtige Grenzen',
    },
    faq: {
      eyebrow: 'FAQ',
      title: '{client} und E-Mail: Fragen und Antworten',
    },
    related: {
      title: 'Weiteren Client einrichten',
      sub: 'Dasselbe Postfach, dieselbe URL. Verbinden Sie so viele Clients, wie Sie möchten.',
      link: '{client} verbinden',
      all: 'Alle Setup-Anleitungen für MCP-Clients',
    },
    guideLink: {
      intro: 'Offizielle Dokumentation von {client} zu entfernten MCP-Servern:',
    },
    postLink: {
      intro: 'Lieber eine ausführliche Anleitung?',
      claude: 'So verbinden Sie Claude mit Ihren E-Mails',
      chatgpt: 'So verbinden Sie ChatGPT mit Ihren E-Mails',
      editors: 'E-Mail für KI-Agenten in Cursor, Cline und VS Code',
    },
    providers: {
      intro: 'Unsicher, welches Postfach Sie zuerst verbinden sollen?',
      label: 'Zur Kompatibilitätsübersicht der Anbieter',
    },
    connect: {
      intro: 'Sie verbinden ein bestimmtes Postfach?',
      label: 'Setup-Anleitungen nach Anbieter',
    },
  },
};

const PT = {
  hub: {
    eyebrow: 'Clientes MCP',
    title: 'Conecte sua caixa de entrada a qualquer cliente MCP',
    lead: 'Um servidor MCP hospedado, {count} guias de configuração. Escolha o cliente que você realmente usa e siga os passos escritos para ele, não um modelo genérico.',
    answer: 'O MCPEmails é um servidor MCP hospedado para e-mail. Você conecta uma caixa de correio uma vez e depois cola uma URL no cliente em que já trabalha. {oauth} dos {count} clientes daqui usam o fluxo OAuth no navegador e não precisam de chave de API nenhuma; os demais usam uma chave de API com permissões limitadas em um cabeçalho Authorization.',
    meta: {
      title: 'Conecte o e-mail ao Claude, Cursor, ChatGPT e {count} clientes MCP',
      description: 'Guias de configuração por cliente para o servidor MCP do MCPEmails. Conecte uma caixa de entrada real ao Claude, Claude Code, Cursor, VS Code, ChatGPT, Cline, Windsurf, Gemini CLI, Zed, JetBrains, Raycast, Warp, n8n ou curl.',
    },
    genericTitle: 'Seu cliente não está na lista?',
    genericSub: 'Qualquer cliente que fale MCP via Streamable HTTP funciona. O endpoint, o handshake e o catálogo de ferramentas estão na documentação.',
    genericCta: 'Ler a documentação',
    breadcrumb: 'Clientes MCP',
    authOauth: 'OAuth',
    authKey: 'Chave de API',
  },
  page: {
    // The one-click install in the hero (install-links.mjs), on pages whose client has one.
    install: {
      after: 'O {client} abre com o MCPEmails já preenchido. Confirme e, na página do navegador que vem em seguida, crie sua conta e escolha sua caixa de entrada.',
      command: 'Ou rode isto no seu terminal',
      copy: 'Copiar',
      copied: 'Copiado',
    },
    breadcrumb: 'Clientes MCP',
    ctaPrimary: 'Conectar sua caixa de entrada',
    ctaSecondary: 'Ler a documentação',
    endpoint: {
      title: 'O único valor de que você precisa',
      sub: 'Tudo nesta página é uma forma de colocar esta URL no {client}.',
      colField: 'Campo',
      colValue: 'Valor',
      fieldUrl: 'URL do servidor MCP',
      fieldTransport: 'Transporte',
      transport: 'Streamable HTTP (MCP 2025-06-18)',
      fieldAuth: 'Autenticação',
      authOauth: 'OAuth 2.1, código de autorização com PKCE. Sem chave de API.',
      authKey: 'Authorization: Bearer, com uma chave de API de permissões limitadas do seu painel.',
    },
    how: {
      eyebrow: 'Configuração',
      title: 'Como conectar o {client} à sua caixa de entrada',
      sub: 'Quatro passos. Os dois primeiros são iguais para todos os clientes, os demais são específicos deste.',
    },
    config: {
      title: 'Configuração',
      terminal: 'terminal',
      json: 'json',
    },
    gotchas: {
      eyebrow: 'Antes de começar',
      title: 'Onde as pessoas costumam tropeçar no {client}',
    },
    limits: {
      title: 'Limites que vale a pena conhecer',
    },
    faq: {
      eyebrow: 'Perguntas frequentes',
      title: '{client} e e-mail: perguntas e respostas',
    },
    related: {
      title: 'Configure outro cliente',
      sub: 'A mesma caixa de entrada, a mesma URL. Conecte quantos clientes quiser.',
      link: 'Conectar o {client}',
      all: 'Todos os guias de configuração de clientes MCP',
    },
    guideLink: {
      intro: 'Documentação oficial do {client} sobre servidores MCP remotos:',
    },
    postLink: {
      intro: 'Prefere um passo a passo completo?',
      claude: 'Como conectar o Claude ao seu e-mail',
      chatgpt: 'Como conectar o ChatGPT ao seu e-mail',
      editors: 'E-mail para agentes de IA no Cursor, Cline e VS Code',
    },
    providers: {
      intro: 'Na dúvida sobre qual caixa de correio conectar primeiro?',
      label: 'Veja a tabela de compatibilidade de provedores',
    },
    connect: {
      intro: 'Vai conectar uma caixa de correio específica?',
      label: 'Guias de configuração por provedor',
    },
  },
};

const JA = {
  hub: {
    eyebrow: 'MCPクライアント',
    title: 'あらゆるMCPクライアントに受信トレイを接続',
    lead: 'ホスト型のMCPサーバーが1つ、セットアップガイドが{count}件。汎用のテンプレートではなく、実際に使っているクライアント向けに書かれた手順に従ってください。',
    answer: 'MCPEmailsはメール用のホスト型MCPサーバーです。メールボックスを一度接続したら、普段使っているクライアントにURLを1つ貼り付けるだけです。ここにある{count}件のクライアントのうち{oauth}件はブラウザーでのOAuthフローを使うため、APIキーは一切不要です。それ以外は、権限を絞ったAPIキーをAuthorizationヘッダーで渡します。',
    meta: {
      title: 'メールをClaude、Cursor、ChatGPTなど{count}種類のMCPクライアントに接続',
      description: 'MCPEmailsのMCPサーバーのクライアント別セットアップガイドです。実際の受信トレイをClaude、Claude Code、Cursor、VS Code、ChatGPT、Cline、Windsurf、Gemini CLI、Zed、JetBrains、Raycast、Warp、n8n、curlに接続できます。',
    },
    genericTitle: 'お使いのクライアントが一覧にない場合',
    genericSub: 'Streamable HTTPでMCPに対応したクライアントなら動作します。エンドポイント、ハンドシェイク、ツールの一覧はドキュメントに記載しています。',
    genericCta: 'ドキュメントを読む',
    breadcrumb: 'MCPクライアント',
    authOauth: 'OAuth',
    authKey: 'APIキー',
  },
  page: {
    // The one-click install in the hero (install-links.mjs), on pages whose client has one.
    install: {
      after: 'MCPEmailsが入力済みの状態で{client}が開きます。確認したら、続いて開くブラウザーのページでアカウントを作成し、受信トレイを選んでください。',
      command: 'またはターミナルで次を実行',
      copy: 'コピー',
      copied: 'コピーしました',
    },
    breadcrumb: 'MCPクライアント',
    ctaPrimary: '受信トレイを接続',
    ctaSecondary: 'ドキュメントを読む',
    endpoint: {
      title: '必要な値は1つだけ',
      sub: 'このページの内容はすべて、このURLを{client}に設定するための方法です。',
      colField: '項目',
      colValue: '値',
      fieldUrl: 'MCPサーバーURL',
      fieldTransport: 'トランスポート',
      transport: 'Streamable HTTP (MCP 2025-06-18)',
      fieldAuth: '認証',
      authOauth: 'OAuth 2.1、PKCE付き認可コード。APIキーは不要です。',
      authKey: 'Authorization: Bearer。ダッシュボードで発行した、権限を絞ったAPIキーを使います。',
    },
    how: {
      eyebrow: 'セットアップ',
      title: '{client}を受信トレイに接続する方法',
      sub: '手順は4つです。最初の2つはどのクライアントでも同じで、残りはこのクライアント固有の手順です。',
    },
    config: {
      title: '設定',
      terminal: 'terminal',
      json: 'json',
    },
    gotchas: {
      eyebrow: '始める前に',
      title: '{client}でつまずきやすいポイント',
    },
    limits: {
      title: '知っておきたい制限',
    },
    faq: {
      eyebrow: 'よくある質問',
      title: '{client}とメールに関するよくある質問',
    },
    related: {
      title: 'ほかのクライアントを設定する',
      sub: '同じ受信トレイ、同じURLです。クライアントはいくつでも接続できます。',
      link: '{client}を接続',
      all: 'MCPクライアントのセットアップガイド一覧',
    },
    guideLink: {
      intro: 'リモートMCPサーバーに関する{client}の公式ドキュメント：',
    },
    postLink: {
      intro: '詳しい手順をまとめた記事もあります。',
      claude: 'Claudeをメールに接続する方法',
      chatgpt: 'ChatGPTをメールに接続する方法',
      editors: 'Cursor、Cline、VS CodeのAIエージェントでメールを使う',
    },
    providers: {
      intro: 'どのメールボックスから接続するか迷っていますか。',
      label: 'プロバイダー互換性の一覧を見る',
    },
    connect: {
      intro: '特定のメールボックスを接続しますか。',
      label: 'プロバイダー別セットアップガイド',
    },
  },
};

const UI = { en: EN, nb: NB, es: ES, fr: FR, zh: ZH, de: DE, pt: PT, ja: JA };

export function clientUi(locale) {
  return UI[locale] ?? EN;
}

/** Tiny placeholder substitution, so these strings can hold {client} and {count}. */
export function fill(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(values, k) ? String(values[k]) : m,
  );
}
