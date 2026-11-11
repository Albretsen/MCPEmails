const translation = {
  title: 'Cómo conectar cualquier cuenta de correo a Claude o ChatGPT (Yahoo, IMAP, dominio propio, varios buzones)',
  description:
    'Todas las formas de darle a Claude o ChatGPT un buzón real a noviembre de 2026: qué cubren los conectores integrados de Gmail, Outlook e iCloud, dónde se quedan cortos, y cómo conectar Yahoo, un dominio propio, GMX o varios buzones con un servidor MCP, una app de escritorio o una herramienta de automatización.',
  coverAlt: 'Yahoo, IMAP, dominio propio y varios buzones más conectados a Claude y ChatGPT',
  content: `Claude y ChatGPT traen conectores de correo integrados, y los dos se detienen en los grandes proveedores. Si tu correo está en Yahoo, AOL, GMX, en un dominio de empresa alojado en IONOS, OVH o un hosting con cPanel, o repartido en varias cuentas, necesitas otra cosa. Esta guía recoge todas las opciones a noviembre de 2026: los conectores integrados y exactamente dónde terminan, los servicios MCP alojados que cubren el hueco (MCPEmails es uno de ellos, y nombramos a los demás), las vías locales y autoalojadas, y las plataformas de automatización. Cada afirmación sobre otro producto se leyó en su propia página el 11 de noviembre de 2026; las fuentes están al final.

**Ir a:** [Conectores integrados](#qué-cubren-los-conectores-integrados) · [Lo que queda fuera](#qué-dejan-fuera-los-conectores-integrados) · [Servicios MCP alojados](#servicios-mcp-alojados) · [Escritorio y autoalojado](#apps-de-escritorio-y-servidores-autoalojados) · [Herramientas de automatización](#plataformas-de-automatización) · [Tabla comparativa](#las-opciones-lado-a-lado) · [Configuración con MCPEmails](#cómo-hacerlo-con-mcpemails) · [FAQ](#faq)

## Qué cubren los conectores integrados

Empieza aquí, porque si tu único buzón es Gmail, una cuenta de trabajo de Microsoft 365 o iCloud, quizá no necesites nada más.

**Claude: Gmail.** El conector de Gmail del directorio de Claude lo hace Google. Lee y busca correo, redacta, envía, responde, reenvía, gestiona etiquetas y mueve mensajes a la papelera, y por defecto Claude pide tu aprobación antes de cada una de esas acciones. El centro de ayuda de Anthropic lo describe como que llega a "the Google account you've connected": una cuenta de Google por conexión. Los adjuntos solo llegan como metadatos. Está disponible para todos los usuarios de Claude; en Team y Enterprise lo activa primero un propietario.

**Claude: Microsoft 365 y Outlook.com personal.** Dos casos. Una cuenta de trabajo o educativa necesita un tenant de Microsoft Entra, un consentimiento único de un Global Administrator, y es de solo lectura hasta que la organización activa las herramientas de escritura. Una cuenta personal de Microsoft (Outlook.com, Hotmail, Live o MSN) se conecta en los planes Free, Pro, Max y Ultra sin administrador, con las herramientas de escritura incluidas, así que Claude puede redactar, enviar y organizar correo y pregunta antes de hacerlo; esta opción no aparece en Team y Enterprise, y las herramientas de escritura no manejan adjuntos.

**Claude: Spark.** El conector de Spark Mail figura en el directorio de Claude y es la única vía integrada hacia Yahoo o IMAP en Claude, con una pega: lee las cuentas que has añadido a la app de escritorio de Spark, y las herramientas solo existen mientras Spark Desktop está abierto en tu Mac o PC. Más en [apps de escritorio](#apps-de-escritorio-y-servidores-autoalojados).

**ChatGPT: Gmail y Outlook.** Las dos son apps en **Settings**, luego **Plugins**. Desde junio de 2026 ChatGPT puede redactar y enviar desde una cuenta conectada de Gmail u Outlook, en la web, para Plus, Pro, Business y Enterprise. Desde agosto de 2026 el plugin de Gmail puede tener varias cuentas de Google, y OpenAI extendió después las cuentas múltiples a otros plugins en todos los planes. La app Outlook Email está documentada para cuentas de trabajo de Microsoft: lo que puede hacer depende del consentimiento de Microsoft Entra y de la configuración del espacio de trabajo, y puede leer, mover y enviar texto sin formato desde un buzón compartido o delegado al que ya tengas acceso. La página de OpenAI no describe las cuentas personales de Outlook.com; [Conectar ChatGPT a Outlook.com y Hotmail](/blog/connect-chatgpt-to-outlook-com-hotmail) cubre lo que la gente se encuentra.

**ChatGPT: iCloud Mail.** Añadido el 27 de octubre de 2026 y desplegándose a todos los planes de ChatGPT en la web, la app de escritorio e iOS. Inicia sesión con una contraseña específica de app de Apple y acepta una dirección que termine en @icloud.com, @me.com o @mac.com, así que una cuenta de Gmail o Yahoo que convive con iCloud en Apple Mail no entra. La búsqueda de contactos es de solo lectura. Detalles en [el plugin de iCloud Mail de ChatGPT](/blog/chatgpt-icloud-mail-plugin).

**El servidor MCP de tu propio proveedor.** Fastmail tiene uno en \`api.fastmail.com/mcp\`, con acceso separado de lectura, escritura y envío, sin acceso a adjuntos, y una cuenta de Fastmail por conexión en Claude. Zoho Mail también tiene uno, gratis en los planes gratuitos y de pago de Zoho, con envío, respuesta, etiquetas, marcas y carpetas, y puede incluir herramientas de otros servicios de Zoho. Cada uno sirve los buzones que ese proveedor aloja, y cada uno se añade a Claude o ChatGPT como conector personalizado.

## Qué dejan fuera los conectores integrados

Junta la lista anterior y estos son los buzones sin vía integrada en ninguno de los dos asistentes:

- **Yahoo Mail y AOL.** Sin conector en Claude, sin plugin en ChatGPT.
- **Un dominio propio en un hosting web o de correo.** cPanel y hosting compartido, IONOS, OVH, Namecheap, GoDaddy, Hostinger, STRATO, one.com, Migadu y el resto. Son buzones IMAP y SMTP, y ninguno de los asistentes habla IMAP.
- **Proveedores regionales.** GMX, web.de, T-Online, Orange, Libero, Seznam, Yandex, mail.ru y similares.
- **Varios buzones en una sola conexión.** El plugin de Gmail de ChatGPT puede tener varias cuentas de Google, y ChatGPT te deja conectar varias apps en paralelo. Ninguno de los asistentes tiene una forma integrada de llegar a un Gmail, un Yahoo y un buzón IMAP de empresa a través de una conexión que sepa cuál es cuál.
- **Outlook.com personal en ChatGPT.** Documentado para Claude en los planes personales; no descrito en la página de Outlook de OpenAI.
- **Clientes distintos de Claude y ChatGPT.** Cursor, Codex, Gemini CLI, VS Code, Zed y otros clientes MCP no tienen conector de correo propio. Todo lo que sea un servidor MCP estándar funciona en ellos; un conector que vive dentro de un asistente, no.

El resto de esta guía trata de cubrir esa lista.

## Servicios MCP alojados

Un servidor MCP de correo alojado inicia sesión en tu buzón por ti, por IMAP y SMTP o por la API del proveedor, y expone el buzón a cualquier cliente MCP a través de una URL. Añades esa URL a Claude como conector personalizado y a ChatGPT como servidor MCP personalizado. Los de abajo hacen todos eso; se diferencian en proveedores, alojamiento y precio. Nuestra comparativa clasificada y fechada, con los puntos débiles de cada uno, es [los mejores servidores MCP de correo](/best-email-mcp-servers).

- **MCPEmails** (este sitio). Gmail y Google Workspace con una contraseña de aplicación de Google, Outlook.com y Microsoft 365 con Iniciar sesión con Microsoft, iCloud, Fastmail, Yahoo, AOL, Zoho, Yandex y cualquier servidor IMAP y SMTP con contraseña de aplicación o contraseña del correo. Varios buzones de cualquier mezcla tras una URL, cada uno enviando desde su propia dirección. Funciona en Claude, ChatGPT, Cursor, Codex y los demás [clientes compatibles](/docs/clients). Una retención por buzón puede dejar cada envío esperando tu aprobación. El correo se obtiene en vivo y no se almacena.
- **Mailbox MCP** (mailbox-mcp.com). Microsoft 365 y Outlook.com con inicio de sesión de Microsoft, Gmail con contraseña de aplicación, iCloud y cualquier servidor IMAP, con guías de configuración para Yahoo y GMX/WEB.DE. Funciona en Claude, ChatGPT, Grok, Cursor, VS Code, Zed, Windsurf, Cline y otros. Niveles de acceso por conexión, desde solo lectura hasta enviar y eliminar. Varios buzones, cada uno con su propio plan. Añade herramientas de calendario y libreta de direcciones.
- **MailMCP** (mailmcp.io). Cualquier proveedor que admita IMAP y SMTP, con ajustes de servidor detectados para los habituales. Funciona en Claude, ChatGPT, Cursor, VS Code, Windsurf, n8n y LibreChat. Envía, y puede programar un envío. Varias cuentas desde un panel, cada una con sus propias credenciales. Datos alojados en Francia.
- **Mailopoly** (mailopoly.com). Una app de correo con bandeja unificada para Gmail, Outlook, iCloud, Yahoo e IMAP, cuyo servidor MCP viene con la app. Figura en los directorios de Claude y ChatGPT, y funciona cualquier cliente de servidores MCP remotos. El envío está detrás de un permiso y se marca como confirmar primero. Una conexión cubre todas las cuentas que tengas.

Los cuatro ponen a un tercero entre el asistente y tu buzón, así que lee cómo trata cada uno las credenciales y el contenido de los mensajes antes de elegir. [¿Es seguro dar a un agente de IA acceso al correo?](/blog/is-it-safe-to-give-ai-agent-email-access) es nuestra opinión sobre qué mirar.

## Apps de escritorio y servidores autoalojados

Si prefieres que el correo se quede en tu propia máquina, hay tres vías.

- **Una app de correo de escritorio con conector MCP.** El conector de Spark para Claude (Spark Mail Limited, Anthropic verified) expone "any Spark email account, including Gmail, Outlook, Exchange, iCloud, Yahoo, and IMAP", con un nivel por cuenta (solo lectura, triaje o envío) que se fija en **Spark Desktop, Settings, AI Agents**. Puede responder, reenviar y programar. La limitación está en el diseño: las herramientas solo aparecen mientras Spark Desktop está abierto, así que sirve para Claude en el ordenador en el que trabajas, no para una tarea programada ni para el móvil. Es un conector de Claude, no un servidor que otros clientes puedan usar.
- **Un servidor IMAP de código abierto que ejecutas tú.** Wh1isper/mcp-email-server es un servidor IMAP y SMTP multicuenta, BSD-3-Clause, que se arranca con \`uvx\` o un contenedor y se configura desde una interfaz local. Tus credenciales y tu correo nunca salen de la máquina. Claude Desktop y la mayoría de herramientas de programación pueden ejecutar un servidor local; Claude en la web y ChatGPT solo se conectan a servidores remotos, así que esta vía es para el escritorio.
- **MCPEmails autoalojado.** El mismo servidor que ejecuta mcpemails.com es código abierto bajo AGPL-3.0. [Ejecútalo tú mismo](/self-hosting) con tu propia base de datos y clave de cifrado, con claves API acotadas por cliente. Claude y ChatGPT solo llegan a él cuando tiene una dirección HTTPS pública.

## Plataformas de automatización

Zapier y Make exponen ahora sus catálogos de apps a los clientes MCP, lo que da a Claude o ChatGPT una forma de actuar sobre un buzón a través de un flujo de trabajo en vez de una conexión al buzón.

- **Zapier MCP** funciona con Claude, ChatGPT, Cursor "and any other AI client", en más de 9.000 apps. Gmail está entre ellas, y la app de Microsoft Outlook lista Send Email, Find Emails y Create Draft Email como herramientas MCP. Está incluido en todos los planes de Zapier, y cada llamada a una herramienta consume dos tareas de tu cuota. La página que leímos lista las apps por nombre y no describe un buzón IMAP genérico.
- **Make MCP** funciona con ChatGPT, Claude, Cursor y cualquier agente MCP. Construyes un escenario en Make (una búsqueda en Gmail u Outlook, un envío) y el escenario se convierte en una herramienta que el asistente puede llamar. Está incluido en todos los planes de Make, el gratuito también, y pagas las operaciones que usan los escenarios.

Encajan cuando el correo es un paso de una automatización mayor que ya tienes en Zapier o Make. Para una conversación sobre tu bandeja ("¿qué necesita respuesta hoy?"), una conexión al buzón es la mejor herramienta, porque el asistente puede buscar, leer y hacer seguimiento sin un escenario por cada pregunta.

## Las opciones lado a lado

| Opción | Qué buzones | Qué apps de IA | Envía | Varios buzones |
| --- | --- | --- | --- | --- |
| Conector de Gmail de Claude | Una cuenta de Google | Claude | Sí, pregunta antes | No |
| Conector de Microsoft 365 de Claude | Cuentas de trabajo de Entra; Outlook.com, Hotmail, Live, MSN personales en Free, Pro, Max, Ultra | Claude | Trabajo: cuando el administrador activa las herramientas de escritura. Personal: sí | No |
| Apps de Gmail y Outlook de ChatGPT | Cuentas de Google; cuentas de trabajo de Microsoft, buzones compartidos y delegados | ChatGPT | Sí, en la web, Plus en adelante | Gmail: varias cuentas de Google |
| Plugin de iCloud Mail de ChatGPT | iCloud (@icloud.com, @me.com, @mac.com) | ChatGPT | Sí | No indicado |
| Servidor MCP de Fastmail o Zoho | Los buzones de ese proveedor | Cualquier cliente MCP | Sí | Fastmail en Claude: una cuenta. Zoho: si el cliente permite varias conexiones |
| Conector de Spark | Cualquier cuenta en Spark Desktop, Yahoo e IMAP incluidos, mientras la app está abierta | Claude | Sí, nivel por cuenta | Sí |
| MCPEmails | Gmail, Outlook y Microsoft 365, iCloud, Fastmail, Yahoo, AOL, Zoho, Yandex, cualquier IMAP | Claude, ChatGPT, Cursor, Codex, cualquier cliente MCP | Sí, retención opcional para aprobación | Sí, una URL |
| Mailbox MCP | Microsoft 365 y Outlook.com, Gmail, iCloud, cualquier IMAP | Claude, ChatGPT, Grok, Cursor, VS Code, Zed, Windsurf, Cline | Sí, nivel por conexión | Sí, por buzón |
| MailMCP | Cualquier proveedor IMAP y SMTP | Claude, ChatGPT, Cursor, VS Code, Windsurf, n8n, LibreChat | Sí, también programado | Sí |
| Mailopoly | Gmail, Outlook, iCloud, Yahoo, IMAP | Claude, ChatGPT, cualquier cliente de MCP remoto | Sí, tras un permiso | Sí |
| Wh1isper/mcp-email-server (autoalojado) | Cualquier proveedor IMAP y SMTP | Clientes MCP locales | Sí | Sí |
| Zapier MCP, Make MCP | Las apps de sus catálogos, Gmail y Outlook entre ellas | Claude, ChatGPT, Cursor, cualquier cliente MCP | Sí, mediante una acción o un escenario | Por conexión de app |

"No indicado" significa que la página que leímos no lo decía en ningún sentido. Los planes y precios se dejan fuera a propósito: cambian, y la página de precios de cada proveedor es el sitio para leerlos.

## Cómo hacerlo con MCPEmails

Tres pasos, unos cinco minutos, y el resultado funciona en Claude y ChatGPT a la vez.

1. **Conecta el buzón.** [Crea una cuenta gratis](/signup), abre **Bandejas**, haz clic en **Conectar bandeja** y elige el proveedor. [Yahoo Mail](/connect/yahoo) y [AOL](/connect/aol) usan una contraseña de aplicación de la página Account Security. Una dirección de empresa en un hosting entra como [IMAP](/connect/imap): escribes la dirección y los ajustes del servidor se rellenan para la mayoría de hosts, con una página propia para [cPanel](/connect/cpanel), [IONOS](/connect/ionos), [OVH](/connect/ovh), [Namecheap](/connect/namecheap) y [GoDaddy](/connect/godaddy). Los lectores alemanes tienen [GMX](/connect/gmx), [web.de](/connect/web-de) y [T-Online](/connect/t-online). Todas las páginas de [connect](/connect) listan los hosts que conocemos. Repite por cada buzón; el plan decide cuántos caben.
2. **Añade el conector a tu app de IA.** En Claude, abre **Customize**, luego **Connectors**, haz clic en **+ Add**, elige **Add custom connector** y pega \`https://mcpemails.com/api/mcp\`. En ChatGPT, en chatgpt.com desde un navegador con un plan de pago, abre **Plugins**, haz clic en el botón más, elige **Add custom MCP server**, pega la misma URL y elige OAuth; la página de ayuda de OpenAI tiene las reglas de plan vigentes. Las páginas por cliente ([Claude](/docs/claude), [ChatGPT](/docs/chatgpt), [Cursor](/docs/cursor), [Codex](/docs/codex) y [el resto](/docs/clients)) tienen capturas y los errores habituales.
3. **Pregunta.** "Lista mi correo de Yahoo sin leer de hoy" o "busca en ventas@ e info@ cualquier cosa de esta semana que nadie haya respondido". El asistente llama primero a \`inbox_list\`, así que sabe qué buzón es cuál, y cada respuesta sale del buzón al que pertenece.

Activa **Revisar antes de enviar** (Review before sending) en cualquier buzón y cada envío desde él espera tu aprobación en el panel. Está incluido en todos los planes.

## FAQ

### ¿Puedo conectar Yahoo Mail a Claude o ChatGPT?

No con sus conectores integrados: a noviembre de 2026 los conectores de correo de Claude cubren Gmail y cuentas de Microsoft, y los plugins de ChatGPT cubren Gmail, Outlook e iCloud Mail. Yahoo se conecta a través de un servidor MCP como MCPEmails, con una contraseña de aplicación de Yahoo, o a través del conector de Spark en Claude mientras Spark Desktop está abierto. [Yahoo Mail en ChatGPT y Claude](/blog/connect-yahoo-mail-to-chatgpt-and-claude) tiene los pasos.

### ¿Cómo conecto a Claude un buzón de dominio propio en cPanel, IONOS u OVH?

Por IMAP. Ni Claude ni ChatGPT hablan IMAP por sí mismos, así que conectas el buzón a un servidor MCP que sí lo hace (MCPEmails, Mailbox MCP, MailMCP o un servidor que ejecutes tú) y añades ese servidor a Claude como conector personalizado. Con MCPEmails escribes la dirección, los ajustes del host se rellenan, y las páginas de [cPanel](/connect/cpanel), [IONOS](/connect/ionos) y [OVH](/connect/ovh) cubren lo que exige cada host.

### ¿Pueden Claude o ChatGPT leer varias cuentas de correo a la vez?

El plugin de Gmail de ChatGPT puede tener varias cuentas de Google. Para una mezcla de proveedores, o para Claude, necesitas un servidor MCP que tenga todos los buzones: MCPEmails, Mailbox MCP, MailMCP, Mailopoly y los servidores autoalojados lo hacen, y el asistente nombra el buzón en cada llamada. [Varias cuentas de correo en Claude y ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) muestra cómo el asistente las distingue.

### ¿Funciona Claude con una cuenta personal de Outlook.com o Hotmail?

Sí, a noviembre de 2026. El centro de ayuda de Anthropic dice que una cuenta personal de Microsoft (Outlook.com, Hotmail, Live o MSN) se conecta en los planes Free, Pro, Max y Ultra sin administrador, con las herramientas de escritura incluidas. La opción no aparece en Team y Enterprise. Un servidor MCP como MCPEmails también conecta Outlook.com con Iniciar sesión con Microsoft, y entonces el mismo buzón funciona también en ChatGPT y otros clientes.

### ¿Necesito la contraseña de mi correo?

Normalmente no la principal. Yahoo, AOL, iCloud, Gmail, Fastmail y Zoho emiten una contraseña de aplicación para otras apps, y un buzón en un hosting usa la contraseña propia del buzón. La app de IA nunca la ve: el servidor MCP la guarda cifrada y tu app de IA inicia sesión en el servidor con OAuth. [¿Qué es una contraseña de aplicación?](/blog/what-is-an-app-password) explica dónde la esconde cada proveedor.

### ¿Puedo usar la misma bandeja en Cursor, Codex u otro cliente MCP?

Sí, si la bandeja está detrás de un servidor MCP estándar. Una URL de MCPEmails, Mailbox MCP o MailMCP funciona en Claude, ChatGPT, Cursor, Codex, VS Code y el resto. Un conector que vive dentro de un asistente, como el conector de Gmail de Claude o el plugin de iCloud de ChatGPT, se queda en ese asistente.

### ¿El servidor MCP almacena mi correo?

Depende del servicio, así que lee la página de privacidad de cada uno. MCPEmails obtiene cada mensaje en vivo de tu proveedor cuando el asistente lo pide y no lo almacena; solo se guarda la credencial cifrada, más un mensaje que programes o retengas para aprobación hasta que se envía. Mailopoly es una app de correo, así que tus cuentas se sincronizan en ella. Las opciones autoalojadas lo mantienen todo en tu máquina.

## Fuentes

Leídas el 11 de noviembre de 2026: los artículos de ayuda de Anthropic sobre [los conectores de Google Workspace](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors), [el conector de Microsoft 365 para organizaciones](https://support.claude.com/en/articles/12542951-enabling-and-using-the-microsoft-365-connector) y [la conexión a Microsoft 365](https://support.claude.com/en/articles/15183774-connect-to-microsoft-365); las fichas de [Gmail](https://claude.com/connectors/gmail) y [Spark](https://claude.com/connectors/spark) en el directorio de Claude; las páginas de OpenAI sobre [apps conectadas](https://help.openai.com/en/articles/11487775-connected-apps-in-chatgpt), [las apps Outlook Email y Calendar](https://help.openai.com/en/articles/12512241-outlook-email-and-calendar-apps-in-chatgpt), [servidores MCP personalizados](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt) y las [notas de versión](https://help.openai.com/en/articles/6825453-chatgpt-release-notes); [el artículo MCP de Fastmail](https://www.fastmail.help/hc/en-us/articles/15869557281295); [Zoho Mail MCP](https://www.zoho.com/mail/help/mcp/getting-started.html); [Mailbox MCP](https://mailbox-mcp.com/), [MailMCP](https://mailmcp.io/en/features) y [Mailopoly](https://www.mailopoly.com/mcp/); [Wh1isper/mcp-email-server](https://github.com/Wh1isper/mcp-email-server); [Zapier MCP](https://zapier.com/mcp) y su [app de Outlook](https://zapier.com/apps/mcp-client-by-zapier/integrations/microsoft-outlook); [Make MCP](https://www.make.com/en/mcp). Si algo de esto ha cambiado desde entonces, [avísanos](/help) y actualizaremos la página.

## Siguiente paso

[Empieza gratis](/signup), conecta el buzón que los conectores integrados no aceptaban y pega una URL en Claude o ChatGPT. La comparativa de [conectores integrados y servidores MCP](/native-connectors-vs-mcp) profundiza en la decisión.`,
};

export default translation;
