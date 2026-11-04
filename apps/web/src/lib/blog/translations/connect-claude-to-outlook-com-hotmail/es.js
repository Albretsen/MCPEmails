const translation = {
  title: 'Cómo conectar Claude con Hotmail y Outlook.com (cuentas personales)',
  description:
    'El conector de Microsoft 365 de Claude no admite cuentas personales de Microsoft. Conecta un correo de Hotmail, Outlook.com, Live o MSN a Claude con Iniciar sesión con Microsoft y una sola URL de conector personalizado.',
  coverAlt: 'Claude conectado a un buzón personal de Outlook.com o Hotmail a través de MCPEmails',
  content: `Para conectar Claude a una dirección personal de Outlook.com, Hotmail, Live o MSN, añades el buzón a MCPEmails con **Conectar con Microsoft** y después añades una URL a Claude como conector personalizado. El conector de Microsoft 365 propio de Claude exige un inquilino (tenant) empresarial de Microsoft, y Anthropic indica que las cuentas personales de Microsoft no se pueden usar con él. Un conector personalizado no tiene ese requisito, así que una dirección antigua de hotmail.com funciona igual que una nueva de outlook.com.

Esta guía trata de las cuentas personales de Microsoft en Claude. Si tu correo es una cuenta de trabajo o educativa de Microsoft 365, consulta en su lugar la [guía de Outlook y Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

## Por qué el conector de Microsoft 365 de Claude rechaza las cuentas personales

La [página de ayuda del conector de Microsoft 365](https://support.claude.com/en/articles/12542951-enabling-and-using-the-microsoft-365-connector) de Anthropic pone dos condiciones antes de que nadie pueda conectarse:

- La cuenta tiene que pertenecer a un inquilino de Microsoft Entra vinculado a un plan Microsoft Business.
- Un administrador global de ese inquilino tiene que autorizar antes la integración.

La misma página dice que las cuentas personales de Microsoft, como las direcciones @outlook.com o @hotmail.com, no se pueden usar para conectarse. Una cuenta personal no tiene detrás ni un inquilino empresarial ni un administrador, así que no hay nada que aprobar ni ningún ajuste que puedas cambiar para que funcione. El conector está pensado para organizaciones: busca en SharePoint, OneDrive, Outlook y Teams, y sus permisos son de solo lectura hasta que un administrador activa las herramientas de escritura.

A tu buzón no le pasa nada. Claude solo necesita otro camino para llegar a él.

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
Sí. El conector de Microsoft 365 integrado en Claude no admite cuentas personales de Microsoft, pero un conector personalizado sí. Conecta la dirección a MCPEmails con Conectar con Microsoft, añade \`https://mcpemails.com/api/mcp\` a Claude en Customize → Connectors, y Claude podrá leer, buscar, enviar y organizar tu correo de Outlook.com, Hotmail, Live o MSN.

**¿Por qué el conector de Microsoft 365 de Claude rechaza mi dirección de Hotmail?**
La página de ayuda de Anthropic dice que ese conector necesita un inquilino de Microsoft Entra vinculado a un plan Microsoft Business y un administrador global que lo autorice, y que las cuentas personales de Microsoft no se pueden usar. Una cuenta personal no tiene inquilino ni administrador.

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
