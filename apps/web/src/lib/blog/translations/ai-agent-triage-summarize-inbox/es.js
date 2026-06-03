export default {
  title: 'Cómo hacer que tu agente de IA clasifique y resuma tu bandeja de entrada',
  description:
    'Guía práctica para clasificar la bandeja de entrada con un agente de IA: prompts listos para copiar que listan el correo no leído, leen lo importante, resumen y priorizan, y consultan según un horario.',
  coverAlt: 'Un agente de IA clasifica y resume una bandeja de entrada a través de MCP — MCP Emails',
  content: `La forma más rápida de que un agente de IA clasifique tu bandeja de entrada es apoyarte en dos herramientas en orden: \`inbox_list\` para encontrar tu buzón, y luego \`email_read\` — con \`action: list\` y \`unread_only: true\` para sacar lo nuevo, y después \`action: read\` para los pocos que parezcan importantes — y luego una instrucción en lenguaje natural para que los resuma y los ordene por prioridad. Ese es todo el bucle. Si quieres que redacte o envíe respuestas, añades \`email_compose\` con \`action: reply\` al final.

Este artículo te da los prompts exactos que uso, qué aspecto tiene un buen resultado y cómo ejecutar el mismo bucle según un horario para que tu clasificación matinal ocurra antes de que te sientes. Da por hecho que tu agente ya tiene acceso al correo a través de [MCP Emails](/blog/how-to-give-your-ai-agent-email-access). Si todavía no has conectado una bandeja de entrada, la [guía de conexión en menos de dos minutos](/blog/connect-email-to-ai-agent-under-2-minutes) te pone al día primero.

## El bucle de clasificación, en una imagen

Cada sesión de clasificación son los mismos cinco pasos. Tu agente decide el orden por su cuenta en cuanto le describes el objetivo, pero ayuda saber qué pasa por debajo:

1. \`inbox_list\` — descubre las bandejas conectadas y sus UUID de \`inbox_id\`. El agente nunca pone un UUID a fuego; lo busca aquí.
2. \`email_read\` con \`action: list\` y \`unread_only: true\` — saca la cola de no leídos de una bandeja, los más recientes primero.
3. \`email_read\` con \`action: read\` — abre el cuerpo completo de los pocos mensajes que merece la pena leer en detalle.
4. Resumir y priorizar — puro razonamiento, sin llamada a herramienta. El modelo agrupa, ordena y explica.
5. \`email_compose\` con \`action: reply\` (opcional) — redacta o envía para los que necesitan respuesta.

Los pasos del 1 al 4 son de solo lectura. Si conectaste con una [concesión OAuth o clave de API](/blog/oauth-vs-api-keys-ai-email-access) con alcance \`read:email\`, el agente físicamente no puede enviar nada, que es justo lo que quieres para un resumen automatizado que repasarás más tarde.

## Prompt 1: el resumen matinal

Empieza sencillo. Este es el que ejecuto casi todos los días. Pégalo en Claude (o en cualquier cliente MCP conectado a MCP Emails) y déjalo trabajar:

> Mira mi bandeja de entrada principal. Saca todo lo no leído y dame un resumen agrupado en tres categorías: necesita respuesta hoy, para tu información / puede esperar, y probablemente ruido. Para cada elemento de las dos primeras categorías, dame una línea: de quién viene y qué quiere. No abras nada que no necesite — repasa primero los asuntos y los remitentes, y lee el cuerpo solo cuando el asunto sea ambiguo.

Fíjate en lo que hace ese prompt. Le dice al agente que se apoye en los metadatos de \`email_read\` (action list) (remitente, asunto, fragmento) y que llame a \`email_read\` con \`action: read\` con moderación. Eso mantiene la sesión rápida y se queda muy por debajo de los límites de tasa — 100 solicitudes por minuto por clave de API, y un techo por espacio de trabajo que empieza en 60/min en el plan Free. Una cola de 40 mensajes no leídos clasificada así son quizá una docena de llamadas a herramientas, no cuarenta.

Una buena respuesta tiene este aspecto:

\`\`\`text
NEEDS A REPLY TODAY (3)
- Dana (Acme): contract redline is back, wants sign-off before Fri
- Priya: blocked on the staging creds, asking you directly
- Stripe: a payment dispute opened, response due in 5 days

FYI / CAN WAIT (4)
- GitHub: 2 PRs merged into main overnight
- Notion: weekly digest
- Lena: shared the Q3 deck, no ask
- AWS: scheduled maintenance next Tuesday

PROBABLY NOISE (11): newsletters, 2 calendar invites already on your
calendar, LinkedIn, 6 marketing blasts.
\`\`\`

Eso es genuinamente útil de una forma en que una bandeja en bruto no lo es. El agente leyó los tres mensajes en los que el asunto no dejaba clara la petición, y dejó cerrados los once boletines.

## Prompt 2: clasificación a fondo con prioridades y razonamiento

Cuando el recuento de no leídos es feo — un lunes después de un fin de semana largo — quiero algo más que categorías. Quiero que el agente defienda su orden para poder fiarme:

> Mi bandeja de entrada es un desastre. Clasifica todo lo no leído de los últimos 4 días. Ordena los 8 primeros según lo urgentes que son en realidad, no según lo escandaloso que sea el remitente. Para cada uno, dime la fecha límite si la hay, quién está bloqueado y tu razonamiento de una frase para el puesto. Lee el cuerpo completo de cualquier cosa de tu top 8 para no andar adivinando.

La frase "no según lo escandaloso que sea el remitente" importa. Sin ella, los agentes le dan demasiado peso a los asuntos en MAYÚSCULAS y a los "URGENTE" de los sistemas automáticos. Con ella, obtienes criterio:

\`\`\`text
1. Priya — blocked on staging creds since Thu. A teammate can't ship
   until you respond. No formal deadline but it's costing time now.
2. Stripe dispute — hard deadline in 5 days, money attached, but you
   have buffer so it's #2 not #1.
3. Dana (Acme) — contract sign-off by Fri. Important, not yet urgent.
...
\`\`\`

Para este prompt el agente llamará a \`email_read\` con \`action: read\` ocho veces, una por cada elemento del top, porque le pediste que dejara de adivinar. Es el compromiso correcto: unas pocas llamadas extra a cambio de un orden sobre el que puedes actuar. Si el agente sí choca con un límite a mitad de ejecución, MCP Emails devuelve un error reintentable con un valor \`retry_after\` en segundos — un cliente que se porta bien espera ese tiempo y retoma en lugar de aporrear el servidor.

## Prompt 3: clasificación que termina en una respuesta

La clasificación vale más cuando cierra asuntos. En cuanto te fíes de los resúmenes, deja que el agente redacte. Yo mantengo a una persona en el bucle para los envíos, así que mi prompt pide borradores, no piloto automático:

> La misma clasificación de siempre. Para cualquier cosa de "necesita respuesta hoy" que pueda responder en dos frases, redacta la respuesta y enséñamela. No la envíes todavía — yo diré "envía la 1 y la 3" o las editaré. Imita mi tono habitual: corto, directo, sin relleno corporativo.

El agente ejecuta el bucle de solo lectura y luego escribe los borradores en línea. Cuando dices "envía la 1 y la 3", llama a \`email_compose\` con \`action: reply\` para esas dos. Las respuestas se encadenan automáticamente — MCP Emails pone por ti las cabeceras \`In-Reply-To\` y \`References\`, así que tu respuesta aterriza en la conversación correcta en vez de empezar una nueva. El correo sale a través de tu propio proveedor (API de Gmail, Microsoft Graph o tu SMTP), de modo que la entregabilidad y la reputación de tu dominio siguen siendo tuyas. Nada se reenvía desde un dominio de envío compartido.

Si quieres dar el siguiente paso y salirte del bucle por completo, eso es otra forma de automatización — consulta [cómo construir un autorespondedor de correo con un agente MCP](/blog/build-email-auto-responder-mcp-agent) para ver las salvaguardas que yo le pondría antes de dejar que un agente envíe sin supervisión.

## Ejecutar la clasificación según un horario

Aquí está la limitación honesta: MCP es **consulta, no inserción.** MCP Emails no tiene webhooks ni envía eventos iniciados por el servidor. Tu agente no recibe un aviso cuando llega correo. Para hacer clasificación continua, algo tiene que llamar a \`email_read\` con \`action: list\` y \`unread_only: true\` con un temporizador.

En la práctica eso significa una de dos configuraciones:

- Un trabajo programado — una entrada de cron, una tarea programada en la plataforma de tu agente, o la propia programación de Claude si tu cliente la admite — que dispare el prompt del resumen matinal a las 8 de la mañana y de nuevo después de comer. Dos veces al día cubre a la mayoría de la gente.
- Un bucle de agente siempre activo que consulte cada pocos minutos durante el horario laboral. Esto es excesivo para una bandeja personal y quema límite de tasa a cambio de poca ganancia. Resérvalo para buzones genuinamente sensibles al tiempo como support@ o alerts@.

Yo uso la versión del trabajo programado. Dos consultas al día, cada una un único prompt de resumen matinal contra mi bandeja principal. Cuesta un puñado de llamadas a herramientas y me deja un resumen limpio delante antes de que abra el cliente de correo. Para la mayoría de la gente, eso gana a un bucle en tiempo real en todos los ejes que importan.

Sea cual sea la cadencia que elijas, mantén la consulta honesta: consultar con más frecuencia no significa más rápido, solo significa más solicitudes contra el mismo techo de 60 a 1000 por minuto. Ajusta el intervalo a la velocidad real a la que se mueve la bandeja.

## Algunas cosas que hacen la clasificación notablemente mejor

- **Nombra la bandeja.** Si has conectado más de una cuenta, di "mi bandeja del trabajo" o "la bandeja de soporte". El agente la resuelve a partir de los títulos de \`inbox_list\`, y así evitas que clasifique el buzón equivocado.
- **Dale una rúbrica, no solo "resume".** "Urgente = alguien está bloqueado o hay una fecha límite para el mismo día" produce un orden muchísimo mejor que dejar la urgencia sin definir.
- **Limita las lecturas.** "Abre el cuerpo solo cuando el asunto sea ambiguo" o "lee los 8 primeros" mantiene las sesiones rápidas y baratas. Un "léelo todo" sin límites es lento y rara vez mejor.
- **Quédate en solo lectura hasta que te fíes.** Funciona con un alcance \`read:email\` durante una semana. Añade \`send:email\` solo cuando los borradores sean buenos de forma constante.

Si la clasificación es el primer flujo de trabajo que vas a probar, es un buen punto de partida — es de solo lectura, la recompensa es inmediata, y construye la confianza que querrás antes de ceder el acceso de envío. Para más ideas cuando ya te sientas cómodo, aquí tienes [siete cosas que un agente de IA puede hacer con acceso a la bandeja de entrada](/blog/7-things-ai-agent-can-do-with-inbox-access).

## Pruébalo en tu propia bandeja de entrada

Conecta una bandeja, pega el Prompt 1 y mira cómo tu agente adelgaza un atasco de 40 mensajes en menos de un minuto. Es [gratis para empezar](/signup), sin tarjeta, y puedes revocar el acceso desde el panel con un solo clic. La [referencia de herramientas en la documentación](/docs) tiene todos los parámetros por si quieres cablear el bucle en un script en lugar de un chat.`,
};
