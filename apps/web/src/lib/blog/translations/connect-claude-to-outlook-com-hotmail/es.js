const translation = {
  title: 'Cómo conectar Claude con Hotmail y Outlook.com (cuentas personales)',
  description:
    'El conector de Microsoft 365 de Claude ya admite una cuenta personal de Microsoft en los planes Free, Pro, Max y Ultra. Cuándo basta con eso, y cómo conectar Hotmail, Outlook.com, Live o MSN a Claude con adjuntos, varios buzones o un plan Team mediante una sola URL de conector personalizado.',
  coverAlt: 'Claude conectado a un buzón personal de Outlook.com o Hotmail a través de MCPEmails',
  content: `Hay dos formas de conectar Claude a una dirección personal de Outlook.com, Hotmail, Live o MSN. El conector de Microsoft 365 propio de Claude acepta una cuenta personal de Microsoft en los planes Free, Pro, Max y Ultra, sin que intervenga ningún administrador. La otra vía es MCPEmails: añades el buzón con **Conectar con Microsoft** y después añades una URL a Claude como conector personalizado. Esta segunda vía cubre lo que el conector integrado deja fuera: adjuntos, varios buzones detrás de una sola conexión, los planes Team y Enterprise, y el mismo buzón en ChatGPT o en cualquier otro cliente MCP. Una dirección antigua de hotmail.com funciona igual que una nueva de outlook.com en ambas.

Esta guía trata de las cuentas personales de Microsoft en Claude. Si tu correo es una cuenta de trabajo o educativa de Microsoft 365, consulta en su lugar la [guía de Outlook y Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

## Qué hace el conector de Microsoft 365 de Claude con una cuenta personal

El artículo [Connect to Microsoft 365](https://support.claude.com/en/articles/15183774-connect-to-microsoft-365) de Anthropic ya cubre las cuentas personales. En los planes Free, Pro, Max y Ultra puedes conectar tú mismo una cuenta de Outlook.com, Hotmail, Live o MSN; no hace falta ningún administrador. El conector llega a Outlook y OneDrive, y sus herramientas de escritura vienen incluidas, así que Claude puede redactar y enviar correo y gestionar eventos del calendario después de pedirte permiso.

Tres límites del mismo artículo importan para el correo:

- **Sin adjuntos en las herramientas de escritura.** Claude no puede enviar, reenviar ni redactar un correo con adjunto a través de él.
- **No en Team ni Enterprise.** A esos planes no se les muestra la opción de cuenta personal, así que una dirección personal de Hotmail junto a un plan de trabajo no tiene vía integrada.
- **Solo dentro de Claude, y para la cuenta con la que inicias sesión.** Gmail tiene su propio conector; iCloud, Yahoo y los buzones IMAP no tienen ninguno, y nada se traslada a ChatGPT ni a otro cliente MCP.

Las cuentas de trabajo o educativas son un caso distinto: un administrador global de Microsoft Entra sigue teniendo que dar su consentimiento antes de que nadie de la organización pueda conectarse. La [guía de Outlook y Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp) y la [página de consentimiento del administrador](/docs/microsoft-365-admin-consent) lo explican.

Si lo único que necesitas es un buzón personal de Outlook.com en Claude, sin adjuntos, el conector integrado lo resuelve. El resto de esta guía es la vía para todo lo demás.

## Lo que necesitas

- Una cuenta personal de Microsoft con buzón de Outlook: una dirección de outlook.com, hotmail.com, live.com o msn.com, incluidas las versiones por país como hotmail.es, outlook.es o hotmail.co.uk.
- Claude en la web o Claude Desktop. Anthropic ofrece conectores personalizados en todos los planes de Claude, incluido el gratuito, que permite un conector personalizado.
- Una cuenta de MCPEmails. [Empieza gratis](/signup) y deja la pestaña abierta.

MCPEmails se sitúa entre los dos. Habla con Claude mediante el Model Context Protocol por un lado y con tu buzón de Outlook.com a través de Microsoft Graph por el otro.

## Paso 1: conecta tu buzón de Outlook.com o Hotmail

1. En el panel de MCPEmails, ve a **Bandejas de entrada** y haz clic en **Conectar bandeja de entrada**.
2. Elige **Outlook** y haz clic en **Conectar con Microsoft**.
3. Inicia sesión en la propia página de Microsoft con tu dirección de Outlook.com, Hotmail, Live o MSN, y completa la verificación en dos pasos si tu cuenta la usa.
4. Revisa los permisos y apruébalos. Microsoft te pide permiso para que MCPEmails pueda leer y modificar tu correo, enviar correo en tu nombre, mantener ese acceso y ver tu perfil básico y tu dirección de correo.

Vuelves al panel con el buzón ya conectado. En una cuenta personal no interviene ningún administrador, y nunca escribes tu contraseña de Microsoft en MCPEmails.

### No uses IMAP ni una contraseña de aplicación

Muchas guías antiguas te dicen que crees una contraseña de aplicación y que introduzcas los ajustes IMAP de Outlook. Eso ya no funciona: Microsoft [dejó de aceptar el inicio de sesión con contraseña para las cuentas de Outlook en aplicaciones de correo que no son de Microsoft](https://support.microsoft.com/en-us/office/modern-authentication-methods-now-needed-to-continue-syncing-outlook-email-in-non-microsoft-email-apps-c5d65390-9676-4763-b41f-d7986499a90d) el 16 de septiembre de 2024. Si eliges **IMAP / SMTP** y escribes una dirección de Hotmail u Outlook.com, el panel muestra un aviso con un botón **Usar Iniciar sesión con Microsoft** que te devuelve a la opción de Outlook. La [página de ajustes de Outlook.com](/connect/outlook) reúne los datos del proveedor en un solo sitio.

## Paso 2: añade MCPEmails a Claude como conector personalizado

En claude.ai o Claude Desktop:

1. Abre **Customize → Connectors**.
2. Haz clic en **+ Add** y luego en **Add custom connector**.
3. Ponle un nombre, por ejemplo MCPEmails, y pega esta URL:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Haz clic en **Continue**, deja la configuración de autenticación que detecta Claude y haz clic en **Add**.
5. Haz clic en **Connect**, inicia sesión en tu cuenta de MCPEmails y aprueba los permisos que quieras darle a Claude, por ejemplo \`read:email\` para leer el correo y \`send:email\` para enviarlo.

Para usarlo en un chat, haz clic en **+** en la esquina inferior izquierda del cuadro de mensaje, elige **Connectors** y activa MCPEmails. No hay que crear ninguna clave de API ni editar ningún archivo de configuración. En un plan Team o Enterprise, solo un propietario puede añadir un conector personalizado; los miembros lo encuentran después en **Customize → Connectors** y hacen clic en **Connect**. Si Claude se queda atascado en alguna de estas pantallas, la [página de configuración de Claude](/docs/claude) cubre los problemas habituales.

## Paso 3: pídele a Claude algo sencillo

Empieza con una petición de solo lectura:

> Resume los cinco correos no leídos más recientes de mi bandeja de Hotmail y dime cuáles necesitan respuesta.

Claude usa la herramienta \`email_read\` para listar y abrir los mensajes. Si responde, la conexión funciona. Después prueba con:

- "Busca la confirmación del pedido que recibí la semana pasada y dime la fecha de entrega."
- "Redacta una respuesta al último correo de mi casero, pero no la envíes."
- "Mueve todos los boletines de este mes a una carpeta llamada Lectura."

Si además tienes Gmail, iCloud o un buzón del trabajo, conéctalos de la misma forma y Claude los verá todos a través del mismo conector. [Varias cuentas de correo en Claude y ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) explica cómo Claude las mantiene separadas.

## Qué puede hacer Claude con un buzón de Outlook.com

Una vez conectado, Claude trabaja con las mismas herramientas de correo que usa con cualquier otro proveedor:

- Leer y buscar correo.
- Enviar, responder y reenviar desde tu propia dirección, con adjuntos.
- Crear y editar borradores, y programar un envío para más tarde.
- Crear carpetas, también anidadas, y mover, copiar y archivar mensajes.
- Marcar mensajes con bandera y marcarlos como leídos o no leídos.
- Mover mensajes a Elementos eliminados o eliminarlos de forma permanente.
- Añadir la firma que configuraste para ese buzón a cada mensaje que envía.

Outlook.com organiza el correo en carpetas, no en etiquetas, así que Claude ordena el correo moviéndolo a una carpeta. Conviene conocer un límite de Microsoft Graph: una búsqueda de texto no se puede combinar con los filtros de no leído, con adjunto, con bandera o de fecha. Cuando una búsqueda incluye texto, esos filtros se descartan, y el resultado le indica a Claude cuáles. Pide primero el texto y deja que Claude acote los resultados.

MCPEmails no envía el correo nuevo a Claude por iniciativa propia. Claude lo comprueba cuando se lo pides, algo que encaja bien con el triaje y los resúmenes.

## ¿Se guarda mi correo de Outlook.com en algún sitio?

No. Cada vez que Claude pide un mensaje, MCPEmails lo obtiene en directo de Microsoft, se lo entrega a Claude y lo descarta. Del buzón se guarda el token OAuth de tu inicio de sesión con Microsoft, cifrado en reposo, además de los pocos datos que necesita una función que actives, como un mensaje programado que espera a enviarse. Para desconectarlo, elimina el buzón en MCPEmails o quita MCPEmails de las aplicaciones que tienen acceso a tu cuenta de Microsoft. [Por qué importa que el correo nunca se almacene](/blog/why-email-never-stored-matters) explica el modelo, y [¿es seguro dar a un agente de IA acceso a tu correo?](/blog/is-it-safe-to-give-ai-agent-email-access) repasa en qué fijarse, como las instrucciones ocultas dentro de un correo.

## Preguntas frecuentes

**¿Puedo conectar Claude con Outlook.com o Hotmail?**
Sí, de dos formas. En Free, Pro, Max o Ultra, el conector de Microsoft 365 integrado en Claude acepta directamente una cuenta personal de Microsoft, sin adjuntos. Para adjuntos, varios buzones, un plan Team o Enterprise, o el mismo buzón en ChatGPT, conecta la dirección a MCPEmails con Conectar con Microsoft, añade \`https://mcpemails.com/api/mcp\` a Claude en Customize → Connectors, y Claude podrá leer, buscar, enviar y organizar tu correo de Outlook.com, Hotmail, Live o MSN.

**¿Por qué el conector de Microsoft 365 de Claude rechaza mi dirección de Hotmail?**
Comprueba el plan. Anthropic dice que las cuentas personales de Microsoft se conectan en Free, Pro, Max y Ultra, y que a los planes Team y Enterprise no se les muestra esa opción. Una dirección de trabajo o educativa es otro caso: necesita que un administrador global de su inquilino de Microsoft Entra dé antes su consentimiento. En un plan Team o Enterprise, MCPEmails como conector personalizado es la vía para una dirección personal.

**¿Necesito una contraseña de aplicación o los ajustes IMAP?**
No. Las cuentas personales de Microsoft se conectan con Iniciar sesión con Microsoft y Microsoft Graph. Microsoft ya no acepta el inicio de sesión con contraseña desde aplicaciones de correo que no son de Microsoft en estas cuentas, así que una contraseña de aplicación tampoco serviría para iniciar sesión.

**¿Funciona con una dirección antigua de Hotmail?**
Sí. Las direcciones de Hotmail, Live, MSN y Outlook.com son el mismo servicio de correo de consumo de Microsoft, así que todas se conectan igual. Si la cuenta de Microsoft con la que inicias sesión no tiene un buzón de Outlook detrás, MCPEmails rechaza la conexión y te lo indica.

**¿La misma configuración sirve en ChatGPT?**
Sí. La URL del conector es la misma, y [cómo conectar ChatGPT a tu correo](/blog/connect-chatgpt-to-email) explica paso a paso la parte de ChatGPT.

## Siguiente paso

[Empieza gratis](/signup), conecta tu buzón de Outlook.com o Hotmail con Microsoft, añade la URL a Claude y pídele que resuma tu correo no leído. Para cualquier otro proveedor, la [guía de configuración del correo en Claude](/blog/connect-claude-to-email) cubre Gmail, iCloud, Fastmail e IMAP.`,
};

export default translation;
