// Copy for /developers, the developer landing page, in every locale.
//
// Kept next to the page rather than in messages/: a messages/ namespace is
// serialised into every marketing page, and this copy is only read here
// (apps/web/CLAUDE.md).
//
// TRANSLATION: en, nb, es, fr, de and zh each have their own object of the
// same shape. A copy change goes into all six.
//
// Every claim is traced to code. If one of these changes, change the page:
//   providers              src/lib/email-providers/*, /docs/providers;
//                          Fastmail is an app password only (no OAuth, no JMAP)
//   one endpoint           supabase/functions/mcp-server/index.ts, /api/mcp
//   flat price             src/lib/stripe/plans.ts: paid plans carry no
//                          per-call price; the page names no limit
//   webhooks               PR claude/dev-api-webhooks (Pro and Business,
//                          HMAC-SHA256 signature, retries up to 24 hours,
//                          about two minutes, polling)
//   idempotency            claimOutboundIdempotency + idempotency-replay.ts
//   scoped keys            src/lib/api-keys/scopes.ts, api_keys.inbox_ids
//   send approval          send_review_mode per inbox (every plan)
//   open source            /self-hosting, github.com/Albretsen/MCPEmails
//
// No competitor names on this page, and no tool count.
// Inline markup: `code`, **bold** and [label](/path), rendered by the page.

const en = {
  meta: {
    title: 'Email API for AI agents, on the inboxes you already have',
    description:
      'Give scripts, n8n workflows and your own AI agents a real Gmail, Outlook or IMAP mailbox over one HTTPS endpoint. MCP and signed webhooks on the same key, scoped keys, idempotent sends and a flat plan price.',
  },
  breadcrumb: 'Developers',
  hero: {
    eyebrow: 'Developers',
    title: 'An email API for AI agents, on the inboxes you already have',
    lead:
      'Connect Gmail, Outlook or any IMAP mailbox once. Your scripts, workflows and agents then read, search, draft and send from those real addresses over one HTTPS endpoint, with MCP and webhooks on the same key.',
    primary: 'Read the developer guide',
    secondary: 'See pricing',
  },
  why: {
    h: 'What you get',
    cards: [
      {
        h: 'Your real mailboxes',
        p: 'Gmail, Outlook and Microsoft 365, iCloud, Yahoo, Zoho, Fastmail with an app password, and any IMAP server. Agents work on the addresses your customers already know, with their history and their sender reputation. Nothing to migrate.',
      },
      {
        h: 'MCP and webhooks on one key',
        p: 'The endpoint that Claude and ChatGPT connect to also answers plain HTTPS from your code. On Pro and Business, a webhook starts your workflow when mail arrives, usually within about two minutes.',
      },
      {
        h: 'A flat price',
        p: 'Paid plans have a fixed monthly price and no per-call charge, so a busy workflow costs the same as a quiet one. Start free with one inbox.',
      },
      {
        h: 'Signed webhooks',
        p: 'Every delivery is signed with HMAC-SHA256 over a timestamp and the body, carries an event id for deduplication, and is retried up to six times when your endpoint does not answer.',
      },
      {
        h: 'Idempotent sends',
        p: 'Pass an `idempotency_key` and retry after a dropped connection without sending twice. The retry hands back the original message id.',
      },
      {
        h: 'Scoped keys',
        p: 'Each key holds only the permissions and inboxes it needs, so a triage script can read the support inbox and nothing else. Revoke one key without touching the others.',
      },
      {
        h: 'Send approval',
        p: 'Hold every send from an inbox until a person approves it. A good default while a new automation proves itself.',
      },
      {
        h: 'Open source',
        p: 'The server is open source, so you can read how each call is handled. You can also [run it yourself](/self-hosting).',
      },
    ],
  },
  how: {
    h: 'How it works',
    steps: [
      'Connect a mailbox in the dashboard. Outlook signs in with Microsoft; most other providers take an app password.',
      'Create an API key, tick the scopes it needs and, if you like, pin it to some inboxes.',
      'Call `tools/list` to see what the key can do, then `tools/call` to read, search, draft or send.',
      'On Pro or Business, add a webhook endpoint so new mail reaches your workflow without polling.',
    ],
    codeLabel: 'bash',
  },
  uses: {
    h: 'What developers build',
    items: [
      '**n8n and other workflow tools:** start a workflow on new mail, read it, and file, draft or reply.',
      '**Coding agents:** give Claude Code a real inbox over HTTP with one command and a key.',
      '**Support and sales agents:** triage a shared inbox, draft answers for a person to approve, follow up on schedule.',
      '**Your own agent:** call the same tools from any language that can send an HTTPS request.',
    ],
  },
  cta: {
    title: 'Connect an inbox and make your first call',
    sub: 'One inbox is free, forever. No card required.',
    button: 'Get started free',
    guide: 'Developer guide',
    pricing: 'See pricing',
  },
  featureList: [
    'Email API over HTTPS (JSON-RPC 2.0, Model Context Protocol)',
    'Works with existing Gmail, Outlook, Microsoft 365 and IMAP mailboxes',
    'Signed webhooks for new mail',
    'Idempotency keys for safe retries',
    'Scoped API keys with per-inbox access',
    'Human approval before sending',
  ],
};

