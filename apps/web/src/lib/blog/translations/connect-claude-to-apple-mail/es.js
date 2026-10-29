// Spanish UI labels checked on 2026-10-20 against Apple's es-es support pages
// (102654, 102619, guide/mail/mail35803) and against messages/es for the
// MCPEmails dashboard and consent screen. Claude's own labels stay in English,
// as in the other es posts.
const translation = {
  title: 'Conectar Claude con Apple Mail: iCloud, Gmail, Outlook y Yahoo',
  description:
    'Conecta Claude con las cuentas de Apple Mail (iCloud, Gmail, Outlook.com, Yahoo, IMAP) para leer, buscar, redactar y enviar correo desde cualquier dispositivo, incluido el iPhone.',
  coverAlt: 'Las cuentas de iCloud, Gmail, Outlook y Yahoo de Apple Mail conectadas a Claude a través de MCP',
  content: `Para conectar Claude con Apple Mail no se conecta la app Mail, sino las cuentas de correo que aparecen en ella. Apple Mail es un cliente: sincroniza una cuenta de iCloud, Gmail, Outlook.com, Yahoo u otra cuenta IMAP desde los servidores de ese proveedor. MCPEmails conecta Claude a esas mismas cuentas desde el lado del servidor, así que Claude ve la misma bandeja de entrada, las mismas carpetas, los mismos borradores y el mismo correo enviado que Apple Mail, y funciona desde claude.ai, Claude Desktop y la app de Claude en tu iPhone. No hace falta que tu Mac esté encendido.

## ¿Se puede conectar Claude con Apple Mail?

Sí, a través de las cuentas que contiene. Apple Mail no tiene una conexión propia en la que Claude pueda iniciar sesión, así que la vía fiable es esta:

1. Comprueba qué cuentas usa Apple Mail.
2. Conecta cada cuenta a MCPEmails, un servidor MCP alojado.
3. Añade MCPEmails a Claude como conector personalizado con una sola URL.

A partir de ahí, Claude puede leer, buscar, redactar, enviar, programar y organizar el correo de cada cuenta conectada, dentro del acceso que le concedas. Los cambios aparecen en Apple Mail, en tu Mac y en tu iPhone, la próxima vez que sincronice, porque los dos miran el mismo buzón.

## Por qué conectar la cuenta y no la app Mail

Los servidores MCP para Apple Mail que encontrarás en GitHub se ejecutan en tu Mac y trabajan a través de la propia app Mail, con AppleScript o leyendo el índice local de Mail. Funcionan, pero con límites que vienen del propio diseño:

- Solo funcionan en un Mac, con el servidor instalado y Mail disponible.
- Claude en tu iPhone, en un PC con Windows o en la web no puede llegar a ellos, porque la conexión vive en ese único Mac.
- Si el Mac está en reposo o cerrado, el servidor no responde.

Un conector personalizado en Claude funciona al revés. El centro de ayuda de Anthropic indica que la conexión con un servidor MCP sale de los servidores de Anthropic, no de tu dispositivo, en todos los clientes de Claude, incluidas las apps móviles. Una conexión a tu cuenta de correo desde el servidor encaja con ese modelo: no hay nada que instalar y el mismo conector funciona allí donde abras Claude.

## Paso 1: Mira qué cuentas usa Apple Mail

- **En un Mac:** en Mail, elige **Mail → Ajustes** y haz clic en **Cuentas**.
- **En el iPhone o el iPad:** abre **Ajustes → Apps → Mail → Cuentas de Mail**.

Cada cuenta de esa lista se conecta a MCPEmails de una de estas formas:

- **iCloud** (@icloud.com, @me.com, @mac.com): una contraseña específica para apps de Apple. Los ajustes están en la [página de iCloud](/connect/icloud).
- **Google**: una contraseña de aplicación de Google. Los ajustes están en la [página de Gmail](/connect/gmail).
- **Outlook.com, Hotmail, Live o Microsoft 365**: Iniciar sesión con Microsoft. Una cuenta del trabajo o de un centro educativo puede necesitar que tu administrador de TI apruebe MCPEmails una vez. Los detalles están en la [página de Outlook](/connect/outlook).
- **Yahoo**: una contraseña de aplicación de Yahoo. Los ajustes están en la [página de Yahoo Mail](/connect/yahoo).
- **Otra (IMAP)**: los ajustes IMAP y SMTP de tu proveedor. Consulta la [página de IMAP personalizado](/connect/imap).

Si tu proveedor no está en esta lista, [cada proveedor compatible](/connect) tiene su propia página con los ajustes del servidor.

## Paso 2: Conecta cada cuenta a MCPEmails

Crea una [cuenta de MCPEmails](/signup) gratuita, abre el panel, ve a **Bandejas de entrada → Conectar bandeja** y elige el proveedor.

### iCloud Mail

Apple no acepta la contraseña de tu cuenta de Apple desde otras apps. Necesitas una contraseña específica para apps:

1. Inicia sesión en [account.apple.com](https://account.apple.com).
2. En **Inicio de sesión y seguridad**, selecciona **Contraseñas específicas para apps**.
3. Selecciona **Generar una contraseña específica para la app**, ponle el nombre \`MCPEmails\` y copia la contraseña que te muestra Apple.
4. En MCPEmails, elige **iCloud**, introduce tu dirección de iCloud y pega esa contraseña.

Para esto, tu cuenta de Apple necesita la autenticación de doble factor. Algo que conviene saber: si cambias la contraseña de tu cuenta de Apple, se revocan todas las contraseñas específicas para apps, así que después de un cambio de contraseña tendrás que generar una nueva y volver a conectar. La [guía de iCloud, Fastmail e IMAP](/blog/connect-icloud-fastmail-imap-to-claude) lo explica con más detalle.

### Gmail

Apple Mail inicia sesión en Google con tu cuenta de Google. MCPEmails usa en su lugar una contraseña de aplicación de Google por IMAP, que Google ofrece cuando tienes activada la verificación en dos pasos. Elige **Gmail** y pega la contraseña de 16 letras junto con tu dirección. La [guía de Gmail](/blog/connect-gmail-to-claude) explica qué hacer con las cuentas de Workspace en las que un administrador ha desactivado las contraseñas de aplicación.

### Outlook.com, Hotmail y Microsoft 365

Elige **Outlook** y haz clic en **Conectar con Microsoft**. No hay ninguna contraseña que pegar.

### Yahoo y otras cuentas IMAP

Crea una contraseña de aplicación en tu proveedor, elige **Yahoo** o **IMAP / SMTP** e introduce la dirección y la contraseña. En los proveedores habituales, los ajustes del servidor se rellenan solos a partir de la dirección.

Conecta cada cuenta de Apple Mail a la que quieras que llegue Claude; cuántas bandejas puedes añadir depende de tu [plan](/pricing). Claude las encuentra con \`inbox_list\`, así que nunca tienes que pegar un ID de cuenta en un prompt.

## Paso 3: Añade MCPEmails a Claude

En claude.ai o en Claude Desktop:

1. Abre **Customize → Connectors**.
2. Haz clic en **+ Add** y luego en **Add custom connector**.
3. Escribe un nombre, por ejemplo \`MCPEmails\`, y pega la URL del conector:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Sigue los pasos y haz clic en **Add**. Después haz clic en **Connect**, inicia sesión en MCPEmails y elige cuánto puede hacer Claude: **Solo lectura**, **Estándar** (añade enviar, borradores y contactos), **Acceso completo** (añade carpetas, programación y eliminación) o **Personalizado**.

No hace falta clave de API ni archivo de configuración. En un plan Team o Enterprise, primero un propietario añade el conector en **Organization settings → Connectors** y luego los miembros hacen clic en **Connect**. La [página de configuración de Claude](/docs/claude) recorre cada paso y los errores más comunes.

### Usarlo en el iPhone

El centro de ayuda de Anthropic indica que un conector que añades en claude.ai o en Claude Desktop está disponible la próxima vez que inicias sesión en la app de Claude para iOS o Android. Añádelo una vez en la web y luego pregúntale a Claude por tu correo desde el móvil. No hace falta que la app Mail del iPhone esté abierta ni que tu Mac esté encendido.

## Qué ve Claude y qué no

Claude trabaja sobre la copia de cada cuenta guardada en el servidor, que es la misma que sincroniza Apple Mail. Eso significa que:

- **Las carpetas que has creado en la cuenta se ven.** Un buzón que has creado dentro de tu cuenta de iCloud o de Gmail vive en el servidor, así que Claude puede listarlo y buscar en él, y mover correo a él si le has dado acceso a las carpetas.
- **Los borradores llegan a Apple Mail.** Cuando Claude guarda un borrador, va a la carpeta Borradores de esa cuenta, así que puedes abrirlo en Apple Mail, editarlo y enviarlo tú.
- **El correo enviado queda archivado.** Un mensaje que envía Claude se guarda en la carpeta Enviados de la cuenta, igual que uno enviado desde Apple Mail. Si un servidor de correo rechaza esa copia, el resultado de Claude lo indica.
- **Los buzones «En mi Mac» no se ven.** Apple los guarda solo en el Mac donde los has creado, así que ninguna conexión desde el servidor puede verlos. Mueve lo que quieras que Claude encuentre a un buzón dentro de la cuenta.
- **Las cuentas POP pueden estar incompletas.** Una cuenta que Apple Mail usa por POP puede haber borrado del servidor el correo antiguo después de descargarlo a tu Mac. MCPEmails se conecta por IMAP, así que Claude solo llega a lo que sigue en el servidor.

El correo se obtiene en directo de tu proveedor en cada petición y MCPEmails no lo almacena. La única excepción es un mensaje que programas para más tarde, que se guarda hasta que se envía.

## Prompts para probar

Empieza por algo de solo lectura:

> Resume el correo sin leer de hoy en iCloud y Gmail. Una sola lista, indicando en cada mensaje de qué cuenta viene.

> Busca la confirmación del vuelo que recibí el mes pasado y dime el localizador de la reserva.

> Redacta una respuesta al último mensaje de mi casero, pero no la envíes. La terminaré yo en Apple Mail.

Para más rutinas, consulta las [formas de dejar que Claude gestione tu bandeja de entrada](/blog/best-ways-to-let-claude-manage-your-inbox) y la [guía para clasificar y resumir la bandeja](/blog/ai-agent-triage-summarize-inbox). Si llevas varias cuentas, [gestionar varias cuentas de correo con IA](/blog/manage-multiple-email-accounts-with-ai) explica cómo hacer que las respuestas salgan siempre desde la dirección correcta.

## Conectar ChatGPT a las mismas cuentas

La URL del conector es un servidor MCP estándar, así que ChatGPT también puede llegar a las mismas cuentas de Apple Mail. Se añade en chatgpt.com como servidor MCP personalizado; el centro de ayuda de OpenAI indica que ese paso solo se puede hacer en la web. Qué planes y qué roles del espacio de trabajo pueden añadir uno cambia a menudo, así que la [página de configuración de ChatGPT](/docs/chatgpt) mantiene los pasos actuales y la [guía de correo para ChatGPT](/blog/connect-chatgpt-to-email) cubre los errores más comunes.

## Mantén el control

- **Concede solo lo que necesitas.** Elige **Solo lectura** en la pantalla de consentimiento si Claude no debe enviar nunca.
- **Revisa los envíos primero.** Activa **Revisión antes de enviar** para una cuenta en el panel y cada envío desde ella esperará tu aprobación. Consulta [la aprobación humana de los envíos de un agente de IA](/blog/approve-ai-agent-email-sends).
- **Revoca cuando quieras.** Elimina la contraseña específica para apps en account.apple.com o revoca la conexión de Claude en **Claves de API**, en el panel de MCPEmails.

Trata cada correo como texto no fiable: un mensaje puede contener instrucciones dirigidas a una IA. La [guía de seguridad sobre el acceso al correo](/blog/is-it-safe-to-give-ai-agent-email-access) explica los riesgos, y la página de [seguridad](/security) explica cómo se cifran las credenciales y dónde se almacenan los datos.

## Preguntas frecuentes

**¿Cómo conecto Claude con Apple Mail?**
Conecta a MCPEmails las cuentas que usa Apple Mail (iCloud, Gmail, Outlook.com, Yahoo o IMAP) y luego añade \`https://mcpemails.com/api/mcp\` como conector personalizado en Claude, en Customize, Connectors. A partir de ahí Claude lee y envía desde esas cuentas, y los resultados aparecen en Apple Mail.

**¿Necesito un Mac para esto?**
No. En tu Mac no se ejecuta nada. Claude llega a tus cuentas de correo a través de MCPEmails, así que funciona desde claude.ai, Claude Desktop en Windows o Mac y la app de Claude en iPhone y Android.

**¿Funciona con Apple Mail en el iPhone?**
Sí. La app Mail de tu iPhone y Claude trabajan sobre las mismas cuentas. Añade el conector una vez en claude.ai y estará disponible en la app de Claude para iPhone la próxima vez que inicies sesión.

**¿Por qué se rechaza la contraseña de mi cuenta de Apple?**
iCloud solo acepta una contraseña específica para apps cuando la conexión viene de otras apps. Genera una en account.apple.com, en Inicio de sesión y seguridad, y pégala en su lugar.

**¿Puede Claude ver mis carpetas «En mi Mac»?**
No. Esos buzones solo existen en tu Mac. Mueve los mensajes a un buzón dentro de tu cuenta de iCloud o de otra cuenta y Claude podrá verlos.

**¿Se almacena mi correo?**
No. Cada petición obtiene el correo en directo de tu proveedor y lo descarta. Las excepciones son los mensajes que programas, que se guardan hasta que se envían, y la credencial cifrada de cada cuenta, que MCPEmails conserva. El paso a paso completo para cada proveedor está en la [guía para conectar Claude a tu correo](/blog/connect-claude-to-email).

## Siguiente paso

[Empieza gratis](/signup), conecta tu cuenta de iCloud, añade el conector en Claude y pregúntale qué necesita respuesta hoy. Luego abre Apple Mail y verás la misma bandeja de entrada que Claude acaba de leer.`,
};

export default translation;
