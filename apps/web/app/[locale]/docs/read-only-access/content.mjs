// Copy for /docs/read-only-access, in every locale.
//
// Kept next to the page rather than in messages/: a messages/ namespace is
// serialised into every marketing page, and this copy is only read here.
//
// Every claim is traced to code. If one of these changes, change the page:
//   permissions            apps/web/src/lib/api-keys/scopes.ts
//   consent screen labels  messages/<locale>/auth.json (authorize.preset.readOnly,
//                          authorize.customize, authorize.allowAccess,
//                          authorize.preset.full); ChatGPT opening on Full access
//                          is src/lib/oauth/consent-presets.ts
//   scope check            supabase/functions/mcp-server/index.ts (tools/call,
//                          before dispatchExecutor)
//   EXAMINE                supabase/functions/mcp-server/imap-read-only.ts
//   BODY.PEEK              supabase/functions/mcp-server/imap-client.ts,
//                          first-party.ts
//   mark_as_read removed   supabase/functions/mcp-server/argument-aliases.ts
//   flag needs             email_organize `flag` action, scope manage:folders
//     manage:folders
//   OAuth sees all tools   toolsForListing in mcp-server/index.ts
//   connect check          apps/web/src/lib/email/validate-imap.ts
//                          (rejectUnauthorized: true, login, logout)
//   receive-only           components/dashboard/ConnectModal.jsx, labels in
//                          messages/<locale>/dashboardChrome.json
//   search                 searchImapMessages in mcp-server/index.ts (UID SEARCH,
//                          INBOX default, page max 100, SEARCH_TIMEOUT_MS 30s)
//   background work        cron dispatchers in supabase/migrations (triage rules,
//                          scheduled sends), 20261024235200_reminders.sql and
//                          mcp-server/reminders-engine.ts, 20261024235400_
//                          morning_briefs.sql (inserts the brief), webhooks in
//                          supabase/functions/client-api/webhooks/deliver.ts
//
// Inline markup: `code` and **bold**, rendered by the page. No other syntax.

const REPO = 'https://github.com/Albretsen/MCPEmails/blob/main';

export const EVIDENCE_LINKS = [
  { key: 'examine', href: `${REPO}/supabase/functions/mcp-server/imap-read-only.ts`, file: 'imap-read-only.ts' },
  { key: 'examineTests', href: `${REPO}/supabase/functions/mcp-server/imap-read-only.test.ts`, file: 'imap-read-only.test.ts' },
  { key: 'scopes', href: `${REPO}/apps/web/src/lib/api-keys/scopes.ts`, file: 'scopes.ts' },
  { key: 'markAsRead', href: `${REPO}/supabase/functions/mcp-server/argument-aliases.ts`, file: 'argument-aliases.ts' },
  { key: 'peek', href: `${REPO}/supabase/functions/mcp-server/imap-client.ts`, file: 'imap-client.ts' },
];

const en = {
  meta: {
    title: 'Read-only email access for AI agents',
    description:
      'What a read-only MCPEmails connection can and cannot do, how writes are refused by both our server and your mail provider, why reading never marks mail as read, and what happens when you connect.',
  },
  breadcrumb: 'Read-only access',
  eyebrow: 'Docs',
  title: 'Read-only access',
  lead:
    'A read-only connection lets an AI read and search your mail and nothing else. This page lists what it can do, what it cannot, and how each limit is enforced.',
  sections: [
    {
      id: 'what',
      h: 'What a read-only connection can do',
      items: [
        'It holds the `read:email` permission, and optionally `search:email`, which adds nothing on top.',
        'It can list, read and search messages, download attachments, and list inboxes and folders.',
        'It cannot send, reply, draft, move, flag, mark as read, delete, schedule or create automations.',
      ],
    },
    {
      id: 'choose',
      h: 'How to choose it',
      items: [
        'When you connect an AI client, the consent screen offers access levels. Pick **Read-only** ("Read and search your mail. Can\'t send, change, or delete anything.") or open **Customize permissions** and grant read only. You can also limit the connection to some of your inboxes.',
        'ChatGPT opens this screen on **Full access**, because it cannot come back and ask for more access later. Select **Read-only** before you click **Allow access**.',
        'API keys created in the dashboard can be limited to the same permissions.',
      ],
    },
    {
      id: 'enforced',
      h: 'How the limits are enforced',
      items: [
        'Every tool call is checked against the connection\'s permissions before we contact your mail server. A call outside the grant is refused with `insufficient_scope`.',
        'On IMAP mailboxes, a read-only connection opens each folder with `EXAMINE`, the read-only form of `SELECT`. Your mail provider then refuses any flag change, move or delete in that session, whatever our code does.',
        'Messages are fetched with `BODY.PEEK`, so reading a message never marks it as read. This holds for every connection, not only read-only ones.',
        'The reading tool never changes your mailbox. Its old `mark_as_read` option was removed; marking as read is a separate action that needs the `manage:folders` permission.',
        'AI clients that sign in with OAuth see the full tool list, so they can ask you for more access. Those calls still fail until you grant it.',
      ],
    },
    {
      id: 'connect',
      h: 'What happens when you connect',
      items: [
        'We open a TLS connection, verify the server\'s certificate, sign in once to check your password or app password, and sign out.',
        'Nothing is downloaded, copied or indexed. Messages are fetched from your provider only when a tool asks for them.',
        'Background work runs only for features you turn on. Automations, scheduled sends, follow-ups and snoozes need write permissions a read-only connection does not have. The morning brief and new-mail webhooks are dashboard settings, not connection permissions: the brief reads your inbox and adds one message to it, and webhooks check for new mail. Both stay off unless you turn them on.',
        'If you never want to send from the address, choose **Advanced settings** → **Connection type** → **Receive only (IMAP)** when you connect it. No SMTP server is configured or contacted.',
      ],
    },
    {
      id: 'search',
      h: 'Searching large mailboxes',
      items: [
        'On IMAP mailboxes, search runs on your provider\'s server with IMAP `SEARCH`. We download only the page of results that was asked for, up to 100 messages, and the AI pages through the rest.',
        'Search covers the inbox unless a folder is named, because searching every folder of a large account is slow.',
        'Each search has a 30-second limit. On a mailbox with tens of thousands of messages, narrow a broad search by sender, subject or date.',
      ],
    },
  ],
  evidence: {
    h: 'Check it yourself',
    intro: 'MCPEmails is open source. These files implement and test what this page describes:',
    labels: {
      examine: 'EXAMINE for read-only connections',
      examineTests: 'Tests for EXAMINE, including the provider refusing a flag change',
      scopes: 'The permission list',
      markAsRead: 'Removal of mark_as_read from the reading tool',
      peek: 'The IMAP client: every body fetch uses BODY.PEEK',
    },
  },
  cta: { title: 'Connect a mailbox read-only', sub: 'One inbox is free, forever.', button: 'Get started', providers: 'Provider support' },
};