const nb = {
  meta: {
    title: 'E-post-API for AI-agenter, på innboksene du allerede har',
    description:
      'Gi skript, n8n-arbeidsflyter og dine egne AI-agenter en ekte Gmail-, Outlook- eller IMAP-postboks over ett HTTPS-endepunkt. MCP og signerte webhooks på samme nøkkel, avgrensede nøkler, idempotente sendinger og en fast planpris.',
  },
  breadcrumb: 'Utviklere',
  hero: {
    eyebrow: 'Utviklere',
    title: 'Et e-post-API for AI-agenter, på innboksene du allerede har',
    lead:
      'Koble til Gmail, Outlook eller en hvilken som helst IMAP-postboks én gang. Skriptene, arbeidsflytene og agentene dine leser, søker, skriver utkast og sender fra de ekte adressene over ett HTTPS-endepunkt, med MCP og webhooks på samme nøkkel.',
    primary: 'Les utviklerguiden',
    secondary: 'Se priser',
  },
  why: {
    h: 'Det du får',
    cards: [
      {
        h: 'Dine ekte postbokser',
        p: 'Gmail, Outlook og Microsoft 365, iCloud, Yahoo, Zoho, Fastmail med app-passord, og enhver IMAP-server. Agentene jobber på adressene kundene dine allerede kjenner, med historikken og avsenderomdømmet. Ingenting å migrere.',
      },
      {
        h: 'MCP og webhooks på én nøkkel',
        p: 'Endepunktet som Claude og ChatGPT kobler seg til, svarer også på vanlig HTTPS fra koden din. På Pro og Business starter en webhook arbeidsflyten din når e-post kommer inn, vanligvis innen rundt to minutter.',
      },
      {
        h: 'En fast pris',
        p: 'Betalte planer har en fast månedspris og ingen kostnad per kall, så en travel arbeidsflyt koster det samme som en rolig. Start gratis med én innboks.',
      },
      {
        h: 'Signerte webhooks',
        p: 'Hver levering signeres med HMAC-SHA256 over et tidsstempel og kroppen, har en hendelses-id for deduplisering, og prøves på nytt opptil seks ganger når endepunktet ditt ikke svarer.',
      },
      {
        h: 'Idempotente sendinger',
        p: 'Send med en `idempotency_key` og prøv igjen etter en brutt tilkobling uten å sende to ganger. Det nye forsøket gir deg tilbake den opprinnelige meldings-id-en.',
      },
      {
        h: 'Avgrensede nøkler',
        p: 'Hver nøkkel har bare tillatelsene og innboksene den trenger, så et sorteringsskript kan lese support-innboksen og ingenting annet. Trekk tilbake én nøkkel uten å røre de andre.',
      },
      {
        h: 'Godkjenning av sending',
        p: 'Hold tilbake alle sendinger fra en innboks til en person godkjenner dem. Et godt utgangspunkt mens en ny automatisering beviser seg.',
      },
      {
        h: 'Åpen kildekode',
        p: 'Serveren er åpen kildekode, så du kan lese hvordan hvert kall håndteres. Du kan også [kjøre den selv](/self-hosting).',
      },
    ],
  },
  how: {
    h: 'Slik fungerer det',
    steps: [
      'Koble til en postboks i dashbordet. Outlook logger inn med Microsoft; de fleste andre leverandører tar et app-passord.',
      'Opprett en API-nøkkel, huk av omfangene den trenger og lås den gjerne til noen innbokser.',
      'Kall `tools/list` for å se hva nøkkelen kan gjøre, deretter `tools/call` for å lese, søke, skrive utkast eller sende.',
      'På Pro eller Business, legg til et webhook-endepunkt så ny e-post når arbeidsflyten din uten polling.',
    ],
    codeLabel: 'bash',
  },
  uses: {
    h: 'Det utviklere bygger',
    items: [
      '**n8n og andre arbeidsflytverktøy:** start en arbeidsflyt på ny e-post, les den, og arkiver, skriv utkast eller svar.',
      '**Kodeagenter:** gi Claude Code en ekte innboks over HTTP med én kommando og en nøkkel.',
      '**Support- og salgsagenter:** sorter en delt innboks, skriv utkast til svar som en person godkjenner, følg opp etter tidsplan.',
      '**Din egen agent:** kall de samme verktøyene fra et hvilket som helst språk som kan sende en HTTPS-forespørsel.',
    ],
  },
  cta: {
    title: 'Koble til en innboks og gjør ditt første kall',
    sub: 'Én innboks er gratis, for alltid. Ingen kort nødvendig.',
    button: 'Kom i gang gratis',
    guide: 'Utviklerguide',
    pricing: 'Se priser',
  },
  featureList: [
    'E-post-API over HTTPS (JSON-RPC 2.0, Model Context Protocol)',
    'Fungerer med eksisterende Gmail-, Outlook-, Microsoft 365- og IMAP-postbokser',
    'Signerte webhooks for ny e-post',
    'Idempotensnøkler for trygge nye forsøk',
    'Avgrensede API-nøkler med tilgang per innboks',
    'Menneskelig godkjenning før sending',
  ],
};

