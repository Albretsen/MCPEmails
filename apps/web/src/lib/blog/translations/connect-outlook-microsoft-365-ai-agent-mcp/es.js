const translation = {
  title: 'Cómo conectar Outlook y Microsoft 365 a tu agente de IA con MCP',
  description:
    'Conecta Outlook.com o Microsoft 365 a tu agente de IA por MCP. Inicia sesión con Microsoft, sin contraseña de aplicación, con Microsoft Graph por debajo. Las cuentas de trabajo pueden necesitar una aprobación única del administrador de TI.',
  coverAlt: 'Conexión de Outlook y Microsoft 365 a un agente de IA mediante MCP',
  content: `Para conectar un buzón de Outlook o Microsoft 365 a tu agente de IA, añades el buzón en el panel de MCP Emails con **Iniciar sesión con Microsoft** y luego apuntas tu agente a un único endpoint MCP. No hay contraseña de aplicación, ni ajustes de IMAP o SMTP, ni portal de Azure, ni un servidor de Graph propio. Una cuenta personal de Outlook.com se conecta en un par de minutos. Una cuenta de trabajo o educativa de Microsoft 365 suele necesitar antes un paso extra: un administrador de TI aprueba la aplicación una sola vez para toda la organización.

La mayoría de las guías de "IA para el correo" dan por hecho Gmail y ahí se quedan. Si vives en Outlook, esta es la versión pensada para Outlook: qué cuentas se conectan directamente, cómo es el paso de aprobación del administrador, qué puede hacer tu agente una vez conectado y los pocos puntos en los que Outlook se comporta distinto de Gmail.

## Las cuentas personales y las de trabajo son dos casos distintos

El correo de Microsoft no es una sola cosa, y la diferencia decide cómo va tu conexión.

- **Cuentas personales de Microsoft**: direcciones de Outlook.com, Hotmail, Live y MSN. Inicias sesión con Microsoft, apruebas tú mismo los permisos y ya estás conectado. No interviene ningún administrador.
- **Cuentas de trabajo o educativas de Microsoft 365**: viven en el inquilino (tenant) de Microsoft Entra de tu organización. Muchas organizaciones exigen que un administrador de TI apruebe una aplicación de terceros antes de que nadie pueda usarla. La política de consentimiento predeterminada de Microsoft (desde finales de 2025) no permite que los empleados aprueben por sí mismos el acceso de lectura al buzón, así que en muchos inquilinos no podrás terminar la conexión tú solo. Es una política del inquilino de Microsoft, no algo que MCP Emails pueda desactivar, y se aplica a cualquier aplicación de correo de terceros.

La aprobación del administrador es un paso único para toda la organización. Una vez hecha, cada empleado se conecta de la forma normal.

## Conecta tu buzón de Outlook o Microsoft 365

Dos partes: conectar el buzón y luego conectar el agente. Están separadas a propósito. La conexión del buzón permite que MCP Emails llegue a tu buzón, y la conexión del agente permite que tu cliente de IA llegue a MCP Emails.

### Paso 1: añade el buzón

1. [Empieza gratis](/signup) y abre el panel.
2. Ve a **Inboxes → Connect Inbox** y elige **Outlook**.
3. Haz clic en **Conectar con Microsoft**. Te lleva a la propia página de inicio de sesión de Microsoft.
4. Inicia sesión con tu cuenta de Microsoft y completa la MFA si tu cuenta la usa.
5. Revisa la pantalla de consentimiento y apruébala. Microsoft muestra que la aplicación viene de un editor verificado, y pide permiso para leer y escribir tu correo, enviar correo en tu nombre y mantener el acceso hasta que desconectes.

MCP Emails guarda cifrado el token OAuth resultante y nada más de tu buzón. Nunca escribes tu contraseña de Microsoft en MCP Emails y no hay contraseña de aplicación que generar. Esa es la principal diferencia con los proveedores IMAP: [iCloud, Fastmail y los buzones IMAP genéricos](/blog/connect-icloud-fastmail-imap-to-claude) usan en su lugar una contraseña específica de aplicación.

### Si tu organización tiene que aprobar antes la aplicación

En una cuenta de trabajo o educativa, Microsoft puede detenerte antes de la pantalla de consentimiento y decir que hace falta la aprobación de un administrador. Cuando ocurre, el panel muestra un aviso con un enlace **Enviar a tu administrador de TI**:

1. Envía ese enlace a tu administrador de TI.
2. Tu administrador lo abre, inicia sesión y aprueba MCP Emails una sola vez para toda la organización.
3. Vuelve al panel y conecta Outlook como en el paso 1. Ahora funciona igual que con una cuenta personal.

Tu administrador aprueba la aplicación para la organización, y cada persona sigue iniciando sesión con su propia cuenta y conecta solo su propio buzón.

### Si la cuenta no tiene buzón de Exchange

Algunas cuentas de Microsoft no tienen buzón de Exchange Online, por ejemplo una cuenta de administrador sin licencia de Exchange, o una organización cuyo correo está alojado en otro sitio. MCP Emails rechaza esas cuentas porque no hay nada que conectar, y te lo dice. Si tu correo vive realmente en otro servidor, conecta la dirección por IMAP.

### Paso 2: conecta tu agente

Conectas un cliente una vez, y la misma configuración sirve para todos los buzones de tu cuenta. Para clientes compatibles con OAuth (claude.ai, Claude Desktop, Cursor), en claude.ai es:

**Customize → Connectors → Add connector → pega la URL → Connect → inicia sesión y aprueba.**

El endpoint es:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

Al hacer clic en Connect, inicias sesión en tu cuenta de MCP Emails y apruebas los permisos: \`read:email\`, \`send:email\` o ambos. No se intercambia ninguna clave de API.

Para clientes que no hablan OAuth (Cline, plugins de JetBrains, tus propios scripts, cURL a pelo), genera una clave con permisos acotados en **Dashboard → API Keys** y envíala como \`Authorization: Bearer <api-key>\`. La guía completa para esos clientes está en [correo para agentes de IA en Cursor, Cline y VS Code](/blog/email-for-ai-agents-cursor-cline-vscode). Si estás comparando los dos enfoques, [OAuth frente a claves de API para el acceso de la IA al correo](/blog/oauth-vs-api-keys-ai-email-access) expone las ventajas e inconvenientes.

## Microsoft Graph, por debajo

Outlook se conecta a través de Microsoft Graph, no de IMAP. Cada llamada a una herramienta que hace tu agente va a Graph en tiempo real: lees un mensaje, y MCP Emails lo obtiene de Graph, entrega el resultado a tu agente y lo descarta. Envías un mensaje, y sale por Graph desde tu dirección real, así que tu entregabilidad y tu reputación siguen siendo tuyas. MCP Emails nunca reenvía correo desde su propio dominio.

## Qué puede hacer tu agente con un buzón de Outlook

- Leer y buscar correo.
- Enviar, responder y reenviar, con adjuntos de hasta 25 MB.
- Trabajar con borradores y programar un envío para más tarde.
- Trabajar con carpetas, incluidas las carpetas anidadas.
- Mover, copiar y archivar mensajes.
- Marcar y desmarcar mensajes con bandera, y marcarlos como leídos o no leídos.
- Mover mensajes a Elementos eliminados o eliminarlos de forma permanente.
- Usar la firma que configuraste para ese buzón en cada mensaje que envía el agente.

### En qué se diferencia Outlook de Gmail

**Carpetas, no etiquetas.** Outlook organiza el correo en carpetas. Las herramientas de etiquetas son solo para Gmail, así que en un buzón de Outlook tu agente archiva el correo moviéndolo a una carpeta.

**Búsqueda.** La búsqueda en Outlook usa la búsqueda propia de Microsoft Graph. Hay una limitación de Graph que importa: una búsqueda de texto no se puede combinar con los filtros de no leído, con adjunto, con bandera o de fecha. Cuando tu consulta incluye texto, esos filtros no se aplican, y el resultado le indica a tu agente cuáles se omitieron. Si necesitas ambas cosas, busca primero el texto y deja que el agente acote los resultados que recibe.

**Cuentas nuevas de Outlook.com.** Microsoft puede bloquear temporalmente el envío desde una cuenta de Outlook.com recién creada que envía muchos mensajes en poco tiempo. Es la protección antiabuso de Microsoft. Si el envío falla en una cuenta nueva, envía a un ritmo más lento y vuelve a intentarlo más tarde.

## Un flujo de trabajo que merece la pena configurar

Este es un bucle de triaje que funciona bien en un buzón de Outlook. Una o dos veces por hora, el agente:

1. Lista el correo no leído de la bandeja de entrada.
2. Lee todo lo que parezca urgente.
3. Resume el lote y redacta borradores de respuesta para los que obviamente contestarías.
4. Deja todo como no leído hasta que confirmes.

MCP Emails no envía el correo nuevo a tu agente por iniciativa propia, así que el agente lo comprueba con la frecuencia que elijas. Para el triaje, eso basta. Para los patrones de sondeo que funcionan, lee [cómo clasificar y resumir una bandeja de entrada](/blog/ai-agent-triage-summarize-inbox).

## Frente a construir tu propio servidor de Microsoft 365

Los servidores MCP de Outlook autoalojados que hay en GitHub chocan todos con el mismo muro: el registro de la aplicación en Entra, el consentimiento del administrador y el ciclo de vida de los tokens de Graph son el trabajo de verdad, y te tocan a ti para siempre. La versión autoalojada de MCP Emails funciona solo con IMAP y SMTP. El conector de Outlook se queda en el producto alojado, así que quien lo quiera en su propia instalación tendría que registrar su propia aplicación de Microsoft Entra. Con el enfoque alojado, el token se cifra en reposo, solo se descifra en el momento de la llamada, y puedes desconectar el buzón desde el panel cuando quieras. [Alojado frente a autoalojado](/blog/hosted-vs-self-hosted-gmail-mcp-server) profundiza en las ventajas e inconvenientes.

Si quieres el contexto de por qué existe esta capa, la [guía completa para dar a tu agente de IA acceso al correo](/blog/how-to-give-your-ai-agent-email-access) es el punto de partida. Si no, [empieza gratis](/signup), conecta tu buzón de Outlook, apunta tu agente al endpoint y dale algo que leer.`,
};

export default translation;
