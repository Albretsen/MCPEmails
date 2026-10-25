const translation = {
  title: 'Cómo dar acceso al correo a tu agente de IA (la guía completa de 2026)',
  description:
    'Da a tu agente de IA acceso de lectura y envío a una bandeja real por MCP: Gmail, Outlook, iCloud, Fastmail o IMAP. Cómo funciona, las herramientas, la seguridad y la configuración.',
  coverAlt: 'Cómo dar a tu agente de IA acceso al correo por MCP — MCPEmails',
  content: `Para dar a un agente de IA acceso al correo, conectas tu bandeja a un servidor MCP y apuntas tu agente a una única URL de endpoint. El agente obtiene entonces un pequeño conjunto de herramientas para leer, buscar y enviar correo. Lo difícil no es el agente: es hacer esto sin filtrar tu contraseña a un prompt, a un registro o a un almacén vectorial. Esa última milla es de lo que trata esta guía.

Si solo quieres el camino rápido: conecta una bandeja en el panel, pega el endpoint de MCP en [claude.ai](https://claude.ai), Claude Desktop, Cursor o tu propio agente, y llama a \`inbox_list\` primero. El resto de este artículo explica qué ocurre en realidad, por qué importa el modelo de seguridad y cómo conectar cada proveedor compatible.

## Qué significa de verdad "correo por MCP"

El [Model Context Protocol](https://modelcontextprotocol.io) es una forma estándar de exponer herramientas a un modelo de lenguaje sobre HTTP. Un servidor de correo MCP presenta tu bandeja no como IMAP en crudo, sino como un puñado de verbos tipados que el agente puede invocar: listar mensajes, leer uno, buscar, enviar, responder. El agente razona sobre esos verbos. Nunca toca el protocolo de buzón subyacente, y nunca ve tus credenciales.

Esa es toda la idea detrás de [MCPEmails](/). Un endpoint, un conjunto de herramientas, cualquier cliente compatible con MCP. Si quieres la explicación de la arquitectura desde cero, el artículo complementario [qué es un servidor de correo MCP](/blog/what-is-an-mcp-email-server) lo cubre en lenguaje claro.

## Por qué la última milla es difícil

Conectar un modelo al correo parece trivial hasta que lo intentas de verdad. Hay tres escollos:

1. **La autenticación es distinta en cada proveedor.** Outlook y Microsoft 365 quieren OAuth con la identidad de Microsoft. Gmail quiere una contraseña de aplicación de Google, que Google solo te deja crear con la verificación en dos pasos activada. iCloud y Fastmail quieren una contraseña específica de aplicación. Cada uno tiene su propio ciclo de refresco de tokens y sus propios modos de fallo.
2. **Las credenciales son radiactivas.** Una contraseña de buzón en una transcripción de chat o en una línea de registro es una brecha a punto de ocurrir. No puedes dejar que el modelo guarde el secreto.
3. **El correo tiene una forma pésima para los agentes.** MIME, cabeceras de hilo, HTML frente a texto plano, adjuntos, carpetas que en realidad son etiquetas. El modelo necesita una respuesta limpia, no RFC 5322.

La solución ingenua de hacerlo tú mismo (darle al modelo una librería IMAP y tu contraseña) falla en los tres puntos a la vez. La mayoría de los repos de "servidor MCP de Gmail" en GitHub se quedan justo ahí.

## Cómo lo resuelve MCPEmails

Cuatro decisiones de diseño hacen el trabajo pesado. Son la razón por la que le confío mi propia bandeja.

### El correo se obtiene en vivo y nunca se almacena

Cada llamada a una herramienta accede a tu proveedor en tiempo real: IMAP/SMTP para Gmail, iCloud, Fastmail y los demás, o Microsoft Graph para Outlook. Los cuerpos de los mensajes, los asuntos y los adjuntos se entregan al agente y se descartan al instante. Nada se cachea, indexa ni almacena. Lo único que se persiste por bandeja es la credencial necesaria para hacer la siguiente llamada. Si quieres la versión larga de por qué esto importa, lee [por qué importa que "el correo nunca se almacena"](/blog/why-email-never-stored-matters).

### Las credenciales se cifran en reposo con AES-256-GCM

La contraseña de aplicación o el token de OAuth de cada bandeja se cifra antes de escribirse en la base de datos. Se descifra en nuestros servidores solo cuando una petición lo necesita, y nunca se envía a tu agente. La clave de cifrado se guarda como secreto del servidor, separada de la base de datos. Así, incluso una fuga de la base de datos entrega a un atacante texto cifrado, no tu bandeja.

### El envío pasa por tu propio proveedor

Cuando el agente envía o responde, el correo sale por tu Gmail, tu Microsoft 365 o tu servidor SMTP. MCPEmails nunca envía correo desde su propio dominio. Tu entregabilidad y la reputación de tu dominio siguen siendo enteramente tuyas: nada de ruleta de carpeta de spam por IP compartida.

### Es MCP estándar sobre HTTP

El servidor habla Streamable HTTP según la especificación MCP 2025-06-18. Ningún SDK que instalar, ningún cliente personalizado. Encaja en cualquier cosa que hable MCP.

## Las herramientas que recibe tu agente

Un puñado de herramientas consolidadas y basadas en acciones cubren toda la superficie: leer, redactar, organizar, más otras para carpetas, programación y contactos. El agente siempre empieza con \`inbox_list\` para descubrir qué hay conectado y obtener el ID de cada bandeja: nunca incrusta un UUID fijo en el código.

- \`inbox_list\` — descubre las cuentas conectadas y sus capacidades
- \`email_read\` (acción \`list\`) — paginado, lo más reciente primero, por bandeja
- \`email_read\` (acción \`read\`) — texto plano parseado, HTML saneado opcional, adjuntos opcionales
- \`email_read\` (acción \`search\`) — sintaxis nativa del proveedor (operadores de Gmail, KQL de Outlook, búsqueda de texto IMAP)
- \`email_compose\` (acción \`send\`) — redacta con CC/BCC, HTML y adjuntos de hasta 10 MB en total
- \`email_compose\` (acción \`reply\`) — lo mismo, y fija por ti las cabeceras de hilo (In-Reply-To, References)
- \`email_organize\` — mover, eliminar, marcar o archivar (una acción por llamada)

Una limitación honesta que conviene dejar clara de entrada: esto es **sondeo, no push**. No hay webhooks. Para reaccionar al correo nuevo, tu agente sondea según una programación, por ejemplo \`email_read\` (acción \`list\`) con \`unread: true\`. Cualquier autorrespondedor que construyas funciona con un temporizador, no con un disparador instantáneo. La [guía para construir un autorrespondedor](/blog/build-email-auto-responder-mcp-agent) muestra cómo hacerlo bien.

Una ronda de triaje matutino se ve así:

\`\`\`json
{
  "step1": "inbox_list                  → finds your work Gmail",
  "step2": "email_read (action list)    → last 24h, unread: true",
  "step3": "email_read (action read)    → full body for anything urgent",
  "step4": "email_compose (action reply) → draft, or just summarize and wait"
}
\`\`\`

Ninguna contraseña viajó por la red. El agente tenía capacidades, no credenciales. Para más ideas, mira [7 cosas que un agente de IA puede hacer con acceso a la bandeja](/blog/7-things-ai-agent-can-do-with-inbox-access) y el [recorrido más a fondo de triaje y resumen](/blog/ai-agent-triage-summarize-inbox).

## Proveedores compatibles y cómo se conecta cada uno

Conectas una bandeja una sola vez en **Panel → Bandejas de entrada → Conectar bandeja**. Cómo te autenticas depende del proveedor.

### Proveedores con OAuth (inicias sesión, sin contraseña)

- **Outlook / Microsoft 365**: OAuth 2.0 con Iniciar sesión con Microsoft, a través de Microsoft Graph y no de IMAP. Las cuentas personales de Outlook.com, Hotmail, Live y MSN se conectan directamente. Las cuentas de trabajo o educativas de Microsoft 365 pueden necesitar antes que un administrador de TI apruebe la aplicación una sola vez para toda la organización; el panel te da un enlace para enviárselo. Detalles de configuración en [conectar Outlook y Microsoft 365 a un agente de IA](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

### Proveedores con contraseña de aplicación

Gmail, iCloud, Fastmail, Yahoo, Zoho, Yandex y cualquier buzón IMAP genérico se conectan con una contraseña de aplicación en lugar de OAuth. Generas la contraseña en los ajustes de seguridad de tu proveedor y la pegas en MCPEmails. Las contraseñas de aplicación de Gmail se crean en tu cuenta de Google, y Google exige tener activada la verificación en dos pasos para crearlas. Las contraseñas de iCloud salen de appleid.apple.com; Fastmail es **solo contraseña de aplicación** (crea una en los ajustes de Fastmail). Todas viajan por el mismo transporte IMAP/SMTP y comparten un conjunto de funciones idéntico. El recorrido completo está en [conectar iCloud, Fastmail o cualquier bandeja IMAP a Claude](/blog/connect-icloud-fastmail-imap-to-claude).

## Conectar tu cliente de IA

Mismo endpoint, mismas herramientas, dos formas de entrar según si tu cliente habla OAuth.

### Clientes con OAuth (sin clave de API)

claude.ai, Claude Desktop, Cursor y clientes similares se conectan con OAuth 2.0 Authorization Code + PKCE y Dynamic Client Registration de RFC 7591. En claude.ai es **Customize → Connectors → Add connector**, pega la URL del endpoint de MCP, pulsa Connect, inicia sesión en tu cuenta de MCPEmails y aprueba. Los tokens se limitan exactamente a lo que apruebes: \`read:email\`, \`send:email\` o ambos. Para guías paso a paso, consulta [configurar Claude con tu bandeja de entrada](/blog/connect-claude-to-email) y [añadir tu correo a ChatGPT](/blog/connect-chatgpt-to-email).

### Clientes sin OAuth (clave de API)

Cline, JetBrains, scripts personalizados y cURL en crudo usan una clave de API con scopes. Crea una en **Panel → Claves de API**, elige sus scopes y cópiala (se muestra una sola vez). Pásala como \`Authorization: Bearer <api-key>\`. La configuración completa para estos está en [correo para agentes de IA en Cursor, Cline y VS Code](/blog/email-for-ai-agents-cursor-cline-vscode), y el compromiso entre los dos enfoques se cubre en [OAuth frente a claves de API para el acceso al correo con IA](/blog/oauth-vs-api-keys-ai-email-access).

Sea como sea, revocas cualquier conexión desde el panel con un solo clic. Copia la URL exacta del endpoint de [la documentación](/docs) en lugar de escribirla a mano.

## ¿Esto es seguro? Y los límites de tasa

Respuesta corta: sí, y el artículo [¿es seguro dar acceso al correo a un agente de IA?](/blog/is-it-safe-to-give-ai-agent-email-access) expone el caso completo. El modelo tiene capacidades acotadas, no tu contraseña; las credenciales están cifradas; nada se almacena; el envío se queda en tu proveedor; el acceso se revoca con un solo clic.

En cuanto a los límites de tasa, cada workspace tiene un tope por minuto que escala con tu plan (consulta [precios](/pricing)), y cada clave de API recibe ventanas por minuto, por hora y por día dimensionadas según ese plan, así que una sola clave puede usar todo el tope y varias claves lo comparten. Cuando alcanzas un límite, el servidor devuelve un error reintentable con un valor \`retry_after\` en segundos. Respétalo. Y nunca reintentes a ciegas un envío con \`email_compose\`: enviarás duplicados.

## Precios

Los planes se cobran por bandejas conectadas. Las claves de API son ilimitadas en todos los planes, y los planes también difieren en límite de ráfaga, retención de analíticas, funciones de equipo y soporte.

- **Gratis, $0 para siempre.** Sin tarjeta. Una bandeja conectada, 60 req/min, analíticas de 30 días, soporte de la comunidad.
- **Personal, $9/mes** (o $86,40/año, $7,20/mes). Hasta tres bandejas conectadas, 120 req/min, analíticas de 90 días, soporte por correo.
- **Pro, $15/mes** (o $144/año, $12/mes). Hasta 10 bandejas conectadas, 300 req/min, analíticas de 2 años, soporte por correo.
- **Business, $39/mes** (o $374,40/año, $31,20/mes). Todo lo de Pro, además de 10 buzones incluidos y $3/mes por cada uno extra, miembros ilimitados con roles, administradores que aprueban los envíos retenidos, un espacio de trabajo separado por cliente o negocio, 1.000 req/min.

Desglose completo en la [página de precios](/pricing).

## Empieza ya

Conecta una bandeja, pega el endpoint en tu agente y llama a \`inbox_list\`. Esa es toda la puesta en marcha. [Empieza gratis](/signup) u ojea el [inicio rápido](/docs#quickstart): tendrás un agente leyendo correo real en un par de minutos.`,
};

export default translation;
