const translation = {
  title: '¿Qué es un servidor de correo MCP? Una explicación en lenguaje claro',
  description:
    'Un servidor de correo MCP es una herramienta que permite a un agente de IA leer y enviar correo mediante verbos limpios en vez de IMAP y contraseñas. Esto es lo que significa.',
  coverAlt: 'Qué es un servidor de correo MCP: una explicación en lenguaje claro de MCPEmails',
  content: `Un servidor de correo MCP es un pequeño servicio que da a un agente de IA como Claude o Cursor acceso en vivo para leer y enviar correo de una bandeja de entrada real, usando el Model Context Protocol. En lugar de entregar a tu agente una contraseña de correo y una biblioteca de IMAP, le entrega una lista corta de acciones: lista mis mensajes, lee este, busca aquello, envía una respuesta. El agente llama a esas acciones como a cualquier otra herramienta, y el servidor hace el trabajo engorroso del proveedor entre bastidores.

Si has oído por ahí el término "MCP" y quieres la versión sin jerga de lo que hace de verdad un servidor de correo *MCP*, aquí la tienes. Vamos a construirla pieza a pieza.

## Primero, ¿qué es MCP?

MCP son las siglas de [Model Context Protocol](https://modelcontextprotocol.io). Es un estándar abierto para conectar modelos de IA con el mundo exterior. Piénsalo como un puerto USB-C para agentes de IA: una forma acordada a la que cualquier herramienta puede enchufarse, de modo que el agente no necesita un cableado a medida para cada servicio que toca.

Antes de MCP, si querías que tu agente usara un calendario, una base de datos y tu correo, escribías tres integraciones distintas con tres formas distintas. MCP resuelve eso. Un servicio expone sus capacidades como **herramientas** (acciones con nombre que el modelo puede llamar) sobre un transporte estándar, y cualquier cliente compatible con MCP sabe cómo descubrirlas y llamarlas.

La parte que importa aquí: un servidor MCP no tiene por qué vivir en tu máquina. MCP Emails funciona sobre **Streamable HTTP** en una única URL de endpoint. Pegas esa URL en tu cliente y ya estás conectado. Sin SDK, sin instalar paquetes, sin un proceso local que cuidar.

## Entonces, ¿qué es un servidor de correo *MCP*?

Un servidor de correo MCP es un servidor MCP cuyas herramientas resultan ser sobre correo. Se sitúa entre tu agente de IA y un buzón real, y traduce las "intenciones del agente" en "operaciones del proveedor".

Aquí va la versión concreta. Conectas una vez tu bandeja de Gmail, Outlook, iCloud, Fastmail o cualquier bandeja IMAP al servidor. El servidor expone entonces el correo como un puñado de herramientas. Cuando tu agente quiere lidiar con el correo, llama a una de esas herramientas, el servidor habla con la API de Gmail (o con Microsoft Graph, o con IMAP) en tu nombre, y devuelve un resultado limpio.

Una buena forma de imaginarlo: el servidor de correo MCP es un **traductor y un portero**. La parte de traductor convierte la petición sencilla del agente ("lee el último mensaje de mi casero") en la llamada de API correcta y específica del proveedor, y convierte la respuesta enredada (partes MIME, codificación, cabeceras de hilos) de vuelta en algo legible. La parte de portero decide qué tiene permitido hacer el agente —solo leer, o leer y enviar— y nunca lo deja acercarse a tu contraseña real.

## Herramientas, no IMAP en crudo

Este es el meollo del asunto, así que quiero ir despacio aquí.

Si alguna vez has configurado el correo en un cliente de correo, te has topado con IMAP y SMTP. Son los protocolos sobre los que funciona el correo, y no son nada amables. IMAP te obliga a hacer malabares con el estado de las carpetas, las marcas de los mensajes, las descargas parciales y una sintaxis de consulta que varía según el servidor. SMTP te obliga a construir a mano mensajes MIME con las cabeceras correctas o tu respuesta cae en el hilo equivocado. Entregar todo eso a un modelo de lenguaje es mala idea. El modelo se equivocará con la codificación, filtrará una credencial en un registro o disparará un envío mal formado.

Un servidor de correo MCP reemplaza eso con **verbos**. El agente no ve protocolos. Ve un menú corto de acciones. MCP Emails incluye un puñado de herramientas consolidadas, y estas tres son las que más trabajan a diario:

\`\`\`json
{
  "tools": [
    "inbox_list",
    "email_read",
    "email_compose"
  ]
}
\`\`\`

Cada una salvo \`inbox_list\` recibe una \`action\`: \`email_read\` cubre listar, leer y buscar; \`email_compose\` cubre enviar, responder y reenviar. Algunas herramientas más completan la superficie (\`email_organize\`, \`folder\`, \`draft\`, \`schedule\`, \`contact_search\`), pero esos pocos verbos básicos cubren el trabajo diario. El agente siempre empieza con \`inbox_list\` para descubrir qué cuentas están conectadas y su \`inbox_id\` —nunca copia y pega un UUID de un archivo de configuración—. Luego lista, lee, busca, envía.

El cambio de "aquí tienes una biblioteca, apáñatelas" a "aquí tienes tres verbos, cada uno con una acción" es el quid de la cuestión. Los verbos son predecibles. Tienen una forma fija, una respuesta documentada y un permiso adjunto. Eso es lo que hace que el correo sea seguro de automatizar en vez de solo apto para una demo.

## Por qué un agente necesita verbos, no tu contraseña

La forma ingenua de dar a un agente acceso al correo es soltar la contraseña de tu buzón en un prompt o una configuración y dejar que ejecute un cliente IMAP. No hagas esto. Una contraseña es una llave maestra: lo concede todo, para siempre, sin manera de acotarla a "solo lectura" y sin forma limpia de retirarla sin cambiarla en todas partes.

Los verbos son distintos. Cuando tu agente se conecta a MCP Emails, recibe un token acotado exactamente a lo que aprobaste: \`read:email\`, \`send:email\`, o ambos. El agente sostiene una capacidad, no una credencial. Si solo concediste acceso de lectura, no hay verbo de envío en su menú: físicamente no puede enviarle correo a nadie.

¿Y el secreto en sí? Se queda en el servidor, cifrado. MCP Emails almacena una sola cosa por bandeja: un token de OAuth o una contraseña de aplicación, cifrada con AES-256-GCM, descifrada solo dentro de una función aislada en el momento de una llamada. Tu correo en sí nunca se almacena. Cada llamada a una herramienta obtiene el mensaje en vivo de tu proveedor y lo descarta en cuanto el agente lo tiene. El cuerpo de tu correo no se queda en alguna base de datos esperando a filtrarse. Si quieres la versión más larga de por qué importa esa decisión de diseño, escribí sobre ello en [por qué importa no almacenar nunca tu correo](/blog/why-email-never-stored-matters).

El modelo de capacidad-no-credencial es también la razón por la que puedes [revocar una conexión con un clic](/blog/oauth-vs-api-keys-ai-email-access) desde el panel. Revocar un verbo es instantáneo y quirúrgico. Rotar una contraseña filtrada no lo es.

## Cómo lo usa de verdad un agente

Una interacción real tiene este aspecto. Pongamos que le pides a Claude que te ponga al día de tu bandeja de entrada:

1. El agente llama a \`inbox_list\` y encuentra tu Gmail del trabajo.
2. Llama a \`email_read\` con \`action: "list"\` y \`unread_only: true\` para obtener las novedades.
3. Para cualquier cosa que parezca importante, llama a \`email_read\` con \`action: "read"\` para extraer el cuerpo completo.
4. Resume, y si has aprobado el acceso de envío, puede redactar una respuesta con \`email_compose\` (\`action: "reply"\`) —que fija las cabeceras de hilo automáticamente para que la respuesta caiga en la conversación correcta—.

Una limitación honesta que conviene saber de entrada: esto es **sondeo, no envío automático**. No hay webhooks. El servidor no avisará a tu agente cuando llegue correo nuevo. Para reaccionar a correo nuevo, el agente tiene que comprobarlo según una programación. Es una concesión deliberada, y define cómo construirías algo como un [autorrespondedor](/blog/build-email-auto-responder-mcp-agent) o una [rutina de clasificación de la bandeja](/blog/ai-agent-triage-summarize-inbox).

## Servidor alojado frente a construir el tuyo

Encontrarás muchos repos de "servidor MCP para Gmail" de código abierto que puedes clonar y ejecutar tú mismo. La mayoría cubren Gmail, casi siempre vía OAuth, y tú te ocupas del alojamiento, del almacenamiento de tokens y de la seguridad. Es un buen camino si disfrutas con ese trabajo. Es un camino peor si quieres también Outlook, iCloud y Fastmail, o si prefieres no ser quien guarda tokens cifrados de buzones a las 2 de la madrugada.

Un servidor de correo MCP alojado se encarga por ti de la dispersión de proveedores y de la seguridad de las credenciales, detrás de un único endpoint. Profundicé en las concesiones en [servidores MCP para Gmail alojados frente a autoalojados](/blog/hosted-vs-self-hosted-gmail-mcp-server) por si estás sopesando ambas opciones.

## La versión corta

Un servidor de correo MCP convierte tu bandeja de entrada en un conjunto de acciones seguras y con nombre que un agente de IA puede llamar sobre un protocolo estándar. El agente obtiene verbos acotados a lo que permitiste. Tu contraseña se queda en el servidor, cifrada. Tu correo de verdad nunca se almacena. Para el recorrido completo de cómo montar esto de principio a fin, empieza por la guía pilar sobre [cómo dar acceso al correo a tu agente de IA](/blog/how-to-give-your-ai-agent-email-access), o salta directamente y [conecta una bandeja en menos de dos minutos](/blog/connect-email-to-ai-agent-under-2-minutes).

¿Quieres probarlo? [Empieza gratis](/signup) —sin tarjeta, con una bandeja conectada— o lee [la documentación](/docs) para la referencia de herramientas y la URL del endpoint.`,
};

export default translation;
