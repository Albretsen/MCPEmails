export default {
  slug: 'connect-email-to-ai-agent-under-2-minutes',
  title: {
    en: 'How to Connect Your Email to an AI Agent in Under 2 Minutes (Gmail, Outlook, iCloud, Fastmail & IMAP)',
    es: 'Cómo conectar un agente de IA a tu bandeja de entrada de correo real',
  },
  description: {
    en: 'Connect your email to an AI agent in under 2 minutes. Step-by-step setup for Gmail, Outlook, iCloud, Fastmail, and any IMAP inbox over MCP: no email ever stored.',
    es: 'Conecta un agente de IA a tu bandeja de entrada real en menos de 2 minutos: Gmail, Outlook, iCloud, Fastmail e IMAP, sin almacenar nunca tu correo.',
  },
  cover: '/blog/cover-connect-email-to-ai-agent-under-2-minutes.svg',
  coverAlt: {
    en: 'Connect your email to an AI agent in under 2 minutes — Gmail, Outlook, iCloud, Fastmail, and IMAP over MCP',
    es: 'Conecta tu correo a un agente de IA en menos de 2 minutos: Gmail, Outlook, iCloud, Fastmail e IMAP con MCP',
  },
  authorId: 'asgeir',
  publishedAt: "2026-05-08T09:00:00.000Z",
  updatedAt: "2026-05-08T09:00:00.000Z",
  tags: ['Tutorial', 'Gmail', 'Outlook', 'IMAP'],
  featured: false,
  content: {
    en: `You connect your email to an AI agent in two moves: connect the inbox in the MCP Emails dashboard, then point your agent at one endpoint URL. With an OAuth-capable client like claude.ai, that's it. No code, no SDK, and your email is never stored anywhere — every read and send hits your provider live and is discarded the moment the agent has it.

This is the fast guide. Pick your provider below, follow the four or five steps, and you'll have Claude (or Cursor, or a custom script) reading and sending real mail in about the time it takes to read this paragraph twice. For the deeper "what is this and is it safe" version, start with the [complete guide to giving your AI agent email access](/blog/how-to-give-your-ai-agent-email-access).

## The one step every provider shares: connect your client

Before you touch a provider, decide how your AI agent will talk to MCP Emails. There are two paths and they both use the same endpoint and the same tools.

**Path A — OAuth client (claude.ai, Claude Desktop, Cursor).** No API key. You paste a URL and approve a sign-in:

1. In claude.ai, go to **Customize → Connectors → Add connector**.
2. Paste the endpoint: \`https://www.mcpemails.com/api/mcp\`
3. Click **Connect**, sign in to your MCP Emails account, and approve the scopes you want (\`read:email\`, \`send:email\`, or both).

That's the whole client side. Tokens are scoped to exactly what you approved, and you can revoke the connection from the dashboard in one click. If you want the trade-offs spelled out, see [OAuth vs API keys for AI email access](/blog/oauth-vs-api-keys-ai-email-access).

**Path B — API-key client (Cline, JetBrains, cURL, custom agents).** For anything without built-in OAuth:

1. Go to **Dashboard → API Keys** and create a key.
2. Pick its scopes (\`read:email\`, \`send:email\`).
3. Copy it once (it's only shown once) and pass it as a header: \`Authorization: Bearer <your-api-key>\`, again against \`https://www.mcpemails.com/api/mcp\`.

If you live in an editor, the [email setup for Cursor, Cline, and VS Code](/blog/email-for-ai-agents-cursor-cline-vscode) covers that path end to end.

Now the inbox. Every provider below starts the same way: **Dashboard → Inboxes → Connect Inbox**, then pick your provider.

## Connect each provider

### Gmail (OAuth)

The fastest of the bunch, because Google does the work.

1. **Dashboard → Inboxes → Connect Inbox → Gmail.**
2. You're bounced to Google's sign-in. Choose the account.
3. Approve read and send access on the consent screen.
4. You land back in the dashboard with the inbox connected. Done.

No password ever changes hands. MCP Emails holds an encrypted OAuth token and calls the Gmail API directly. Searches use Gmail's native operators (\`from:\`, \`is:unread\`, \`after:\`), so your agent can be precise.

### Outlook / Microsoft 365 (OAuth)

Same shape as Gmail, different identity provider.

1. **Dashboard → Inboxes → Connect Inbox → Outlook / Microsoft 365.**
2. Sign in with your Microsoft account on Microsoft's page.
3. Approve the permissions.
4. The inbox shows up connected. Sending goes out through Microsoft Graph, so it's a normal message from your own account.

If your tenant has conditional access or admin consent rules, the [Outlook and Microsoft 365 setup guide](/blog/connect-outlook-microsoft-365-ai-agent-mcp) walks through the admin-side gotchas.

### iCloud (app-specific password)

iCloud doesn't hand third parties OAuth, so you generate an app-specific password. It takes one extra minute.

1. Go to [appleid.apple.com](https://appleid.apple.com), sign in, and open the **Sign-In and Security** section.
2. Under **App-Specific Passwords**, create a new one and label it "MCP Emails."
3. Copy the generated password (it looks like \`xxxx-xxxx-xxxx-xxxx\`).
4. In **Dashboard → Inboxes → Connect Inbox → iCloud**, enter your iCloud address and paste that app password.

iCloud runs over IMAP/SMTP under the hood, so you get the same tool set as everyone else.

### Fastmail (app-specific password — not OAuth)

A quick correction if you've read older docs: **Fastmail connects with an app password, not OAuth.** Don't go looking for a "Sign in with Fastmail" button — there isn't one here.

1. In Fastmail, open **Settings → Privacy & Security → Integrations** (or **App Passwords**).
2. Create a new app password. Give it mail (IMAP/SMTP) access and name it "MCP Emails."
3. Copy the password Fastmail generates.
4. In **Dashboard → Inboxes → Connect Inbox → Fastmail**, enter your Fastmail address and paste it.

That's it — Fastmail behaves exactly like the other IMAP providers from the agent's side.

### Generic IMAP (Yahoo, Zoho, Yandex, and the rest)

Anything that speaks IMAP/SMTP works through one connector. The pattern is identical to iCloud and Fastmail: make an app password at your provider, then paste it.

1. In your provider's security settings, create an **app password** (Yahoo, Zoho, and Yandex all bury this under account security). Use a real app password, not your login password — most providers block plain-password IMAP now anyway.
2. **Dashboard → Inboxes → Connect Inbox → IMAP.**
3. Enter your email address and the app password. MCP Emails autodetects common servers; if yours is unusual, drop in the IMAP and SMTP host/port your provider lists.
4. Save. The inbox connects and is ready.

For provider-specific quirks across iCloud, Fastmail, and the long tail of IMAP hosts, the [iCloud, Fastmail, and IMAP deep-dive](/blog/connect-icloud-fastmail-imap-to-claude) is the troubleshooting reference.

## First call: discover, then act

Whichever provider you picked, the agent's first move is always the same. Have it call \`inbox_list\` to discover what's connected and grab each inbox's \`inbox_id\` — the agent never copy-pastes a UUID. From there it works through a small set of consolidated tools — \`email_read\` (with an \`action\` of \`list\`, \`read\`, or \`search\`), \`email_compose\` (\`send\`, \`reply\`, or \`forward\`), and \`email_organize\` for moving, flagging, and archiving — plus \`folder\`, \`draft\`, \`schedule\`, and \`contact_search\`:

\`\`\`json
{
  "tools": [
    "inbox_list",
    "email_read",
    "email_compose",
    "email_organize"
  ]
}
\`\`\`

A good smoke test: ask your agent "summarize my three most recent unread emails." It'll run \`inbox_list\`, then \`email_read\` with \`action: "list"\` and \`unread_only: true\`, then \`email_read\` with \`action: "read"\` on each. If that works, your connection is live.

One honest caveat worth setting up front: MCP Emails is poll-based. There are no webhooks or push events, so an agent reacts to new mail by checking on a schedule rather than getting pinged. That's the right model for most workflows, and it's how the [inbox triage and summarize](/blog/ai-agent-triage-summarize-inbox) patterns work.

## Why this is safe to do quickly

Speed here doesn't come from cutting corners on security. Email is fetched live on every call and never stored — bodies, subjects, and attachments are handed to the agent and dropped immediately. The only thing persisted per inbox is your OAuth token or app password, encrypted with AES-256-GCM, and decrypted only inside an isolated function at call time. Sending always goes through your own provider, so your domain reputation stays yours. If you want the architecture in detail, read [why "email is never stored" actually matters](/blog/why-email-never-stored-matters).

## Wrap-up

That's the whole thing: one inbox connection, one endpoint, a handful of tools. The Free tier connects one inbox and needs no card; Personal is $5/month for up to three inboxes, and Pro connects every mailbox you own. See [pricing](/pricing). Ready to try it? [Start free](/signup), connect your inbox, and paste the endpoint into your agent.`,
    es: `Conectas tu correo a un agente de IA en dos pasos: conecta el buzón en el panel de MCP Emails y luego apunta tu agente a una única URL de endpoint. Con un cliente compatible con OAuth como claude.ai, eso es todo. Sin código, sin SDK, y tu correo no se almacena en ningún sitio: cada lectura y cada envío llega a tu proveedor en tiempo real y se descarta en cuanto el agente lo recibe.

Esta es la guía rápida. Elige tu proveedor más abajo, sigue los cuatro o cinco pasos y tendrás a Claude (o Cursor, o un script propio) leyendo y enviando correo real en aproximadamente el tiempo que tardas en leer este párrafo dos veces. Si prefieres la versión más a fondo de "qué es esto y si es seguro", empieza por la [guía completa para dar acceso al correo a tu agente de IA](/blog/how-to-give-your-ai-agent-email-access).

## El paso que comparten todos los proveedores: conecta tu cliente

Antes de tocar un proveedor, decide cómo hablará tu agente de IA con MCP Emails. Hay dos caminos y ambos usan el mismo endpoint y las mismas herramientas.

**Camino A — cliente con OAuth (claude.ai, Claude Desktop, Cursor).** Sin clave de API. Pegas una URL y apruebas un inicio de sesión:

1. En claude.ai, ve a **Personalizar → Conectores → Añadir conector**.
2. Pega el endpoint: \`https://www.mcpemails.com/api/mcp\`
3. Pulsa **Conectar**, inicia sesión en tu cuenta de MCP Emails y aprueba los permisos que quieras (\`read:email\`, \`send:email\`, o ambos).

Eso es todo en el lado del cliente. Los tokens se limitan exactamente a lo que aprobaste, y puedes revocar la conexión desde el panel con un clic. Si quieres ver los pros y contras al detalle, lee [OAuth frente a claves de API para el acceso al correo con IA](/blog/oauth-vs-api-keys-ai-email-access).

**Camino B — cliente con clave de API (Cline, JetBrains, cURL, agentes propios).** Para cualquier cosa sin OAuth integrado:

1. Ve a **Panel → API Keys** y crea una clave.
2. Elige sus permisos (\`read:email\`, \`send:email\`).
3. Cópiala una vez (solo se muestra una vez) y pásala como cabecera: \`Authorization: Bearer <tu-clave-api>\`, de nuevo contra \`https://www.mcpemails.com/api/mcp\`.

Si trabajas dentro de un editor, la [configuración de correo para Cursor, Cline y VS Code](/blog/email-for-ai-agents-cursor-cline-vscode) cubre ese camino de principio a fin.

Ahora el buzón. Todos los proveedores de abajo empiezan igual: **Panel → Inboxes → Connect Inbox** y eliges tu proveedor.

## Conecta cada proveedor

### Gmail (OAuth)

El más rápido de todos, porque el trabajo lo hace Google.

1. **Panel → Inboxes → Connect Inbox → Gmail.**
2. Te redirige al inicio de sesión de Google. Elige la cuenta.
3. Aprueba el acceso de lectura y envío en la pantalla de consentimiento.
4. Vuelves al panel con el buzón conectado. Listo.

Nunca se intercambia una contraseña. MCP Emails guarda un token de OAuth cifrado y llama directamente a la API de Gmail. Las búsquedas usan los operadores nativos de Gmail (\`from:\`, \`is:unread\`, \`after:\`), así que tu agente puede ser preciso.

### Outlook / Microsoft 365 (OAuth)

Misma forma que Gmail, distinto proveedor de identidad.

1. **Panel → Inboxes → Connect Inbox → Outlook / Microsoft 365.**
2. Inicia sesión con tu cuenta de Microsoft en la página de Microsoft.
3. Aprueba los permisos.
4. El buzón aparece conectado. El envío sale por Microsoft Graph, así que es un mensaje normal desde tu propia cuenta.

Si tu organización tiene acceso condicional o reglas de consentimiento de administrador, la [guía de configuración de Outlook y Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp) explica los detalles del lado del administrador.

### iCloud (contraseña específica de la app)

iCloud no ofrece OAuth a terceros, así que generas una contraseña específica de la app. Lleva un minuto más.

1. Ve a [appleid.apple.com](https://appleid.apple.com), inicia sesión y abre la sección **Inicio de sesión y seguridad**.
2. En **Contraseñas específicas de app**, crea una nueva y ponle la etiqueta "MCP Emails".
3. Copia la contraseña generada (tiene la forma \`xxxx-xxxx-xxxx-xxxx\`).
4. En **Panel → Inboxes → Connect Inbox → iCloud**, escribe tu dirección de iCloud y pega esa contraseña de app.

iCloud funciona sobre IMAP/SMTP por debajo, así que dispones del mismo conjunto de herramientas que el resto.

### Fastmail (contraseña específica de la app, no OAuth)

Una corrección rápida si has leído documentación antigua: **Fastmail se conecta con una contraseña de app, no con OAuth.** No busques un botón de "Iniciar sesión con Fastmail": aquí no existe.

1. En Fastmail, abre **Settings → Privacy & Security → Integrations** (o **App Passwords**).
2. Crea una contraseña de app nueva. Dale acceso a correo (IMAP/SMTP) y ponle el nombre "MCP Emails".
3. Copia la contraseña que genera Fastmail.
4. En **Panel → Inboxes → Connect Inbox → Fastmail**, escribe tu dirección de Fastmail y pégala.

Eso es todo: desde el lado del agente, Fastmail se comporta exactamente igual que los demás proveedores IMAP.

### IMAP genérico (Yahoo, Zoho, Yandex y los demás)

Cualquier servicio que hable IMAP/SMTP funciona con un solo conector. El patrón es idéntico al de iCloud y Fastmail: crea una contraseña de app en tu proveedor y luego pégala.

1. En los ajustes de seguridad de tu proveedor, crea una **contraseña de app** (Yahoo, Zoho y Yandex la esconden en la seguridad de la cuenta). Usa una contraseña de app real, no la de tu inicio de sesión: la mayoría de proveedores ya bloquean el IMAP con contraseña normal.
2. **Panel → Inboxes → Connect Inbox → IMAP.**
3. Escribe tu dirección de correo y la contraseña de app. MCP Emails detecta los servidores habituales; si el tuyo es poco común, indica el host y el puerto de IMAP y SMTP que muestre tu proveedor.
4. Guarda. El buzón se conecta y queda listo.

Para las particularidades de iCloud, Fastmail y la larga lista de servidores IMAP, el [análisis a fondo de iCloud, Fastmail e IMAP](/blog/connect-icloud-fastmail-imap-to-claude) es la referencia para resolver problemas.

## Primera llamada: descubre y luego actúa

Sea cual sea el proveedor que elijas, el primer movimiento del agente siempre es el mismo. Haz que llame a \`inbox_list\` para descubrir qué hay conectado y obtener el \`inbox_id\` de cada buzón: el agente nunca copia y pega un UUID. A partir de ahí trabaja con un pequeño conjunto de herramientas consolidadas: \`email_read\` (con un \`action\` de \`list\`, \`read\` o \`search\`), \`email_compose\` (\`send\`, \`reply\` o \`forward\`) y \`email_organize\` para mover, marcar y archivar, además de \`folder\`, \`draft\`, \`schedule\` y \`contact_search\`:

\`\`\`json
{
  "tools": [
    "inbox_list",
    "email_read",
    "email_compose",
    "email_organize"
  ]
}
\`\`\`

Una buena prueba rápida: pídele al agente "resume mis tres correos sin leer más recientes". Ejecutará \`inbox_list\`, luego \`email_read\` con \`action: "list"\` y \`unread_only: true\` y después \`email_read\` con \`action: "read"\` en cada uno. Si eso funciona, tu conexión está activa.

Una advertencia honesta que conviene dejar clara desde el principio: MCP Emails funciona por sondeo. No hay webhooks ni eventos push, así que un agente reacciona al correo nuevo comprobándolo según una programación, no recibiendo un aviso. Es el modelo adecuado para la mayoría de flujos, y así funcionan los patrones de [clasificación y resumen del buzón](/blog/ai-agent-triage-summarize-inbox).

## Por qué es seguro hacerlo rápido

La rapidez aquí no viene de recortar en seguridad. El correo se obtiene en tiempo real en cada llamada y nunca se almacena: los cuerpos, asuntos y adjuntos se entregan al agente y se descartan de inmediato. Lo único que se conserva por buzón es tu token de OAuth o contraseña de app, cifrado con AES-256-GCM y descifrado solo dentro de una función aislada en el momento de la llamada. El envío siempre pasa por tu propio proveedor, así que la reputación de tu dominio sigue siendo tuya. Si quieres la arquitectura al detalle, lee [por qué importa de verdad que "el correo nunca se almacene"](/blog/why-email-never-stored-matters).

## Para terminar

Eso es todo: una conexión de buzón, un endpoint, un puñado de herramientas. El plan Gratis conecta un buzón, no cuesta nada ni pide tarjeta; Personal cuesta 5 USD al mes y conecta hasta tres buzones; Pro conecta todos los que tengas; consulta los [precios](/pricing). ¿Listo para probarlo? [Empieza gratis](/signup), conecta tu buzón y pega el endpoint en tu agente.`,
  },
};