const nb = {
  meta: {
    title: 'Skrivebeskyttet e-posttilgang for AI-agenter',
    description:
      'Hva en skrivebeskyttet MCPEmails-tilkobling kan og ikke kan gjøre, hvordan endringer avvises både av vår server og av e-postleverandøren din, hvorfor lesing aldri markerer e-post som lest, og hva som skjer når du kobler til.',
  },
  breadcrumb: 'Skrivebeskyttet tilgang',
  eyebrow: 'Dokumentasjon',
  title: 'Skrivebeskyttet tilgang',
  lead:
    'En skrivebeskyttet tilkobling lar en AI lese og søke i e-posten din, og ingenting annet. Her ser du hva den kan, hva den ikke kan, og hvordan hver grense håndheves.',
  sections: [
    {
      id: 'what',
      h: 'Hva en skrivebeskyttet tilkobling kan gjøre',
      items: [
        'Den har tillatelsen `read:email`, og eventuelt `search:email`, som ikke gir noe ekstra.',
        'Den kan liste, lese og søke i meldinger, laste ned vedlegg og liste innbokser og mapper.',
        'Den kan ikke sende, svare, lage utkast, flytte, flagge, markere som lest, slette, planlegge eller lage automatiseringer.',
      ],
    },
    {
      id: 'choose',
      h: 'Slik velger du den',
      items: [
        'Når du kobler til en AI-klient, viser samtykkeskjermen tilgangsnivåer. Velg **Skrivebeskyttet** («Les og søk i e-posten din. Kan ikke sende, endre eller slette noe.») eller åpne **Tilpass tillatelser** og gi bare lesetilgang. Du kan også begrense tilkoblingen til noen av innboksene dine.',
        'ChatGPT åpner denne skjermen på **Full tilgang**, fordi ChatGPT ikke kan komme tilbake og be om mer tilgang senere. Velg **Skrivebeskyttet** før du klikker **Gi tilgang**.',
        'API-nøkler du lager i dashbordet kan begrenses til de samme tillatelsene.',
      ],
    },
    {
      id: 'enforced',
      h: 'Slik håndheves grensene',
      items: [
        'Hvert verktøykall sjekkes mot tilkoblingens tillatelser før vi kontakter e-postserveren din. Et kall utenfor tillatelsene avvises med `insufficient_scope`.',
        'På IMAP-postbokser åpner en skrivebeskyttet tilkobling hver mappe med `EXAMINE`, den skrivebeskyttede formen av `SELECT`. Da avviser e-postleverandøren selv enhver endring av flagg, flytting eller sletting i den økten, uansett hva vår kode gjør.',
        'Meldinger hentes med `BODY.PEEK`, så det å lese en melding markerer den aldri som lest. Det gjelder alle tilkoblinger, ikke bare skrivebeskyttede.',
        'Leseverktøyet endrer aldri postboksen din. Det gamle valget `mark_as_read` er fjernet; å markere som lest er en egen handling som krever tillatelsen `manage:folders`.',
        'AI-klienter som logger inn med OAuth ser hele verktøylisten, slik at de kan be deg om mer tilgang. Disse kallene feiler likevel til du gir tilgangen.',
      ],
    },
    {
      id: 'connect',
      h: 'Hva som skjer når du kobler til',
      items: [
        'Vi åpner en TLS-tilkobling, sjekker serverens sertifikat, logger inn én gang for å kontrollere passordet eller app-passordet ditt, og logger ut.',
        'Ingenting lastes ned, kopieres eller indekseres. Meldinger hentes fra leverandøren din bare når et verktøy ber om dem.',
        'Bakgrunnsarbeid kjører bare for funksjoner du slår på. Automatiseringer, planlagte utsendelser, oppfølging og utsettelse krever skrivetillatelser som en skrivebeskyttet tilkobling ikke har. Morgenoppsummeringen og webhooks for ny e-post er innstillinger i dashbordet, ikke tilkoblingstillatelser: oppsummeringen leser innboksen din og legger til én melding i den, og webhooks ser etter ny e-post. Begge er av til du slår dem på.',
        'Hvis du aldri vil sende fra adressen, velger du **Avanserte innstillinger** → **Tilkoblingstype** → **Kun motta (IMAP)** når du kobler den til. Ingen SMTP-server settes opp eller kontaktes.',
      ],
    },
    {
      id: 'search',
      h: 'Søk i store postbokser',
      items: [
        'På IMAP-postbokser kjøres søket på leverandørens server med IMAP `SEARCH`. Vi laster bare ned den siden med treff som ble bedt om, opptil 100 meldinger, og AI-en blar videre gjennom resten.',
        'Søket dekker innboksen med mindre en mappe er oppgitt, fordi det er tregt å søke i alle mapper på en stor konto.',
        'Hvert søk har en grense på 30 sekunder. I en postboks med titusenvis av meldinger bør du snevre inn et bredt søk etter avsender, emne eller dato.',
      ],
    },
  ],
  evidence: {
    h: 'Sjekk selv',
    intro: 'MCPEmails er åpen kildekode. Disse filene implementerer og tester det denne siden beskriver:',
    labels: {
      examine: 'EXAMINE for skrivebeskyttede tilkoblinger',
      examineTests: 'Tester for EXAMINE, blant annet at leverandøren avviser en flaggendring',
      scopes: 'Listen over tillatelser',
      markAsRead: 'Fjerningen av mark_as_read fra leseverktøyet',
      peek: 'IMAP-klienten: hver henting av innhold bruker BODY.PEEK',
    },
  },
  cta: { title: 'Koble til en postboks skrivebeskyttet', sub: 'Én innboks er gratis, for alltid.', button: 'Kom i gang', providers: 'Støttede leverandører' },
};