const es = {
  meta: {
    title: 'API de correo para agentes de IA, en los buzones que ya tienes',
    description:
      'Da a tus scripts, flujos de n8n y agentes de IA un buzón real de Gmail, Outlook o IMAP a través de un único endpoint HTTPS. MCP y webhooks firmados con la misma clave, claves con ámbitos, envíos idempotentes y un precio de plan fijo.',
  },
  breadcrumb: 'Desarrolladores',
  hero: {
    eyebrow: 'Desarrolladores',
    title: 'Una API de correo para agentes de IA, en los buzones que ya tienes',
    lead:
      'Conecta Gmail, Outlook o cualquier buzón IMAP una sola vez. Tus scripts, flujos de trabajo y agentes leen, buscan, redactan y envían desde esas direcciones reales a través de un único endpoint HTTPS, con MCP y webhooks en la misma clave.',
    primary: 'Leer la guía para desarrolladores',
    secondary: 'Ver precios',
  },
  why: {
    h: 'Lo que obtienes',
    cards: [
      {
        h: 'Tus buzones reales',
        p: 'Gmail, Outlook y Microsoft 365, iCloud, Yahoo, Zoho, Fastmail con contraseña de aplicación y cualquier servidor IMAP. Los agentes trabajan en las direcciones que tus clientes ya conocen, con su historial y su reputación de remitente. Nada que migrar.',
      },
      {
        h: 'MCP y webhooks en una clave',
        p: 'El endpoint al que se conectan Claude y ChatGPT también responde a HTTPS normal desde tu código. En Pro y Business, un webhook arranca tu flujo de trabajo cuando llega correo, normalmente en unos dos minutos.',
      },
      {
        h: 'Un precio fijo',
        p: 'Los planes de pago tienen un precio mensual fijo y ningún cargo por llamada, así que un flujo de trabajo intenso cuesta lo mismo que uno tranquilo. Empieza gratis con un buzón.',
      },
      {
        h: 'Webhooks firmados',
        p: 'Cada entrega se firma con HMAC-SHA256 sobre una marca de tiempo y el cuerpo, lleva un id de evento para deduplicar y se reintenta hasta seis veces cuando tu endpoint no responde.',
      },
      {
        h: 'Envíos idempotentes',
        p: 'Pasa una `idempotency_key` y reintenta tras una conexión cortada sin enviar dos veces. El reintento te devuelve el id del mensaje original.',
      },
      {
        h: 'Claves con ámbitos',
        p: 'Cada clave tiene solo los permisos y buzones que necesita, así que un script de triaje puede leer el buzón de soporte y nada más. Revoca una clave sin tocar las demás.',
      },
      {
        h: 'Aprobación de envíos',
        p: 'Retén todos los envíos de un buzón hasta que una persona los apruebe. Un buen valor por defecto mientras una automatización nueva demuestra lo que vale.',
      },
      {
        h: 'Código abierto',
        p: 'El servidor es de código abierto, así que puedes leer cómo se gestiona cada llamada. También puedes [ejecutarlo tú mismo](/self-hosting).',
      },
    ],
  },
  how: {
    h: 'Cómo funciona',
    steps: [
      'Conecta un buzón en el panel. Outlook inicia sesión con Microsoft; la mayoría de los demás proveedores aceptan una contraseña de aplicación.',
      'Crea una clave de API, marca los ámbitos que necesita y, si quieres, fíjala a algunos buzones.',
      'Llama a `tools/list` para ver qué puede hacer la clave, y luego a `tools/call` para leer, buscar, redactar o enviar.',
      'En Pro o Business, añade un endpoint de webhook para que el correo nuevo llegue a tu flujo de trabajo sin consultas periódicas.',
    ],
    codeLabel: 'bash',
  },
  uses: {
    h: 'Lo que construyen los desarrolladores',
    items: [
      '**n8n y otras herramientas de flujos de trabajo:** arranca un flujo con el correo nuevo, léelo y archívalo, redacta o responde.',
      '**Agentes de programación:** da a Claude Code un buzón real por HTTP con un comando y una clave.',
      '**Agentes de soporte y ventas:** haz triaje de un buzón compartido, redacta respuestas para que una persona las apruebe, haz seguimiento según un horario.',
      '**Tu propio agente:** llama a las mismas herramientas desde cualquier lenguaje que pueda enviar una solicitud HTTPS.',
    ],
  },
  cta: {
    title: 'Conecta un buzón y haz tu primera llamada',
    sub: 'Un buzón es gratis, para siempre. Sin tarjeta.',
    button: 'Empezar gratis',
    guide: 'Guía para desarrolladores',
    pricing: 'Ver precios',
  },
  featureList: [
    'API de correo sobre HTTPS (JSON-RPC 2.0, Model Context Protocol)',
    'Funciona con buzones existentes de Gmail, Outlook, Microsoft 365 e IMAP',
    'Webhooks firmados para el correo nuevo',
    'Claves de idempotencia para reintentos seguros',
    'Claves de API con ámbitos y acceso por buzón',
    'Aprobación humana antes de enviar',
  ],
};

