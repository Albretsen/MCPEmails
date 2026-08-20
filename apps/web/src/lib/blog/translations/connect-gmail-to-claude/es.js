export default {
  title: 'Cómo conectar Gmail con Claude (en 2 minutos, sin código)',
  description:
    'Conecta Gmail con Claude a través de MCP en unos dos minutos: un inicio de sesión de Google, una URL de endpoint, sin API key, sin código. Claude lee, busca y envía tu correo en directo, y tu correo nunca se almacena.',
  coverAlt: 'Cómo conectar Gmail con Claude en dos minutos a través de MCP: un inicio de sesión de Google, una URL de endpoint, sin correo almacenado',
  content: `Para conectar Gmail con Claude, haces dos cosas: conectas tu bandeja de Gmail una vez en el panel de MCP Emails y, después, pegas una única URL de endpoint en los ajustes de conectores de Claude y apruebas un inicio de sesión. Eso es todo: sin código, sin SDK, sin API key. Tarda unos dos minutos, y Claude nunca almacena tu correo: cada lectura y cada envío golpea la API de Gmail en directo y se descarta en cuanto Claude lo tiene.

Esta es la guía centrada exclusivamente en Gmail. Si gestionas varias bandejas o un proveedor que no es Gmail, la guía [conecta cualquier correo en menos de dos minutos](/blog/connect-email-to-ai-agent-under-2-minutes) cubre también Outlook, iCloud, Fastmail e IMAP.

## Lo que necesitarás

- Una cuenta de **Gmail o Google Workspace**.
- Una versión de **Claude que admita conectores personalizados**: claude.ai en un plan de pago, o Claude Desktop. (Los conectores son la forma en que Claude se comunica con los servidores MCP.)
- Una cuenta gratuita de **MCP Emails**. Sin tarjeta de crédito, una bandeja conectada para siempre. [Empieza gratis](/signup) y mantén esta pestaña abierta.

MCP Emails es el puente que está en medio: habla el Model Context Protocol con Claude por un lado y la API de Gmail con Google por el otro. Si quieres el contexto sobre lo que eso significa, consulta [qué es realmente un servidor de correo MCP](/blog/what-is-an-mcp-email-server).

## Paso 1: Conecta tu bandeja de Gmail

En el panel de MCP Emails, abre **Inboxes → Connect Inbox → Gmail** y haz clic en **Connect with Google**.

1. Se te envía al inicio de sesión normal de Google. Elige la cuenta que quieres que use Claude.
2. Aprueba el acceso de lectura y envío en la pantalla de consentimiento de Google.
3. Vuelves al panel con la bandeja conectada. Listo.

Nunca cambia de manos ninguna contraseña. MCP Emails recibe un token OAuth de Google, lo cifra con AES-256-GCM y llama directamente a la API de Gmail en cada solicitud. Como usa la propia API de Gmail, las búsquedas de tu agente pueden emplear operadores nativos como \`from:\`, \`is:unread\` y \`after:\`, de modo que Claude puede ser preciso en lugar de adivinar.

> Una nota sincera: mientras MCP Emails completa la revisión de seguridad de Google, el flujo de consentimiento puede mostrar una pantalla que dice "Google hasn't verified this app". Para continuar, haz clic en **Advanced** y luego en **Go to mcpemails.com**. Esta pantalla desaparece una vez completada la verificación.

## Paso 2: Añade MCP Emails a Claude

Ahora apunta Claude al mismo endpoint. Como Claude es un cliente OAuth, no necesitas ninguna API key en absoluto: pegas una URL y apruebas un inicio de sesión.

1. En **claude.ai o Claude Desktop**, abre **Settings → Connectors**.
2. Haz clic en **Add custom connector**.
3. Pega esto como la URL del conector y luego haz clic en **Add**:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Haz clic en **Connect**, inicia sesión con tu cuenta de MCP Emails y aprueba los scopes que quieras: \`read:email\`, \`send:email\`, o ambos.

Eso es todo lo que hay del lado del cliente. La conexión queda limitada exactamente a lo que aprobaste, y puedes revocarla desde el panel con un solo clic. Si prefieres entender la ruta con API key (para clientes sin OAuth integrado, como Cline o un script personalizado), lee [OAuth frente a API keys para el acceso de la IA al correo](/blog/oauth-vs-api-keys-ai-email-access).

## Paso 3: Pídele a Claude tu primer prompt

Pruébalo con algo pequeño. Pídele a Claude:

> "Resume mis tres correos no leídos más recientes."

Entre bastidores, Claude llama a \`inbox_list\` para descubrir tu Gmail conectado y luego a \`email_read\` para listar y leer los mensajes. Si responde, tu conexión está activa. A partir de ahí, prueba:

- "Encuentra la factura de Stripe del mes pasado y dime el importe."
- "Redacta una respuesta educada al último correo de mi casero, pero no lo envíes todavía."
- "Archiva todas las newsletters de mi bandeja de esta semana."
- "¿A qué me comprometí en mi hilo de correo con Acme?"

Para un conjunto más profundo de patrones (triaje diario, resúmenes automáticos y rutinas de limpieza), consulta [las mejores formas de dejar que Claude gestione tu bandeja](/blog/best-ways-to-let-claude-manage-your-inbox) y la [guía de triaje y resumen](/blog/ai-agent-triage-summarize-inbox).

## Qué puede hacer Claude con tu Gmail

Una vez conectado, Claude trabaja con un pequeño conjunto de herramientas consolidadas, así que puede hacer mucho más que leer:

- **Leer y buscar** — \`email_read\` (listar, leer, búsqueda de texto completo con operadores de Gmail).
- **Enviar y responder** — \`email_compose\` (enviar, responder, reenviar): los mensajes salen a través de Gmail como correo normal desde tu propia dirección, de modo que la reputación de tu dominio sigue siendo tuya.
- **Organizar** — \`email_organize\` (mover, etiquetar, marcar, archivar).
- **Borradores, carpetas, programación y contactos** — \`draft\`, \`folder\`, \`schedule\` y \`contact_search\` completan el conjunto.

Una cosa que conviene esperar de entrada: MCP Emails funciona por sondeo (poll-based). No hay webhooks push, así que Claude reacciona al correo nuevo cuando le pides que lo revise, no en el instante en que llega un mensaje. Para casi cualquier flujo de trabajo de asistente, ese es exactamente el modelo adecuado.

## ¿Es seguro conectar Gmail con Claude?

Versión corta: sí, y el diseño está construido en torno a ello.

- **Tu correo nunca se almacena.** Los cuerpos, los asuntos y los adjuntos se obtienen en directo en cada llamada, se entregan a Claude y se descartan de inmediato. Lo único que se persiste por bandeja es tu token OAuth cifrado. Aquí tienes [por qué que "el correo nunca se almacena" importa de verdad](/blog/why-email-never-stored-matters).
- **Tú controlas el alcance.** Aprueba solo lectura y Claude literalmente no puede enviar. Aprueba ambos y aun así puedes revocar cualquiera en cualquier momento.
- **Sin compartir contraseñas.** Gmail usa OAuth, así que MCP Emails nunca ve tu contraseña de Google, y también puedes desconectarlo desde los ajustes de tu cuenta de Google.

El modelo de amenazas completo (qué está cifrado, qué vería y qué no vería un atacante) se expone en [¿es seguro dar a un agente de IA acceso al correo?](/blog/is-it-safe-to-give-ai-agent-email-access)

## Preguntas frecuentes

**¿Necesito una API key para conectar Gmail con Claude?**
No. Claude admite OAuth, así que pegas la URL del endpoint y apruebas un inicio de sesión. Las API keys son solo para clientes sin OAuth integrado.

**¿Claude almacena mis mensajes de Gmail?**
No. El correo se obtiene en directo desde la API de Gmail en cada solicitud y se descarta justo después de que Claude lo lea. No se retiene nada salvo tu token de acceso cifrado.

**¿Puede Claude enviar correo desde mi Gmail?**
Sí, si concedes el scope \`send:email\`. Los envíos pasan por la API de Gmail como mensajes normales desde tu propia cuenta. Concede solo lectura si prefieres que Claude no envíe nunca.

**¿Funciona con el plan gratuito de Claude?**
Los conectores personalizados requieren un plan de Claude que los admita (claude.ai de pago o Claude Desktop). La parte de MCP Emails es gratuita y sin tarjeta.

**¿Verá MCP Emails mi contraseña de Google?**
No. La conexión con Gmail usa Google OAuth, así que tu contraseña nunca sale de Google.

## Conclusión

Eso es todo: un inicio de sesión de Google, una URL de endpoint, y Claude puede leer, buscar y enviar tu correo real, sin almacenarlo nunca. El nivel Gratis no cuesta nada, no necesita tarjeta y conecta una bandeja; Pro conecta todos los buzones que tengas (consulta [precios](/pricing)).

¿Listo? [Conecta tu Gmail gratis](/signup), pega el endpoint en Claude y pídele que te resuma el correo no leído.`,
};
