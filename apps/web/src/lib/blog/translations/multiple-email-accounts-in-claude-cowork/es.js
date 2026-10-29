const translation = {
  title: 'Varias cuentas de correo en Claude Cowork, incluido Outlook personal',
  description:
    'Claude Cowork llega a una sola cuenta de Google con su conector de Gmail, y su conector de Microsoft 365 rechaza las direcciones personales de Outlook. Cómo dar a una tarea de Cowork varias bandejas de entrada, del trabajo y personales.',
  coverAlt:
    'Cuentas de correo del trabajo y personales, como Gmail y Outlook.com, conectadas a una misma tarea de Claude Cowork',
  content: `**Claude Cowork usa los mismos conectores que el chat de Claude, así que tiene los mismos límites de correo: una cuenta de Google con el conector de Gmail, y solo cuentas de trabajo de Microsoft 365 con el conector de Microsoft 365.** Una dirección personal de Outlook.com o Hotmail, un segundo Gmail o un buzón de empresa en un servidor IMAP necesitan un conector personalizado. Con un servidor MCP como MCPEmails, un solo conector personalizado da a una tarea de Cowork todos los buzones que conectes, cada uno por su nombre.

**Ir a:** [Conectores integrados](#hasta-dónde-llegan-los-conectores-de-correo-integrados-de-cowork) · [Varias bandejas](#varias-bandejas-de-entrada-en-una-misma-tarea-de-cowork) · [Configuración](#configúralo) · [Permisos](#mantén-el-envío-bajo-tu-control) · [Preguntas frecuentes](#preguntas-frecuentes)

## Hasta dónde llegan los conectores de correo integrados de Cowork

La [guía de Cowork](https://support.claude.com/en/articles/13345190-get-started-with-cowork) de Anthropic gestiona los conectores desde la misma página **Customize → Connectors** que el chat, y el chat y Cowork comparten ahora un mismo espacio en la app de Claude. Lo que tenga conectado tu cuenta de Claude es lo que puede usar una tarea de Cowork.

- **Gmail.** El conector de Gmail de Claude lee, busca, redacta borradores y envía. El [artículo de Anthropic](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors) habla del acceso a "la cuenta de Google que has conectado" y no dice nada sobre añadir una segunda. Con él, un Gmail personal y uno del trabajo no conviven.
- **Microsoft 365.** El [conector de Microsoft 365](https://support.claude.com/en/articles/12542951-enabling-and-using-the-microsoft-365-connector) es para cuentas del inquilino (tenant) de Microsoft 365 de una empresa. Primero tiene que dar su consentimiento un administrador global, empieza en solo lectura, y las cuentas personales de Microsoft, como @outlook.com y @hotmail.com, quedan excluidas.
- **Todo lo demás.** Yahoo, iCloud, Fastmail, Zoho, IONOS o tu propio servidor de correo no tienen un conector integrado en Claude.

Así que la combinación habitual, un buzón del trabajo más un Outlook.com personal o un segundo Gmail, no cabe en Cowork solo con los conectores integrados.

## Varias bandejas de entrada en una misma tarea de Cowork

Los [conectores personalizados](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) son servidores MCP remotos, y Anthropic indica que están disponibles en Claude, Cowork y Claude Desktop. Claude llega a ellos desde la nube de Anthropic, lo que tiene una consecuencia para Cowork: un servidor MCP local que hayas configurado en \`claude_desktop_config.json\` no está disponible allí. El servidor tiene que ser accesible desde internet.

MCPEmails es un servidor MCP alojado, así que eso ya se cumple. Conectas cada buzón una vez, añades una URL a Claude y todos los buzones quedan disponibles en tus tareas de Cowork:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

- **Cualquier combinación de proveedores.** [Gmail y Google Workspace](/connect/gmail) con una contraseña de aplicación de Google, [Outlook.com, Hotmail y Live personales](/connect/outlook) y [Microsoft 365 de trabajo](/connect/office365) con Iniciar sesión con Microsoft, [iCloud](/connect/icloud), [Yahoo](/connect/yahoo), [Fastmail](/connect/fastmail), [Zoho](/connect/zoho) y cualquier buzón compatible con [IMAP y SMTP](/connect/imap).
- **Cada buzón por su nombre.** La tarea llama a \`inbox_list\` y ve cada dirección conectada con su nombre visible, así que "revisa info@ y mi Outlook" no necesita ninguna configuración extra.
- **Respuestas desde la dirección correcta.** Cada buzón envía a través de su propio proveedor, con su propio nombre de remitente y su firma.
- **Sin almacenamiento.** El correo se obtiene en directo de tu proveedor en cada solicitud y no se guarda en nuestros servidores.

Una dirección personal de Outlook.com se conecta con Iniciar sesión con Microsoft y no necesita administrador. Una cuenta de trabajo de Microsoft 365 puede necesitar que su administrador de TI apruebe MCPEmails una vez para toda la organización; [aprobación del administrador de Microsoft 365](/docs/microsoft-365-admin-consent) explica qué aprueba y le da el enlace.

## Configúralo

1. **Conecta tus buzones.** [Crea una cuenta gratuita de MCPEmails](/signup), abre **Bandejas de entrada** y luego **Conectar bandeja de entrada**, una vez por buzón. Dale a cada uno un nombre visible claro, como "Outlook personal" o "Ventas Acme": es lo que Claude lee para distinguirlos.
2. **Añade el conector a Claude.** Abre **Customize → Connectors**, haz clic en **+ Add** y después en **Add custom connector**. Llámalo MCPEmails, introduce \`https://mcpemails.com/api/mcp\`, haz clic en **Continue**, deja los ajustes de inicio de sesión detectados y haz clic en **Add**. En Team y Enterprise lo añade un Owner, y los miembros hacen clic en **Connect**.
3. **Inicia sesión y elige el acceso.** **Solo lectura** para tareas que solo leen, **Estándar** para añadir los borradores y el envío, o **Acceso completo** para añadir la programación, las carpetas y la eliminación.
4. **Actívalo en Cowork.** En una tarea, abre el menú **+** y activa MCPEmails en los conectores.

La [guía de configuración de Claude](/blog/connect-claude-to-email) muestra cada pantalla, y [los conectores personalizados de Claude, explicados](/blog/claude-custom-connectors-explained) cubre lo que un conector personalizado puede y no puede hacer.

Cowork está en los planes Pro, Max, Team y Enterprise de Claude. El plan Free de MCPEmails conecta un buzón; para varios buzones hace falta un plan de pago, que encontrarás en la [página de precios](/pricing).

## Mantén el envío bajo tu control

Una tarea de Cowork avanza por muchos pasos por su cuenta, así que decide de antemano qué puede hacer sin preguntar.

- **En Claude.** La guía de Cowork de Anthropic te permite configurar cada herramienta de un conector como **Always allow**, **Needs approval** o **Blocked**. Si pones las herramientas de envío de MCPEmails en **Needs approval**, Claude se detiene antes de cada envío. En Team y Enterprise, puede que tu organización exija aprobación para las herramientas de escritura de todos modos.
- **En MCPEmails.** Activa la **Revisión antes de enviar** en un buzón y elige cómo: **Preguntar primero en el chat** hace que Claude te muestre el correo y espere tu sí, y **Aprobar en mcpemails.com** retiene cada envío hasta que un propietario o administrador del espacio de trabajo lo aprueba con la sesión iniciada, algo que Claude no puede hacer por ti. Consulta [aprobación humana de los envíos de correo de la IA](/blog/approve-ai-agent-email-sends).
- **Primero, un borrador.** Cuando pides un correo, MCPEmails le indica a Claude que lo guarde como borrador en ese buzón, donde puedes leerlo y editarlo antes de que se envíe nada.

El correo lo escriben otras personas, y parte de él está escrito para manipular a una IA. Una tarea que lee correo y además puede enviar debería tener activada una de estas comprobaciones.

## Prompts para varias bandejas de entrada

> Usando MCPEmails, revisa mi bandeja de entrada del trabajo y mi Outlook personal y enumera todo lo de los últimos dos días que necesita una respuesta mía. Una sola lista, con cada línea etiquetada con su bandeja. No envíes ni muevas nada.

> Usando MCPEmails, busca la confirmación del vuelo de la semana que viene. Busca en todas las bandejas de entrada conectadas y dime en cuál está.

> Usando MCPEmails, redacta una respuesta desde ventas@ a la consulta más reciente y guárdala como borrador. No la envíes.

Para recibir el mismo resumen cada mañana sin pedirlo, programa el primer prompt: [resumen diario del correo con Claude y ChatGPT](/blog/daily-email-briefing-with-claude-and-chatgpt) explica las tareas programadas de Claude. [Varias cuentas de correo en Claude y ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) cubre la misma configuración en el chat de Claude y en ChatGPT.

## Preguntas frecuentes

**¿Puede Claude Cowork usar dos cuentas de Gmail?**
No con el conector de Gmail integrado en Claude, que según Anthropic llega a la única cuenta de Google que conectaste. Conecta las dos cuentas a MCPEmails con contraseñas de aplicación de Google y añade MCPEmails como conector personalizado; así una tarea de Cowork ve las dos.

**¿Puede Cowork leer mi correo personal de Outlook.com o Hotmail?**
No con el conector de Microsoft 365 de Claude, que rechaza las cuentas personales de Microsoft. Conecta la dirección a MCPEmails con Iniciar sesión con Microsoft y luego añade MCPEmails a Claude. [Cómo conectar Claude con Outlook.com y Hotmail](/blog/connect-claude-to-outlook-com-hotmail) tiene los pasos.

**¿Funcionan los conectores personalizados en Cowork?**
Sí. Anthropic indica que los conectores personalizados están disponibles en Claude, Cowork y Claude Desktop. Tienen que ser servidores remotos accesibles desde internet; un servidor local del archivo de configuración de escritorio no está disponible en Cowork.

**¿Necesito un conector por cada buzón?**
No. Un solo conector de MCPEmails cubre todos los buzones de tu espacio de trabajo, y la misma URL funciona en el chat de Claude, Cowork, ChatGPT y otros clientes MCP.

**¿Puede Claude enviar correo desde Cowork?**
Sí, desde cualquier buzón que hayas conectado con acceso Estándar o Acceso completo. [¿Puede Claude leer tu correo y enviar emails?](/blog/can-claude-read-my-email#puede-claude-enviar-correos) compara cómo gestiona el envío cada conector.

## Siguiente paso

[Empieza gratis](/signup), conecta el buzón que más consultas, añade MCPEmails a Claude y pregunta a una tarea de Cowork qué necesita respuesta hoy. Añade las demás bandejas de entrada cuando quieras una sola respuesta en lugar de varias.`,
};

export default translation;
