const translation = {
  title: 'Cómo conectar Gmail con Claude (en 2 minutos, sin código)',
  description:
    'Conecta Gmail con Claude a través de MCP en unos dos minutos: una contraseña de aplicación de Google (o Iniciar sesión con Google), una URL de endpoint, sin API key, sin código. Claude lee, busca y envía tu correo en directo, y tu correo nunca se almacena.',
  coverAlt: 'Cómo conectar Gmail con Claude en dos minutos a través de MCP: una contraseña de aplicación de Google, una URL de endpoint, sin correo almacenado',
  content: `Para conectar Gmail con Claude, haces dos cosas: conectas tu bandeja de Gmail una vez en el panel de MCP Emails con una contraseña de aplicación de Google y, después, pegas una única URL de endpoint en los ajustes de conectores de Claude y apruebas un inicio de sesión. Eso es todo: sin código, sin SDK, sin API key. Tarda unos dos minutos, y Claude nunca almacena tu correo: cada lectura y cada envío va a Gmail en directo y se descarta en cuanto Claude lo tiene.

Esta es la guía centrada exclusivamente en Gmail. Si gestionas varias bandejas o un proveedor que no es Gmail, la guía [conecta cualquier correo en menos de dos minutos](/blog/connect-email-to-ai-agent-under-2-minutes) cubre también Outlook, iCloud, Fastmail e IMAP.

## Lo que necesitarás

- Una cuenta de **Gmail o Google Workspace**.
- Una versión de **Claude que admita conectores personalizados**: claude.ai en un plan de pago, o Claude Desktop. (Los conectores son la forma en que Claude se comunica con los servidores MCP.)
- Una cuenta gratuita de **MCP Emails**. Sin tarjeta de crédito, una bandeja conectada para siempre. [Empieza gratis](/signup) y mantén esta pestaña abierta.

MCP Emails es el puente que está en medio: habla el Model Context Protocol con Claude por un lado y se comunica con Gmail por el otro, por IMAP de forma predeterminada o mediante la API de Gmail si inicias sesión con Google. Si quieres el contexto sobre lo que eso significa, consulta [qué es realmente un servidor de correo MCP](/blog/what-is-an-mcp-email-server).

## Paso 1: Conecta tu bandeja de Gmail

En el panel de MCP Emails, abre **Inboxes → Connect Inbox** y elige **Gmail**. Gmail se conecta de forma predeterminada con una contraseña de aplicación de Google:

1. Activa la verificación en dos pasos en tu cuenta de Google si aún no lo está. Google solo ofrece contraseñas de aplicación en las cuentas que la tienen.
2. Ve a **myaccount.google.com/apppasswords** y crea una. Son 16 letras minúsculas en cuatro grupos, y los espacios no importan.
3. De vuelta en MCP Emails, introduce tu dirección de Gmail completa, pega la contraseña de aplicación y haz clic en **Conectar bandeja de entrada**. La conexión se prueba con Gmail antes de guardarse. Listo.

Tu contraseña normal de Google nunca se usa. La contraseña de aplicación es una credencial aparte, MCP Emails la cifra con AES-256-GCM y puedes revocarla desde la misma página de Google cuando quieras. Por debajo, la bandeja se conecta por IMAP y SMTP (\`imap.gmail.com\`).

### ¿Prefieres iniciar sesión con Google?

La ventana de conexión ofrece también una segunda vía: abre **¿Prefieres iniciar sesión con Google?** y haz clic en **Conectar con Google**. Eliges tu cuenta en la propia página de Google y apruebas el acceso de lectura y envío. Antes, Google muestra una pantalla de advertencia, porque Google no ha verificado la aplicación. Para continuar, haz clic en **Advanced** y luego en **Go to mcpemails.com**.

### Qué vía elegir

Las dos vías siguen funcionando, y la elección decide lo que Claude puede hacer después:

- **Contraseña de aplicación (IMAP):** las etiquetas de Gmail aparecen como carpetas, la búsqueda usa la búsqueda de texto de IMAP y Claude puede copiar mensajes y eliminarlos de forma permanente.
- **Iniciar sesión con Google (API de Gmail):** Claude trabaja con etiquetas reales de Gmail y puede buscar con operadores de Gmail como \`from:\`, \`is:unread\` y \`after:\`. Eliminar mueve el correo a la papelera.

En una cuenta de Google Workspace, un administrador puede desactivar las contraseñas de aplicación en todo el dominio o bloquear las aplicaciones de terceros en la vía de inicio de sesión con Google. Si una vía está bloqueada, prueba la otra o pregunta a tu administrador.

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

- **Leer y buscar:** \`email_read\` (listar, leer, búsqueda de texto completo, con operadores de Gmail si conectaste con Iniciar sesión con Google).
- **Enviar y responder:** \`email_compose\` (enviar, responder, reenviar). Los mensajes salen a través de Gmail como correo normal desde tu propia dirección, de modo que la reputación de tu dominio sigue siendo tuya.
- **Organizar:** \`email_organize\` (mover, marcar, archivar, y etiquetas en la vía de inicio de sesión con Google).
- **Borradores, carpetas, programación y contactos:** \`draft\`, \`folder\`, \`schedule\` y \`contact_search\` completan el conjunto.

Una cosa que conviene esperar de entrada: MCP Emails funciona por sondeo (poll-based). No hay webhooks push, así que Claude reacciona al correo nuevo cuando le pides que lo revise, no en el instante en que llega un mensaje. Para casi cualquier flujo de trabajo de asistente, ese es exactamente el modelo adecuado.

## ¿Es seguro conectar Gmail con Claude?

Versión corta: sí, y el diseño está construido en torno a ello.

- **Tu correo nunca se almacena.** Los cuerpos, los asuntos y los adjuntos se obtienen en directo en cada llamada, se entregan a Claude y se descartan de inmediato. Lo único que se persiste por bandeja es la credencial cifrada: tu contraseña de aplicación, o el token OAuth si iniciaste sesión con Google. Aquí tienes [por qué que "el correo nunca se almacena" importa de verdad](/blog/why-email-never-stored-matters).
- **Tú controlas el alcance.** Aprueba solo lectura y Claude literalmente no puede enviar. Aprueba ambos y aun así puedes revocar cualquiera en cualquier momento.
- **Sin compartir contraseñas.** Tu contraseña normal de Google nunca llega a MCP Emails. Una contraseña de aplicación es una credencial aparte que puedes revocar en myaccount.google.com/apppasswords, Iniciar sesión con Google usa OAuth, y en ambos casos puedes desconectar la bandeja desde el panel.

El modelo de amenazas completo (qué está cifrado, qué vería y qué no vería un atacante) se expone en [¿es seguro dar a un agente de IA acceso al correo?](/blog/is-it-safe-to-give-ai-agent-email-access)

## Preguntas frecuentes

**¿Necesito una API key para conectar Gmail con Claude?**
No. Claude admite OAuth, así que pegas la URL del endpoint y apruebas un inicio de sesión. Las API keys son solo para clientes sin OAuth integrado.

**¿Claude almacena mis mensajes de Gmail?**
No. El correo se obtiene en directo desde Gmail en cada solicitud y se descarta justo después de que Claude lo lea. No se retiene nada salvo tu credencial cifrada (la contraseña de aplicación, o el token de acceso si iniciaste sesión con Google).

**¿Puede Claude enviar correo desde mi Gmail?**
Sí, si concedes el scope \`send:email\`. Los envíos salen a través de Gmail como mensajes normales desde tu propia cuenta. Concede solo lectura si prefieres que Claude no envíe nunca.

**¿Funciona con el plan gratuito de Claude?**
Los conectores personalizados requieren un plan de Claude que los admita (claude.ai de pago o Claude Desktop). La parte de MCP Emails es gratuita y sin tarjeta.

**¿Verá MCP Emails mi contraseña de Google?**
No. Pegas una contraseña de aplicación, una credencial aparte que genera Google y que puedes revocar, o inicias sesión con Google mediante OAuth. Tu contraseña normal de Google nunca se introduce en ningún lugar de MCP Emails.

## Conclusión

Eso es todo: una contraseña de aplicación de Google, una URL de endpoint, y Claude puede leer, buscar y enviar tu correo real, sin almacenarlo nunca. El nivel Gratis no cuesta nada, no necesita tarjeta y conecta una bandeja; Personal cuesta 5 $/mes y conecta hasta tres; Pro conecta todos los buzones que tengas (consulta [precios](/pricing)).

¿Listo? [Conecta tu Gmail gratis](/signup), pega el endpoint en Claude y pídele que te resuma el correo no leído.`,
};

export default translation;