const es = {
  meta: {
    title: 'Acceso de solo lectura al correo para agentes de IA',
    description:
      'Qué puede y qué no puede hacer una conexión de solo lectura de MCPEmails, cómo nuestro servidor y tu proveedor de correo rechazan los cambios, por qué leer nunca marca el correo como leído y qué ocurre al conectarte.',
  },
  breadcrumb: 'Acceso de solo lectura',
  eyebrow: 'Documentación',
  title: 'Acceso de solo lectura',
  lead:
    'Una conexión de solo lectura permite a una IA leer y buscar en tu correo, y nada más. Aquí verás qué puede hacer, qué no, y cómo se aplica cada límite.',
  sections: [
    {
      id: 'what',
      h: 'Qué puede hacer una conexión de solo lectura',
      items: [
        'Tiene el permiso `read:email` y, opcionalmente, `search:email`, que no añade nada más.',
        'Puede listar, leer y buscar mensajes, descargar adjuntos y listar bandejas y carpetas.',
        'No puede enviar, responder, crear borradores, mover, marcar con indicador, marcar como leído, eliminar, programar ni crear automatizaciones.',
      ],
    },
    {
      id: 'choose',
      h: 'Cómo elegirla',
      items: [
        'Al conectar un cliente de IA, la pantalla de consentimiento ofrece niveles de acceso. Elige **Solo lectura** («Leer y buscar en tu correo. No puede enviar, modificar ni eliminar nada.») o abre **Personalizar permisos** y concede solo lectura. También puedes limitar la conexión a algunas de tus bandejas.',
        'ChatGPT abre esta pantalla en **Acceso completo**, porque no puede volver más tarde a pedir más acceso. Selecciona **Solo lectura** antes de pulsar **Permitir acceso**.',
        'Las claves de API creadas en el panel pueden limitarse a los mismos permisos.',
      ],
    },
    {
      id: 'enforced',
      h: 'Cómo se aplican los límites',
      items: [
        'Cada llamada a una herramienta se comprueba contra los permisos de la conexión antes de contactar con tu servidor de correo. Una llamada fuera de lo concedido se rechaza con `insufficient_scope`.',
        'En buzones IMAP, una conexión de solo lectura abre cada carpeta con `EXAMINE`, la forma de solo lectura de `SELECT`. Así es tu propio proveedor quien rechaza cualquier cambio de indicador, traslado o eliminación en esa sesión, haga lo que haga nuestro código.',
        'Los mensajes se obtienen con `BODY.PEEK`, así que leer un mensaje nunca lo marca como leído. Esto vale para todas las conexiones, no solo las de solo lectura.',
        'La herramienta de lectura nunca cambia tu buzón. Su antigua opción `mark_as_read` se eliminó; marcar como leído es una acción aparte que requiere el permiso `manage:folders`.',
        'Los clientes de IA que inician sesión con OAuth ven la lista completa de herramientas, para poder pedirte más acceso. Esas llamadas siguen fallando hasta que lo concedas.',
      ],
    },
    {
      id: 'connect',
      h: 'Qué ocurre al conectarte',
      items: [
        'Abrimos una conexión TLS, verificamos el certificado del servidor, iniciamos sesión una vez para comprobar tu contraseña o contraseña de aplicación, y cerramos la sesión.',
        'No se descarga, copia ni indexa nada. Los mensajes se obtienen de tu proveedor solo cuando una herramienta los pide.',
        'Solo hay trabajo en segundo plano para las funciones que activas. Las automatizaciones, los envíos programados, los seguimientos y los mensajes pospuestos requieren permisos de escritura que una conexión de solo lectura no tiene. El resumen matinal y los webhooks de correo nuevo son ajustes del panel, no permisos de la conexión: el resumen lee tu bandeja y le añade un mensaje, y los webhooks comprueban si hay correo nuevo. Ambos siguen desactivados salvo que los actives.',
        'Si nunca quieres enviar desde la dirección, elige **Configuración avanzada** → **Tipo de conexión** → **Solo recibir (IMAP)** al conectarla. No se configura ni se contacta ningún servidor SMTP.',
      ],
    },
    {
      id: 'search',
      h: 'Búsquedas en buzones grandes',
      items: [
        'En buzones IMAP, la búsqueda se ejecuta en el servidor de tu proveedor con IMAP `SEARCH`. Solo descargamos la página de resultados solicitada, hasta 100 mensajes, y la IA recorre el resto página a página.',
        'La búsqueda abarca la bandeja de entrada salvo que se indique una carpeta, porque buscar en todas las carpetas de una cuenta grande es lento.',
        'Cada búsqueda tiene un límite de 30 segundos. En un buzón con decenas de miles de mensajes, acota una búsqueda amplia por remitente, asunto o fecha.',
      ],
    },
  ],
  evidence: {
    h: 'Compruébalo tú mismo',
    intro: 'MCPEmails es de código abierto. Estos archivos implementan y prueban lo que describe esta página:',
    labels: {
      examine: 'EXAMINE para conexiones de solo lectura',
      examineTests: 'Pruebas de EXAMINE, incluido el proveedor rechazando un cambio de indicador',
      scopes: 'La lista de permisos',
      markAsRead: 'La eliminación de mark_as_read de la herramienta de lectura',
      peek: 'El cliente IMAP: toda obtención de contenido usa BODY.PEEK',
    },
  },
  cta: { title: 'Conecta un buzón en solo lectura', sub: 'Una bandeja gratis, para siempre.', button: 'Empezar', providers: 'Proveedores compatibles' },
};

