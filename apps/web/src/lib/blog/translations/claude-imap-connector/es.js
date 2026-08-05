export default {
  title: 'Conector IMAP para Claude: conecta cualquier bandeja IMAP a Claude',
  description:
    'Configura un conector IMAP para Claude con ajustes IMAP/SMTP, contraseña de aplicación y TLS. Incluye seguridad, limitaciones y solución de problemas.',
  coverAlt: 'Claude conectado a un buzón IMAP y SMTP mediante MCPEmails',
  content: `Un **conector IMAP para Claude** permite que Claude trabaje con buzones que no tienen una integración nativa con Claude: Fastmail, iCloud Mail, Yahoo, Zoho, Yandex, un buzón de tu propio dominio o casi cualquier proveedor que ofrezca IMAP y SMTP.

Claude no inicia sesión en el servidor de correo ni maneja directamente la contraseña de tu buzón. MCPEmails actúa como intermediario. Se conecta al proveedor mediante IMAP para el correo entrante y SMTP para el saliente, y presenta a Claude un conjunto uniforme de herramientas del [Model Context Protocol](https://modelcontextprotocol.io). Esta diferencia es importante: IMAP y SMTP gestionan el buzón, mientras que MCP ofrece a Claude acciones seguras y estructuradas como leer, buscar, responder y mover.

Esta guía explica el conector genérico y la parte de la configuración que corresponde a Claude. Si usas iCloud o Fastmail y quieres ver sus pantallas exactas para crear contraseñas de aplicación y sus nombres de servidor, mantén abierta también la [guía específica para iCloud, Fastmail e IMAP](/blog/connect-icloud-fastmail-imap-to-claude).

## Qué hace realmente el conector IMAP para Claude

La conexión consta de tres partes:

1. **Tu proveedor de correo** ofrece IMAP para leer y organizar mensajes, además de SMTP para enviarlos.
2. **MCPEmails** guarda las credenciales de correo cifradas, se comunica con esos servidores y convierte sus respuestas en herramientas de correo predecibles.
3. **Claude** se conecta al endpoint MCP y solo invoca las herramientas permitidas por los ámbitos que apruebes.

Por tanto, Claude nunca necesita una biblioteca IMAP, una configuración SMTP ni una contraseña en el prompt. Una vez conectado, puede usar \`inbox_list\` para encontrar el buzón, \`email_read\` para listar, leer, buscar o recuperar archivos adjuntos, \`email_compose\` para enviar, responder y reenviar, y \`email_organize\` para mover, copiar, marcar o archivar mensajes. Otras herramientas se ocupan de carpetas, borradores, programación, contactos y eliminación; consulta la lista completa en la [referencia de herramientas](/docs#tools).

## Qué necesitas antes de empezar

Obtén estos datos de la página de ayuda de tu proveedor de correo o de tu administrador:

- **Dirección de correo:** por ejemplo, \`you@example.com\`. Es la dirección que aparece en la bandeja conectada.
- **Nombre de usuario:** normalmente la dirección de correo completa. Algunos alojamientos con dominio propio asignan un usuario IMAP/SMTP distinto.
- **Servidor y puerto IMAP:** por ejemplo, \`imap.example.com\` en el puerto \`993\` para IMAP con TLS implícito. Esta conexión se encarga de leer, buscar, gestionar carpetas y realizar acciones sobre mensajes.
- **Servidor y puerto SMTP:** por ejemplo, \`smtp.example.com\` en el puerto \`465\` o \`587\`. El puerto \`465\` usa TLS implícito; \`587\` actualiza la conexión mediante STARTTLS. Esta conexión se encarga de enviar, responder y reenviar.
- **Contraseña:** preferiblemente una contraseña de aplicación revocable creada para el acceso desde clientes de correo.

No deduzcas los nombres de servidor a partir del dominio si el proveedor publica sus ajustes. El alojamiento de correo suele estar separado del alojamiento web, y una dirección con dominio propio puede usar un inicio de sesión específico del proveedor distinto de la dirección visible.

Usa una **contraseña de aplicación** siempre que el proveedor la admita. Es independiente de la contraseña principal de la cuenta y puede revocarse sin cambiar la contraseña que utilizas para iniciar sesión. Los proveedores suelen exigir autenticación de dos factores antes de permitir su creación. Algunos también requieren activar primero el acceso IMAP en los ajustes del correo.

MCPEmails incluye configuraciones predefinidas para iCloud, Yahoo, Zoho y Yandex, además de un flujo específico de contraseña de aplicación para Fastmail. Estas opciones rellenan automáticamente los servidores y puertos conocidos. Elige **Generic IMAP** para otro proveedor o tu propio servidor de correo e introduce tú mismo los valores.

## Paso 1: conecta el buzón IMAP/SMTP

1. [Crea una cuenta de MCPEmails o inicia sesión](/signup) y abre **Dashboard → Inboxes → Connect Inbox**.
2. Selecciona el proveedor por nombre cuando esté disponible. En caso contrario, elige **IMAP / SMTP**.
3. Introduce la dirección de correo y la contraseña de aplicación. Para el conector genérico, añade también el servidor y puerto IMAP, el servidor y puerto SMTP y, si tu proveedor te lo asignó, un nombre de usuario distinto.
4. Guarda la conexión. MCPEmails valida las credenciales con el servidor IMAP antes de almacenar la bandeja, por lo que un inicio de sesión rechazado o un endpoint TLS inaccesible falla aquí en vez de aparecer más tarde en Claude.

Los valores seguros habituales son IMAP \`993\` y SMTP \`465\` o \`587\`. No son intercambiables: utiliza el puerto y el modo de seguridad documentados por el proveedor. MCPEmails trata el puerto SMTP \`587\` como STARTTLS y los demás puertos SMTP configurados como TLS implícito. Se rechazan las conexiones que no admiten TLS.

## Paso 2: añade MCPEmails como conector de Claude

Después de conectar el buzón, dirige Claude a MCPEmails:

1. En claude.ai, abre **Customize → Connectors**.
2. Elige **Add connector** e introduce \`https://www.mcpemails.com/api/mcp\`.
3. Selecciona **Connect**, inicia sesión en MCPEmails y aprueba solo los permisos que necesite el flujo de trabajo.

Por ejemplo, un resumidor necesita acceso de lectura y búsqueda, pero no de envío o eliminación. Un flujo de respuestas necesita acceso de envío. La gestión de carpetas y la eliminación permanente tienen sus propios ámbitos, por lo que puedes mantener deshabilitadas las acciones destructivas hasta que sean realmente útiles. Consulta el [tutorial para conectar Claude al correo](/blog/connect-claude-to-email) para ver el proceso del lado del cliente con más detalle.

Ejecuta después una pequeña prueba de funcionamiento:

\`\`\`
Use inbox_list to find my IMAP inbox. List my five newest unread messages and summarize them. Do not send, move, or delete anything.
\`\`\`

Empezar con \`inbox_list\` permite a Claude obtener el \`inbox_id\` correcto en lugar de depender de un UUID copiado.

## Qué puede hacer Claude mediante IMAP

Cuando la conexión funciona, Claude puede:

- Listar y leer mensajes obtenidos en directo del proveedor.
- Buscar por remitente, destinatario, asunto, texto del cuerpo, estado de lectura, estado de marca y fechas.
- Descargar o extraer archivos adjuntos compatibles dentro de los límites de tamaño y formato documentados.
- Enviar mensajes nuevos mediante SMTP, o responder y reenviar conservando el contexto relevante del mensaje.
- Mover, copiar, marcar, archivar y organizar correo en carpetas IMAP.
- Crear y gestionar borradores, programar mensajes y buscar contactos cuando la herramienta admita la operación.
- Mover correo a la Papelera o, con permiso explícito de eliminación y \`permanent: true\`, eliminarlo definitivamente mediante IMAP.

Esta última función exige precaución. La eliminación permanente mediante IMAP evita la Papelera y puede ser irreversible. MCPEmails expone la eliminación como una herramienta destructiva independiente y el cliente MCP controla el comportamiento de confirmación, pero aun así solo debes conceder \`delete:email\` a los flujos que lo necesiten.

## Limitaciones importantes de IMAP

Un conector IMAP ofrece una compatibilidad amplia, pero no hace que todos los proveedores sean idénticos.

- **Sin avisos push de correo entrante:** MCPEmails solo funciona mediante solicitud y respuesta. No envía webhooks ni activa Claude cuando llega un mensaje. Un flujo automatizado debe consultar el correo periódicamente, por ejemplo listando los mensajes no leídos.
- **La búsqueda varía según el transporte:** los filtros estructurados de remitente, asunto, texto y fecha funcionan entre proveedores, pero IMAP genérico no admite el filtro \`has_attachment\`. La sintaxis de búsqueda nativa de un proveedor no es transferible.
- **Las carpetas no son etiquetas de Gmail:** IMAP mueve un mensaje entre carpetas, mientras que Gmail puede asociar varias etiquetas a un solo mensaje. La diferencia práctica se explica en [etiquetas de Gmail frente a carpetas IMAP](/blog/gmail-labels-vs-imap-folders-ai-agents).
- **SMTP es necesario para enviar:** un inicio de sesión IMAP válido demuestra que Claude puede acceder al correo entrante, no que el servidor, puerto o permiso de envío SMTP sean correctos. Prueba un mensaje saliente inofensivo antes de depender de un flujo de respuestas.
- **Las políticas del proveedor siguen vigentes:** continúan aplicándose las cuotas del buzón, los límites de envío y conexiones simultáneas, los controles de spam y las restricciones del administrador.

## Solución de problemas de una conexión IMAP con Claude

### «Authentication failed» al conectar la bandeja

Usa una contraseña de aplicación, no la contraseña del sitio web del proveedor. Confirma que la autenticación de dos factores y el acceso IMAP estén activados si el proveedor los exige. Vuelve a copiar la contraseña generada sin espacios iniciales ni finales. Si la dirección pertenece a un dominio propio, comprueba si el nombre de usuario es la dirección completa o un nombre de cuenta independiente.

### El servidor agota el tiempo de espera o TLS falla

Comprueba la ortografía del servidor y usa los puertos seguros documentados por el proveedor. Empieza con IMAP \`993\`; para SMTP, usa el \`465\` o \`587\` documentado. El nombre de un sitio web, panel de control o dominio sin prefijo no es necesariamente un servidor de correo. En un servidor privado, confirma también que el firewall acepte conexiones externas y que su certificado TLS coincida con el nombre del servidor de correo.

### Claude puede leer, pero no enviar

Los ajustes IMAP funcionan, pero SMTP es independiente. Revisa el servidor y puerto SMTP, confirma que las credenciales tengan acceso SMTP o «mail» y verifica que el proveedor permita el envío autenticado desde la dirección From. Por ejemplo, las contraseñas de aplicación de Fastmail deben crearse con acceso **Mail (IMAP/SMTP)**, no con acceso de solo lectura.

### Claude no encuentra el buzón

Pide a Claude que vuelva a llamar a \`inbox_list\`. Si la bandeja no aparece, revisa su estado en el panel de MCPEmails y vuelve a conectarla si la contraseña de aplicación fue revocada o cambiada. Si aparece pero se deniega una acción, vuelve a conectar el conector de Claude o actualiza la clave de API con el ámbito necesario.

### Los resultados de búsqueda son más limitados de lo esperado

Empieza con campos estructurados como \`from\`, \`subject\`, \`text\`, \`since\` y \`before\`, y especifica las carpetas en las que buscar cuando sea necesario. No copies la sintaxis de operadores de Gmail en una búsqueda IMAP genérica esperando un comportamiento idéntico. Recuerda que el filtro por presencia de adjuntos se ignora en IMAP genérico.

## Seguridad: las credenciales permanecen fuera de Claude

MCPEmails almacena el token OAuth o la contraseña de aplicación IMAP necesarios para futuras llamadas, cifrados en reposo con AES-256-GCM. El contenido normal del buzón se obtiene en directo cuando se ejecuta una herramienta y no persiste entre llamadas. El tráfico usa TLS, y puedes revocar una contraseña de aplicación en el proveedor o desconectar la bandeja desde el panel.

Esta separación clara es el principal motivo para usar un puente MCP en vez de pegar credenciales de correo en un chat o configuración local: Claude recibe capacidades de correo con ámbitos limitados, no las llaves del buzón. Para conocer los detalles de almacenamiento y del modelo de amenazas, consulta [por qué importa que «el correo nunca se almacene»](/blog/why-email-never-stored-matters) y el [resumen de seguridad](/security).

## En pocas palabras

Un conector IMAP para Claude es una conexión de buzón IMAP/SMTP presentada a Claude como herramientas MCP. Reúne los ajustes seguros del servidor, crea una contraseña de aplicación revocable, conecta la bandeja en MCPEmails y añade \`https://www.mcpemails.com/api/mcp\` en Claude. Prueba primero el acceso de solo lectura, añade deliberadamente los ámbitos de envío o acciones destructivas y usa la lista de solución de problemas anterior si el proveedor rechaza la conexión.

¿Quieres probarlo? [Conecta una bandeja IMAP](/signup) o usa la [guía de configuración específica por proveedor](/blog/connect-icloud-fastmail-imap-to-claude) para ver los detalles de iCloud y Fastmail.`,
};
