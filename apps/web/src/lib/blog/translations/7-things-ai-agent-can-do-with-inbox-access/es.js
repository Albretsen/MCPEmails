export default {
  title: '7 cosas que tu agente de IA puede hacer en cuanto tiene acceso a la bandeja de entrada',
  description:
    'Siete cosas concretas que un agente de IA puede hacer con acceso a tu bandeja: clasificar correo sin leer, resumir hilos, redactar respuestas, encontrar adjuntos y hacer seguimientos.',
  coverAlt: 'Siete cosas que tu agente de IA puede hacer con acceso a la bandeja de entrada a través de MCP — MCPEmails',
  content: `En cuanto tu agente puede leer y enviar correo de verdad, se acaban las demos de juguete y empieza el trabajo real. Aquí tienes siete cosas que puedes ponerle a hacer hoy mismo: clasificar el montón de correos sin leer, resumir un hilo largo, redactar respuestas con tu voz, rescatar ese adjunto concreto, perseguir seguimientos, dirigir el correo al sitio correcto y enviarte un resumen semanal.

Cada ejemplo de abajo se corresponde con herramientas MCP reales que puedes invocar ahora mismo. Las herramientas son las mismas tanto si conectas Gmail, Outlook, iCloud, Fastmail o un buzón IMAP genérico. Si todavía no has conectado un agente a tu bandeja, la [guía completa para darle acceso al correo a tu agente de IA](/blog/how-to-give-your-ai-agent-email-access) cubre la configuración; el [tutorial de conexión en 2 minutos](/blog/connect-email-to-ai-agent-under-2-minutes) es el camino rápido.

Una advertencia honesta por adelantado, porque condiciona la mitad de esta lista: **MCP Emails funciona por sondeo (poll), no por push.** No hay webhooks ni eventos iniciados por el servidor. Al agente no le avisan cuando llega correo. Lo comprueba según una programación. Suena a limitación, y para algunos casos lo es, pero también significa que nada se dispara sin un reloj que tú controlas. Iré señalando dónde importa el sondeo.

## El conjunto de herramientas, de un vistazo

Todo lo de aquí se apoya en un puñado de herramientas centrales: \`inbox_list\`, \`email_read\` y \`email_compose\`. Estas dos últimas agrupan listar, leer y buscar (\`email_read\`) y enviar, responder y reenviar (\`email_compose\`) en una sola herramienta cada una, con un parámetro \`action\` que elige la variante. Hay unas cuantas más: \`email_organize\` para marcar como leído, banderas y carpetas, además de \`folder\`, \`draft\`, \`schedule\` y \`contact_search\`. La primera llamada que tu agente debería hacer siempre es \`inbox_list\`, para descubrir las cuentas conectadas y sus valores \`inbox_id\`, de modo que nunca codifiques un UUID a mano en un prompt.

Los prompts de abajo están escritos tal como yo se los escribiría de verdad a Claude o a Cursor. El agente averigua qué herramienta llamar.

### 1. Clasificar el montón de correos sin leer

La bandeja de entrada de la mañana es sobre todo ruido con tres cosas importantes enterradas dentro. Haz que el agente lo ordene antes de que termines tu café.

> Revisa mi bandeja de trabajo en busca de correo sin leer de las últimas 24 horas. Agrúpalo en "necesita respuesta hoy", "para tu información" y "boletines/automáticos". Para el primer grupo, dame una línea sobre lo que quiere cada uno.

Por debajo, el agente llama a \`email_read\` con la acción list y \`unread_only: true\` sobre la bandeja que devolvió \`inbox_list\`, lee los pocos que parecen importantes con \`email_read\` de nuevo (acción read) y se salta el resto. Puede marcar como leído el ruido evidente para que deje de inflar el contador. Para una versión más a fondo de esto, el [manual de clasificación y resumen](/blog/ai-agent-triage-summarize-inbox) va herramienta por herramienta.

### 2. Resumir un hilo largo

Te añaden a un hilo de 40 mensajes en el mensaje 38. Nadie va a leerse lo anterior. El agente sí.

> Lee el hilo con asunto "Q3 vendor migration" y dime en qué quedó realmente: qué se decidió, quién se encarga de qué y cualquier pregunta abierta que yo tenga que responder.

\`email_read\` con la acción search encuentra el hilo (usa la sintaxis de búsqueda nativa de tu proveedor, así que los operadores de Gmail, KQL de Outlook y la búsqueda de texto de IMAP funcionan todos), y luego \`email_read\` con la acción read extrae el texto plano ya parseado de cada mensaje. Esa acción read también puede devolver HTML saneado y adjuntos cuando lo pides, pero para un resumen el texto plano es más rápido y más barato.

### 3. Redactar respuestas con tu voz

La redacción es donde los agentes se ganan el sueldo. El modelo escribe la respuesta aburrida, tú la ojeas y la envías.

> Redacta una respuesta al último mensaje de Dana rechazando la reunión pero ofreciendo dos horarios la semana que viene. Imita mi tono habitual, corto y directo.

El agente usa \`email_compose\` con la acción reply, que coloca por ti las cabeceras de hilo (In-Reply-To y References), de modo que la respuesta cae en la conversación correcta en lugar de empezar una nueva. Las respuestas admiten CC, BCC, HTML y adjuntos de hasta 10 MB en total. Mi regla: deja que el agente redacte libremente, pero mantén a una persona en el botón de enviar para cualquier cosa que salga de la empresa. Trata \`email_compose\` (sea la acción send, reply o forward) como el paso que de verdad revisas.

### 4. Encontrar ese adjunto concreto

Sabes que alguien envió el contrato firmado en marzo. No sabes en cuál de 200 hilos está. Buscar gana a hacer scroll.

> Encuentra el correo más reciente con un adjunto PDF de cualquiera de acme.com sobre la renovación y saca el adjunto.

\`email_read\` con la acción search lo acota con una consulta nativa del proveedor y luego \`email_read\` con la acción read y \`include_attachments\` devuelve el archivo. Como el correo se obtiene en vivo y se descarta después de la llamada, ese adjunto no se queda en ninguna caché para más tarde. La [arquitectura sin almacenamiento](/blog/why-email-never-stored-matters) es la razón por la que es seguro apuntar un agente a esto.

### 5. Recordatorios de seguimiento (este va por sondeo)

"¿Llegó a responder el cliente?" es una pregunta que se te olvida hacer hasta que es demasiado tarde. Un agente puede vigilar el hilo por ti, pero aquí es donde muerde la realidad del poll en lugar de push.

> Cada día laborable a las 4pm, comprueba si alguien respondió a las propuestas que envié esta semana. Lista las que siguen esperando con la fecha de envío original.

No hay ningún evento que despierte al agente cuando llega una respuesta. En su lugar lo ejecutas según una programación —un cron, la función de tareas programadas de tu cliente, lo que encaje— y cada ejecución hace el trabajo: \`email_read\` con la acción search para las propuestas enviadas y luego la acción list para ver qué ha vuelto. Si quieres que un hilo estancado se dé un toque a sí mismo, el agente puede incluso redactar y poner en cola un seguimiento. La [construcción del autorrespondedor](/blog/build-email-auto-responder-mcp-agent) recorre el bucle de sondeo en detalle, incluido cómo respetar el valor \`retry_after\` cuando te topas con un límite de tasa para no machacar el servidor.

### 6. Dirigir o reenviar al sitio correcto

No todo correo es para ti. Algunos pertenecen a un buzón compartido, a una dirección de tickets o a un compañero.

> Reenvía todo lo que parezca una factura a accounting@, y marca los recibos que debería guardar para impuestos.

La herramienta de reenvío envía a través de tu propio proveedor, así que el mensaje conserva la reputación de tu dominio en lugar de ir retransmitido desde un tercero. Las banderas y las carpetas dejan que el agente archive cosas sin borrarlas. Este es el tipo de regla permanente que casa de forma natural con la pasada de clasificación de correo sin leer del punto 1: una ejecución, dos resultados.

### 7. Un resumen semanal

Termina la semana con un resumen escrito en lugar de una mirada de culpa a una bandeja que nunca vaciaste.

> Viernes a las 5pm: resume todo lo que recibí esta semana y a lo que no he respondido, agrupado por remitente, con la única tarea más importante de todo el conjunto. Envíamelo por correo.

Esto cose las demás: \`email_read\` (acción search y luego list) para reunir la semana, la acción read de esa misma herramienta para las que necesitan detalle y luego \`email_compose\` para entregarte el resumen a ti mismo. Igual que el toque de seguimiento, es una ejecución programada, no una reacción. Tú decides la cadencia.

## Cuánto cuesta esto y dónde están los límites

Los siete funcionan en el [plan Gratis](/pricing), que cuesta 0 $ y conecta una bandeja a 60 peticiones por minuto. Pro (29 $/mes) conecta todos los buzones que tengas y sube el límite de ráfaga a 300 peticiones por minuto; Team (79 $/mes) añade miembros con roles, un espacio de trabajo separado por cliente, SSO y 1.000 peticiones por minuto. Una bandeja sobra para un resumen semanal; en cuanto quieras el trabajo y lo personal en el mismo agente, eso es Pro.

Cuando llegues a un límite, el servidor devuelve un error reintentable con \`data.retry_after\` en segundos. Respétalo. Y nunca reintentes a ciegas un envío de \`email_compose\`, porque un reintento tras un timeout puede significar que dos copias del mismo mensaje aterricen en la bandeja de alguien.

## Empieza por una

No intentes construir las siete el primer día. Elige la pasada de clasificación o el resumen semanal, déjalo aburrido y fiable, y luego añade el siguiente. [Conecta una bandeja](/signup) y haz que tu agente ejecute \`inbox_list\` como primer movimiento. La [referencia de herramientas en la documentación](/docs) tiene los parámetros exactos para cada llamada de arriba.`,
};
