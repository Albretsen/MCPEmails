const translation = {
  title: 'Conecta Claude a tu correo con MCP (Gmail, iCloud e IMAP)',
  description:
    'Una guía práctica para conectar Claude a Gmail, iCloud, Fastmail, Yahoo, Zoho y cualquier buzón IMAP mediante MCP, sin código y sin almacenar correo.',
  coverAlt:
    'Conecta Claude a Gmail, iCloud, Fastmail, Yahoo, Zoho y correo IMAP con MCP Emails',
  content: `> **Outlook y Microsoft 365 están en desarrollo.** Todavía no se pueden conectar en producción. Esta guía cubre Gmail, iCloud, Fastmail, Yahoo, Zoho y otros buzones IMAP disponibles hoy.

Claude puede leer, buscar, organizar y enviar tu correo, pero necesita un servidor MCP para llegar a un buzón real. MCP Emails es ese puente: conecta un buzón una vez, añade un endpoint seguro a Claude y Claude obtiene el mismo conjunto de herramientas de correo con Gmail, iCloud, Fastmail, Yahoo, Zoho y otros proveedores IMAP.

No hay código que escribir, ningún SDK que instalar ni clave de API que usar cuando te conectas mediante el flujo OAuth de Claude. El correo se obtiene en tiempo real de tu proveedor para cada solicitud y MCP Emails no lo almacena.

**Ve a tu proveedor:** [Gmail](#gmail-y-google-workspace) · [iCloud](#icloud-mail) · [Fastmail](#fastmail) · [Yahoo, Zoho, Yandex o IMAP personalizado](#yahoo-zoho-yandex-e-imap-personalizado)

## Lo que necesitas

- Un **plan o aplicación de Claude compatible con conectores personalizados**.
- Una cuenta gratuita de **MCP Emails**: [créala aquí](/signup).
- Un buzón de correo. Gmail usa OAuth; iCloud, Fastmail, Yahoo, Zoho y la mayoría de los demás proveedores usan una contraseña específica de aplicación. La compatibilidad con Outlook está en desarrollo.

## Paso 1: Conecta tu buzón a MCP Emails

En el panel de MCP Emails, abre **Inboxes → Connect Inbox** y elige tu proveedor.

### Gmail y Google Workspace

Elige **Gmail**, inicia sesión con Google y aprueba el acceso. Tu contraseña de Google nunca se comparte con MCP Emails. Consulta la [guía específica de Gmail](/blog/connect-gmail-to-claude) si un administrador de Workspace controla el acceso a aplicaciones.

### iCloud Mail

Crea una contraseña específica de aplicación en tu cuenta de Apple, elige **iCloud** e introduce esa contraseña, no la normal de tu cuenta de Apple. La [guía de iCloud e IMAP](/blog/connect-icloud-fastmail-imap-to-claude) incluye los pasos exactos.

### Fastmail

Crea en Fastmail una contraseña de aplicación con acceso a Mail, elige **Fastmail** y pégala en MCP Emails. Consérvala hasta que la prueba de conexión termine correctamente.

### Yahoo, Zoho, Yandex e IMAP personalizado

Crea una contraseña de aplicación, elige **IMAP** e introduce la dirección y la contraseña. Los ajustes comunes se detectan automáticamente; los dominios personalizados pueden requerir el host, puerto y modo de seguridad IMAP/SMTP indicados por el proveedor.

Puedes conectar más de un buzón. Claude los descubre con \`inbox_list\`, así que no tienes que pegar identificadores de buzón en un prompt.

¿Necesitas ayuda para cada proveedor? Consulta la [configuración multidispositivo en dos minutos](/blog/connect-email-to-ai-agent-under-2-minutes), la [guía de Gmail](/blog/connect-gmail-to-claude) o la [guía de iCloud, Fastmail e IMAP](/blog/connect-icloud-fastmail-imap-to-claude).

## Paso 2: Añade MCP Emails a Claude

En claude.ai o Claude Desktop:

1. Abre **Settings → Connectors**.
2. Elige **Add custom connector**.
3. Pega esta URL:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Selecciona **Connect**, inicia sesión en MCP Emails y aprueba los permisos que quieras: \`read:email\`, \`send:email\` o ambos.

Ese es todo el proceso en Claude. OAuth limita la conexión a los permisos que aprobaste y puedes revocarla desde MCP Emails cuando quieras. Si usas un cliente sin OAuth, emplea una clave de API limitada; [OAuth frente a claves de API](/blog/oauth-vs-api-keys-ai-email-access) explica ese camino.

## Paso 3: Dale a Claude una primera tarea segura

Empieza con una solicitud de solo lectura:

> Resume mis tres correos no leídos más recientes y marca todo lo que necesite una respuesta hoy.

Claude primero encuentra el buzón conectado y después lista y lee los mensajes relevantes. Cuando funcione, prueba:

- «Busca la factura de Stripe del mes pasado y dime el importe.»
- «Redacta una respuesta al último mensaje de Alex, pero no la envíes.»
- «Muéstrame los boletines de esta semana que puedo archivar.»
- «¿Qué acordé en mi hilo con Acme?»

Para rutinas repetibles, usa la [guía de triaje de la bandeja de entrada](/blog/ai-agent-triage-summarize-inbox) o las [formas de dejar que Claude gestione tu bandeja](/blog/best-ways-to-let-claude-manage-your-inbox).

## Lo que Claude puede hacer después de conectarse

MCP Emails ofrece a Claude herramientas de correo concretas, no una contraseña ni una conexión IMAP en bruto:

- **Leer y buscar:** \`email_read\` enumera mensajes, lee mensajes completos y busca correo. Las búsquedas de Gmail también admiten operadores como \`from:\` e \`is:unread\`.
- **Enviar, responder y reenviar:** \`email_compose\` envía a través de tu propio proveedor y dirección.
- **Organizar:** \`email_organize\` mueve, etiqueta, marca y archiva mensajes.
- **Trabajar con borradores, carpetas, programación y contactos:** \`draft\`, \`folder\`, \`schedule\` y \`contact_search\` cubren el resto de un flujo práctico de correo.

MCP Emails funciona por sondeo: Claude comprueba el correo nuevo cuando se lo pides, en vez de recibir un evento push en el instante en que llega un mensaje.

## Solución de problemas de conexión y configuración de Claude

- **El proveedor rechaza la contraseña:** usa una contraseña de aplicación generada por el proveedor, no la contraseña con la que entras en la web. Regénérala después de activar la autenticación de dos factores si es necesario.
- **Una conexión IMAP personalizada agota el tiempo:** confirma el host, el puerto y el modo TLS. El puerto 993 suele usar TLS implícito; el 143 suele usar STARTTLS.
- **Claude se conecta pero no ve correo:** comprueba primero que el buzón esté activo en MCP Emails, vuelve a conectar Claude con **read:email** y pídele que llame a **inbox_list**.
- **Claude puede leer pero no enviar:** vuelve a conectarlo con **send:email** y verifica que la conexión admita SMTP o el envío nativo del proveedor.

Si sigues bloqueado, consulta la [matriz de proveedores](/docs/providers), abre la [guía de inicio](/docs#quickstart) y prueba una solicitud de solo lectura antes de activar el envío.

## ¿Es seguro conectar Claude al correo?

Sí, siempre que concedas solo el acceso necesario y mantengas a una persona implicada en las acciones salientes.

- **El correo no se almacena.** MCP Emails obtiene el contenido de cada mensaje en tiempo real y lo descarta tras entregarlo. La credencial cifrada necesaria para reconectar con tu proveedor es el único dato del buzón que se conserva.
- **Tu proveedor mantiene el control de autenticación.** Gmail usa OAuth, así que MCP Emails nunca recibe tu contraseña. Con proveedores IMAP, usa una contraseña específica de aplicación revocable en lugar de tu contraseña normal.
- **Los permisos son explícitos.** Da acceso de solo lectura si Claude no debe enviar nunca. Añade el permiso de envío solo cuando lo necesites y revócalo cuando quieras.

Trata el cuerpo de cada correo como una entrada no fiable. Pide a Claude que redacte antes de enviar, revisa los mensajes externos y no dejes que las instrucciones dentro de un correo anulen tu intención. La [guía de seguridad para el acceso al correo](/blog/is-it-safe-to-give-ai-agent-email-access) explica el modelo de amenazas con más detalle.

## Preguntas frecuentes

**¿Puede Claude conectarse a Gmail, Outlook o iCloud?**  
Gmail se conecta con OAuth e iCloud con una contraseña específica de aplicación. Outlook está en desarrollo y todavía no está disponible en producción. MCP Emails también admite Fastmail e IMAP genérico, lo que cubre servicios como Yahoo y Zoho.

**¿Necesito una clave de API?**  
No para el flujo de conector OAuth de Claude. Pega la URL del endpoint e inicia sesión. Las claves de API son para clientes MCP sin OAuth integrado.

**¿Puede Claude enviar correo?**  
Sí, si concedes \`send:email\`. Empieza con acceso de solo lectura o pide primero borradores si quieres una revisión humana.

**¿MCP Emails almacena mi buzón?**  
No. Los mensajes se leen en tiempo real de tu proveedor y se descartan. MCP Emails solo almacena la credencial cifrada necesaria para esas solicitudes en tiempo real.

## Siguiente paso

[Empieza gratis](/signup), conecta el buzón, añade \`https://mcpemails.com/api/mcp\` a Claude y pídele que resuma tu correo no leído. Consulta la [documentación](/docs) para ver la referencia completa de herramientas MCP y capacidades por proveedor.`,
};

export default translation;
