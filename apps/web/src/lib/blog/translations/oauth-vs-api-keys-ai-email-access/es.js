export default {
  title: 'OAuth o claves de API para el acceso de la IA al email: ¿cuál usar?',
  description: 'OAuth o claves de API para el acceso de la IA al email: usa OAuth en claude.ai, Claude Desktop y Cursor; usa una clave de API con alcance en Cline, JetBrains y scripts.',
  coverAlt: 'OAuth frente a claves de API para conectar agentes de IA al email — MCPEmails',
  content: `Cuando conectas un agente de IA a tu email a través de MCP Emails, te autenticas de una de dos formas: con OAuth o con una clave de API. La respuesta corta es OAuth si tu cliente lo admite (claude.ai, Claude Desktop, Cursor), y una clave de API con alcance si no lo admite (Cline, JetBrains, scripts, cURL). Ambos llegan al mismo endpoint y exponen las mismas herramientas. La diferencia está en quién gestiona el secreto y con qué facilidad puedes cortar el acceso.

Esto no es un intercambio entre seguridad y comodidad en el que sacrificas una por la otra. Ambos caminos quedan limitados exactamente a \`read:email\`, \`send:email\`, o ambos, y los dos se pueden revocar desde el panel con un clic. La verdadera pregunta es cuál encaja con el cliente que realmente estás usando. Para tener la visión de conjunto de cómo se conecta todo esto, empieza por la guía principal, [cómo dar acceso al email a tu agente de IA](/blog/how-to-give-your-ai-agent-email-access).

## La recomendación en 30 segundos

Usa **OAuth** cuando tu cliente MCP lo admita. Hoy eso cubre claude.ai, Claude Desktop y Cursor. Pegas una URL, inicias sesión, apruebas los alcances y listo. Ningún secreto que copiar, ninguno que guardar, ninguno que filtrar.

Usa una **clave de API** cuando tu cliente no tenga flujo de OAuth. Cline, el asistente de IA de JetBrains, un cron de Python, un script de shell que canaliza JSON-RPC por cURL: todos necesitan un token de portador. Creas una en el panel, le pones alcance, la copias una vez y la pasas en la cabecera \`Authorization\`.

Si ambas opciones están disponibles para el mismo cliente, elige OAuth. Cuantos menos secretos en tus archivos de configuración, mejor; siempre es la opción por defecto más acertada.

## Cómo funciona OAuth aquí

OAuth es el camino sin clave. En lugar de generar tú una credencial y pegarla en algún sitio, el cliente y el servidor la negocian directamente, y el token vive dentro del cliente en vez de en un archivo de configuración que tú gestionas.

En claude.ai, el flujo es: **Customize → Connectors → Add connector → pega la URL → Connect → inicia sesión y aprueba.** La URL es el endpoint MCP, \`https://mcpemails.com/api/mcp\`. Una vez que apruebas, el agente tiene acceso y nunca tocaste un secreto.

Por debajo es OAuth estándar y actual:

- **Authorization Code + PKCE** (RFC 7636), de modo que nunca se transmite ningún secreto de cliente. PKCE es el mismo mecanismo que protege los inicios de sesión de las apps móviles y de página única.
- **Dynamic Client Registration** (RFC 7591), de modo que el cliente se registra por sí solo sin que tengas que configurar nada manualmente.
- **Los tokens se renuevan automáticamente** dentro de los clientes compatibles. No tienes que estar pendiente de ninguna caducidad.
- **Los alcances son exactamente los que apruebas** en la pantalla de consentimiento: \`read:email\`, \`send:email\`, o ambos.

La ventaja práctica: el token nunca aparece como una cadena de texto plano que podrías subir por accidente, registrar en un log o pegar en el chat equivocado. Cuando quieres cortar el acceso, revocas la conexión en el panel y el agente queda fuera de inmediato. Y sobre por qué esa revocación importa de verdad: la bandeja en sí queda intacta porque [el email nunca se almacena](/blog/why-email-never-stored-matters) en nuestro lado, para empezar.

## Cómo funcionan las claves de API aquí

Algunos clientes no hablan OAuth. No es un demérito. Cline, JetBrains y cualquier cosa que escribas tú mismo simplemente esperan un token de portador, que es la forma más antigua y perfectamente válida de autenticar una máquina.

Creas una en **Dashboard → API Keys**:

1. Ponle a la clave un nombre que reconozcas luego (\`cline-laptop\`, \`triage-cron\`).
2. Elige sus alcances: \`read:email\`, \`send:email\`, o ambos.
3. Cópiala. Se muestra **una sola vez** y nunca más. Si la pierdes, creas una nueva.

La clave tiene este aspecto, \`mcpe_live_AbCdEfGhIjKlMnOpQrStUvWxYz123456\`, y la pasas en cada petición:

\`\`\`
Authorization: Bearer mcpe_live_AbCdEfGhIjKlMnOpQrStUvWxYz123456
\`\`\`

Una llamada JSON-RPC en crudo para listar tus bandejas tiene este aspecto:

\`\`\`json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": { "name": "inbox_list", "arguments": {} }
}
\`\`\`

Haz un POST a \`https://mcpemails.com/api/mcp\` con la cabecera de portador y recibes de vuelta tus bandejas conectadas y sus identificadores. A partir de ahí el agente llama a \`email_read\` (con \`action\` en list, read o search) y \`email_compose\` (\`action\` send, reply o forward): las herramientas básicas, más \`email_organize\`, \`folder\`, \`schedule\` y \`contact_search\` para banderas, carpetas, programación y contactos.

Lo único que las claves de API te piden y OAuth no: trata la clave como una contraseña. Es un secreto de larga duración en texto plano. Ponla en una variable de entorno, no en código que vayas a subir a GitHub. Si una clave se filtra, revócala desde el panel y rota a una nueva.

## Alcances: concede el mínimo, siempre

Esta parte es idéntica para ambos métodos, y es el control de seguridad que más trabajo hace. Una conexión que solo puede \`read:email\` no puede enviar nada, haga lo que haga el agente. Si estás construyendo un [flujo de resumen y clasificación](/blog/ai-agent-triage-summarize-inbox), concede solo lectura. El agente lee, prioriza e informa, y no hay vía para que un modelo confundido o manipulado dispare un mensaje.

Añade \`send:email\` solo cuando enviar sea el verdadero objetivo, como en un [autorespondedor construido sobre las herramientas MCP](/blog/build-email-auto-responder-mcp-agent). Y aun así, asigna una clave o conexión distinta por tarea en lugar de una sola credencial todopoderosa que reutilizas en todas partes. El privilegio mínimo no es paranoia. Es el seguro más barato que vas a contratar.

## Entonces, ¿cuál usar?

### Usa OAuth si...

Tu cliente es claude.ai, Claude Desktop o Cursor. Quieres cero secretos en tu configuración. Quieres que la renovación de tokens se gestione por ti. Quieres la forma de revocar más limpia posible. Esta es la opción por defecto y deberías recurrir a ella primero.

### Usa una clave de API si...

Tu cliente no admite OAuth: Cline, JetBrains, los ejecutores de herramientas al estilo de OpenAI o tu propio código. Estás haciendo scripts contra el endpoint con cURL o un programa pequeño. Necesitas una credencial estable que un proceso sin interfaz pueda usar sin que una persona tenga que hacer clic en una pantalla de consentimiento. Una clave con alcance encaja perfecto aquí, y hay un recorrido completo para los [clientes Cursor, Cline y VS Code](/blog/email-for-ai-agents-cursor-cline-vscode).

Una cosa más que es cierta sin importar cuál elijas: los límites de uso. Cada clave de API está limitada a 100 requests/minute, 1,000/hour y 10,000/day, y cada workspace tiene un techo de ráfaga según el plan (60/min en [Free](/pricing), hasta 1,000/min en Scale). Cuando alcanzas un límite, el servidor te devuelve un valor \`retry_after\` en segundos. Respétalo, y nunca reintentes a ciegas un envío de \`email_compose\`: enviarías el mensaje dos veces.

## En resumen

OAuth y las claves de API no son un ranking de seguridad. Son una cuestión de encaje con tu cliente. OAuth es la mejor opción por defecto porque mantiene los secretos completamente fuera de tus manos, pero una clave de API con alcance y bien guardada es de verdad segura para los clientes y scripts que la necesitan. Elige los alcances con cuidado, guarda las claves en variables de entorno y revoca todo lo que no estés usando.

¿Listo para conectar una? Enlazar una bandeja y un cliente lleva unos [dos minutos de principio a fin](/blog/connect-email-to-ai-agent-under-2-minutes), o puedes leer la [documentación](/docs) completa y [empezar gratis](/signup).`,
};
