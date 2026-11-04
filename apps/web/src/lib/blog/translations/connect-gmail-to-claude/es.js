const translation = {
  title: 'Cómo conectar Claude con Gmail: conector propio o MCP',
  description:
    'Claude ya trae un conector de Gmail para una cuenta. Te contamos cuándo basta y cómo conectar Claude con Gmail por MCP en dos minutos si además usas Outlook, IMAP, varias bandejas u otras apps de IA.',
  coverAlt: 'Cómo conectar Gmail con Claude en dos minutos a través de MCP: una contraseña de aplicación de Google, una URL de endpoint, sin correo almacenado',
  content: `¿Cómo conectar Claude con Gmail? Si solo quieres una cuenta de Gmail dentro de Claude, lo más rápido es el conector de Gmail que Claude ya trae: actívalo en los ajustes de conectores de Claude y listo. MCPEmails tiene sentido cuando necesitas algo más: Outlook, iCloud, Yahoo o cualquier buzón IMAP junto a Gmail, varias bandejas en la misma conversación, o la misma bandeja en ChatGPT, Cursor y otras apps compatibles con MCP. El resto de esta guía explica cómo configurarlo.

Para conectar Claude con Gmail a través de MCPEmails, haces dos cosas: conectas tu bandeja de Gmail una vez en el panel de MCPEmails con una contraseña de aplicación de Google y, después, pegas una única URL de endpoint en los ajustes de conectores de Claude y apruebas un inicio de sesión. Eso es todo: sin código, sin SDK, sin clave de API. Tarda unos dos minutos, y Claude nunca almacena tu correo: cada lectura y cada envío va a Gmail en directo y se descarta en cuanto Claude lo tiene.

Esta es la guía centrada exclusivamente en Gmail. Si gestionas varias bandejas o un proveedor que no es Gmail, la guía [conecta cualquier correo en menos de dos minutos](/blog/connect-email-to-ai-agent-under-2-minutes) cubre también Outlook, iCloud, Fastmail e IMAP.

## Lo que necesitarás

- Una cuenta de **Gmail o Google Workspace**.
- **Claude** en la web (claude.ai) o en Claude Desktop. Todos los planes de Claude pueden añadir conectores personalizados, que son la forma en que Claude se comunica con los servidores MCP. El plan Free permite uno, y Pro y Max no tienen límite.
- Una cuenta gratuita de **MCPEmails**. Sin tarjeta de crédito, una bandeja conectada para siempre. [Empieza gratis](/signup) y mantén esta pestaña abierta.

MCPEmails es el puente que está en medio: habla el Model Context Protocol con Claude por un lado y se comunica con Gmail por el otro mediante IMAP y SMTP. Si quieres el contexto sobre lo que eso significa, consulta [qué es realmente un servidor de correo MCP](/blog/what-is-an-mcp-email-server).

## Paso 1: Conecta tu bandeja de Gmail

En el panel de MCPEmails, abre **Bandejas de entrada → Conectar bandeja** y elige **Gmail**. Gmail se conecta de forma predeterminada con una contraseña de aplicación de Google:

1. Activa la verificación en dos pasos en tu Cuenta de Google si aún no está activada. Google solo ofrece contraseñas de aplicación en las cuentas que la tienen.
2. Ve a **myaccount.google.com/apppasswords** y crea una. Son 16 letras minúsculas en cuatro grupos, y los espacios no importan.
3. De vuelta en MCPEmails, introduce tu dirección de Gmail completa, pega la contraseña de aplicación y haz clic en **Conectar bandeja**. La conexión se prueba con Gmail antes de guardarse. Listo.

Tu contraseña normal de Google nunca se usa. La contraseña de aplicación es una credencial aparte, MCPEmails la cifra con AES-256-GCM y puedes revocarla desde la misma página de Google cuando quieras. Por debajo, la bandeja se conecta por IMAP y SMTP (\`imap.gmail.com\`).

### En una cuenta de Google Workspace

Un administrador de Google Workspace puede desactivar las contraseñas de aplicación en todo el dominio. Si **myaccount.google.com/apppasswords** no está disponible para ti, pide a tu administrador que las active. La página de [ajustes y límites de Gmail](/connect/gmail) reúne en un solo sitio los detalles específicos de Gmail.

## Paso 2: Añade MCPEmails a Claude

Ahora apunta Claude al mismo endpoint. Como Claude es un cliente OAuth, no necesitas ninguna clave de API: pegas una URL y apruebas un inicio de sesión.

1. En **claude.ai o Claude Desktop**, abre **Customize → Connectors**.
2. Haz clic en **+ Add** y después en **Add custom connector**.
3. Llámalo MCPEmails y pega esto como la URL del conector:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Haz clic en **Continue**, revisa los ajustes de inicio de sesión que detectó Claude (los valores predeterminados sirven) y haz clic en **Add**.
5. Inicia sesión con tu cuenta de MCPEmails y aprueba los permisos que quieras: \`read:email\`, \`send:email\`, o ambos.
6. En un chat, haz clic en **+** abajo a la izquierda, elige **Connectors** y activa MCPEmails.

En un plan Team o Enterprise, un Owner añade el conector una vez en **Organization settings → Connectors**. Después, los miembros abren **Customize → Connectors**, buscan MCPEmails y hacen clic en **Connect**.

Eso es todo lo que hay del lado del cliente. La conexión queda limitada exactamente a lo que aprobaste, y puedes revocarla desde el panel con un solo clic. Si quieres entender la opción con clave de API (para clientes sin OAuth integrado, como Cline o un script personalizado), lee [OAuth frente a claves de API para el acceso de la IA al correo](/blog/oauth-vs-api-keys-ai-email-access). ¿También quieres conectar otra bandeja? La [configuración del correo en Claude paso a paso](/blog/connect-claude-to-email) cubre Outlook, iCloud, Fastmail e IMAP.

## Paso 3: Haz tu primera petición a Claude

Pruébalo con algo pequeño. Pídele a Claude:

> "Resume mis tres correos no leídos más recientes."

Entre bastidores, Claude llama a \`inbox_list\` para descubrir tu Gmail conectado y luego a \`email_read\` para listar y leer los mensajes. Si responde, tu conexión está activa. A partir de ahí, prueba:

- "Encuentra la factura de Stripe del mes pasado y dime el importe."
- "Redacta una respuesta educada al último correo de mi casero, pero no la envíes todavía."
- "Archiva todas las newsletters de mi bandeja de esta semana."
- "¿A qué me comprometí en mi hilo de correo con Acme?"

Para ir más allá (triaje diario, resúmenes automáticos y rutinas de limpieza), consulta [las mejores formas de dejar que Claude gestione tu bandeja](/blog/best-ways-to-let-claude-manage-your-inbox) y la [guía de triaje y resumen](/blog/ai-agent-triage-summarize-inbox).

## Qué puede hacer Claude con tu Gmail

Una vez conectado, Claude trabaja con un pequeño conjunto de herramientas consolidadas, así que puede hacer mucho más que leer:

- **Leer y buscar:** \`email_read\` (listar, leer y buscar por remitente, destinatario, asunto, estado de no leído o rango de fechas).
- **Enviar y responder:** \`email_compose\` (enviar, responder, reenviar). Los mensajes salen a través de Gmail como correo normal desde tu propia dirección, de modo que la reputación de tu dominio sigue siendo tuya.
- **Organizar:** \`email_organize\` (mover, copiar, marcar, archivar). Las etiquetas de Gmail aparecen como carpetas, así que un mensaje con varias etiquetas aparece en varias carpetas, moverlo cambia sus etiquetas y archivarlo lo quita de la bandeja de entrada.
- **Borradores, carpetas, programación y contactos:** \`draft\`, \`folder\`, \`schedule\` y \`contact_search\` completan el conjunto.

Claude también tiene un conector de Gmail propio, y también puede enviar. [¿Puede Claude leer tu correo y enviar emails?](/blog/can-claude-read-my-email) lo compara con MCPEmails, buzón por buzón.

Conviene saberlo de entrada: MCPEmails funciona por sondeo. No hay webhooks push, así que Claude reacciona al correo nuevo cuando le pides que lo revise, no en el instante en que llega un mensaje. Para casi cualquier flujo de trabajo de asistente, ese es exactamente el modelo adecuado.

## ¿Es seguro conectar Gmail con Claude?

Versión corta: sí, y el diseño está construido en torno a ello.

- **Tu correo nunca se almacena.** Los cuerpos, los asuntos y los adjuntos se obtienen en directo en cada llamada, se entregan a Claude y se descartan de inmediato. Por cada bandeja se guarda la credencial cifrada, tu contraseña de aplicación, además de los pocos datos que necesita una función que actives, como un mensaje programado que espera a enviarse. Aquí tienes [por qué importa de verdad que "el correo nunca se almacena"](/blog/why-email-never-stored-matters).
- **Tú controlas el alcance.** Aprueba solo lectura y Claude literalmente no puede enviar. Aprueba ambos y aun así podrás revocar cualquiera de los dos en cualquier momento.
- **Sin compartir contraseñas.** Tu contraseña normal de Google nunca llega a MCPEmails. Una contraseña de aplicación es una credencial aparte que puedes revocar en myaccount.google.com/apppasswords cuando quieras, o puedes eliminar la bandeja en MCPEmails.

El modelo de amenazas completo (qué está cifrado, qué vería y qué no vería un atacante) se expone en [¿es seguro dar a un agente de IA acceso al correo?](/blog/is-it-safe-to-give-ai-agent-email-access)

## Preguntas frecuentes

**¿Necesito una clave de API para conectar Gmail con Claude?**
No. Claude admite OAuth, así que pegas la URL del endpoint y apruebas un inicio de sesión. Las claves de API son solo para clientes sin OAuth integrado.

**¿Claude almacena mis mensajes de Gmail?**
No. El correo se obtiene en directo desde Gmail en cada solicitud y se descarta justo después de que Claude lo lea. No se retiene nada del correo que lee Claude; lo que se guarda es tu credencial cifrada (la contraseña de aplicación).

**¿Puede Claude enviar correo desde mi Gmail?**
Sí, si concedes el permiso \`send:email\`. Los envíos salen a través de Gmail como mensajes normales desde tu propia cuenta. Concede solo lectura si prefieres que Claude no envíe nunca.

**¿Funciona con el plan gratuito de Claude?**
Sí. El plan Free de Claude permite añadir un conector personalizado, suficiente para MCPEmails, y Pro y Max no tienen límite. La parte de MCPEmails es gratuita y sin tarjeta.

**¿Verá MCPEmails mi contraseña de Google?**
No. Pegas una contraseña de aplicación, una credencial aparte que genera Google y que puedes revocar cuando quieras. Tu contraseña normal de Google nunca se introduce en ningún lugar de MCPEmails.

## Conclusión

Eso es todo: una contraseña de aplicación de Google, una URL de endpoint, y Claude puede leer, buscar y enviar tu correo real, sin almacenarlo nunca. El plan Gratis no cuesta nada, no necesita tarjeta y conecta una bandeja; Personal cuesta $9/mes y conecta hasta tres; Pro conecta hasta 10 (consulta [precios](/pricing)).

¿Listo? [Conecta tu Gmail gratis](/signup), pega el endpoint en Claude y pídele que te resuma el correo no leído.`,
};

export default translation;