const fr = {
  meta: {
    title: 'Accès en lecture seule aux e-mails pour les agents IA',
    description:
      'Ce qu\'une connexion MCPEmails en lecture seule peut et ne peut pas faire, comment notre serveur et votre fournisseur de messagerie refusent les modifications, pourquoi la lecture ne marque jamais un e-mail comme lu, et ce qui se passe à la connexion.',
  },
  breadcrumb: 'Accès en lecture seule',
  eyebrow: 'Documentation',
  title: 'Accès en lecture seule',
  lead:
    'Une connexion en lecture seule permet à une IA de lire votre courrier et d\'y faire des recherches, rien de plus. Cette page détaille ce qu\'elle peut faire, ce qu\'elle ne peut pas faire, et comment chaque limite est appliquée.',
  sections: [
    {
      id: 'what',
      h: 'Ce que peut faire une connexion en lecture seule',
      items: [
        'Elle détient l\'autorisation `read:email` et, éventuellement, `search:email`, qui n\'ajoute rien.',
        'Elle peut lister, lire et rechercher des messages, télécharger des pièces jointes, et lister les boîtes et les dossiers.',
        'Elle ne peut pas envoyer, répondre, créer de brouillon, déplacer, marquer d\'un indicateur, marquer comme lu, supprimer, programmer ni créer d\'automatisation.',
      ],
    },
    {
      id: 'choose',
      h: 'Comment la choisir',
      items: [
        'Quand vous connectez un client IA, l\'écran de consentement propose des niveaux d\'accès. Choisissez **Lecture seule** (« Lire et rechercher dans votre courrier. Ne peut rien envoyer, modifier ni supprimer. ») ou ouvrez **Personnaliser les autorisations** et n\'accordez que la lecture. Vous pouvez aussi limiter la connexion à certaines de vos boîtes.',
        'ChatGPT ouvre cet écran sur **Accès complet**, car il ne peut pas revenir demander plus d\'accès plus tard. Sélectionnez **Lecture seule** avant de cliquer sur **Autoriser l\'accès**.',
        'Les clés API créées dans le tableau de bord peuvent être limitées aux mêmes autorisations.',
      ],
    },
    {
      id: 'enforced',
      h: 'Comment les limites sont appliquées',
      items: [
        'Chaque appel d\'outil est vérifié par rapport aux autorisations de la connexion avant que nous contactions votre serveur de messagerie. Un appel hors autorisation est refusé avec `insufficient_scope`.',
        'Sur les boîtes IMAP, une connexion en lecture seule ouvre chaque dossier avec `EXAMINE`, la forme en lecture seule de `SELECT`. C\'est alors votre fournisseur lui-même qui refuse tout changement d\'indicateur, déplacement ou suppression pendant cette session, quoi que fasse notre code.',
        'Les messages sont récupérés avec `BODY.PEEK` : lire un message ne le marque donc jamais comme lu. C\'est vrai pour toutes les connexions, pas seulement en lecture seule.',
        'L\'outil de lecture ne modifie jamais votre boîte. Son ancienne option `mark_as_read` a été supprimée ; marquer comme lu est une action distincte qui exige l\'autorisation `manage:folders`.',
        'Les clients IA qui se connectent via OAuth voient la liste complète des outils, pour pouvoir vous demander plus d\'accès. Ces appels échouent tant que vous ne l\'accordez pas.',
      ],
    },
    {
      id: 'connect',
      h: 'Ce qui se passe à la connexion',
      items: [
        'Nous ouvrons une connexion TLS, vérifions le certificat du serveur, nous connectons une fois pour contrôler votre mot de passe ou mot de passe d\'application, puis nous déconnectons.',
        'Rien n\'est téléchargé, copié ni indexé. Les messages ne sont récupérés chez votre fournisseur que lorsqu\'un outil les demande.',
        'Aucun travail en arrière-plan ne tourne, sauf pour les fonctionnalités que vous activez. Les automatisations, les envois programmés, les relances et les mises en attente exigent des autorisations d\'écriture qu\'une connexion en lecture seule n\'a pas. Le récapitulatif du matin et les webhooks de nouveaux e-mails sont des réglages du tableau de bord, pas des autorisations de connexion : le récapitulatif lit votre boîte et y ajoute un message, et les webhooks vérifient l\'arrivée de nouveaux e-mails. Les deux restent désactivés tant que vous ne les activez pas.',
        'Si vous ne voulez jamais envoyer depuis l\'adresse, choisissez **Paramètres avancés** → **Type de connexion** → **Réception uniquement (IMAP)** en la connectant. Aucun serveur SMTP n\'est configuré ni contacté.',
      ],
    },
    {
      id: 'search',
      h: 'Rechercher dans de grandes boîtes',
      items: [
        'Sur les boîtes IMAP, la recherche s\'exécute sur le serveur de votre fournisseur avec IMAP `SEARCH`. Nous ne téléchargeons que la page de résultats demandée, jusqu\'à 100 messages, et l\'IA parcourt la suite page par page.',
        'La recherche porte sur la boîte de réception sauf si un dossier est indiqué, car chercher dans tous les dossiers d\'un grand compte est lent.',
        'Chaque recherche est limitée à 30 secondes. Dans une boîte de plusieurs dizaines de milliers de messages, affinez une recherche large par expéditeur, objet ou date.',
      ],
    },
  ],
  evidence: {
    h: 'Vérifiez par vous-même',
    intro: 'MCPEmails est open source. Ces fichiers implémentent et testent ce que décrit cette page :',
    labels: {
      examine: 'EXAMINE pour les connexions en lecture seule',
      examineTests: 'Les tests d\'EXAMINE, dont le refus d\'un changement d\'indicateur par le fournisseur',
      scopes: 'La liste des autorisations',
      markAsRead: 'Le retrait de mark_as_read de l\'outil de lecture',
      peek: 'Le client IMAP : chaque récupération de contenu utilise BODY.PEEK',
    },
  },
  cta: { title: 'Connectez une boîte en lecture seule', sub: 'Une boîte gratuite, pour toujours.', button: 'Commencer', providers: 'Fournisseurs pris en charge' },
};

