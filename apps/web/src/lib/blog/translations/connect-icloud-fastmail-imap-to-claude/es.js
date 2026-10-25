const translation = {
  title: 'Cómo conectar iCloud, Fastmail o cualquier buzón IMAP a Claude',
  description:
    'Conecta iCloud, Fastmail o cualquier buzón IMAP a Claude con una contraseña específica de aplicación. Configuración paso a paso, el endpoint MCP y lo que IMAP hace y Gmail no.',
  coverAlt: 'Conecta iCloud, Fastmail y cualquier buzón IMAP a Claude a través de MCP',
  content: `Conectar iCloud, Fastmail o cualquier buzón IMAP a Claude requiere algo que Outlook no necesita: una **contraseña específica de aplicación**. La generas dentro de tu proveedor de correo, la pegas una sola vez en MCPEmails y Claude puede leer, buscar y enviar a través de esa bandeja. Sin flujos OAuth, sin tener que memorizar la configuración del servidor SMTP.

Esta es la vía para cualquier proveedor que no sea Gmail o Microsoft. iCloud, Fastmail, Yahoo, Zoho, Yandex y cualquier host IMAP genérico funcionan sobre el mismo transporte IMAP/SMTP, así que comparten un conjunto de funciones idéntico. Si puedes sacar una contraseña de aplicación del proveedor, puedes conectarlo. Gmail se conecta de la misma forma, con una contraseña de aplicación de Google por IMAP.

## Por qué estos proveedores usan una contraseña de aplicación y no OAuth

Outlook expone una API OAuth moderna, así que MCPEmails lo conecta con Iniciar sesión con Microsoft en lugar de una contraseña. (Una cuenta de trabajo o educativa de Microsoft 365 puede necesitar antes que un administrador de TI apruebe la aplicación una sola vez; la [guía de Outlook y Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp) lo explica.) Gmail funciona como los proveedores de esta guía: se conecta con una contraseña de aplicación de Google sobre IMAP, y Google solo te deja crearla con la verificación en dos pasos activada. iCloud y Fastmail no ofrecen esa vía a las herramientas de correo de terceros. En su lugar te entregan una **contraseña específica de aplicación**: una contraseña larga y generada al azar, acotada a una sola aplicación, separada de la contraseña real de tu cuenta y revocable de forma independiente.

Vale la pena hacer una corrección, porque artículos más antiguos lo cuentan mal: **Fastmail funciona solo con contraseña de aplicación.** Fastmail solía admitir un flujo OAuth para algunas integraciones, pero hoy, para conectarte a MCPEmails, generas una contraseña de aplicación en los ajustes de Fastmail. Igual que en iCloud. Si una guía te dice que "inicies sesión con Fastmail" mediante OAuth, está desactualizada.

La contraseña de aplicación se convierte en la única credencial que MCPEmails guarda para esa bandeja, [cifrada con AES-256-GCM en reposo](/blog/why-email-never-stored-matters) y descifrada en nuestros servidores solo cuando una petición la necesita. Nunca se envía a Claude. Tu correo real nunca se almacena: cada llamada a una herramienta lo obtiene en vivo del proveedor y lo descarta.

## Genera una contraseña específica de aplicación para iCloud

1. Ve a [appleid.apple.com](https://appleid.apple.com) e inicia sesión con tu Cuenta de Apple.
2. En la sección **Inicio de sesión y seguridad**, abre **Contraseñas específicas de app**.
3. Pulsa el **+** (Generate an app-specific password), ponle una etiqueta como \`MCPEmails\` y confirma con la contraseña de tu Cuenta de Apple.
4. Apple te muestra una contraseña con el formato \`abcd-efgh-ijkl-mnop\`. Cópiala ahora. No podrás volver a verla más tarde.

Necesitarás tener activada la autenticación de doble factor en tu Cuenta de Apple: las contraseñas específicas de aplicación no están disponibles sin ella. El host IMAP de iCloud es \`imap.mail.me.com\` y el SMTP es \`smtp.mail.me.com\`, pero MCPEmails los rellena por ti cuando eliges iCloud como proveedor, así que normalmente no tendrás que tocarlos. La [página de ajustes de iCloud Mail](/connect/icloud) recoge los mismos valores.

## Genera una contraseña de aplicación para Fastmail

1. Inicia sesión en Fastmail y abre **Settings → Privacy & Security → Connected apps & API tokens** (las cuentas más antiguas lo etiquetan como **App Passwords**).
2. Pulsa **New app password**.
3. Dale un nombre (\`MCPEmails\` sirve) y, para el acceso, elige **Mail (IMAP/SMTP)** para que pueda leer y enviar.
4. Fastmail genera la contraseña una sola vez. Cópiala antes de cerrar el cuadro de diálogo.

El host IMAP de Fastmail es \`imap.fastmail.com\` y el SMTP es \`smtp.fastmail.com\`. De nuevo, elegir Fastmail en MCPEmails los configura automáticamente. La [página de ajustes de Fastmail](/connect/fastmail) también los incluye.

## Conecta una bandeja IMAP genérica (todo lo demás)

Para Yahoo, Zoho, Yandex, un servidor de correo autoalojado o cualquier otra cosa con un endpoint IMAP, los pasos tienen la misma forma: consigue una contraseña de aplicación del proveedor (la mayoría de los que admiten 2FA exigen una) y luego dale a MCPEmails cuatro cosas:

- **Host y puerto IMAP** (habitualmente \`993\` para TLS)
- **Host y puerto SMTP** (habitualmente \`465\` o \`587\`)
- Tu **dirección de correo** como nombre de usuario
- La **contraseña de aplicación** como contraseña

Si de verdad solo tienes una contraseña normal y el proveedor no ofrece contraseñas de aplicación, eso también funcionará, pero la contraseña de aplicación es la opción correcta. Limita los daños posibles: si la revocas, solo se corta esta conexión, no toda tu cuenta. Para puertos, modos TLS y solución de problemas en cualquier otro host, consulta la [guía completa del conector IMAP](/blog/claude-imap-connector).

## Conecta la bandeja en MCPEmails

Una vez que tengas la contraseña copiada:

1. Abre el panel y ve a **Bandejas de entrada → Conectar bandeja**.
2. Elige tu proveedor: **iCloud**, **Fastmail** o **IMAP genérico**.
3. Pega tu dirección de correo y la contraseña específica de aplicación. Para IMAP genérico, confirma también el host y el puerto.
4. Guarda. La bandeja queda activa en menos de un minuto.

Eso es todo. Si quieres la versión más rápida posible con cualquier proveedor, el [tutorial de conexión en menos de dos minutos](/blog/connect-email-to-ai-agent-under-2-minutes) lo cubre de principio a fin.

## Apunta Claude a tu bandeja

Conectar la bandeja y conectar Claude son dos pasos separados. La bandeja vive en MCPEmails; ahora le das a Claude el endpoint de [MCP](https://modelcontextprotocol.io) para que pueda llamar a las herramientas.

En claude.ai:

1. Ve a **Customize → Connectors**.
2. Pulsa **Add connector** y pega el endpoint: \`https://www.mcpemails.com/api/mcp\`
3. Pulsa **Connect**, inicia sesión con tu cuenta de MCPEmails y aprueba los permisos que quieras: \`read:email\`, \`send:email\` o ambos.

Sin clave de API, sin archivo de configuración. claude.ai usa OAuth con PKCE por debajo, y el token que recibe Claude queda acotado exactamente a lo que aprobaste. Si estás en un cliente que no puede hacer OAuth (Cursor, Cline, un script de cURL), generas una clave acotada en su lugar, algo que explico en [acceso al correo para Cursor, Cline y VS Code](/blog/email-for-ai-agents-cursor-cline-vscode).

Una vez conectado, pídele a Claude que ejecute \`inbox_list\` primero. Devuelve tu bandeja y su \`inbox_id\`, así nunca tienes que copiar y pegar un UUID. A partir de ahí están las [herramientas básicas](/docs): \`email_read\` (listar, leer y buscar mensajes), \`email_compose\` (enviar, responder, reenviar) y \`email_organize\`, más algunas otras para carpetas, borradores, programación y contactos. Cada una se controla con un parámetro \`action\`.

Un prompt para confirmar que funciona:

\`\`\`
Usa inbox_list para encontrar mi bandeja de iCloud y luego resume mis 5 mensajes no leídos más recientes.
\`\`\`

## Cómo funciona el borrado en IMAP

Aquí está la parte que se le escapa a la gente. Un borrado normal mueve el mensaje a la papelera en todos los proveedores. Con \`permanent: true\`, MCPEmails marca el mensaje como borrado y lo elimina (expunge) en IMAP, y usa el borrado permanente de Microsoft Graph en Outlook. Gmail por IMAP sigue después sus propios ajustes de IMAP: por defecto, eliminar un mensaje de la bandeja de entrada o de una etiqueta solo le quita esa etiqueta y el mensaje sigue en Todos, mientras que eliminarlo desde la papelera lo borra para siempre.

En los demás hosts IMAP es más sencillo. Fastmail, iCloud, Yahoo, Zoho, Yandex e IMAP genérico admiten todos el **expunge definitivo** (hard expunge): Claude puede eliminar un mensaje de forma permanente, no solo enviarlo a la papelera. Si quieres un agente que de verdad haga limpieza, IMAP (u Outlook) se lo permite. Útil, y también una razón para pensar bien qué permisos concedes. El expunge es irreversible.

La búsqueda también se comporta de forma un poco distinta. Gmail dispone de toda su sintaxis de operadores, Outlook usa KQL y los proveedores IMAP usan la búsqueda de texto de IMAP: capaz, pero no tan expresiva como los operadores de Gmail. Conviene saberlo si escribes prompts con mucha búsqueda.

## Qué puedes construir una vez conectado

La mecánica es la misma con cualquier proveedor, así que cualquier flujo de trabajo que hayas visto para Gmail funciona en tu bandeja de Fastmail o iCloud. Algunos que de verdad compensan:

- Una clasificación matutina que marque lo que necesita a una persona y redacte borradores de respuesta para el resto. Consulta [clasificar y resumir la bandeja](/blog/ai-agent-triage-summarize-inbox).
- Un autorespondedor casi en tiempo real. Una advertencia honesta: MCPEmails funciona por sondeo, no por push; no hay webhooks, así que el agente comprueba si hay correo nuevo según una programación. La [creación de un autorespondedor](/blog/build-email-auto-responder-mcp-agent) explica cómo hacerlo bien.

Si todavía estás decidiendo si conectar el correo a un agente, empieza por el artículo pilar: [cómo dar a tu agente de IA acceso al correo](/blog/how-to-give-your-ai-agent-email-access).

## Conclusión

iCloud, Fastmail e IMAP no son ciudadanos de segunda aquí. Genera una contraseña de aplicación, pégala en **Bandejas de entrada → Conectar bandeja**, apunta Claude al [endpoint](/docs) y tendrás un agente con acceso completo de lectura y envío, más un borrado permanente de verdad. Es [gratis para empezar](/signup), sin tarjeta y con una bandeja para siempre.`,
};

export default translation;
