const translation = {
  title: 'Resumen diario del correo con Claude y ChatGPT: tu bandeja de entrada resumida cada día',
  description:
    'Tres formas de recibir un resumen diario de tu bandeja de entrada: una tarea programada de Claude, una tarea programada de ChatGPT o un resumen matinal que MCPEmails deja en tu bandeja sin abrir ningún chat. Configuración, prompts y límites.',
  coverAlt:
    'Un resumen diario de Claude y ChatGPT con el correo nuevo de varias bandejas de entrada conectadas',
  content: `**Puedes recibir un resumen diario de tu correo de Claude o ChatGPT dándole al asistente dos cosas: acceso a tu buzón y un horario.** Los dos asistentes ya ejecutan tareas programadas. Las de Claude ejecutan un prompt cada hora, cada día, cada semana o los días laborables, y las de ChatGPT se ejecutan a una hora fija en todos los planes. Conecta la tarea a tu buzón mediante un conector y cada mañana tendrás el resumen esperándote.

Hay una tercera vía que no necesita ningún chat: MCPEmails puede dejar un resumen matinal directamente en tu bandeja de entrada a la hora que elijas. Esta guía cubre las tres, con los prompts que conviene usar y lo que ninguna de ellas puede hacer.

**Ir a:** [Claude](#un-resumen-diario-del-correo-con-claude) · [ChatGPT](#un-resumen-programado-de-la-bandeja-de-entrada-en-chatgpt) · [Resumen matinal](#el-resumen-matinal-sin-chat) · [Cuál elegir](#cuál-elegir) · [Prompts](#prompts-para-un-resumen-útil) · [Preguntas frecuentes](#preguntas-frecuentes)

## Primero, dale al asistente acceso a tu buzón

Una tarea programada solo puede resumir el correo al que llega. El conector de Gmail propio de Claude llega a una cuenta de Google, y su conector de Microsoft 365 llega a cuentas de trabajo cuando un administrador lo aprueba. ChatGPT tiene su propia app de Gmail. Para todo lo demás, o para reunir varios buzones en un mismo resumen, conéctalos a través de un servidor MCP.

MCPEmails es un servidor MCP alojado. Conectas cada buzón una vez y luego añades una sola URL de conector a Claude o ChatGPT:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

Funciona con Gmail y Google Workspace, Outlook y Microsoft 365, iCloud, Yahoo, Fastmail, Zoho y cualquier buzón compatible con IMAP y SMTP. Cada buzón conectado aparece en el asistente por su nombre, así que un mismo resumen puede cubrir a la vez tu propia dirección, info@ y un Gmail personal. [Varias cuentas de correo en Claude y ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) explica esa configuración.

Un resumen solo lee, así que elige el acceso **Solo lectura** cuando te lo pregunte la pantalla de consentimiento. Así, una tarea que se ejecuta mientras no estás no puede enviar, mover ni eliminar nada, diga lo que diga el correo que lee. [Acceso de solo lectura](/docs/read-only-access) enumera exactamente lo que puede hacer esa conexión.

## Un resumen diario del correo con Claude

Las tareas programadas de Claude forman parte de Cowork en la app de Claude, en todos los planes de pago (Pro, Max, Team y Enterprise). Según el [artículo de ayuda de Anthropic](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-cowork), una tarea puede ejecutarse cada hora, cada día, cada semana, los días laborables o solo cuando la inicias tú, y usa los mismos conectores que tus otras tareas. Las tareas se ejecutan en remoto, así que mantienen su horario aunque tu ordenador esté en reposo o la app esté cerrada, salvo que la tarea necesite archivos o apps locales.

1. **Añade MCPEmails a Claude.** Abre **Customize → Connectors**, haz clic en **+ Add** y después en **Add custom connector**. Llámalo MCPEmails, introduce \`https://mcpemails.com/api/mcp\`, haz clic en **Continue**, deja los ajustes de inicio de sesión detectados y haz clic en **Add**. Inicia sesión en MCPEmails y elige **Solo lectura**. La [guía de configuración de Claude](/blog/connect-claude-to-email) muestra cada pantalla.
2. **Crea la tarea.** Haz clic en **Scheduled** en la barra lateral, luego en **New task**, y elige **Create with Claude** o **Set up manually**. También puedes describir la tarea en una conversación ("todos los días laborables a las 7, resume mi bandeja de entrada") y Claude te propone un nombre, un horario y unas instrucciones que confirmas con **Schedule**.
3. **Pega el prompt del resumen** de la [sección de prompts](#prompts-para-un-resumen-útil) y elige **Weekdays** o **Daily**.
4. **Ejecútala una vez a mano** para comprobar el resultado antes de la primera ejecución programada.

En Claude, cada herramienta de un conector se puede configurar como **Always allow**, **Needs approval** o **Blocked**. Para un resumen, bloquea las herramientas de envío y organización de MCPEmails, o mantén la conexión en Solo lectura, para que la tarea se quede en un resumen.

## Un resumen programado de la bandeja de entrada en ChatGPT

El [artículo de ayuda de OpenAI sobre las tareas](https://help.openai.com/en/articles/10291617-tasks-in-chatgpt) dice que las tareas programadas están en todos los planes, incluidos Free y Go. Free ejecuta una tarea como mucho una vez al día, en una franja aproximada como "por la mañana". Los planes de pago pueden ejecutar tareas hasta cada hora, a una hora exacta. Cada plan tiene un límite de tareas activas, de 3 en Free a 15 en Pro y Enterprise. Creas una tarea desde la página **Scheduled** o pidiéndola en un chat, y ChatGPT puede avisarte por notificación push o por correo cuando termina.

Las tareas pueden usar apps compatibles, y OpenAI menciona Gmail, Slack y GitHub. Si tu correo está en una sola cuenta de Gmail, la app de Gmail propia de ChatGPT es la fuente más sencilla para la tarea.

El artículo de OpenAI no dice si un servidor MCP que hayas añadido tú está disponible dentro de una tarea. Para usar MCPEmails, añádelo como se describe en la [guía de configuración de ChatGPT](/docs/chatgpt), programa la tarea para dentro de unos minutos y comprueba que la primera ejecución lee tu correo antes de confiar en ella. OpenAI también advierte de que una acción que envía un mensaje o modifica datos puede necesitar tu aprobación y pausa la tarea, un motivo más para que el resumen sea de solo lectura.

## El resumen matinal: sin chat

Los planes Pro y Business de MCPEmails incluyen un **resumen matinal**: un resumen diario que MCPEmails prepara en sus propios servidores y deja directamente en una de tus bandejas de entrada a la hora que elijas. No interviene ningún asistente, chat ni app abierta, así que llega incluso los días en que no abres Claude ni ChatGPT.

Cada resumen cubre tu día en tu hora local:

- **Primero, los remitentes VIP.** El correo nuevo de las direcciones o dominios que indiques, en todas tus bandejas de entrada.
- **El correo nuevo de cada bandeja** desde el último resumen: cuántos mensajes y los remitentes y asuntos más recientes.
- **Los seguimientos pendientes.** Recordatorios que tu IA creó para correos que no recibieron respuesta.
- **El correo pospuesto** que vuelve más tarde ese mismo día.
- **Los envíos programados** que salen más tarde ese mismo día.

Cubre hasta 10 bandejas de entrada conectadas. Los días sin novedades se omiten en lugar de enviarse vacíos. El resumen se añade directamente a la bandeja de entrada, así que no se envía nada y nada sale de tu buzón. Se genera a partir de reglas, sin que ningún modelo de IA lea tu correo.

Para activarlo, abre **Ajustes** en el panel, busca **Resumen matinal** en los ajustes del espacio de trabajo, marca **Dejar un resumen matinal en mi bandeja de entrada cada día** y elige la hora, tu zona horaria, la bandeja de entrada en la que se deja y los remitentes VIP. Solo los propietarios y administradores del espacio de trabajo pueden cambiarlo.

Los seguimientos y el correo pospuesto del resumen vienen de tu IA, y forman parte de los mismos planes. Pide a Claude o ChatGPT "avísame si Dana no ha respondido el viernes" o "pospón esto hasta el lunes por la mañana", y MCPEmails lo controla en sus servidores aunque el chat esté cerrado.

## Cuál elegir

- **Quieres el resumen escrito en lenguaje natural, con criterio sobre lo que importa:** una tarea programada de Claude o ChatGPT. El modelo lee el correo y decide qué destacar.
- **Lo quieres cada día sin depender de una app de chat ni de sus límites de tareas:** el resumen matinal. Llega a tu bandeja de entrada a la hora fijada y nunca improvisa.
- **Quieres los dos:** funcionan juntos. El resumen matinal te da la lista fija cada mañana, y le preguntas al asistente por cualquier cosa que aparezca en ella.

Si prefieres que el correo se ordene en lugar de resumirse, las [reglas de clasificación automática del correo](/blog/automated-email-triage-rules) mueven, etiquetan y marcan el correo nuevo según un horario, sin ningún modelo.

## Prompts para un resumen útil

Pide un formato breve y fijo. Un resumen que lees en un minuto es un resumen que sigues leyendo.

> Usando MCPEmails, dame mi resumen matinal de todas las bandejas de entrada conectadas: qué ha llegado desde ayer a esta hora, qué necesita hoy una respuesta mía y cualquier cosa con una fecha límite esta semana. Agrupa por bandeja de entrada, como máximo 10 líneas. No envíes, muevas ni cambies nada.

> Usando MCPEmails, enumera el correo no leído de las últimas 24 horas en ventas@ e info@ que venga de un cliente o de un posible cliente. Para cada uno: remitente, resumen de una línea y si necesita respuesta hoy. Omite boletines y notificaciones. Solo lectura.

> Usando MCPEmails, revisa mi bandeja de entrada en busca de facturas, contratos y cualquier cosa que mencione un pago o una fecha de vencimiento y que haya llegado la última semana. Una línea por cada uno, con el importe y la fecha si aparecen. Solo lectura.

Decir "solo lectura" en el prompt es un buen hábito, pero la protección fiable es la propia conexión: una conexión de Solo lectura no puede enviar aunque un mensaje le diga al modelo que lo haga. El correo lo escriben otras personas, y parte de él está escrito para manipular a los asistentes de IA. [¿Es seguro dar a un agente de IA acceso al correo?](/blog/is-it-safe-to-give-ai-agent-email-access) explica por qué.

Para más prompts de clasificación, consulta [clasificar y resumir la bandeja de entrada con un agente de IA](/blog/ai-agent-triage-summarize-inbox). Para escribir una respuesta según un horario en lugar de leer, [programar un correo con Claude o ChatGPT](/blog/schedule-email-with-claude-and-chatgpt) explica los envíos en cola.

## Preguntas frecuentes

**¿Puede Claude resumir mi correo cada día?**
Sí. Crea en Claude (Pro, Max, Team o Enterprise) una tarea programada que se ejecute cada día o los días laborables, con un conector a tu buzón. El conector de Gmail de Claude cubre una cuenta de Google; MCPEmails cubre cualquier proveedor y varios buzones a la vez.

**¿Puede ChatGPT resumir mi bandeja de entrada según un horario?**
Sí. Las tareas programadas de ChatGPT pueden usar su app de Gmail en cualquier plan, con Free limitado a una vez al día. OpenAI no dice si un servidor MCP personalizado funciona dentro de una tarea, así que prueba una ejecución antes de confiar en ella.

**¿Se ejecuta la tarea con el ordenador apagado?**
Las tareas programadas de Claude se ejecutan en remoto salvo que necesiten archivos o apps locales. Las tareas de ChatGPT se ejecutan en los servidores de OpenAI. El resumen matinal de MCPEmails se ejecuta en nuestros servidores y llega a tu bandeja de entrada en cualquier caso.

**¿Se guarda mi correo para el resumen?**
MCPEmails no lo guarda. El correo se obtiene en directo de tu proveedor en cada solicitud y se descarta en cuanto se envía la respuesta. El resumen matinal se escribe en tu propio buzón, no lo guardamos nosotros. Consulta [seguridad](/security).

**¿Qué plan incluye el resumen matinal?**
Pro y Business. Una tarea programada de Claude o ChatGPT puede leer a través de MCPEmails en cualquier plan de MCPEmails, incluido Free con una bandeja de entrada. Los planes actuales están en la [página de precios](/pricing).

## Siguiente paso

[Empieza gratis](/signup), conecta tu buzón con más movimiento con acceso de Solo lectura, añade MCPEmails a Claude o ChatGPT y ejecuta una vez a mano el prompt del resumen. Cuando el resultado sea el que quieres, prográmalo.`,
};

export default translation;