const fr = {
  meta: {
    title: 'API e-mail pour agents IA, sur les boîtes que vous avez déjà',
    description:
      'Donnez à vos scripts, workflows n8n et agents IA une vraie boîte Gmail, Outlook ou IMAP via un seul endpoint HTTPS. MCP et webhooks signés sur la même clé, clés à portées limitées, envois idempotents et un tarif de formule fixe.',
  },
  breadcrumb: 'Développeurs',
  hero: {
    eyebrow: 'Développeurs',
    title: 'Une API e-mail pour agents IA, sur les boîtes que vous avez déjà',
    lead:
      'Connectez Gmail, Outlook ou n\'importe quelle boîte IMAP une seule fois. Vos scripts, workflows et agents lisent, recherchent, rédigent et envoient depuis ces vraies adresses via un seul endpoint HTTPS, avec MCP et webhooks sur la même clé.',
    primary: 'Lire le guide développeur',
    secondary: 'Voir les tarifs',
  },
  why: {
    h: 'Ce que vous obtenez',
    cards: [
      {
        h: 'Vos vraies boîtes mail',
        p: 'Gmail, Outlook et Microsoft 365, iCloud, Yahoo, Zoho, Fastmail avec un mot de passe d\'application, et n\'importe quel serveur IMAP. Les agents travaillent sur les adresses que vos clients connaissent déjà, avec leur historique et leur réputation d\'expéditeur. Rien à migrer.',
      },
      {
        h: 'MCP et webhooks sur une seule clé',
        p: 'L\'endpoint auquel Claude et ChatGPT se connectent répond aussi au HTTPS ordinaire depuis votre code. Sur Pro et Business, un webhook lance votre workflow à l\'arrivée du courrier, généralement en deux minutes environ.',
      },
      {
        h: 'Un prix fixe',
        p: 'Les formules payantes ont un prix mensuel fixe et aucune facturation à l\'appel : un workflow chargé coûte autant qu\'un workflow calme. Commencez gratuitement avec une boîte.',
      },
      {
        h: 'Webhooks signés',
        p: 'Chaque livraison est signée en HMAC-SHA256 sur un horodatage et le corps, porte un identifiant d\'événement pour la déduplication, et est retentée jusqu\'à six fois quand votre endpoint ne répond pas.',
      },
      {
        h: 'Envois idempotents',
        p: 'Passez une `idempotency_key` et réessayez après une connexion coupée sans envoyer deux fois. La nouvelle tentative vous rend l\'identifiant du message d\'origine.',
      },
      {
        h: 'Clés à portées limitées',
        p: 'Chaque clé ne détient que les permissions et les boîtes dont elle a besoin : un script de tri peut lire la boîte support et rien d\'autre. Révoquez une clé sans toucher aux autres.',
      },
      {
        h: 'Approbation des envois',
        p: 'Retenez chaque envoi d\'une boîte jusqu\'à ce qu\'une personne l\'approuve. Un bon réglage par défaut le temps qu\'une nouvelle automatisation fasse ses preuves.',
      },
      {
        h: 'Open source',
        p: 'Le serveur est open source, vous pouvez donc lire comment chaque appel est traité. Vous pouvez aussi [l\'héberger vous-même](/self-hosting).',
      },
    ],
  },
  how: {
    h: 'Comment ça marche',
    steps: [
      'Connectez une boîte mail dans le tableau de bord. Outlook se connecte avec Microsoft ; la plupart des autres fournisseurs prennent un mot de passe d\'application.',
      'Créez une clé API, cochez les portées dont elle a besoin et, si vous le souhaitez, limitez-la à certaines boîtes.',
      'Appelez `tools/list` pour voir ce que la clé peut faire, puis `tools/call` pour lire, rechercher, rédiger ou envoyer.',
      'Sur Pro ou Business, ajoutez un endpoint de webhook pour que le nouveau courrier atteigne votre workflow sans interrogation périodique.',
    ],
    codeLabel: 'bash',
  },
  uses: {
    h: 'Ce que les développeurs construisent',
    items: [
      '**n8n et autres outils de workflow :** lancez un workflow sur le nouveau courrier, lisez-le, puis classez, rédigez ou répondez.',
      '**Agents de code :** donnez à Claude Code une vraie boîte en HTTP avec une commande et une clé.',
      '**Agents support et ventes :** triez une boîte partagée, rédigez des réponses qu\'une personne approuve, relancez selon un calendrier.',
      '**Votre propre agent :** appelez les mêmes outils depuis n\'importe quel langage capable d\'envoyer une requête HTTPS.',
    ],
  },
  cta: {
    title: 'Connectez une boîte et faites votre premier appel',
    sub: 'Une boîte est gratuite, pour toujours. Aucune carte requise.',
    button: 'Commencer gratuitement',
    guide: 'Guide développeur',
    pricing: 'Voir les tarifs',
  },
  featureList: [
    'API e-mail en HTTPS (JSON-RPC 2.0, Model Context Protocol)',
    'Fonctionne avec les boîtes Gmail, Outlook, Microsoft 365 et IMAP existantes',
    'Webhooks signés pour le nouveau courrier',
    'Clés d\'idempotence pour des nouvelles tentatives sûres',
    'Clés API à portées limitées avec accès par boîte',
    'Approbation humaine avant l\'envoi',
  ],
};

