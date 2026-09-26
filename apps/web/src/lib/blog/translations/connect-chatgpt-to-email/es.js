const translation = {
  title: 'Conecta ChatGPT a tu correo con MCP (Gmail, Outlook, iCloud e IMAP)',
  description:
    'Paso a paso: conecta Gmail, Outlook, iCloud, Fastmail o cualquier buzón IMAP a ChatGPT con un conector MCP, y a OpenAI Codex con una clave limitada. Sin almacenar correo.',
  coverAlt:
    'Conecta ChatGPT y OpenAI Codex a Gmail, Outlook, iCloud, Fastmail y correo IMAP con MCP Emails',
  content: `ChatGPT no puede llegar a un buzón por su cuenta. Necesita un servidor MCP delante de tu correo, y MCP Emails es ese servidor: conecta un buzón una vez, apunta ChatGPT a una sola URL y obtendrás las mismas herramientas de correo tanto si el buzón está en Gmail, Outlook o Microsoft 365, iCloud, Fastmail, Yahoo, Zoho o un servidor IMAP propio.

Aquí intervienen dos superficies de OpenAI que se autentican de forma distinta. ChatGPT ejecuta un flujo OAuth en el navegador, así que no hay ninguna clave de API que pegar. OpenAI Codex se ejecuta en tu terminal y usa una clave limitada como token bearer. Mismo endpoint, mismas herramientas.

**Ir a:** [Configuración de ChatGPT](#paso-2-agrega-el-conector-en-chatgpt) · [OpenAI Codex](#openai-codex-en-la-terminal) · [Problemas comunes](#problemas-comunes)

## Lo que necesitas

- **ChatGPT Plus, Pro, Business, Enterprise o Edu, en la web.** Los conectores MCP personalizados están detrás del modo de desarrollador, que OpenAI ofrece en chatgpt.com para esos planes. Las cuentas Free y Go no pueden añadir uno, y las apps de móvil y escritorio no muestran la opción. En Business y Enterprise, puede que un administrador tenga que permitir antes el modo de desarrollador.
- **Una cuenta gratuita de MCP Emails.** [Créala aquí](/signup). El plan gratuito admite un buzón conectado y no pide tarjeta.
- **Un buzón.** Gmail, Outlook o Microsoft 365, iCloud, Fastmail, Yahoo, Zoho, Yandex o cualquier servicio que hable IMAP y SMTP.

Si estás en Free o Go, la misma bandeja y la misma URL ya funcionan en [Claude](/docs/claude), [Cursor](/docs/cursor), [VS Code](/docs/vscode) y los demás [clientes compatibles](/docs/clients).

## Paso 1: Conecta tu buzón a MCP Emails

En el panel de MCP Emails, abre **Inboxes**, luego **Connect Inbox**, y elige tu proveedor.

### Gmail y Google Workspace

Gmail se conecta de forma predeterminada con una contraseña de aplicación de Google sobre IMAP, y también está disponible el inicio de sesión con OAuth de Google. Usa la contraseña de aplicación si un administrador de Workspace restringe el acceso de aplicaciones de terceros. La [guía de Gmail](/blog/connect-gmail-to-claude) tiene los pasos.

### iCloud, Fastmail, Yahoo y Zoho

Estos proveedores piden una contraseña específica de aplicación, no la que escribes en la web. Créala en el proveedor, elige el proveedor en MCP Emails y pégala. La [guía de iCloud, Fastmail e IMAP](/blog/connect-icloud-fastmail-imap-to-claude) tiene los pasos exactos.

### Outlook y Microsoft 365

Outlook se conecta con Iniciar sesión con Microsoft, no con una contraseña de aplicación: elige **Outlook**, haz clic en **Conectar con Microsoft** y aprueba. Las cuentas personales de Outlook.com, Hotmail, Live y MSN se conectan directamente. Las cuentas de trabajo o educativas de Microsoft 365 pueden necesitar antes que un administrador de TI apruebe la aplicación una sola vez para toda la organización; el panel te da un enlace para enviárselo. La [guía de Outlook y Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp) tiene los detalles.

### Cualquier otro buzón IMAP

Elige **IMAP** e introduce la dirección y la contraseña de aplicación. Los ajustes habituales se detectan automáticamente; un dominio personalizado puede requerir el host, el puerto y el modo de seguridad de tu proveedor. La [matriz de proveedores](/docs/providers) indica qué admite cada uno, y hay una página por proveedor en [connect](/connect), incluidas [Gmail](/connect/gmail), [Outlook](/connect/outlook), [Microsoft 365](/connect/office365), [iCloud](/connect/icloud) e [IMAP genérico](/connect/imap).

Conecta más de un buzón si tu plan lo permite. ChatGPT los descubre con \`inbox_list\`, así que nunca pegas un identificador de buzón en un prompt.

## Paso 2: Agrega el conector en ChatGPT

1. Activa el **modo de desarrollador** en los ajustes de ChatGPT, dentro de la configuración avanzada de aplicaciones y conectores.
2. Crea un conector nuevo y ponle un nombre.
3. Pega esta URL del conector:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Elige **OAuth** como método de autenticación, crea el conector y autoriza con MCP Emails.
5. Abre un chat nuevo, haz clic en **+**, elige **Developer mode** y selecciona la app de MCP Emails. ChatGPT solo ve las herramientas en un chat donde lo hayas hecho, así que repítelo en cada conversación nueva.

Elige OAuth, no la opción sin autenticación. Este servidor rechaza las llamadas anónimas, así que un conector creado sin autenticación parece correcto durante la configuración y falla en su primera llamada a una herramienta, que es el orden más confuso posible. Con OAuth, ChatGPT se registra solo y completa un flujo de código de autorización con PKCE: no hay ningún client id que crear ni ningún secreto en ninguna parte. La redacción de los menús cambia mientras OpenAI itera sobre la beta, así que consulta la [página de configuración de ChatGPT](/docs/chatgpt) para ver la ruta actual.

## Paso 3: Aprueba solo los permisos necesarios

La pantalla de consentimiento es nuestra, no de OpenAI. El primer consentimiento empieza en \`read:email\`, que basta para triar, resumir y encontrar cosas, y deja fuera toda acción irreversible mientras decides hasta dónde quieres llegar. Los demás permisos son \`send:email\`, \`search:email\` y \`manage:automations\`.

Conceder de menos tiene arreglo: una llamada que necesita un permiso que el token no tiene devuelve un 403 con un error de permiso insuficiente, así que el cliente puede volver a pedir ese permiso y reintentar. El propietario del buzón también puede exigir [aprobación humana](/blog/approve-ai-agent-email-sends) en el panel, lo que retiene cada envío, respuesta, reenvío, envío de borrador y envío programado hasta que una persona lo libera.

## Paso 4: Dale a ChatGPT una primera tarea segura

Empieza en modo de solo lectura:

> Resume mis tres correos no leídos más recientes y marca todo lo que necesite respuesta hoy. No envíes, muevas ni elimines nada.

ChatGPT encuentra primero el buzón y después lee solo los mensajes que necesita. Cuando eso funcione, prueba:

- «Busca la factura de Stripe del mes pasado y dime el importe.»
- «Redacta una respuesta al último mensaje de Alex, pero déjala como borrador.»
- «Muéstrame los boletines de esta semana que podría archivar y espera mi confirmación.»

Para rutinas repetibles, empieza por la [guía de triaje de la bandeja de entrada](/blog/ai-agent-triage-summarize-inbox) o la [colección de prompts de flujo de trabajo](/blog/ai-agent-email-workflows-and-prompts).

## Lo que ChatGPT puede hacer una vez conectado

MCP Emails entrega a ChatGPT herramientas concretas en vez de una contraseña o una conexión IMAP en bruto:

- **Leer y buscar:** \`email_read\` cubre list, read, read_batch, search y attachment. Las búsquedas de Gmail admiten operadores como \`from:\` e \`is:unread\`.
- **Enviar, responder y reenviar:** \`email_compose\` envía a través de tu propio proveedor y tu propia dirección.
- **Organizar:** \`email_organize\`, \`email_search_and_move\` y \`email_delete\`.
- **Borradores, carpetas y programación:** \`draft\`, \`draft_list\`, \`folder\`, \`folder_list\`, \`schedule\` y \`schedule_list\`.
- **El resto:** \`contact_search\`, \`signature_get\`, \`signature_set\`, además de \`automation\` y \`automation_read\` para reglas recurrentes.

Un límite que conviene tener en cuenta: MCP Emails funciona por sondeo. No hay webhooks ni eventos iniciados por el servidor, así que ChatGPT comprueba el correo nuevo cuando se lo pides, no en el instante en que llega un mensaje.

## OpenAI Codex en la terminal

Codex es una superficie distinta de los conectores de ChatGPT, y ahí el flujo OAuth del navegador no es el camino. Un cliente de terminal se autentica con un token bearer:

1. En el panel, abre **API Keys** y crea una clave marcando solo los permisos que ese agente necesita.
2. Cópiala de inmediato. La clave empieza por \`mcpe_\` seguido de 64 caracteres hexadecimales y solo se muestra una vez.
3. Registra \`https://mcpemails.com/api/mcp\` como servidor MCP por HTTP en la configuración MCP del propio Codex, pasando la clave en una cabecera \`Authorization: Bearer\`.

Las conexiones con clave y las conexiones OAuth llegan al mismo endpoint y ven el mismo catálogo de herramientas. La única diferencia es de dónde salió el token. Para comprobar antes el endpoint, la [guía de HTTP en bruto](/docs/curl) incluye una llamada \`tools/list\` de una línea, y [OAuth frente a claves de API](/blog/oauth-vs-api-keys-ai-email-access) explica cuándo conviene cada camino.

Limita bien la clave. Solo lectura suele ser lo correcto para un agente de programación: uno que puede resumir un hilo de soporte es útil, y uno que puede enviar correo sin supervisión es otra categoría de riesgo.

## Problemas comunes

- **No aparece la opción de crear un conector personalizado.** El modo de desarrollador requiere Plus, Pro, Business, Enterprise o Edu, en chatgpt.com desde un navegador. Las cuentas Free y Go no lo tienen. En un espacio Business o Enterprise, un administrador tiene que permitirlo.
- **El conector falla en su primera llamada a una herramienta.** Probablemente se creó sin autenticación. Bórralo y vuelve a crearlo con OAuth.
- **El conector está creado, pero ChatGPT responde sin tocar tu correo.** No está activado en este chat. Haz clic en **+**, elige **Developer mode**, selecciona la app de MCP Emails y vuelve a preguntar.
- **El proveedor rechaza tu contraseña.** Usa una contraseña de aplicación generada por el proveedor, no la de inicio de sesión web. Algunos proveedores solo la emiten con la verificación en dos pasos activada.
- **Una conexión IMAP personalizada agota el tiempo.** Confirma el host, el puerto y el modo TLS. El puerto 993 suele usar TLS implícito; el 143 suele usar STARTTLS.
- **ChatGPT se conecta pero no ve correo.** Comprueba que el buzón esté activo en el panel, confirma que la conexión tiene \`read:email\` y pide a ChatGPT que llame primero a \`inbox_list\`.

## Preguntas frecuentes

**¿Puede ChatGPT leer y enviar mi correo?**
Con un conector MCP personalizado, sí: leer, buscar, enviar, responder, reenviar, organizar y programar, siempre limitado a los permisos que apruebes durante la configuración.

**¿Necesito una clave de API para ChatGPT?**
No. Elige OAuth y ChatGPT se registra solo y completa el flujo. Las claves de API son para clientes que no pueden ejecutar un flujo de navegador, como Codex y los scripts.

**¿Codex se configura igual?**
No. Codex es una superficie de terminal, así que usa una clave de API limitada en una cabecera \`Authorization: Bearer\` en lugar del flujo OAuth del navegador. Mismo endpoint, mismas herramientas.

**¿Se almacena mi correo en vuestros servidores?**
No. Cada mensaje se obtiene en tiempo real de tu proveedor para la petición que lo pidió y después se descarta. Solo se conserva la credencial cifrada del proveedor. [Por qué importa no almacenar correo](/blog/why-email-never-stored-matters) explica el razonamiento.

**¿Cuánto cuesta?**
El plan gratuito incluye un buzón conectado y 150 acciones de correo facturables por mes natural UTC, con los primeros 7 días sin contar. Ese límite mensual se aplica a los espacios de trabajo creados a partir del 2026-09-13; los creados antes están exentos. Los planes de pago añaden buzones y quitan el límite: consulta [precios](/pricing).

## Siguiente paso

[Empieza gratis](/signup), conecta un buzón, añade \`https://mcpemails.com/api/mcp\` a ChatGPT y pídele que resuma tu correo no leído. La [página de configuración de ChatGPT](/docs/chatgpt) tiene la ruta actual; la [documentación](/docs) tiene la referencia completa de herramientas.`,
};

export default translation;
