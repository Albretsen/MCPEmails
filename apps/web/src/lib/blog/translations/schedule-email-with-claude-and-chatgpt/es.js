const translation = {
  title: 'Cómo programar un correo con Claude o ChatGPT (envío programado)',
  description:
    'Programa un correo en Claude o ChatGPT para que salga más tarde desde tu Gmail, Outlook, iCloud o buzón IMAP: configuración, zonas horarias, cancelación y límites.',
  coverAlt:
    'Claude y ChatGPT programando un correo para enviarlo más tarde desde un buzón conectado con MCPEmails',
  content: `Para programar un correo con Claude o ChatGPT, el asistente necesita una herramienta de correo capaz de guardar un mensaje y enviarlo más tarde. MCPEmails la tiene. Conecta tu buzón, añade MCPEmails como conector y di cuándo: "Envía esto a Dana el lunes a las 9:00, hora de Oslo." El mensaje espera en una cola en el servidor de MCPEmails y sale desde tu propia dirección a esa hora, sigan o no abiertos el chat, la app o tu ordenador.

Funciona igual en Claude, en ChatGPT y en otros clientes MCP, y con Gmail y Google Workspace, Outlook y Microsoft 365, iCloud, Fastmail, Yahoo, Zoho y cualquier buzón compatible con IMAP y SMTP.

**Ir a:** [Conectores integrados](#qué-hacen-los-conectores-de-correo-integrados) · [Configuración](#cómo-programar-un-correo-con-claude-o-chatgpt) · [Zonas horarias](#zonas-horarias) · [Cancelar o cambiar](#consultar-cancelar-o-cambiar-un-correo-programado) · [Preguntas frecuentes](#preguntas-frecuentes)

## Qué hacen los conectores de correo integrados

Los dos asistentes traen sus propios conectores de correo. Así estaban a 20 de octubre de 2026:

- **Claude.** El artículo de ayuda de Anthropic sobre el conector de Gmail enumera buscar, leer, redactar borradores, enviar, responder y reenviar. Programar un mensaje para más tarde no figura en la lista.
- **ChatGPT.** La página de ayuda de OpenAI sobre su app Outlook Email cubre buscar y leer mensajes, acciones sobre personas y contactos, y enviar correo en texto plano desde buzones compartidos o delegados. Sus preguntas frecuentes sobre la app de Google tratan el uso de datos y las tareas que se activan con Gmail. Ninguna de las dos describe un envío programado.

ChatGPT sí tiene **tareas programadas**, que ejecutan un prompt a la hora que elijas. Eso no es lo mismo que un correo en cola. El mensaje se escribe cuando se ejecuta la tarea, no cuando apruebas el texto, y OpenAI advierte de que las acciones que requieren tu aprobación pueden pausar la tarea.

Un envío programado con MCPEmails es un mensaje terminado: lees ahora el texto exacto, y ese texto es el que sale a la hora fijada.

## Cómo programar un correo con Claude o ChatGPT

1. **Conecta tu buzón a MCPEmails.** En el panel, abre **Bandejas de entrada**, luego **Conectar bandeja**, y elige tu proveedor. Hay una página por proveedor en [conectar](/connect).
2. **Añade MCPEmails a tu asistente.** En Claude, abre **Customize**, luego **Connectors**, haz clic en **+ Add**, elige **Add custom connector** y pega \`https://mcpemails.com/api/mcp\`. La [guía de Claude](/blog/connect-claude-to-email) tiene todos los pasos. En ChatGPT, MCPEmails se añade como conector MCP personalizado; qué planes lo ofrecen y dónde está el menú han cambiado más de una vez este año, así que sigue los pasos actuales de la [guía de configuración de ChatGPT](/docs/chatgpt).
3. **Concede la programación al autorizar.** La pantalla de consentimiento de MCPEmails ofrece niveles de acceso. Elige **Acceso completo**, o **Personalizado** con la programación marcada. **Estándar** deja fuera la programación, así que una solicitud de programación se rechaza.
4. **Pide el correo y la hora.** Indica los destinatarios, qué decir, la fecha y la hora, y tu zona horaria.

Por detrás, el asistente llama a la herramienta \`schedule\` con la acción \`create\` y le pasa los destinatarios, el asunto, el cuerpo y la hora de envío. MCPEmails comprueba al momento las direcciones, el asunto y el cuerpo, así que una dirección mal formada o un cuerpo vacío se rechaza ahora en lugar de fallar el lunes por la mañana. No puede distinguir una dirección válida que no querías de la que sí querías, y por eso los prompts de abajo piden ver antes el destinatario. El resultado incluye la hora programada y un id que el asistente puede usar más tarde para cancelar.

A la hora de envío, un despachador en el servidor de MCPEmails, que revisa la cola cada minuto, envía el mensaje a través del propio proveedor del buzón: Gmail, Microsoft o el servidor SMTP del buzón. Sale desde tu dirección, con tu [firma](/blog/email-signatures-for-claude) añadida en ese momento. Cuenta con que llegue en torno a un minuto después de la hora fijada; no está pensado para una precisión al segundo.

Si el servidor de correo rechaza el mensaje antes de aceptar nada de él, el despachador vuelve a intentarlo cada minuto durante un máximo de 15 minutos después de la hora de envío. Si mientras tanto el buzón se ha desconectado, el mensaje no se envía.

## Prompts que programan sin problemas

> Escribe un breve agradecimiento a dana@example.com por la llamada de hoy y prográmalo para el lunes a las 09:00, Europe/Oslo. Enséñame el texto y la hora de envío antes de programarlo.

> Programa el recordatorio de pago de abajo desde accounts@ a las tres direcciones que aparecen en él, para el día 1 del mes que viene a las 08:30, hora de Nueva York.

> ¿Qué correos tengo programados? Indica destinatario, asunto y hora de envío en mi zona horaria.

> Cancela el correo programado para Dana.

Pedir ver antes el texto y la hora cuesta un mensaje más y detecta los dos fallos más habituales: el destinatario equivocado y la hora equivocada. Si gestionas varios buzones, indica desde cuál enviar ("desde accounts@"); [varias cuentas de correo en Claude y ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) explica cómo los distingue el asistente.

## Zonas horarias

La herramienta \`schedule\` recibe la hora de envío como una marca de tiempo con desfase horario, por ejemplo \`2026-11-02T09:00:00+01:00\`. El asistente convierte "el lunes a las 9" a ese formato, así que necesita saber tu zona. Nombra una ciudad o una zona en el prompt ("hora de Oslo", "Europe/Oslo", "hora del Este de EE. UU."); si no, el modelo tiene que adivinarla.

El cambio de hora es donde fallan las suposiciones. Oslo está en +02:00 hasta el último domingo de octubre y en +01:00 después, así que las 09:00 hora de Oslo del 2 de noviembre de 2026 son \`+01:00\`. Decir la ciudad permite al asistente elegir el desfase correcto para esa fecha.

La confirmación indica la hora en UTC. Pide al asistente que te la repita en tu hora local antes de darla por buena. Una hora que ya ha pasado se rechaza.

## Consultar, cancelar o cambiar un correo programado

- **Ver qué hay en cola.** \`schedule_list\` devuelve los mensajes pendientes, del más próximo al más lejano, con destinatarios, asunto, hora de envío y estado. Puedes pedirlos de todos los buzones o de uno solo.
- **Cancelar.** La herramienta \`schedule\` con la acción \`cancel\` detiene un mensaje mientras siga pendiente. Una vez que el despachador ha empezado a enviarlo, ya no se puede cancelar.
- **Cambiar.** No hay edición. Pide al asistente que cancele el mensaje y programe el corregido; puede hacer las dos cosas en un mismo turno.
- **Los cambios en la firma se aplican.** La firma se añade en el momento del envío, así que el cambio que hagas después de programar es el que sale.

## Lo que la programación no hace

- **Responder dentro de un hilo.** Un correo programado es un mensaje nuevo con su propio asunto, así que no se agrupa como respuesta. Para una respuesta que pertenece a la conversación, pide al asistente que guarde un borrador de respuesta (\`draft\` con la acción \`reply\`) y envíalo tú cuando llegue el momento.
- **Usar un adjunto de otro correo.** El archivo tiene que ir incluido en la propia solicitud, 10 MB en total. Un envío inmediato puede adjuntar un archivo directamente desde un mensaje de tu buzón; uno programado, no.
- **Repetirse.** Cada correo programado sale una sola vez. Para un recordatorio semanal hay que programar cada envío.
- **Ser exacta al segundo.** La cola se revisa una vez por minuto.

Una solicitud de programación puede llevar una clave de idempotencia. Si el asistente la reintenta con la misma clave tras un corte de conexión, MCPEmails pone el mensaje en cola una vez, no dos. [Cómo evitar envíos de correo duplicados por IA](/blog/prevent-duplicate-ai-agent-email-sends) explica cómo.

## Dónde espera el mensaje

Casi todo lo que hace MCPEmails es en directo: el correo se lee de tu proveedor en cada solicitud y no se guarda. Un correo programado no puede funcionar así, porque tiene que existir en algún sitio hasta su hora de envío. MCPEmails lo guarda cifrado (AES-256-GCM) en su base de datos en Estocolmo, y solo lo descifra para enviarlo o para mostrar sus destinatarios y su asunto cuando listas tus envíos programados. Un mensaje cancelado nunca se envía. La [página de seguridad](/security) tiene los detalles.

## Preguntas frecuentes

**¿Puede Claude programar un correo para enviarlo más tarde?**
Sí, a través de un servidor MCP con una herramienta de envío programado. Conecta tu buzón a MCPEmails, añádelo a Claude como conector personalizado, concede la programación y pide a Claude que envíe el mensaje en una fecha, hora y zona horaria concretas. El conector de Gmail propio de Anthropic no menciona la programación.

**¿Puede ChatGPT programar un correo?**
Sí, de la misma forma: añade MCPEmails como conector MCP personalizado ([configuración](/docs/chatgpt)) y pídeselo. Las tareas programadas de ChatGPT ejecutan un prompt más tarde, que no es lo mismo que poner en cola un mensaje terminado.

**¿Tiene que seguir abierto Claude o ChatGPT hasta que salga el correo?**
No. El mensaje queda en cola en el servidor de MCPEmails y se envía desde allí. Puedes cerrar el chat, la app y el ordenador.

**¿Con qué proveedores de correo se puede programar?**
Con cualquier buzón desde el que MCPEmails pueda enviar: Gmail y Google Workspace, Outlook y Microsoft 365, iCloud, Fastmail, Yahoo, Zoho, Yandex y otros buzones IMAP y SMTP. El mensaje se envía a través del propio proveedor de ese buzón.

**¿Cómo cancelo un correo programado?**
Pide al asistente que lo cancele. Busca el mensaje con \`schedule_list\` y lo cancela por su id, algo que funciona hasta que empieza el envío.

## Siguiente paso

[Empieza gratis](/signup), conecta tu buzón y pide a Claude o ChatGPT que programe un correo de prueba para ti mismo dentro de cinco minutos. La [guía de Claude](/blog/connect-claude-to-email) y la [guía de ChatGPT](/blog/connect-chatgpt-to-email) cubren la conexión, y la [referencia de herramientas](/docs#tools) enumera todos los argumentos de programación.`,
};

export default translation;