const de = {
  meta: {
    title: 'E-Mail-API für KI-Agenten, auf den Postfächern, die Sie schon haben',
    description:
      'Geben Sie Skripten, n8n-Workflows und eigenen KI-Agenten ein echtes Gmail-, Outlook- oder IMAP-Postfach über einen HTTPS-Endpunkt. MCP und signierte Webhooks mit demselben Schlüssel, eingeschränkte Schlüssel, idempotente Sendungen und ein fester Tarifpreis.',
  },
  breadcrumb: 'Entwickler',
  hero: {
    eyebrow: 'Entwickler',
    title: 'Eine E-Mail-API für KI-Agenten, auf den Postfächern, die Sie schon haben',
    lead:
      'Verbinden Sie Gmail, Outlook oder ein beliebiges IMAP-Postfach einmal. Ihre Skripte, Workflows und Agenten lesen, suchen, entwerfen und senden dann von diesen echten Adressen über einen HTTPS-Endpunkt, mit MCP und Webhooks auf demselben Schlüssel.',
    primary: 'Entwicklerleitfaden lesen',
    secondary: 'Preise ansehen',
  },
  why: {
    h: 'Was Sie bekommen',
    cards: [
      {
        h: 'Ihre echten Postfächer',
        p: 'Gmail, Outlook und Microsoft 365, iCloud, Yahoo, Zoho, Fastmail mit App-Passwort und jeder IMAP-Server. Agenten arbeiten auf den Adressen, die Ihre Kunden schon kennen, mit deren Verlauf und Absenderreputation. Nichts zu migrieren.',
      },
      {
        h: 'MCP und Webhooks auf einem Schlüssel',
        p: 'Der Endpunkt, mit dem sich Claude und ChatGPT verbinden, antwortet auch auf gewöhnliches HTTPS aus Ihrem Code. In Pro und Business startet ein Webhook Ihren Workflow, wenn E-Mails eintreffen, meist innerhalb von etwa zwei Minuten.',
      },
      {
        h: 'Ein fester Preis',
        p: 'Bezahlte Tarife haben einen festen Monatspreis und keine Kosten pro Aufruf, sodass ein ausgelasteter Workflow dasselbe kostet wie ein ruhiger. Starten Sie kostenlos mit einem Postfach.',
      },
      {
        h: 'Signierte Webhooks',
        p: 'Jede Zustellung ist mit HMAC-SHA256 über einen Zeitstempel und den Body signiert, trägt eine Ereignis-ID zur Deduplizierung und wird bis zu sechsmal wiederholt, wenn Ihr Endpunkt nicht antwortet.',
      },
      {
        h: 'Idempotente Sendungen',
        p: 'Übergeben Sie einen `idempotency_key` und wiederholen Sie nach einer abgebrochenen Verbindung, ohne doppelt zu senden. Die Wiederholung liefert die ursprüngliche Nachrichten-ID zurück.',
      },
      {
        h: 'Eingeschränkte Schlüssel',
        p: 'Jeder Schlüssel hat nur die Berechtigungen und Postfächer, die er braucht, sodass ein Triage-Skript das Support-Postfach lesen kann und sonst nichts. Widerrufen Sie einen Schlüssel, ohne die anderen anzutasten.',
      },
      {
        h: 'Sendefreigabe',
        p: 'Halten Sie jede Sendung aus einem Postfach zurück, bis eine Person sie freigibt. Eine gute Voreinstellung, solange sich eine neue Automatisierung erst bewähren muss.',
      },
      {
        h: 'Open Source',
        p: 'Der Server ist Open Source, Sie können also nachlesen, wie jeder Aufruf verarbeitet wird. Sie können ihn auch [selbst betreiben](/self-hosting).',
      },
    ],
  },
  how: {
    h: 'So funktioniert es',
    steps: [
      'Verbinden Sie ein Postfach im Dashboard. Outlook meldet sich mit Microsoft an; die meisten anderen Anbieter nehmen ein App-Passwort.',
      'Erstellen Sie einen API-Schlüssel, kreuzen Sie die nötigen Scopes an und legen Sie ihn, wenn Sie möchten, auf einige Postfächer fest.',
      'Rufen Sie `tools/list` auf, um zu sehen, was der Schlüssel kann, dann `tools/call`, um zu lesen, zu suchen, zu entwerfen oder zu senden.',
      'In Pro oder Business fügen Sie einen Webhook-Endpunkt hinzu, damit neue E-Mails Ihren Workflow ohne Abfragen erreichen.',
    ],
    codeLabel: 'bash',
  },
  uses: {
    h: 'Was Entwickler bauen',
    items: [
      '**n8n und andere Workflow-Tools:** einen Workflow bei neuer E-Mail starten, sie lesen und ablegen, entwerfen oder antworten.',
      '**Coding-Agenten:** Claude Code mit einem Befehl und einem Schlüssel ein echtes Postfach über HTTP geben.',
      '**Support- und Vertriebsagenten:** ein gemeinsames Postfach triagieren, Antworten zur Freigabe durch eine Person entwerfen, nach Zeitplan nachfassen.',
      '**Ihr eigener Agent:** dieselben Tools aus jeder Sprache aufrufen, die eine HTTPS-Anfrage senden kann.',
    ],
  },
  cta: {
    title: 'Verbinden Sie ein Postfach und machen Sie Ihren ersten Aufruf',
    sub: 'Ein Postfach ist kostenlos, für immer. Keine Karte nötig.',
    button: 'Kostenlos loslegen',
    guide: 'Entwicklerleitfaden',
    pricing: 'Preise ansehen',
  },
  featureList: [
    'E-Mail-API über HTTPS (JSON-RPC 2.0, Model Context Protocol)',
    'Funktioniert mit bestehenden Gmail-, Outlook-, Microsoft-365- und IMAP-Postfächern',
    'Signierte Webhooks für neue E-Mails',
    'Idempotenzschlüssel für sichere Wiederholungen',
    'Eingeschränkte API-Schlüssel mit Zugriff pro Postfach',
    'Freigabe durch einen Menschen vor dem Senden',
  ],
};