const zh = {
  meta: {
    title: 'AI 代理的只读邮件访问',
    description:
      'MCPEmails 只读连接能做什么、不能做什么；我们的服务器和您的邮件服务商如何拒绝写入；为什么读取永远不会把邮件标为已读；以及连接时会发生什么。',
  },
  breadcrumb: '只读访问',
  eyebrow: '文档',
  title: '只读访问',
  lead: '只读连接让 AI 只能读取和搜索您的邮件，别无其他。本页列出它能做什么、不能做什么，以及每项限制如何执行。',
  sections: [
    {
      id: 'what',
      h: '只读连接能做什么',
      items: [
        '它持有 `read:email` 权限，也可以附带 `search:email`，但后者不增加任何能力。',
        '它可以列出、读取和搜索邮件，下载附件，并列出收件箱和文件夹。',
        '它不能发送、回复、起草、移动、加旗标、标为已读、删除、定时发送或创建自动化。',
      ],
    },
    {
      id: 'choose',
      h: '如何选择',
      items: [
        '连接 AI 客户端时，授权页面会提供访问级别。选择 **只读**（“读取和搜索您的邮件。无法发送、更改或删除任何内容。”），或打开 **自定义权限** 只授予读取。您还可以只允许连接访问部分收件箱。',
        'ChatGPT 打开此页面时默认选中 **完全访问**,因为它之后无法回来申请更多权限。请在点击 **允许访问** 之前选择 **只读**。',
        '在控制台创建的 API 密钥也可以限制为相同的权限。',
      ],
    },
    {
      id: 'enforced',
      h: '限制如何执行',
      items: [
        '每次工具调用都会在我们联系您的邮件服务器之前，按连接的权限进行检查。超出授权的调用会以 `insufficient_scope` 被拒绝。',
        '对于 IMAP 邮箱，只读连接用 `EXAMINE`（`SELECT` 的只读形式）打开每个文件夹。这样，在该会话中，无论我们的代码做什么，您的邮件服务商本身都会拒绝任何旗标更改、移动或删除。',
        '邮件内容通过 `BODY.PEEK` 获取，因此读取邮件永远不会把它标为已读。这适用于所有连接，而不仅是只读连接。',
        '读取工具从不更改您的邮箱。它旧的 `mark_as_read` 选项已被移除；标为已读是单独的操作，需要 `manage:folders` 权限。',
        '通过 OAuth 登录的 AI 客户端会看到完整的工具列表，以便向您申请更多权限。在您授予之前，这些调用仍会失败。',
      ],
    },
    {
      id: 'connect',
      h: '连接时会发生什么',
      items: [
        '我们建立 TLS 连接，验证服务器证书，登录一次以检查您的密码或应用专用密码，然后退出。',
        '不会下载、复制或索引任何内容。只有当工具请求时，才会从您的服务商获取邮件。',
        '后台任务只为你开启的功能运行。自动化、定时发送、跟进提醒和稍后处理都需要只读连接所没有的写入权限。晨间简报和新邮件 Webhook 是控制台设置，而不是连接权限：简报会读取你的收件箱并向其中添加一封邮件，Webhook 会检查是否有新邮件。两者默认关闭，除非你开启。',
        '如果您从不打算用该地址发信，连接时选择 **高级设置** → **连接类型** → **仅接收 (IMAP)**。不会配置或联系任何 SMTP 服务器。',
      ],
    },
    {
      id: 'search',
      h: '搜索大型邮箱',
      items: [
        '对于 IMAP 邮箱，搜索在您服务商的服务器上通过 IMAP `SEARCH` 执行。我们只下载所请求的那一页结果，最多 100 封，AI 再逐页获取其余结果。',
        '除非指定文件夹，搜索只覆盖收件箱，因为在大型账户的所有文件夹中搜索很慢。',
        '每次搜索限时 30 秒。在有数万封邮件的邮箱中，请按发件人、主题或日期缩小宽泛的搜索。',
      ],
    },
  ],
  evidence: {
    h: '自行核实',
    intro: 'MCPEmails 是开源的。以下文件实现并测试了本页所述内容：',
    labels: {
      examine: '只读连接使用 EXAMINE',
      examineTests: 'EXAMINE 的测试，包括服务商拒绝旗标更改',
      scopes: '权限列表',
      markAsRead: '从读取工具中移除 mark_as_read',
      peek: 'IMAP 客户端：每次获取内容都使用 BODY.PEEK',
    },
  },
  cta: { title: '以只读方式连接邮箱', sub: '一个收件箱永久免费。', button: '开始使用', providers: '支持的服务商' },
};

