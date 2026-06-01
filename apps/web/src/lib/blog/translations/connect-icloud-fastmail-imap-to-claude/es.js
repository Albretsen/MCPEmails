export default {
  title: 'Cómo conectar iCloud, Fastmail o cualquier buzón IMAP a Claude',
  description:
    'Conecta iCloud, Fastmail o cualquier buzón IMAP a Claude con una contraseña específica de aplicación. Configuración paso a paso, el endpoint MCP y lo que IMAP hace y Gmail no.',
  coverAlt: 'Conecta iCloud, Fastmail y cualquier buzón IMAP a Claude a través de MCP',
  content: `Conectar iCloud, Fastmail o cualquier buzón IMAP a Claude requiere algo que Gmail y Outlook no necesitan: una **contraseña específica de aplicación**. La generas dentro de tu proveedor de correo, la pegas una sola vez en MCP Emails y Claude puede leer, buscar y enviar a través de ese buzón. Sin el baile del OAuth, sin tener que memorizar la configuración del servidor SMTP.

Esta es la vía para cualquier proveedor que no sea Gmail o Microsoft. iCloud, Fastmail, Yahoo, Zoho, Yandex y cualquier host IMAP genérico funcionan sobre el mismo transporte IMAP/SMTP, así que comparten un conjunto de funciones idéntico. Si puedes sacar una contraseña de aplicación del proveedor, puedes conectarlo. Un extra interesante frente a los proveedores con OAuth: IMAP le da a Claude un borrado real y permanente.

## Por qué estos proveedores usan una contraseña de aplicación y no OAuth

Gmail y Outlook exponen APIs OAuth modernas, así que MCP Emails los conecta con un inicio de sesión de un solo clic. iCloud y Fastmail no ofrecen esa vía a las herramientas de correo de terceros. En su lugar te entregan una **contraseña específica de aplicación**: una contraseña larga y generada al azar, acotada a una sola aplicación, separada de la contraseña real de tu cuenta y revocable por su cuenta.

Vale la pena hacer una corrección, porque artículos más antiguos lo cuentan mal: **Fastmail funciona solo con contraseña de aplicación.** Fastmail solía admitir un flujo OAuth para algunas integraciones, pero hoy, para conectarte a MCP Emails, generas una contraseña de aplicación en los ajustes de Fastmail. Igual que en iCloud. Si una guía te dice que "inicies sesión con Fastmail" mediante OAuth, está desactualizada.

La contraseña de aplicación se convierte en la única credencial que MCP Emails guarda para ese buzón, [cifrada con AES-256-GCM en reposo](/blog/why-email-never-stored-matters) y descifrada solo dentro de una Edge Function aislada en el momento de la llamada. Tu correo real nunca se almacena: cada llamada a una herramienta lo obtiene en vivo del proveedor y lo descarta.

## Genera una contraseña específica de aplicación para iCloud

1. Ve a [appleid.apple.com](https://appleid.apple.com) e inicia sesión con tu Apple Account.
2. En la sección **Sign-In and Security**, abre **App-Specific Passwords**.
3. Pulsa el **+** (Generate an app-specific password), ponle una etiqueta como \`MCP Emails\` y confirma con la contraseña de tu Apple Account.
4. Apple te muestra una contraseña con el formato \`abcd-efgh-ijkl-mnop\`. Cópiala ahora. No podrás volver a verla más tarde.

Necesitarás tener activada la autenticación de dos factores en tu Apple Account: las contraseñas específicas de aplicación no están disponibles sin ella. El host IMAP de iCloud es \`imap.mail.me.com\` y el SMTP es \`smtp.mail.me.com\`, pero MCP Emails los rellena por ti cuando eliges iCloud como proveedor, así que normalmente no tendrás que tocarlos.

## Genera una contraseña de aplicación para Fastmail

1. Inicia sesión en Fastmail y abre **Settings → Privacy & Security → Connected apps & API tokens** (las cuentas más antiguas lo etiquetan como **App Passwords**).
2. Pulsa **New app password**.
3. Dale un nombre (\`MCP Emails\` sirve) y, para el acceso, elige **Mail (IMAP/SMTP)** para que pueda leer y enviar.
4. Fastmail genera la contraseña una sola vez. Cópiala antes de cerrar el cuadro de diálogo.

El host IMAP de Fastmail es \`imap.fastmail.com\` y el SMTP es \`smtp.fastmail.com\`. De nuevo, elegir Fastmail en MCP Emails los configura automáticamente.

## Conecta un buzón IMAP genérico (todo lo demás)

Para Yahoo, Zoho, Yandex, un servidor de correo autoalojado o cualquier otra cosa con un endpoint IMAP, los pasos tienen la misma forma: consigue una contraseña de aplicación del proveedor (la mayoría de los que admiten 2FA exigen una) y luego dale a MCP Emails cuatro cosas:

- **Host y puerto IMAP** (habitualmente \`993\` para TLS)
- **Host y puerto SMTP** (habitualmente \`465\` o \`587\`)
- Tu **dirección de correo** como nombre de usuario
- La **contraseña de aplicación** como contraseña

Si de verdad solo tienes una contraseña normal y el proveedor no ofrece contraseñas de aplicación, eso también funcionará, pero la contraseña de aplicación es la opción correcta. Limita el radio de daño. Revócala y solo muere esta conexión, no toda tu cuenta.

## Conecta el buzón en MCP Emails

Una vez que tengas la contraseña copiada:

1. Abre el dashboard y ve a **Inboxes → Connect Inbox**.
2. Elige tu proveedor: **iCloud**, **Fastmail** o **Generic IMAP**.
3. Pega tu dirección de correo y la contraseña específica de aplicación. Para IMAP genérico, confirma también el host y el puerto.
4. Guarda. El buzón queda activo en menos de un minuto.

Eso es todo. Si quieres la versión más rápida posible con cualquier proveedor, el [tutorial de conexión en menos de dos minutos](/blog/connect-email-to-ai-agent-under-2-minutes) lo cubre de principio a fin.

## Apunta Claude a tu buzón

Conectar el buzón y conectar Claude son dos pasos separados. El buzón vive en MCP Emails; ahora le das a Claude el endpoint de [MCP](https://modelcontextprotocol.io) para que pueda llamar a las herramientas.

En claude.ai:

1. Ve a **Customize → Connectors**.
2. Pulsa **Add connector** y pega el endpoint: \`https://www.mcpemails.com/api/mcp\`
3. Pulsa **Connect**, inicia sesión con tu cuenta de MCP Emails y aprueba los scopes que quieras: \`read:email\`, \`send:email\` o ambos.

Sin clave de API, sin archivo de configuración. claude.ai usa OAuth con PKCE por debajo, y el token que recibe Claude queda acotado exactamente a lo que aprobaste. Si estás en un cliente que no puede hacer OAuth (Cursor, Cline, un script de cURL), generas una clave acotada en su lugar, algo que explico en [acceso al correo para Cursor, Cline y VS Code](/blog/email-for-ai-agents-cursor-cline-vscode).

Una vez conectado, pídele a Claude que ejecute \`list_inboxes\` primero. Devuelve tu buzón y su \`inbox_id\`, así nunca copias y pegas un UUID. A partir de ahí están las [seis herramientas básicas](/docs) — \`list_messages\`, \`read_email\`, \`search_emails\`, \`send_email\`, \`reply_to_email\` — más algunas otras para etiquetas, carpetas, programación y contactos.

Un prompt para confirmar que funciona:

\`\`\`
Use list_inboxes to find my iCloud inbox, then summarize my 5 most recent unread messages.
\`\`\`

## Lo único que IMAP hace y Gmail y Outlook no pueden

Aquí está la parte que se le escapa a la gente. Cuando Claude "borra" un mensaje en Gmail o Outlook, va a la papelera. Es una limitación dura de las APIs de Gmail y Microsoft Graph: no exponen un borrado permanente a las aplicaciones de terceros. El mensaje permanece en la papelera hasta que vence la ventana de retención del proveedor.

IMAP es distinto. Fastmail, iCloud, Yahoo, Zoho, Yandex e IMAP genérico admiten todos el **expunge definitivo** (hard expunge): Claude puede eliminar un mensaje de forma permanente, no solo enviarlo a la papelera. Si quieres un agente que de verdad recoja después de sí mismo, IMAP es el único transporte que se lo permite. Útil, y también una razón para ser deliberado sobre qué scopes concedes. El expunge es irreversible.

La búsqueda también se comporta de forma un poco distinta. Gmail dispone de toda su sintaxis de operadores, Outlook usa KQL y los proveedores IMAP usan la búsqueda de texto de IMAP: capaz, pero no tan expresiva como los operadores de Gmail. Conviene saberlo si escribes prompts con mucha búsqueda.

## Qué puedes construir una vez conectado

La mecánica es la misma con cualquier proveedor, así que cualquier flujo de trabajo que hayas visto para Gmail funciona en tu buzón de Fastmail o iCloud. Algunos que valen su peso:

- Una clasificación matutina que marque lo que necesita a una persona y redacte borradores de respuesta para el resto. Mira [clasificar y resumir el buzón](/blog/ai-agent-triage-summarize-inbox).
- Un autorespondedor casi en tiempo real. Una advertencia honesta: MCP Emails funciona por sondeo, no por push; no hay webhooks, así que el agente comprueba si hay correo nuevo según una programación. La [creación de un autorespondedor](/blog/build-email-auto-responder-mcp-agent) explica cómo hacerlo bien.

Si todavía estás decidiendo si conectar el correo a un agente, empieza por el artículo pilar: [cómo dar a tu agente de IA acceso al correo](/blog/how-to-give-your-ai-agent-email-access).

## Conclusión

iCloud, Fastmail e IMAP no son ciudadanos de segunda aquí. Genera una contraseña de aplicación, pégala en **Inboxes → Connect Inbox**, apunta Claude al [endpoint](/docs) y tendrás un agente con acceso completo de lectura y envío, más el borrado permanente que los proveedores con OAuth no pueden ofrecer. Es [gratis para empezar](/signup), sin tarjeta y con buzones ilimitados.`,
};
