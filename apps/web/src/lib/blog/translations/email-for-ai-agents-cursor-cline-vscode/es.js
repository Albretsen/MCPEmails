export default {
  title: 'Configurar el correo para agentes de IA en Cursor, Cline y VS Code',
  description: 'Da acceso al correo a tu agente de programación en Cursor, Cline y VS Code. Cursor usa OAuth; Cline y los clientes propios usan una API key con permisos por MCP.',
  coverAlt: 'Configurar el acceso al correo para agentes de programación con IA en Cursor, Cline y VS Code mediante MCP',
  content: `Aquí va la versión corta. Para darle a un agente de programación de tu editor acceso a una bandeja de entrada real, apúntalo a un único endpoint MCP: \`https://www.mcpemails.com/api/mcp\`. Cursor habla OAuth, así que pegas esa URL e inicias sesión. Cline, la configuración MCP en bruto de VS Code y cualquier script propio no hacen el baile de OAuth, así que se autentican con una API key con permisos enviada en una cabecera \`Authorization: Bearer\`. El mismo endpoint, las mismas herramientas, dos formas de entrar.

Esta guía cubre ambas vías, muestra cómo generar una API key limitada exactamente a \`read:email\` y \`send:email\`, y termina con un flujo de trabajo que uso de verdad: el agente clasifica mi bandeja de entrada y envía respuestas sin que yo salga del editor. Si prefieres ver primero el panorama general, la guía base sobre [cómo dar a tu agente de IA acceso al correo](/blog/how-to-give-your-ai-agent-email-access) es el punto de partida.

## Antes de conectar cualquier cliente: conecta una bandeja de entrada

El servidor MCP no es dueño de tu correo. Hace de intermediario con una conexión en vivo al proveedor que ya uses, recupera los mensajes en el momento de la llamada y los descarta. No se almacena nada de tu correo. Así que el primer paso ocurre en el panel, no en tu editor.

Ve a **Dashboard → Inboxes → Connect Inbox** y elige un proveedor:

- **Gmail** u **Outlook / Microsoft 365** → OAuth con un clic. Inicia sesión con Google o Microsoft y aprueba.
- **iCloud, Fastmail, Yahoo, Zoho o cualquier host IMAP genérico** → una contraseña específica de aplicación. Genérala en los ajustes del proveedor (en iCloud es appleid.apple.com) y pégala.

Fastmail funciona solo con contraseña de aplicación, no con OAuth, así que no busques ahí una pantalla de consentimiento al estilo de Google. Si usas iCloud o Fastmail, el [tutorial de configuración de iCloud, Fastmail e IMAP](/blog/connect-icloud-fastmail-imap-to-claude) tiene los detalles de cada proveedor. Para Outlook, consulta [cómo conectar Outlook y Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

Una vez conectada una bandeja de entrada, tu agente llega a ella a través de las herramientas. Nunca pegas un UUID ni una contraseña en la configuración de tu editor.

## Cursor: pega la URL, inicia sesión y listo

Cursor admite OAuth 2.0 para servidores MCP, que es la vía indolora. No hay API key ni secreto que gestionar en un archivo de configuración.

1. Abre los ajustes de Cursor y busca la sección de servidores MCP.
2. Añade un nuevo servidor con la URL \`https://www.mcpemails.com/api/mcp\`.
3. Cursor abre una ventana del navegador. Inicia sesión en tu cuenta de MCP Emails y aprueba los permisos que quieras darle al agente: \`read:email\`, \`send:email\` o ambos.
4. La conexión se pone en verde y las herramientas de correo aparecen en la lista de herramientas de Cursor.

Por debajo, eso es OAuth 2.0 con código de autorización y PKCE, y el token que guarda Cursor está limitado exactamente a lo que aprobaste. Si solo concediste \`read:email\`, el agente literalmente no puede enviar. Cuando termines, revoca la conexión desde **Dashboard → API Keys** (las concesiones de OAuth también viven ahí) con un clic, y el acceso de Cursor muere al instante.

Claude Desktop y claude.ai siguen el mismo flujo de pegar y aprobar si también los usas.

## Cline, VS Code en bruto y scripts propios: usa una API key

Cline, la configuración \`mcp\` simple de VS Code, JetBrains y cualquier cosa que programes tú no implementan el apretón de manos de OAuth. Para esos casos creas una API key y la envías como token bearer. También es la opción adecuada para trabajos de CI y automatizaciones lanzadas por cron, donde no hay una persona para hacer clic en una pantalla de aprobación.

### Paso 1: crea una API key con permisos

En **Dashboard → API Keys**, haz clic en **Create key**. Ponle un nombre que reconozcas después (\`cline-laptop\`, \`triage-cron\`) y luego elige sus permisos:

- \`read:email\` para listar, buscar y leer.
- \`send:email\` para enviar y responder.

Concede solo lo que el cliente necesite. Un asistente de clasificación de solo lectura no tiene por qué tener \`send:email\`. La clave se muestra una sola vez: cópiala en el momento en que aparezca, porque no podrás volver a verla. Si la pierdes, la rotas; no la recuperas.

### Paso 2: pon la clave en la configuración de tu cliente

Para Cline (y la mayoría de configuraciones MCP de VS Code), añade el servidor al JSON de configuración MCP con la cabecera bearer:

\`\`\`json
{
  "mcpServers": {
    "mcpemails": {
      "url": "https://www.mcpemails.com/api/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
\`\`\`

Una llamada cURL en bruto para confirmar que la clave funciona antes de tocar ningún editor:

\`\`\`bash
curl -s https://www.mcpemails.com/api/mcp \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
\`\`\`

Si te devuelve una lista de herramientas, estás conectado. Un error \`-32001\` significa que la clave es incorrecta o le falta un permiso; ese no se puede reintentar, así que arregla la clave en vez de meterte en un bucle. No subas la clave al repositorio. Léela desde una variable de entorno y mantenla fuera de git. Si estás sopesando qué modelo de autenticación usar en cada sitio, [OAuth frente a API keys para el acceso al correo con IA](/blog/oauth-vs-api-keys-ai-email-access) expone las ventajas y desventajas.

## Las herramientas que recibe tu agente

Ambas vías exponen la misma superficie. Un puñado de herramientas consolidadas, basadas en acciones, cubren el trabajo:

- \`inbox_list\` — llama siempre a esta primero para descubrir las bandejas de entrada conectadas y sus IDs.
- \`email_read\` (acción \`list\`) — paginada, primero las más recientes.
- \`email_read\` (acción \`read\`) — texto plano analizado, HTML saneado opcional, adjuntos.
- \`email_read\` (acción \`search\`) — búsqueda nativa del proveedor (operadores de Gmail, KQL de Outlook, texto IMAP).
- \`email_compose\` (acción \`send\`) — redacta con CC/BCC, HTML y adjuntos de hasta 10 MB.
- \`email_compose\` (acción \`reply\`) — ajusta por ti las cabeceras In-Reply-To y References para que el hilo se mantenga intacto.

Hay algunas más para etiquetas y movimientos (\`email_organize\`), carpetas, envío programado y contactos, pero esas pocas hacen el grueso del trabajo real.

## Un flujo de trabajo de desarrollo que merece la pena

Aquí es donde sale rentable. Mantengo una clave de lectura y envío conectada a mi editor y me apoyo en el agente durante las partes del día que de otro modo perdería con la bandeja de entrada.

Clasificación matutina, escrita directamente en el panel de chat:

> Llama a inbox_list y luego lista los no leídos de mi bandeja de entrada de trabajo de las últimas 12 horas. Agrúpalos: necesita respuesta, para tu información y ruido. En el grupo de para tu información dame una línea por cada uno.

El agente ejecuta \`inbox_list\`, luego \`email_read\` con la acción \`list\` y \`unread_only\` activado, lee los que importan y devuelve un resumen ordenado. Cuando veo uno que quiero responder, le digo:

> Responde al mensaje del contratista de diseño confirmando que el jueves a las 14:00 va bien, que sea breve.

Llama a \`email_compose\` con la acción \`reply\`, el hilado se gestiona solo y la respuesta sale a través de mi propio Gmail, así que llega desde mi dirección y con la reputación de mi dominio, no la de algún relay. Para un tratamiento más a fondo de los prompts de clasificación, mira [cómo hacer que un agente de IA clasifique y resuma tu bandeja de entrada](/blog/ai-agent-triage-summarize-inbox).

Una limitación honesta: no hay webhooks. El servidor no te envía el correo nuevo. Si quieres que el agente reaccione a los mensajes entrantes, haces polling: \`email_read\` con la acción \`list\` y \`unread_only: true\` de forma periódica. Es una decisión de diseño deliberada, y condiciona cómo construyes cualquier cosa reactiva, como un [autocontestador sobre MCP](/blog/build-email-auto-responder-mcp-agent).

## Límites de tasa para el acceso por scripts

Si manejas el servidor desde un trabajo de cron o un bucle de agente apretado, ten en cuenta los límites. Cada API key está limitada a **100 peticiones por minuto, 1.000 por hora y 10.000 por día**, en todos los planes. Por encima de eso hay un techo de ráfaga por espacio de trabajo que fija tu plan: 60/min en Free, 300/min en Agent ($12/month) y 1.000/min en Scale ($49/month). Consulta la [página de precios](/pricing) para el desglose completo.

Cuando alcanzas un límite, el servidor devuelve un error que se puede reintentar (código \`-32029\`) con \`data.retry_after\` en segundos. Respétalo: espera ese tiempo y vuelve a intentarlo. Y nunca reintentes a ciegas un envío de \`email_compose\` ante un fallo genérico; dispararás duplicados. Comprueba primero si de verdad se envió.

## Para terminar

Cursor te conecta con una URL y un inicio de sesión. Todo lo demás necesita una clave con permisos y una cabecera bearer. Ambos llegan al mismo endpoint y a las mismas herramientas, y ambos mantienen tus credenciales fuera de tu repositorio y fuera del contexto del modelo.

[Empieza gratis](/signup) y conecta tu primera bandeja de entrada, o lee la [documentación](/docs) para la referencia completa de herramientas.`,
};