const de = {
  meta: {
    title: 'Nur-Lese-Zugriff auf E-Mails für KI-Agenten',
    description:
      'Was eine MCPEmails Verbindung mit Nur-Lese-Zugriff kann und was nicht, wie unser Server und Ihr E-Mail-Anbieter Schreibzugriffe ablehnen, warum Lesen E-Mails nie als gelesen markiert und was beim Verbinden passiert.',
  },
  breadcrumb: 'Nur-Lese-Zugriff',
  eyebrow: 'Dokumentation',
  title: 'Nur-Lese-Zugriff',
  lead:
    'Eine Verbindung mit Nur-Lese-Zugriff erlaubt einer KI, Ihre E-Mails zu lesen und zu durchsuchen, und sonst nichts. Diese Seite zeigt, was sie kann, was nicht und wie jede Grenze durchgesetzt wird.',
  sections: [
    {
      id: 'what',
      h: 'Was eine Verbindung mit Nur-Lese-Zugriff kann',
      items: [
        'Sie hat die Berechtigung `read:email` und optional `search:email`, die nichts hinzufügt.',
        'Sie kann Nachrichten auflisten, lesen und durchsuchen, Anhänge herunterladen sowie Postfächer und Ordner auflisten.',
        'Sie kann nicht senden, antworten, Entwürfe anlegen, verschieben, markieren, als gelesen markieren, löschen, zeitversetzt senden oder Automatisierungen erstellen.',
      ],
    },
    {
      id: 'choose',
      h: 'So wählen Sie ihn aus',
      items: [
        'Wenn Sie einen KI-Client verbinden, bietet der Zustimmungsbildschirm Zugriffsstufen an. Wählen Sie **Nur-Lese-Zugriff** („E-Mails lesen und durchsuchen. Kann nichts senden, ändern oder löschen.“) oder öffnen Sie **Berechtigungen anpassen** und gewähren Sie nur Lesen. Sie können die Verbindung auch auf einige Ihrer Postfächer beschränken.',
        'ChatGPT öffnet diesen Bildschirm mit **Vollzugriff**, weil es später nicht zurückkommen und mehr Zugriff anfragen kann. Wählen Sie **Nur-Lese-Zugriff**, bevor Sie auf **Zugriff erlauben** klicken.',
        'API-Schlüssel, die Sie im Dashboard erstellen, lassen sich auf dieselben Berechtigungen beschränken.',
      ],
    },
    {
      id: 'enforced',
      h: 'Wie die Grenzen durchgesetzt werden',
      items: [
        'Jeder Tool-Aufruf wird mit den Berechtigungen der Verbindung abgeglichen, bevor wir Ihren Mailserver kontaktieren. Ein Aufruf außerhalb der Freigabe wird mit `insufficient_scope` abgelehnt.',
        'Bei IMAP-Postfächern öffnet eine Verbindung mit Nur-Lese-Zugriff jeden Ordner mit `EXAMINE`, der schreibgeschützten Form von `SELECT`. Ihr E-Mail-Anbieter lehnt dann in dieser Sitzung jede Änderung von Markierungen, jedes Verschieben und jedes Löschen selbst ab, egal was unser Code tut.',
        'Nachrichten werden mit `BODY.PEEK` abgerufen. Das Lesen einer Nachricht markiert sie daher nie als gelesen. Das gilt für jede Verbindung, nicht nur für solche mit Nur-Lese-Zugriff.',
        'Das Lese-Tool ändert Ihr Postfach nie. Seine frühere Option `mark_as_read` wurde entfernt. Als gelesen markieren ist eine eigene Aktion, die die Berechtigung `manage:folders` braucht.',
        'KI-Clients, die sich per OAuth anmelden, sehen die vollständige Tool-Liste, damit sie Sie um mehr Zugriff bitten können. Diese Aufrufe scheitern trotzdem, bis Sie den Zugriff gewähren.',
      ],
    },
    {
      id: 'connect',
      h: 'Was beim Verbinden passiert',
      items: [
        'Wir öffnen eine TLS-Verbindung, prüfen das Zertifikat des Servers, melden uns einmal an, um Ihr Passwort oder App-Passwort zu prüfen, und melden uns wieder ab.',
        'Nichts wird heruntergeladen, kopiert oder indexiert. Nachrichten werden nur dann bei Ihrem Anbieter abgerufen, wenn ein Tool sie anfordert.',
        'Im Hintergrund läuft nur, was Sie selbst einschalten. Automatisierungen, zeitversetzte Sendungen, Nachfassen und Zurückstellen brauchen Schreibrechte, die eine Verbindung mit Nur-Lese-Zugriff nicht hat. Das Morgen-Briefing und Webhooks für neue E-Mails sind Dashboard-Einstellungen, keine Verbindungsrechte: Das Briefing liest Ihren Posteingang und fügt ihm eine Nachricht hinzu, und Webhooks prüfen auf neue E-Mails. Beides bleibt aus, bis Sie es einschalten.',
        'Wenn Sie von der Adresse nie senden möchten, wählen Sie beim Verbinden **Erweiterte Einstellungen** → **Verbindungstyp** → **Nur empfangen (IMAP)**. Dann wird kein SMTP-Server eingerichtet oder kontaktiert.',
      ],
    },
    {
      id: 'search',
      h: 'Große Postfächer durchsuchen',
      items: [
        'Bei IMAP-Postfächern läuft die Suche mit IMAP `SEARCH` auf dem Server Ihres Anbieters. Wir laden nur die angeforderte Ergebnisseite herunter, bis zu 100 Nachrichten, und die KI blättert durch den Rest.',
        'Die Suche umfasst den Posteingang, sofern kein Ordner angegeben ist, denn alle Ordner eines großen Kontos zu durchsuchen ist langsam.',
        'Jede Suche ist auf 30 Sekunden begrenzt. Grenzen Sie in einem Postfach mit Zehntausenden Nachrichten eine breite Suche nach Absender, Betreff oder Datum ein.',
      ],
    },
  ],
  evidence: {
    h: 'Prüfen Sie es selbst',
    intro: 'MCPEmails ist Open Source. Diese Dateien setzen um und testen, was diese Seite beschreibt:',
    labels: {
      examine: 'EXAMINE für Verbindungen mit Nur-Lese-Zugriff',
      examineTests: 'Tests für EXAMINE, einschließlich der Ablehnung einer Markierungsänderung durch den Anbieter',
      scopes: 'Die Liste der Berechtigungen',
      markAsRead: 'Entfernung von mark_as_read aus dem Lese-Tool',
      peek: 'Der IMAP-Client: Jeder Abruf von Inhalten nutzt BODY.PEEK',
    },
  },
  cta: { title: 'Postfach mit Nur-Lese-Zugriff verbinden', sub: 'Ein Postfach ist kostenlos, für immer.', button: 'Jetzt starten', providers: 'Unterstützte Anbieter' },
};