const zh = {
  meta: {
    title: '面向 AI 代理的邮件 API，用你已有的收件箱',
    description:
      '通过一个 HTTPS 端点，让脚本、n8n 工作流和你自己的 AI 代理使用真实的 Gmail、Outlook 或 IMAP 邮箱。同一个密钥上的 MCP 和签名 webhook、限定权限的密钥、幂等发送，以及固定的套餐价格。',
  },
  breadcrumb: '开发者',
  hero: {
    eyebrow: '开发者',
    title: '面向 AI 代理的邮件 API，用你已有的收件箱',
    lead:
      '只需连接一次 Gmail、Outlook 或任意 IMAP 邮箱。你的脚本、工作流和代理就能通过一个 HTTPS 端点，从这些真实地址读取、搜索、起草和发送邮件，MCP 和 webhook 使用同一个密钥。',
    primary: '阅读开发者指南',
    secondary: '查看价格',
  },
  why: {
    h: '你将获得',
    cards: [
      {
        h: '你真实的邮箱',
        p: 'Gmail、Outlook 和 Microsoft 365、iCloud、Yahoo、Zoho、使用应用专用密码的 Fastmail，以及任何 IMAP 服务器。代理在客户早已熟悉的地址上工作，带着原有的历史记录和发件人信誉。无需迁移。',
      },
      {
        h: '一个密钥同时用于 MCP 和 webhook',
        p: 'Claude 和 ChatGPT 连接的那个端点，也响应来自你代码的普通 HTTPS 请求。在 Pro 和 Business 套餐上，邮件到达时 webhook 会启动你的工作流，通常在约两分钟内。',
      },
      {
        h: '固定价格',
        p: '付费套餐按月固定收费，不按调用计费，所以繁忙的工作流和清闲的工作流花费相同。从一个收件箱免费开始。',
      },
      {
        h: '签名 webhook',
        p: '每次投递都用 HMAC-SHA256 对时间戳和请求体签名，带有用于去重的事件 id，并在你的端点无响应时最多重试六次。',
      },
      {
        h: '幂等发送',
        p: '传入 `idempotency_key`，连接中断后重试也不会发送两次。重试会返回原始的邮件 id。',
      },
      {
        h: '限定权限的密钥',
        p: '每个密钥只拥有它需要的权限和收件箱，所以一个分拣脚本可以只读支持收件箱，别的都碰不到。撤销一个密钥不影响其他密钥。',
      },
      {
        h: '发送审批',
        p: '暂留某个收件箱的每一次发送，直到有人批准。新自动化在证明自己之前的好默认设置。',
      },
      {
        h: '开源',
        p: '服务器是开源的，你可以查看每个调用是如何处理的。你也可以[自行部署](/self-hosting)。',
      },
    ],
  },
  how: {
    h: '工作原理',
    steps: [
      '在控制台连接一个邮箱。Outlook 通过 Microsoft 登录；其他大多数服务商使用应用专用密码。',
      '创建一个 API 密钥，勾选它需要的权限范围，并可选择把它限定在某些收件箱。',
      '调用 `tools/list` 查看密钥能做什么，然后用 `tools/call` 读取、搜索、起草或发送。',
      '在 Pro 或 Business 套餐上添加一个 webhook 端点，新邮件就能不经轮询直接触发你的工作流。',
    ],
    codeLabel: 'bash',
  },
  uses: {
    h: '开发者用它构建什么',
    items: [
      '**n8n 和其他工作流工具：**由新邮件启动工作流，读取它，然后归档、起草或回复。',
      '**编码代理：**用一条命令和一个密钥，让 Claude Code 通过 HTTP 获得一个真实收件箱。',
      '**支持与销售代理：**分拣共享收件箱，起草回复交由人工审批，按计划跟进。',
      '**你自己的代理：**用任何能发出 HTTPS 请求的语言调用同样的工具。',
    ],
  },
  cta: {
    title: '连接一个收件箱，发起你的第一次调用',
    sub: '一个收件箱永久免费。无需信用卡。',
    button: '免费开始',
    guide: '开发者指南',
    pricing: '查看价格',
  },
  featureList: [
    '基于 HTTPS 的邮件 API（JSON-RPC 2.0，Model Context Protocol）',
    '适用于现有的 Gmail、Outlook、Microsoft 365 和 IMAP 邮箱',
    '新邮件的签名 webhook',
    '用于安全重试的幂等键',
    '限定权限、按收件箱授权的 API 密钥',
    '发送前的人工审批',
  ],
};

export const DEVELOPERS = { en, nb, es, fr, de, zh };

export function developersCopy(locale) {
  return DEVELOPERS[locale] ?? en;
}
