const translation = {
  title: 'Conecta el correo de empresa de tu propio dominio a tu agente de IA (IMAP)',
  description:
    'Guía de configuración para tu@tuempresa.com: averigua quién gestiona realmente tu correo, conecta Google Workspace, Zoho, Fastmail, Migadu, Titan, Rackspace, IONOS o cPanel, y corrige el nombre del remitente antes de que tu agente responda.',
  coverAlt:
    'Conecta un correo de empresa con dominio propio a un agente de IA con MCP Emails',
  content: `> **¿Usas Microsoft 365?** Si resulta que tu buzón de empresa es un tenant de Microsoft, esta guía te ayudará a confirmarlo. Conéctalo con **Outlook** e Iniciar sesión con Microsoft en lugar de IMAP; puede que tu administrador de TI tenga que aprobar antes la aplicación una sola vez para toda la organización. La [guía de Outlook y Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp) explica los pasos.

Casi todas las guías para conectar el correo a un agente de IA dan por hecho que tu dirección acaba en gmail.com. El correo de empresa es distinto: el dominio no dice quién sirve el buzón, puede que otra persona controle si los clientes de correo pueden iniciar sesión, y lo que envía tu agente llega a tus clientes con tu nombre. Esta es la guía para tu@tuempresa.com.

**Ve a tu proveedor:** [Google Workspace](#google-workspace) · [Zoho Mail](#zoho-mail) · [Fastmail y Migadu](#fastmail-y-migadu) · [Titan Email](#titan-email) · [Rackspace Email](#rackspace-email) · [IONOS](#ionos) · [cPanel y hosting compartido](#cpanel-y-hosting-compartido)

## Por qué un buzón de empresa es más difícil que uno personal

- **Puede que otra persona controle el acceso de las aplicaciones.** Un administrador de Google Workspace puede desactivar las contraseñas de aplicación para todo el dominio. Zoho entrega los buzones con IMAP desactivado y Titan con el acceso de terceros desactivado. Los tres rechazan el inicio de sesión igual que una contraseña incorrecta.
- **Tu dirección no nombra tu servidor de correo.** Nuestro propio hello@mcpemails.com lo sirve Migadu, y nada en el dominio lo indica. Adivinar \`mail.tuempresa.com\` normalmente no lleva a ninguna parte.
- **SMTP no siempre refleja a IMAP.** Rackspace sirve ambos desde un único host sin marca; OVH Hosted Exchange no escucha en el 465 y necesita el 587 con STARTTLS.
- **El nombre del remitente lo ven tus clientes.** Una respuesta que sale sin nombre acaba siendo una incidencia de soporte.

## Paso 1: Averigua quién gestiona realmente tu correo

MCP Emails intenta responder por ti. Escribe tu dirección en el formulario IMAP, espera medio segundo y consultará cuatro fuentes en orden: una tabla de los proveedores que han causado fallos de conexión reales, los registros de servicio RFC 6186 de tu dominio, tu registro MX comparado con esa tabla y la base de datos de autoconfiguración de Mozilla. No se rellena nada salvo que se resuelvan las dos mitades.

Para comprobarlo tú mismo antes:

\`\`\`
dig +short MX tuempresa.com
dig +short SRV _imaps._tcp.tuempresa.com
\`\`\`

Los registros de servicio indican host y puerto directamente, pero la mayoría de dominios no publican ninguno, así que normalmente te quedas con la respuesta MX:

- Termina en \`.l.google.com\`, o \`smtp.google.com\`: Google Workspace.
- \`mx.zoho.com\` o su equivalente regional: Zoho Mail.
- \`aspmx1.migadu.com\`: Migadu. \`mx1.titan.email\`: Titan, con la marca con la que lo compraras.
- Un MX alojado en Microsoft: un tenant de Microsoft 365. Conéctalo con **Outlook**, no por IMAP.
- El nombre del servidor de tu empresa de hosting: un buzón de cPanel o Plesk.

## Paso 2: Sigue el camino de tu proveedor

En el panel, abre **Inboxes → Connect Inbox** y elige la ruta que te corresponda.

### Google Workspace

Workspace se conecta por defecto con una **contraseña de aplicación de Google** sobre IMAP (\`imap.gmail.com\` en el 993, \`smtp.gmail.com\` en el 465); OAuth también está disponible. Las contraseñas de aplicación solo existen con la Verificación en dos pasos activada, y un administrador puede desactivarlas para todo el dominio, en cuyo caso la página de Google simplemente no está disponible para ti. Los administradores también pueden restringir las aplicaciones OAuth de terceros en Seguridad → Controles de API, lo que bloquea esa vía en la propia pantalla de consentimiento de Google. Si ambas están cerradas, habla con tu administrador.

### Zoho Mail

**Activa el acceso IMAP** primero, en Configuración → Cuentas de correo → la dirección → Acceso IMAP. Viene desactivado y se configura buzón por buzón, así que activarlo para ti no hace nada por un compañero. Genera además una **contraseña específica de aplicación** si tienes la verificación en dos pasos activada.

Tu host depende de dos cosas que Zoho nunca muestra juntas: en cuál de sus seis centros de datos regionales vive la cuenta (\`.com\`, \`.eu\`, \`.in\`, \`.com.au\`, \`.jp\`, \`zohocloud.ca\`) y si es una cuenta de organización de pago con dominio propio, que usa \`imappro\` y \`smtppro\` de esa región. MCP Emails pregunta por ambas y construye el nombre del host.

### Fastmail y Migadu

Fastmail usa una **contraseña de aplicación** con acceso a Mail (IMAP/SMTP), desde Configuración → Privacy & Security: \`imap.fastmail.com\` en el 993 y \`smtp.fastmail.com\` en el 465. Una guía que te diga que inicies sesión en Fastmail con OAuth está desactualizada.

Migadu usa la **contraseña del buzón**, no la de tu cuenta de Migadu, que gestiona dominios y facturación y no autentica correo alguno. Un alias no tiene contraseña, así que si la dirección que quieres es un alias, añade una **identidad** en el buzón y dale la suya. Los hosts son \`imap.migadu.com\` y \`smtp.migadu.com\`. La [guía de iCloud e IMAP](/blog/connect-icloud-fastmail-imap-to-claude) detalla los pasos de la contraseña de aplicación.

### Titan Email

Titan rechaza cualquier cliente de correo hasta que activas un interruptor: **Settings → Enable Titan on Other Apps**. Hasta entonces el inicio de sesión falla como si la contraseña fuera incorrecta. Titan además se vende con la marca de otros, así que dónde lo compraste decide tus hosts: GoDaddy lo vende como Professional Email en \`imap.secureserver.net\` y \`smtpout.secureserver.net\`, y Hostinger como Titan en \`imap.titan.email\`. La guía de Titan te dice que desactives la verificación en dos pasos; no hace falta, porque admite contraseñas de aplicación.

### Rackspace Email

Los dos hosts son \`secure.emailsrvr.com\`, entrante y saliente, sea cual sea tu dominio. El nombre no lleva marca de Rackspace, así que la gente lo "corrige" por algo más verosímil y deja de funcionar. Usa la contraseña del buzón del panel de Cloud Office. Con la autenticación multifactor activada, esa contraseña deja de funcionar por IMAP y SMTP aunque siga valiendo en el webmail, así que necesitas una contraseña de aplicación. Rackspace también vende Hosted Exchange, que no se puede conectar aquí, y revende Microsoft 365, que se conecta con **Outlook** en lugar de IMAP.

### IONOS

IONOS da a **cada dirección su propia contraseña de correo**, que se define en el panel de control en Email. Tu acceso a la cuenta de IONOS, que muy a menudo también es una dirección de correo, autentica el panel y nada más, y esa única confusión explica la mayoría de los fallos de IONOS en nuestros registros. IONOS responde tanto en el 993 con TLS como en el 143 con STARTTLS, así que alternar entre ellos es tiempo perdido: un espacio de trabajo hizo doce intentos seguidos alternándolos y el problema era la contraseña desde el principio.

### cPanel y hosting compartido

No existe un servicio de correo de cPanel, solo el servidor de tu empresa de hosting, así que el panel es la única autoridad sobre su nombre. Abre **Email Accounts**, pulsa **Connect Devices** y copia los valores de **Mail Client Manual Settings**, usando la columna segura SSL/TLS. El usuario es la dirección de correo completa, nunca tu acceso a cPanel, y la credencial es la contraseña del buzón. Sin contraseña de aplicación y sin OAuth. Plesk funciona igual.

## Cuando no se detecta nada y tienes que introducir los datos

Da a MCP Emails cuatro cosas por protocolo: host, puerto, modo de seguridad y tu dirección completa como usuario. Las convenciones son fijas, y el formulario mantiene el puerto y la seguridad sincronizados para que no se separen:

- IMAP **993** es TLS implícito; IMAP **143** es STARTTLS.
- SMTP **465** es TLS implícito; SMTP **587** es STARTTLS, y el **25** es STARTTLS en los hosts pequeños que no ofrecen otra cosa.

Confundirlos era la mayor causa de conexiones genéricas fallidas: STARTTLS en el 993 se queda esperando un saludo que un servidor solo TLS nunca envía, y TLS implícito en el 143 falla el handshake. Ya no tienes que acertar a la primera. Una conexión que nunca llegó a establecer una sesión utilizable se reintenta en los otros transportes estándar, hasta tres intentos por protocolo, empezando por el que pediste. Una contraseña rechazada por el servidor nunca se reintenta: reenviarla solo triplicaría el contador de inicios de sesión fallidos que tu proveedor usa para bloquear cuentas.

El envío negocia una cosa más que nunca verás. Los hosts tipo Exchange anuncian **LOGIN** sin PLAIN, así que MCP Emails lee lo que ofrece el servidor, prueba PLAIN primero cuando están los dos y recurre a LOGIN. Un mecanismo rechazado nunca se comunica como contraseña incorrecta.

## Define el nombre del remitente antes de que tu agente responda

Todo lo que envía tu agente construye la cabecera From a partir de un único campo: el nombre para mostrar del buzón, delante de tu dirección. Si lo dejas vacío, el correo sale solo con la dirección.

Defínelo por buzón en la página de detalle del buzón, donde una vista previa muestra la cabecera tal como la verán los destinatarios. Un agente también puede definirlo con \`signature_set\` y el argumento \`sender_name\`. Los nombres tienen un límite de 100 caracteres y se eliminan los caracteres de control y los signos de ángulo para que un nombre no pueda colar una segunda dirección en la cabecera. Aprovecha para poner una firma: [firmas de correo para Claude](/blog/email-signatures-for-claude).

## Resolución de problemas del correo de empresa

- **Rechaza el inicio de sesión y la contraseña es correcta.** Comprueba primero el interruptor: acceso IMAP en Zoho, acceso de terceros en Titan, contraseñas de aplicación en Workspace, multifactor en Rackspace.
- **Estás usando otra contraseña.** Migadu, IONOS, Rackspace y cPanel separan el acceso al panel de control de la contraseña del buzón, y las dos suelen ser direcciones de correo.
- **Da tiempo de espera en lugar de fallar.** Eso es el host o el puerto, no la credencial. Vuelve a leer el nombre del host en el panel del proveedor.
- **Lee el correo pero no envía.** La mitad saliente tiene su propio host, puerto y modo de seguridad, y algunos hosts no escuchan en el 465. Confirma que concediste \`send:email\`.
- **Es un buzón de Microsoft 365.** Comprado directamente o revendido por GoDaddy, IONOS o Rackspace, sigue siendo un tenant de Microsoft. Conéctalo con **Outlook** e Iniciar sesión con Microsoft, no por IMAP. Si Microsoft dice que hace falta la aprobación de un administrador, envía a tu administrador de TI el enlace que muestra el panel.

La [matriz de proveedores](/docs/providers) y las [páginas de proveedor](/connect) recogen el detalle de cada uno.

## Preguntas frecuentes

**¿Cómo averiguo quién aloja el correo de mi empresa?**
Consulta el registro MX de tu dominio, o escribe tu dirección en el formulario de conexión y deja que la detección automática revise el MX y los registros de servicio por ti.

**¿Puedo conectar una dirección de Google Workspace?**
Sí, con una contraseña de aplicación de Google sobre IMAP, o con OAuth. Tu administrador puede bloquear cualquiera de las dos: las contraseñas de aplicación se pueden desactivar para todo el dominio y las aplicaciones OAuth de terceros se pueden restringir en los controles de API.

**¿Y si mi proveedor no publica los ajustes IMAP?**
Introdúcelos tú: host, puerto, modo de seguridad y tu dirección completa como usuario. Si el primer transporte no responde, se prueban automáticamente las alternativas estándar.

**¿MCP Emails almacena el correo de mi empresa?**
No. El contenido de los mensajes se obtiene en tiempo real de tu proveedor en cada solicitud y se descarta. Solo se conserva la credencial cifrada del proveedor.

**¿Basta un buzón en el plan gratuito?**
Free conecta 1 buzón. Personal cuesta 5 $/mes por 3 buzones sin límite mensual de acciones, y Pro 15 $/mes por buzones ilimitados. Consulta los [precios](/pricing).

## Siguiente paso

[Crea una cuenta gratuita](/signup), conecta tu buzón de empresa, define el nombre del remitente y añade \`https://mcpemails.com/api/mcp\` a tu cliente. Luego pídele que llame a \`inbox_list\` y resuma el correo sin leer de ayer antes de concederle nada que envíe.`,
};

export default translation;
