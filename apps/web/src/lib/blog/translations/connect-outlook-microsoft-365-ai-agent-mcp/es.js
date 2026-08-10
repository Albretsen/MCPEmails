export default {
  title: 'Cómo conectar Outlook y Microsoft 365 a tu agente de IA con MCP',
  description:
    'Conecta Outlook o Microsoft 365 a tu agente de IA por MCP en minutos. OAuth de Microsoft, Graph por debajo, leer/buscar/enviar/responder — sin servidor propio.',
  coverAlt: 'Conexión de Outlook y Microsoft 365 a un agente de IA mediante MCP',
  content: `> **Próximamente.** La compatibilidad con Outlook y Microsoft 365 está desarrollada pero aún no disponible para todos. Hoy no puedes conectar un buzón de Outlook en producción — esta guía adelanta cómo funcionará cuando se lance el conector. Para los buzones que sí puedes conectar ahora mismo, consulta [Gmail e IMAP](/docs/providers).

Para conectar un buzón de Outlook o Microsoft 365 a tu agente de IA, inicias sesión en MCP Emails, añades la bandeja con OAuth de Microsoft y apuntas tu agente a un único endpoint MCP. Sin registro de aplicaciones, sin portal de Azure, sin servidor de Graph propio. Todo el proceso lleva unos dos minutos, y tu agente obtiene lectura, búsqueda, envío, respuesta, marcas y carpetas sobre el buzón en vivo.

La mayoría de las guías de "IA para el correo" dan por hecho Gmail y se quedan ahí. A Outlook le dedican un encogimiento de hombros y un enlace a algún repositorio de GitHub medio abandonado. Si trabajas dentro de Microsoft 365, ese es el enfoque equivocado. Este artículo es la versión centrada en Outlook: lo que de verdad funciona, cómo fluye el inicio de sesión de Microsoft, qué corre por debajo y dónde están los bordes entre cuentas personales y de trabajo.

## Por qué Outlook es más complicado de lo que parece (y por qué aquí eso no es problema tuyo)

El correo de Microsoft no es una sola cosa. Está el Outlook.com / Hotmail / Live de consumo, y están las cuentas de trabajo y centros educativos de Microsoft 365 que viven en Entra ID (el servicio de identidad que antes se llamaba Azure AD). Se autentican de forma distinta, y un tenant de trabajo puede tener encima políticas de acceso condicional, requisitos de consentimiento del administrador y reglas de MFA.

La vía artesanal implica registrar una aplicación en el portal de Azure / Entra, elegir los tipos de cuenta compatibles correctos, solicitar permisos de Microsoft Graph como \`Mail.Read\` y \`Mail.Send\`, configurar un redirect URI, gestionar la renovación de tokens y, después, escribir las llamadas a Graph para listar, leer y enviar correo. La gente quema una tarde entera en esto y acaba manteniendo un pequeño servidor para siempre. Lo he visto pasar.

MCP Emails hace ese registro y esa fontanería de tokens una sola vez, de forma centralizada, para que tú no tengas que hacerlo. Haces clic en "iniciar sesión con Microsoft", apruebas y ya estás conectado. Si quieres el trasfondo conceptual de por qué existe esta capa, la [guía completa para dar acceso al correo a tu agente de IA](/blog/how-to-give-your-ai-agent-email-access) es el pilar por el que empezar.

## Conecta tu bandeja de Outlook / Microsoft 365

Dos partes: conectar el buzón y luego conectar el agente. Están separadas a propósito: la conexión del buzón autoriza a MCP Emails a llegar a tu proveedor, y la conexión del agente autoriza a tu cliente a llegar a MCP Emails.

### Paso 1 — Añade la bandeja

1. [Empieza gratis](/signup) y abre el panel.
2. Ve a **Inboxes → Connect Inbox**.
3. Elige **Outlook / Microsoft 365**.
4. Te lleva a la propia página de inicio de sesión de Microsoft. Introduce tu cuenta de Microsoft de trabajo o personal, completa la MFA si tu tenant la exige y revisa la pantalla de consentimiento.
5. Aprueba. Microsoft devuelve un token OAuth, MCP Emails lo cifra (AES-256-GCM) y guarda solo ese token. No se conserva nada más de tu buzón.

Esto es OAuth 2.0, el mismo modelo que usa Gmail. Nunca pegas una contraseña de Outlook en MCP Emails, y no hay ninguna contraseña de aplicación que generar. Esa es la diferencia clave frente a los proveedores IMAP; si vas a conectar [iCloud, Fastmail o un buzón IMAP genérico](/blog/connect-icloud-fastmail-imap-to-claude), esos usan una contraseña específica de aplicación, porque no ofrecen OAuth para clientes de terceros.

### Paso 2 — Conecta tu agente

Conectas un cliente una vez, y la misma configuración funciona para todas las bandejas de tu cuenta. Para clientes compatibles con OAuth (claude.ai, Claude Desktop, Cursor), en claude.ai es así:

**Customize → Connectors → Add connector → pega la URL → Connect → inicia sesión y aprueba.**

El endpoint es:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

Cuando haces clic en Connect, inicias sesión en tu cuenta de MCP Emails y apruebas los permisos: \`read:email\`, \`send:email\` o ambos. No cambia de manos ninguna clave de API; por debajo usa OAuth 2.0 Authorization Code con PKCE y registro dinámico de clientes.

Para clientes que no hablan OAuth (Cline, plugins de JetBrains, tus propios scripts, cURL puro), genera una clave con permisos acotados en **Dashboard → API Keys**, elige los permisos y envíala como \`Authorization: Bearer <api-key>\`. El recorrido completo para esos clientes está en [correo para agentes de IA en Cursor, Cline y VS Code](/blog/email-for-ai-agents-cursor-cline-vscode). Si estás sopesando los dos enfoques, [OAuth frente a claves de API para el acceso de IA al correo](/blog/oauth-vs-api-keys-ai-email-access) expone las ventajas y desventajas.

## Microsoft Graph, por debajo

Una vez conectado, cada llamada de herramienta que hace tu agente sale hacia Microsoft Graph en tiempo real. Lee un mensaje y MCP Emails llama a Graph, entrega el resultado parseado a tu agente y lo descarta. Envía un mensaje y sale a través de Graph en tu nombre, desde tu dirección real, por la infraestructura de Microsoft, de modo que la capacidad de entrega y la reputación de tu dominio siguen siendo tuyas. MCP Emails nunca retransmite correo desde su propio dominio.

La consecuencia práctica: el correo que envía tu agente se ve exactamente como un correo que enviaste tú, porque lo es. Aterriza en tus Elementos enviados. Las respuestas se enhebran correctamente porque la herramienta de respuesta fija por ti las cabeceras In-Reply-To y References.

## Cuentas personales frente a cuentas de trabajo o educativas

Las dos funcionan. Una cuenta de consumo de Outlook.com y una cuenta de trabajo o educativa de Microsoft 365 se conectan a través del mismo flujo de inicio de sesión de Microsoft, y ambas exponen las mismas herramientas a tu agente.

El único punto donde se cuela la realidad es la pantalla de consentimiento en las cuentas de trabajo o educativas. Si tu administrador de TI ha restringido el consentimiento de aplicaciones de terceros en tu tenant —cosa que hacen muchas organizaciones grandes— puede que veas "se requiere aprobación" en lugar de un aviso de consentimiento normal, y la conexión queda a la espera de un administrador. Eso no es una limitación de MCP Emails; es la política de tu tenant, y bloquearía igual a cualquier cliente de terceros. Con una cuenta personal, o un tenant que permite el consentimiento del usuario, lo apruebas tú mismo y listo.

## Qué funciona una vez conectado

Tu agente obtiene las herramientas básicas consolidadas más los extras que admite Outlook:

- \`inbox_list\` — llámala siempre primero. Devuelve tus buzones conectados y sus UUID \`inbox_id\` para que el agente nunca adivine un ID.
- \`email_read\` — una sola herramienta con varias acciones: \`list\` (los más recientes primero, paginado, con filtros como \`unread_only\`), \`read\` (texto plano parseado, HTML saneado opcional, adjuntos opcionales) y \`search\` (consulta la nota sobre búsqueda más abajo).
- \`email_compose\` — la acción \`send\` redacta con CC/CCO, HTML y adjuntos de hasta 10 MB en total; las acciones \`reply\` y \`forward\` mantienen el hilo con las cabeceras correctas.
- \`email_organize\` — marcar como leído/no leído, marcar con bandera, archivar, eliminar y mover, cada una mediante su propia \`action\`.

Más allá de esas, Outlook admite marcar como leído/no leído, marcar con bandera (la "flag" de Outlook se corresponde con el concepto de destacado/marcado), reenviar y mover entre carpetas. Consulta la [documentación](/docs) en vivo para ver la lista de capacidades actual antes de construir sobre una herramienta concreta.

### La búsqueda usa el \`$search\` de Microsoft

La búsqueda de Outlook no es la búsqueda de Gmail. Donde Gmail acepta operadores como \`from:\` e \`is:unread\`, \`email_read\` con la acción \`search\` contra una bandeja de Outlook pasa tu consulta al \`$search\` de Microsoft Graph, que hace coincidencias de texto completo ordenadas por relevancia en todo el buzón y además acepta KQL. Así, una consulta como \`invoice from accounting last week\` funciona como lenguaje natural, y puedes afinar más con KQL como \`from:finance@acme.com AND subject:invoice\`. Si escribes prompts que fijan operadores de Gmail, no se comportarán igual en Outlook: dile a tu agente que busque en lenguaje llano y deja que Graph ordene.

## Un flujo que vale la pena montar

Este es un bucle de triaje que ejecuto contra una bandeja de Microsoft 365. Una o dos veces por hora, el agente:

1. Llama a \`email_read\` con la acción \`list\` y \`unread_only: true\`.
2. Lee con la acción \`read\` de \`email_read\` cualquier cosa que parezca urgente.
3. Resume el lote y redacta borradores de respuesta para los que yo respondería sin dudar.
4. Deja todo como no leído hasta que yo confirme.

Una advertencia honesta: MCP Emails funciona por sondeo. No hay webhooks ni notificaciones push del servidor, así que el agente comprueba según una programación en lugar de recibir un aviso en el instante en que llega el correo. Para el triaje eso está bien: tú fijas la cadencia. Si estás construyendo algo más reactivo, lee [cómo clasificar y resumir una bandeja de entrada](/blog/ai-agent-triage-summarize-inbox) para conocer los patrones de sondeo que aguantan.

## Comparado con construir tu propio servidor de M365

Los servidores MCP de Outlook autoalojados que circulan por GitHub chocan todos contra el mismo muro: el registro de la aplicación en Entra y el ciclo de vida del token de Graph son el verdadero trabajo, y son tuyos para siempre. Te encargas de los tokens de renovación, de los cambios de permisos cuando Microsoft ajusta Graph y de la seguridad de allí donde residan esos tokens. Con el enfoque alojado, el token está cifrado en reposo, se descifra solo dentro de una función aislada en el momento de la llamada y se puede revocar desde el panel con un clic. Si quieres la comparación completa, [alojado frente a autoalojado](/blog/hosted-vs-self-hosted-gmail-mcp-server) profundiza en las ventajas y desventajas.

Conectar Outlook no cuesta nada probarlo: el [plan Free](/pricing) ofrece bandejas ilimitadas, 2.500 acciones facturables por período de facturación y 60 solicitudes por minuto, sin tarjeta. Añade tu buzón de Microsoft 365, apunta Claude al endpoint y dale algo que leer.`,
};