const pt = {
  meta: {
    title: 'Acesso somente leitura ao e-mail para agentes de IA',
    description:
      'O que uma conexão somente leitura do MCPEmails pode e não pode fazer, como alterações são recusadas pelo nosso servidor e pelo seu provedor de e-mail, por que ler nunca marca o e-mail como lido e o que acontece quando você conecta.',
  },
  breadcrumb: 'Acesso somente leitura',
  eyebrow: 'Documentação',
  title: 'Acesso somente leitura',
  lead:
    'Uma conexão somente leitura permite que uma IA leia e pesquise seus e-mails, e nada mais. Esta página mostra o que ela pode fazer, o que não pode e como cada limite é aplicado.',
  sections: [
    {
      id: 'what',
      h: 'O que uma conexão somente leitura pode fazer',
      items: [
        'Ela tem a permissão `read:email` e, opcionalmente, `search:email`, que não acrescenta nada além disso.',
        'Ela pode listar, ler e pesquisar mensagens, baixar anexos e listar caixas de entrada e pastas.',
        'Ela não pode enviar, responder, criar rascunhos, mover, sinalizar, marcar como lido, excluir, agendar nem criar automações.',
      ],
    },
    {
      id: 'choose',
      h: 'Como escolher esse acesso',
      items: [
        'Quando você conecta um cliente de IA, a tela de consentimento oferece níveis de acesso. Escolha **Somente leitura** ("Lê e pesquisa seus e-mails. Não envia, altera nem exclui nada.") ou abra **Personalizar permissões** e conceda só leitura. Você também pode limitar a conexão a algumas das suas caixas de entrada.',
        'O ChatGPT abre essa tela em **Acesso total**, porque não consegue voltar depois para pedir mais acesso. Selecione **Somente leitura** antes de clicar em **Permitir acesso**.',
        'Chaves de API criadas no painel podem ser limitadas às mesmas permissões.',
      ],
    },
    {
      id: 'enforced',
      h: 'Como os limites são aplicados',
      items: [
        'Cada chamada de ferramenta é verificada contra as permissões da conexão antes de entrarmos em contato com o seu servidor de e-mail. Uma chamada fora do que foi concedido é recusada com `insufficient_scope`.',
        'Em caixas de correio IMAP, uma conexão somente leitura abre cada pasta com `EXAMINE`, a forma somente leitura de `SELECT`. Assim, o próprio provedor de e-mail recusa qualquer mudança de sinalização, movimentação ou exclusão nessa sessão, independentemente do que o nosso código faça.',
        'As mensagens são buscadas com `BODY.PEEK`, então ler uma mensagem nunca a marca como lida. Isso vale para todas as conexões, não só as somente leitura.',
        'A ferramenta de leitura nunca altera sua caixa de correio. A antiga opção `mark_as_read` foi removida; marcar como lido é uma ação separada que exige a permissão `manage:folders`.',
        'Clientes de IA que entram com OAuth veem a lista completa de ferramentas, para poderem pedir mais acesso a você. Essas chamadas continuam falhando até você conceder o acesso.',
      ],
    },
    {
      id: 'connect',
      h: 'O que acontece quando você conecta',
      items: [
        'Abrimos uma conexão TLS, verificamos o certificado do servidor, fazemos login uma vez para conferir sua senha ou senha de app e saímos.',
        'Nada é baixado, copiado ou indexado. As mensagens são buscadas no seu provedor só quando uma ferramenta as solicita.',
        'Só há trabalho em segundo plano para recursos que você ativa. Automações, envios agendados, lembretes de acompanhamento e sonecas exigem permissões de escrita que uma conexão somente leitura não tem. O resumo matinal e os webhooks de e-mail novo são configurações do painel, não permissões da conexão: o resumo lê a sua caixa de entrada e adiciona uma mensagem a ela, e os webhooks verificam se há e-mail novo. Os dois ficam desativados até você ativá-los.',
        'Se você nunca quiser enviar a partir do endereço, escolha **Configurações avançadas** → **Tipo de conexão** → **Só receber (IMAP)** ao conectá-lo. Nenhum servidor SMTP é configurado ou contatado.',
      ],
    },
    {
      id: 'search',
      h: 'Pesquisa em caixas de correio grandes',
      items: [
        'Em caixas de correio IMAP, a pesquisa roda no servidor do seu provedor com o `SEARCH` do IMAP. Baixamos só a página de resultados solicitada, com até 100 mensagens, e a IA percorre o restante página por página.',
        'A pesquisa cobre a caixa de entrada, a menos que uma pasta seja indicada, porque pesquisar todas as pastas de uma conta grande é lento.',
        'Cada pesquisa tem um limite de 30 segundos. Em uma caixa de correio com dezenas de milhares de mensagens, refine uma pesquisa ampla por remetente, assunto ou data.',
      ],
    },
  ],
  evidence: {
    h: 'Confira você mesmo',
    intro: 'O MCPEmails é de código aberto. Estes arquivos implementam e testam o que esta página descreve:',
    labels: {
      examine: 'EXAMINE para conexões somente leitura',
      examineTests: 'Testes do EXAMINE, incluindo o provedor recusando uma mudança de sinalização',
      scopes: 'A lista de permissões',
      markAsRead: 'Remoção do mark_as_read da ferramenta de leitura',
      peek: 'O cliente IMAP: toda busca de conteúdo usa BODY.PEEK',
    },
  },
  cta: { title: 'Conecte uma caixa de correio em modo somente leitura', sub: 'Uma caixa de entrada é grátis, para sempre.', button: 'Começar', providers: 'Provedores compatíveis' },
};

