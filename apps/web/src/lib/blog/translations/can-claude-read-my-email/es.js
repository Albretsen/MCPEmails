const translation = {
  title: '¿Puede Claude leer tu correo y enviar emails? Buzón por buzón',
  description:
    'Sí, en Gmail y en cuentas de trabajo de Microsoft 365, con los conectores propios de Claude. Yahoo, iCloud, Outlook.com, los buzones IMAP y varios proveedores a la vez necesitan un servidor MCP.',
  coverAlt:
    'Claude leyendo y enviando correo desde buzones de Gmail, Microsoft 365, Yahoo, iCloud e IMAP',
  content: `**Sí, Claude puede leer tu correo y enviar emails, pero solo desde un buzón que le hayas conectado.** Claude tiene dos conectores de correo propios, uno para Gmail y otro para cuentas de trabajo de Microsoft 365. El de Gmail lee, busca y envía, y por defecto te pide aprobación antes de cada envío. El de Microsoft 365 lee y busca, y solo puede enviar después de que un administrador active sus herramientas de escritura. Yahoo, iCloud, una dirección personal de Outlook.com, un buzón de empresa en un servidor IMAP o varios proveedores detrás de una sola conexión necesitan un servidor MCP como MCPEmails.

Esta página te ayuda a saber en qué caso estás. Los datos sobre los productos de Anthropic y Google se consultaron en sus propias páginas en octubre de 2026. Esos productos cambian a menudo, así que cada sección enlaza la página en la que se apoya.

**Ir a:** [Gmail](#gmail-el-conector-propio-de-claude) · [Microsoft 365](#outlook-y-microsoft-365-solo-cuentas-de-trabajo) · [Lo que no cubren los conectores integrados](#lo-que-no-cubren-los-conectores-integrados) · [MCPEmails](#cómo-mcpemails-cubre-ese-hueco) · [Preguntas frecuentes](#preguntas-frecuentes)

## Gmail: el conector propio de Claude

El conector de Gmail de Claude aparece en el directorio de conectores de Claude como creado por Google, y funciona sobre el servidor MCP de Gmail de Google (\`gmailmcp.googleapis.com\`). Lo activas desde los ajustes de conectores de Claude e inicias sesión con tu cuenta de Google.

Lo que puede hacer, según el [artículo de ayuda de Anthropic](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors) y la [ficha del directorio](https://claude.com/connectors/gmail):

- **Leer y buscar** tu correo con preguntas en lenguaje natural, y leer hilos completos.
- **Redactar, enviar, responder y reenviar.** El artículo de Anthropic menciona las cuatro acciones.
- **Organizar** con etiquetas, y mover mensajes o hilos a la papelera.
- **Preguntar antes.** Por defecto, Claude te pide aprobación antes de cada envío, respuesta o reenvío. En los planes Team y Enterprise, un propietario tiene que activar primero el conector para la organización, y decide si los miembros pueden dejar que esas acciones se ejecuten sin preguntar.

Dónde se queda corto:

- **Adjuntos.** El artículo de Anthropic dice que Claude solo ve los metadatos de los adjuntos, no su contenido.
- **Una sola cuenta de Google.** El artículo habla del acceso a "la cuenta de Google que has conectado" y no menciona cómo añadir una segunda.

Google también documenta el mismo servidor MCP de Gmail dentro de su [programa Google Workspace Developer Preview](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server). Los miembros de ese programa pueden añadirlo ellos mismos a otros clientes MCP, con su propio cliente OAuth de Google Cloud. Esa versión documentada incluye herramientas para buscar, leer hilos, crear borradores y cambiar etiquetas, y ninguna para enviar: revisas el borrador y lo envías desde Gmail.

Si Gmail es tu único buzón y Claude es tu única aplicación de IA, puede que el conector integrado sea todo lo que necesitas.

## Outlook y Microsoft 365: solo cuentas de trabajo

El conector de Microsoft 365 de Claude lee el correo de Outlook en cuentas que pertenecen al inquilino (tenant) de Microsoft 365 de una empresa.

- **La lectura y la búsqueda** cubren tu buzón principal, su carpeta Archivo y los buzones compartidos que puedes abrir.
- **El envío está desactivado por defecto.** El conector empieza en solo lectura. Cuando se activan las herramientas de escritura, Claude puede enviar y reenviar correo, y crear, editar y eliminar borradores. Las herramientas de escritura rechazan los mensajes con adjuntos.
- **Tiene que aprobarlo un administrador.** Un administrador global de Microsoft Entra de tu organización debe dar su consentimiento antes de que nadie pueda conectarse, y otra vez antes de que funcionen las herramientas de escritura.
- **Las cuentas personales no se admiten.** El [artículo de Anthropic](https://support.claude.com/en/articles/12542951-enabling-and-using-the-microsoft-365-connector) lo dice claramente: las direcciones @outlook.com y @hotmail.com no se pueden usar para conectarse.

Así que una dirección personal de Outlook.com, Hotmail o Live no tiene ningún camino integrado hacia Claude. [Cómo conectar Claude con Outlook.com y Hotmail](/blog/connect-claude-to-outlook-com-hotmail) explica el camino que sí funciona.

## Lo que no cubren los conectores integrados

Si juntas los dos, estos son los buzones a los que no llega ninguno de los conectores integrados:

- **Yahoo Mail y AOL.**
- **iCloud Mail.**
- Direcciones **personales de Outlook.com, Hotmail y Live**.
- **Buzones de empresa en un servidor IMAP**: Fastmail, Zoho Mail, IONOS, STRATO, un hosting con cPanel o tu propio servidor.
- **Una segunda cuenta de Google.** El artículo de Anthropic describe una única cuenta de Google conectada y no menciona cómo añadir otra.
- **Varios proveedores detrás de una sola conexión**, para que una misma pregunta busque a la vez en info@, en tu propia dirección y en un Gmail personal.

Fastmail y Zoho Mail tienen sus propios servidores MCP, que puedes añadir a Claude como conectores personalizados. Cada uno llega solo a los buzones de su proveedor. Ninguno de los dos artículos de ayuda de Claude menciona programar un envío para más tarde. La [comparación entre los conectores integrados de Claude y ChatGPT](/native-connectors-vs-mcp) recoge cada función con su fuente y la fecha en que se comprobó.

## Cómo MCPEmails cubre ese hueco

MCPEmails es un servidor MCP alojado. Conectas cada buzón una vez, añades una sola URL de conector a Claude, y Claude puede leer, buscar y enviar desde todos los buzones conectados:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

- **Cualquier proveedor.** [Yahoo Mail](/connect/yahoo), [iCloud Mail](/connect/icloud), [Outlook.com personal](/connect/outlook) y [Microsoft 365 de trabajo](/connect/office365) (los dos con Iniciar sesión con Microsoft), [Gmail](/connect/gmail) con una contraseña de aplicación de Google, [Fastmail](/connect/fastmail) con una contraseña de aplicación, [Zoho Mail](/connect/zoho) y cualquier buzón que use [IMAP y SMTP](/connect/imap). La [lista completa de proveedores](/connect) tiene una página de ajustes para cada uno.
- **Varios buzones en un mismo chat.** Claude llama a \`inbox_list\` y ve cada dirección conectada por su nombre, así que "busca en ventas@ y en mi Gmail" funciona en una sola conversación. [Varias cuentas de correo en Claude](/blog/multiple-email-accounts-in-claude-and-chatgpt) explica esa configuración.
- **Enviar desde la dirección correcta.** Cada buzón envía a través de su propio proveedor, con su propio nombre de remitente y su firma.
- **Programar y organizar.** Claude puede programar un envío para más tarde, y mover, marcar con bandera, archivar o eliminar correo en todos los buzones conectados, una vez que le das Acceso completo.
- **Leer adjuntos.** Claude puede [extraer el texto de un adjunto PDF, CSV o HTML](/blog/extract-email-attachments-for-ai) sin que el archivo se guarde.
- **Los mismos buzones en otras aplicaciones.** Es un servidor MCP estándar, así que la misma configuración funciona también en ChatGPT, Cursor, VS Code y otros clientes MCP.

El correo se obtiene en directo de tu proveedor en cada solicitud y no se almacena. Lo que se guarda: la credencial cifrada de cada buzón, un mensaje que programes, hasta que se envíe, y un envío retenido para revisión, hasta que se apruebe, se rechace o caduque. Los datos se almacenan en Estocolmo.

### Añádelo a Claude

1. [Crea una cuenta gratuita de MCPEmails](/signup) y conecta un buzón en **Bandejas de entrada** y luego **Conectar bandeja de entrada**.
2. En claude.ai o Claude Desktop, abre **Customize → Connectors**, haz clic en **+ Add** y después en **Add custom connector**. Llámalo MCPEmails, introduce \`https://mcpemails.com/api/mcp\`, haz clic en **Continue**, deja los ajustes de inicio de sesión detectados y haz clic en **Add**.
3. Inicia sesión en MCPEmails cuando Claude te lo pida y elige cuánto acceso le das a Claude: **Solo lectura**, **Estándar** (añade el envío y los borradores) o **Acceso completo** (añade la programación, las carpetas y la eliminación).

La [guía paso a paso para configurar Claude](/blog/connect-claude-to-email) recorre cada pantalla y cada proveedor, y la [página de configuración de Claude](/docs/claude) cubre los errores del conector.

## ¿Puede Claude enviar correos sin preguntar?

Depende del conector y de ti.

- **El conector de Gmail de Claude** pregunta por defecto antes de cada envío, respuesta y reenvío.
- **El conector de Microsoft 365 de Claude** no puede enviar nada hasta que se activan las herramientas de escritura.
- **MCPEmails** solo envía si le diste a Claude acceso de envío al conectarlo. Con **Solo lectura**, Claude no puede enviar. Para un buzón en el que cada mensaje saliente deba revisarse, activa **Revisión antes de enviar** en los ajustes de esa bandeja de entrada: cada envío espera entonces a que un propietario o administrador del espacio de trabajo lo apruebe, con la sesión iniciada en MCPEmails en un navegador. Claude no puede aprobarlo por sí mismo. Consulta [aprobación humana de los envíos de correo de la IA](/blog/approve-ai-agent-email-sends).

Uses el camino que uses, trata lo que hay dentro de un correo como datos, no como instrucciones. Un mensaje puede contener texto escrito para manipular a una IA, y un paso de revisión lo detecta antes de que nada salga de tu buzón. La [guía de seguridad sobre el acceso al correo](/blog/is-it-safe-to-give-ai-agent-email-access) explica los riesgos con más detalle.

## Preguntas frecuentes

**¿Puede Claude leer mi correo?**
Sí, una vez que conectas un buzón. Gmail y las cuentas de trabajo de Microsoft 365 se conectan con los conectores propios de Claude. Yahoo, iCloud, Outlook.com personal y los buzones IMAP se conectan a través de un servidor MCP como MCPEmails, añadido a Claude como conector personalizado.

**¿Puede Claude enviar correos?**
Sí. El conector de Gmail de Claude puede enviar, responder y reenviar, y por defecto te pide aprobación antes. El conector de Microsoft 365 puede enviar cuando se activan las herramientas de escritura. Con MCPEmails, Claude envía desde cualquier buzón conectado si le diste acceso de envío al conectarlo.

**¿Puede Claude leer mi Gmail?**
Sí, con el conector de Gmail integrado en Claude, para la cuenta de Google que conectes. Para usar más de una cuenta de Google, o Gmail junto a otros proveedores en el mismo chat, conéctalas a través de MCPEmails con una contraseña de aplicación de Google.

**¿Puede Claude acceder a mi correo de Outlook o Hotmail?**
Las cuentas de Microsoft 365 de trabajo y educativas pueden usar el conector de Microsoft 365 de Claude cuando un administrador lo aprueba. Las direcciones personales de Outlook.com y Hotmail no. MCPEmails conecta ambas con Iniciar sesión con Microsoft, aunque una cuenta de trabajo puede seguir necesitando que su administrador de TI apruebe la aplicación una vez para toda la organización.

**¿Puede Claude leer el correo de Yahoo o iCloud?**
No con un conector integrado. Conecta el buzón a MCPEmails con una contraseña de aplicación de Yahoo o de Apple y luego añade MCPEmails a Claude.

**¿Puede Claude leer varias cuentas de correo a la vez?**
Sí, a través de MCPEmails. Cada buzón que conectas aparece en Claude a través de una única URL de conector, y Claude indica el buzón en cada llamada.

**¿MCPEmails guarda mis correos?**
No. El contenido de los mensajes se obtiene en directo de tu proveedor en cada solicitud y se descarta en cuanto se envía la respuesta. Consulta [seguridad](/security) para ver qué se guarda.

## Siguiente paso

Si todo tu correo está en una sola cuenta de Gmail, prueba primero el conector de Gmail de Claude. Para todo lo demás, [empieza gratis](/signup), conecta un buzón, añade \`https://mcpemails.com/api/mcp\` a Claude y pregúntale qué necesita respuesta hoy.`,
};

export default translation;