const ja = {
  meta: {
    title: 'AIエージェント向けの読み取り専用メールアクセス',
    description:
      'MCPEmailsの読み取り専用接続でできること、できないこと。書き込みが当社のサーバーとメールプロバイダーの両方で拒否される仕組み、読んでも既読にならない理由、接続時に行われる処理を説明します。',
  },
  breadcrumb: '読み取り専用アクセス',
  eyebrow: 'ドキュメント',
  title: '読み取り専用アクセス',
  lead:
    '読み取り専用接続では、AIはメールの読み取りと検索だけを行えます。このページでは、できること、できないこと、そして各制限がどのように適用されるかを説明します。',
  sections: [
    {
      id: 'what',
      h: '読み取り専用接続でできること',
      items: [
        '`read:email` 権限を持ち、オプションで `search:email` も持ちます。`search:email` で追加される操作はありません。',
        'メッセージの一覧表示、閲覧、検索、添付ファイルのダウンロード、受信トレイとフォルダーの一覧表示ができます。',
        '送信、返信、下書きの作成、移動、フラグ付け、既読にする操作、削除、予約送信、自動化の作成はできません。',
      ],
    },
    {
      id: 'choose',
      h: '選び方',
      items: [
        'AIクライアントを接続すると、同意画面でアクセスレベルを選べます。**読み取り専用**（「メールの読み取りと検索。送信、変更、削除はできません。」）を選ぶか、**権限を個別に設定**を開いて読み取りだけを許可してください。接続を一部の受信トレイに限定することもできます。',
        'ChatGPTでは、この画面は**フルアクセス**が選択された状態で開きます。ChatGPTは後から追加のアクセスを求めることができないためです。**アクセスを許可**をクリックする前に**読み取り専用**を選んでください。',
        'ダッシュボードで作成したAPIキーも、同じ権限に限定できます。',
      ],
    },
    {
      id: 'enforced',
      h: '制限の適用方法',
      items: [
        'ツールの呼び出しはすべて、メールサーバーに接続する前に接続の権限と照合されます。許可された範囲外の呼び出しは `insufficient_scope` で拒否されます。',
        'IMAPのメールボックスでは、読み取り専用接続は各フォルダーを `SELECT` の読み取り専用版である `EXAMINE` で開きます。そのため、当社のコードの動作にかかわらず、そのセッションでのフラグ変更、移動、削除はメールプロバイダー自身が拒否します。',
        'メッセージは `BODY.PEEK` で取得するため、読んでも既読になりません。これは読み取り専用に限らず、すべての接続に当てはまります。',
        '読み取りツールがメールボックスを変更することはありません。以前の `mark_as_read` オプションは削除されました。既読にする操作は別のアクションで、`manage:folders` 権限が必要です。',
        'OAuthでログインするAIクライアントには、追加のアクセスを求められるよう、ツールの一覧がすべて表示されます。ただし、アクセスを許可するまで、それらの呼び出しは失敗します。',
      ],
    },
    {
      id: 'connect',
      h: '接続時に行われること',
      items: [
        'TLS接続を開き、サーバーの証明書を検証し、パスワードまたはアプリ パスワードを確認するために一度ログインしてから、ログアウトします。',
        'ダウンロード、コピー、インデックス作成は一切行いません。メッセージは、ツールが要求したときにだけプロバイダーから取得します。',
        'バックグラウンドで動くのは、オンにした機能だけです。自動化、予約送信、フォローアップ、スヌーズには、読み取り専用接続にはない書き込み権限が必要です。モーニングブリーフと新着メールのWebhookは接続の権限ではなく、ダッシュボードの設定です。ブリーフは受信トレイを読み取ってメッセージを1通追加し、Webhookは新着メールを確認します。どちらもオンにしない限りオフのままです。',
        'そのアドレスから送信することがない場合は、接続時に**詳細設定** → **接続の種類** → **受信のみ (IMAP)** を選んでください。SMTPサーバーの設定も接続も行われません。',
      ],
    },
    {
      id: 'search',
      h: '大きなメールボックスの検索',
      items: [
        'IMAPのメールボックスでは、検索はIMAPの `SEARCH` を使ってプロバイダーのサーバー上で実行されます。ダウンロードするのは要求された結果の1ページ分（最大100件）だけで、残りはAIがページ単位で取得します。',
        'フォルダーを指定しない限り、検索対象は受信トレイです。大きなアカウントのすべてのフォルダーを検索すると時間がかかるためです。',
        '1回の検索には30秒の制限があります。数万件のメッセージがあるメールボックスでは、差出人、件名、日付で広い検索を絞り込んでください。',
      ],
    },
  ],
  evidence: {
    h: 'ご自身で確認する',
    intro: 'MCPEmailsはオープンソースです。このページで説明している内容は、次のファイルで実装とテストが行われています。',
    labels: {
      examine: '読み取り専用接続でのEXAMINE',
      examineTests: 'EXAMINEのテスト（プロバイダーがフラグ変更を拒否するケースを含む）',
      scopes: '権限の一覧',
      markAsRead: '読み取りツールからのmark_as_readの削除',
      peek: 'IMAPクライアント: 本文の取得にはすべてBODY.PEEKを使用',
    },
  },
  cta: { title: 'メールボックスを読み取り専用で接続', sub: '受信トレイ1つは、ずっと無料です。', button: '始める', providers: '対応プロバイダー' },
};

export const READ_ONLY_ACCESS = { en, nb, es, fr, zh, de, pt, ja };

export function readOnlyAccessCopy(locale) {
  return READ_ONLY_ACCESS[locale] ?? en;
}
