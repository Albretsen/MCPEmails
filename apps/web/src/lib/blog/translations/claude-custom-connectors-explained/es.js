const translation = {
  title: 'Conectores personalizados de Claude: planes, configuración, OAuth y seguridad',
  description:
    'Qué son los conectores personalizados de Claude, qué planes y apps los admiten, cómo añadir un servidor MCP remoto por URL, inicio de sesión, controles de administrador y seguridad.',
  coverAlt: 'Conectores personalizados de Claude: un servidor MCP remoto añadido a Claude mediante su URL',
  content: `Los **conectores personalizados de Claude** (custom connectors) te permiten añadir a Claude cualquier servidor remoto del [Model Context Protocol](https://modelcontextprotocol.io) con solo pegar su URL. Una vez añadido, Claude puede llamar a las herramientas de ese servidor en tus chats: consultar una base de datos, abrir una incidencia o, en el ejemplo práctico del final de esta guía, leer y enviar tu correo.

Los detalles sobre planes y menús proceden de las páginas de ayuda de Anthropic, revisadas el 26 de octubre de 2026. La interfaz de Claude cambia con frecuencia, así que si una etiqueta no coincide, la referencia es la [guía de conectores personalizados de Anthropic](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

## Qué es un conector personalizado de Claude

Un conector personalizado de Claude es un servidor MCP remoto que añades a Claude mediante su URL, en lugar de elegirlo en el directorio de conectores (Connectors Directory). El servidor funciona en internet, expone un conjunto de herramientas y normalmente te pide iniciar sesión con OAuth. Después, Claude llama a esas herramientas en tu nombre, dentro de los permisos que hayas aprobado.

Conviene tener claras tres cosas desde el principio:

- **Anthropic no verifica los conectores personalizados.** Los conectores del directorio llevan las etiquetas Verified o Community. Un conector que añades por URL conecta Claude con un servicio que Anthropic no ha revisado, así que confías en quien gestiona el servidor.
- **La conexión sale de la nube de Anthropic, no de tu ordenador.** Según Anthropic, esto se cumple en todos los clientes de Claude, incluidos claude.ai, Claude Desktop, Cowork y las apps móviles. El servidor tiene que ser accesible desde internet. Un servidor en una red privada o detrás de una VPN no se conectará, salvo que su firewall permita los rangos de IP de Anthropic o se acceda a él a través de lo que Anthropic llama un túnel MCP (MCP tunnel).
- **Se añade una vez por cuenta, no una vez por dispositivo.**

Si MCP es nuevo para ti, [qué es un servidor MCP de correo](/blog/what-is-an-mcp-email-server) explica el protocolo con el correo como ejemplo.

## En qué se diferencian de los conectores del directorio y las extensiones de escritorio

Claude tiene tres formas de acceder a una herramienta externa:

- **Conectores del directorio:** aparecen en el directorio de conectores de Claude. Los encuentras en **Customize → Connectors** y haces clic en **Connect**. Los conectores de Gmail y Microsoft 365 de Claude pertenecen a este grupo.
- **Conectores personalizados:** servidores MCP remotos que añades por URL. Son el tema de esta guía.
- **Extensiones de escritorio:** servidores MCP locales empaquetados como archivos \`.mcpb\` que se instalan en **Settings → Extensions** de la app de escritorio de Claude. Se ejecutan en tu propio ordenador. Los servidores locales configurados en \`claude_desktop_config.json\` son a su vez un mecanismo distinto y no están disponibles en claude.ai ni en Cowork.

Claude Code añade el mismo tipo de servidor remoto desde la terminal; la [página de configuración de Claude Code](/docs/claude-code) muestra el comando para MCPEmails. Para ver cómo se comportan de forma distinta un servidor MCP general y un conector integrado de un solo proveedor, consulta [conectores nativos y MCP comparados](/native-connectors-vs-mcp).

## Qué planes y apps de Claude admiten conectores personalizados

Según el centro de ayuda de Anthropic, a fecha de octubre de 2026:

- **Planes:** los conectores personalizados están disponibles en Free, Pro, Max, Team y Enterprise. El plan Free está limitado a un conector personalizado; Pro y Max no tienen límite.
- **Apps donde se añaden:** claude.ai en la web, Claude Desktop y Cowork.
- **Móvil:** un conector que conectas en la web o en Claude Desktop pasa a estar disponible en Claude para iOS y Android la próxima vez que inicies sesión allí. Anthropic describe la instalación de conectores en el móvil como una beta y considera la web y la app de escritorio la vía principal para los conectores personalizados, así que configúralo primero en un ordenador.
- **Quién puede añadirlo en un plan de empresa:** en los planes Team, solo los Owners y Primary Owners. En los planes Enterprise, los Owners, los Primary Owners y las personas con un rol personalizado que incluya gestionar las bibliotecas de la organización.

## Cómo añadir un conector personalizado en Free, Pro o Max

1. Abre **Customize → Connectors** en claude.ai o en Claude Desktop.
2. Haz clic en **+ Add** y después en **Add custom connector**.
3. Escribe un nombre y la URL del servidor, y haz clic en **Continue**.
4. Revisa los ajustes de inicio de sesión que ha detectado Claude. Los valores predeterminados suelen ser correctos, y la siguiente sección explica las opciones.
5. Haz clic en **Add** y después inicia sesión en el servicio.

Los ajustes de autenticación de un conector no se pueden cambiar después de añadirlo. Para modificarlos, elimina el conector y vuelve a añadirlo. Para eliminarlo, abre **Customize → Connectors** y usa **Remove** o el menú de tres puntos que aparece junto a él.

## Cómo añaden conectores personalizados las organizaciones en Team y Enterprise

En los planes Team y Enterprise, añadir un conector y conectarse a él son dos pasos distintos:

1. **Un Owner lo añade para la organización.** Abre **Organization settings → Connectors**, haz clic en **Add**, elige **Custom** y después **Web** si Claude pide un tipo. Introduce el nombre y la URL y completa las mismas pantallas de autenticación.
2. **Cada miembro se conecta con su propia cuenta.** Los miembros abren **Customize → Connectors**, buscan el conector, que suele llevar la etiqueta **Custom**, y hacen clic en **Connect**.

Como cada persona inicia sesión por separado, Claude solo accede a aquello a lo que esa persona tiene acceso en el servicio conectado. La excepción es un conector configurado con una credencial compartida, como una clave de API: todos los que lo usan obtienen el acceso de esa credencial.

Los Owners también pueden limitar lo que un conector puede hacer en toda la organización. Cada herramienta se puede configurar como **Always allow**, **Needs approval** o **Blocked**, y los usuarios no pueden anular el ajuste de la organización. El propio ejemplo de Anthropic se parece mucho al caso del correo que verás más abajo: dejar que Claude busque y resuma correos, pero impedir que envíe mensajes.

Los miembros que no pueden añadir un conector necesitan que lo haga un Owner. El botón **Request** que ofrece Claude sirve para los conectores del directorio, así que para una URL personalizada envía la URL directamente a tu Owner.

## Opciones de inicio de sesión: OAuth, registro automático o sin inicio de sesión

Al añadir un conector, Claude muestra hasta tres grupos de ajustes. Los valores detectados suelen ser correctos.

**Authentication** decide cuándo inicia sesión cada persona:

- **Sign in now:** cada usuario pasa por el inicio de sesión OAuth del servidor antes de usar el conector. Es la opción adecuada para un servidor que guarda datos personales.
- **Sign in when needed:** Claude se conecta sin credenciales y pide a los usuarios que inicien sesión cuando el servidor lo requiere.
- **No sign-in:** cualquiera que tenga la URL puede usar el conector. También sirve para servidores que esperan una clave de API fija, que entonces añades como cabecera de la solicitud.

**OAuth client** decide cómo se identifica Claude ante el sistema de inicio de sesión del servidor. No aparece si eliges No sign-in:

- **Use Claude's published identity** es la opción que recomienda Anthropic. El servidor lee los datos de Claude de un Client ID Metadata Document alojado por Anthropic, así que no hay nada que configurar, siempre que el servidor admita ese método.
- **Register automatically** usa OAuth Dynamic Client Registration, que admiten la mayoría de los servidores MCP.
- **Use your own OAuth client** es para un ID de cliente que hayas registrado tú mismo en el servidor.

**Request headers** guarda credenciales fijas, como una clave de API o un token bearer. Claude las almacena de forma segura, no las vuelve a mostrar después de guardarlas y las envía en cada solicitud, con un máximo de cuatro cabeceras por conector. Anthropic marca las cabeceras de solicitud como una beta disponible para un número limitado de organizaciones, así que puede que no veas esta sección.

La diferencia en la práctica: con OAuth, cada persona inicia sesión con su propia cuenta, aprueba permisos concretos y puede revocar el acceso sin que nadie comparta un secreto. Con una clave fija, una sola credencial da el mismo acceso a todos los que usan el conector. [OAuth frente a claves de API para el acceso de la IA al correo](/blog/oauth-vs-api-keys-ai-email-access) profundiza en esa disyuntiva.

## Activar un conector en un chat

Añadir un conector no hace que todos los chats lo usen. En una conversación, haz clic en el botón **+** de la parte inferior izquierda, abre **Connectors** y activa o desactiva cada conector para ese chat. Claude también puede sugerir por su cuenta una app conectada cuando encaja con lo que pides.

Para controlar herramientas concretas, abre **Customize → Connectors**, selecciona el conector y configura cada herramienta, o cada grupo de herramientas de solo lectura y de escritura, como **Always allow**, **Needs approval** o **Blocked**. Cuando Claude te pida ejecutar una herramienta, elige **Allow always** solo para servidores y herramientas en los que confíes lo suficiente como para dejarlos funcionar sin supervisión.

## Lista de comprobación de seguridad antes de conectar

Las recomendaciones de Anthropic se resumen en cinco puntos:

- **Conéctate solo a servidores gestionados por organizaciones de confianza.** El servidor decide qué hacen sus herramientas y puede cambiarlas más adelante.
- **Lee los permisos en la pantalla de inicio de sesión.** Concede el conjunto más reducido que cumpla su función y rechaza lo que parezca innecesario.
- **Trata lo que devuelven las herramientas como contenido no fiable.** Una página web, una incidencia o un correo pueden contener texto escrito para manipular a Claude. Anthropic afirma que Claude tiene protecciones integradas contra la inyección de prompts, pero aun así conviene vigilar lo que entra y lo que sale.
- **Bloquea o somete a aprobación las acciones de escritura que no necesites.** Enviar, eliminar y mover es donde los errores acaban siendo visibles para otras personas.
- **Ten cuidado con Research.** Anthropic advierte que Research puede llamar a herramientas de los conectores automáticamente sin preguntar cada vez, así que desactiva las herramientas de escritura antes de usarlo con un conector.

## Ejemplo práctico: el correo en Claude con MCPEmails

El correo pone a prueba todo lo anterior: un buzón contiene datos privados y enviar un mensaje es una acción real. MCPEmails es un servidor MCP alojado que conecta Gmail, Outlook y Microsoft 365, iCloud, Fastmail, Yahoo, Zoho, Yandex y otros buzones IMAP, y los presenta a Claude como un único conector personalizado.

**1. Conecta un buzón a MCPEmails.** [Crea una cuenta](/signup) y abre **Dashboard → Inboxes → Connect inbox**. Outlook y Microsoft 365 usan Sign in with Microsoft, la mayoría de los demás proveedores usan una contraseña de aplicación y las [páginas de proveedores](/connect) indican los ajustes de cada uno. La [página de configuración de Claude](/docs/claude) resume los pasos 1 y 2.

**2. Añade el conector en Claude.** En **Customize → Connectors**, haz clic en **+ Add** y después en **Add custom connector**, llámalo MCPEmails, introduce la URL de abajo y haz clic en **Continue**:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

**3. Elige los ajustes de inicio de sesión.** Selecciona **Sign in now**. Para el cliente OAuth sirve cualquiera de las dos primeras opciones: MCPEmails admite la identidad publicada de Claude y el registro automático. Deja vacías las cabeceras de solicitud, ya que OAuth no necesita clave de API.

**4. Inicia sesión y elige el acceso.** Haz clic en **Add**, inicia sesión en MCPEmails y aprueba los permisos en la pantalla de consentimiento. Claude pide primero solo \`read:email\`. Si ya tienes una bandeja conectada, la pantalla se abre con la opción de solo lectura correspondiente. Si estás configurando MCPEmails desde Claude, se abre en **Estándar** (leer, borradores y enviar), para que el primer borrador no necesite una segunda aprobación; elige **Solo lectura** si quieres menos. Añade \`send:email\`, \`manage:drafts\`, \`manage:folders\` o \`delete:email\` solo cuando un flujo de trabajo los necesite. Un token sin \`send:email\` no puede enviar, le pidan lo que le pidan a Claude. Si una solicitud posterior necesita un permiso que no concediste, MCPEmails responde con un error \`insufficient_scope\` que indica el ámbito que falta. Al volver a conectar, marca ese permiso en la pantalla de consentimiento. La [página de acceso de solo lectura](/docs/read-only-access) muestra exactamente qué puede y qué no puede hacer una autorización de solo lectura.

**5. Configura los permisos de las herramientas en Claude.** MCPEmails separa la lectura y la escritura en herramientas distintas. \`email_read\`, \`inbox_list\`, \`folder_list\` y \`draft_list\` solo leen, mientras que \`email_compose\` envía, responde y reenvía, y \`email_delete\` elimina. Esa separación te permite poner \`email_compose\` en **Needs approval** y \`email_delete\` en **Blocked**, mientras la lectura sigue en **Always allow**. La [referencia de herramientas](/docs#tools) las enumera todas.

**6. Empieza con una tarea de solo lectura.** Activa el conector en un chat nuevo y pide a Claude que liste tus bandejas de entrada y resuma tus cinco correos no leídos más recientes sin enviar, mover ni eliminar nada. Encontrarás más prompts para empezar en la [guía para conectar Claude al correo](/blog/connect-claude-to-email).

Un solo conector cubre todos los buzones que conectas, y así es como [varias cuentas de correo acaban en un mismo chat de Claude](/blog/multiple-email-accounts-in-claude-and-chatgpt). Para ver a qué buzones llegan sin él los conectores integrados de Claude, lee [¿puede Claude leer tu correo?](/blog/can-claude-read-my-email)

En un equipo, el Owner añade la misma URL una sola vez en **Organization settings → Connectors**, y cada miembro hace clic en **Connect** e inicia sesión con su propia cuenta de MCPEmails. Cada persona ve solo las bandejas a las que tiene acceso su propia cuenta. Para que el correo saliente espere a una persona, decida lo que decida Claude, el propietario de una bandeja puede activar la aprobación de envíos en el panel de MCPEmails: cada envío, respuesta, reenvío, envío de borrador y envío programado queda retenido hasta que alguien lo aprueba, y una solicitud sin decidir caduca a las 24 horas. [Aprobar los envíos de correo de un agente de IA](/blog/approve-ai-agent-email-sends) explica esa configuración paso a paso.

En cuanto a los datos, MCPEmails obtiene el correo en directo de tu proveedor en cada solicitud y no almacena el contenido de los mensajes. Solo guarda el token OAuth cifrado o la contraseña de aplicación que necesita para acceder al buzón. Los resultados que contienen texto del buzón se marcan como contenido no fiable, de modo que Claude sabe que un correo que le pide reenviar o eliminar algo es un dato que debe comunicar, no una instrucción. El [resumen de seguridad](/security) y [¿es seguro dar acceso al correo a un agente de IA?](/blog/is-it-safe-to-give-ai-agent-email-access) explican el modelo de amenazas.

## Solución de problemas de los conectores personalizados

- **No aparece el botón Add custom connector.** En los planes Team y Enterprise, los miembros no pueden añadir conectores personalizados. Pide a un Owner que añada la URL en **Organization settings → Connectors**.
- **No puedes añadir un segundo conector en Free.** El plan Free permite un conector personalizado. Elimina el que ya no uses o pasa a un plan de pago de Claude.
- **La conexión agota el tiempo de espera o falla.** Claude se conecta desde la nube de Anthropic, así que el servidor debe ser accesible desde internet. La URL alojada de MCPEmails lo es. Un servidor que gestionas tú, como la [instalación autoalojada](/self-hosting), necesita una dirección HTTPS pública o un firewall que permita los rangos de IP de Anthropic. La instalación autoalojada inicia sesión con una clave de API en lugar de OAuth, así que Claude solo puede usarla donde esté disponible la sección Request headers.
- **Elegiste mal los ajustes de inicio de sesión.** Los ajustes de autenticación no se pueden editar. Elimina el conector y vuelve a añadirlo; después, los miembros tendrán que volver a conectarse.
- **El conector está conectado, pero Claude no lo usa.** Abre **+ → Connectors** en ese chat y comprueba que el interruptor está activado y que la herramienta que necesitas no está en **Blocked**.
- **No aparece en el móvil.** Conéctalo primero en la web o en Claude Desktop y después vuelve a iniciar sesión en la app móvil.
- **Se deniega una acción de correo.** Al token le falta un ámbito. Vuelve a conectarlo y aprueba el ámbito que necesita esa acción, o revoca la autorización anterior en el panel de MCPEmails, en **API keys**, donde la conexión de Claude aparece como \`OAuth:\` seguido del nombre del cliente. La [página de configuración de Claude](/docs/claude) recoge el resto de soluciones específicas de Claude.

## Preguntas frecuentes

**¿Qué son los conectores personalizados de Claude?**  
Son servidores MCP remotos que añades a Claude mediante su URL. Claude llama a las herramientas del servidor en tus chats después de que inicies sesión y apruebes los permisos. Están disponibles en los planes Free, Pro, Max, Team y Enterprise, y el plan Free permite uno.

**¿Funcionan los conectores personalizados en Claude Desktop y en el móvil?**  
Sí. Los añades en claude.ai, Claude Desktop o Cowork, y un conector que conectas allí está disponible en las apps de iOS y Android la próxima vez que inicies sesión.

**¿Quién puede añadir un conector personalizado en un plan Team o Enterprise?**  
En Team, los Owners y Primary Owners. En Enterprise, también las personas con un rol personalizado que incluya gestionar las bibliotecas de la organización. Después, cada miembro se conecta por su cuenta.

**¿Es seguro un conector personalizado?**  
Es tan seguro como el servidor que hay detrás y los permisos que concedas. Anthropic no verifica los conectores personalizados, así que conéctate solo a servidores de confianza, aprueba los permisos más reducidos posibles y somete a aprobación o bloquea las acciones de escritura.

**¿Necesito una clave de API para usar MCPEmails como conector personalizado de Claude?**  
No. Claude inicia sesión en MCPEmails con OAuth. Las claves de API son para clientes MCP sin flujo OAuth, como los scripts.

## Siguiente paso

[Crea una cuenta gratuita de MCPEmails](/signup), conecta un buzón y añade \`https://mcpemails.com/api/mcp\` como conector personalizado en Claude. Si tu buzón usa IMAP y no tiene una configuración predefinida con nombre, la [guía del conector IMAP para Claude](/blog/claude-imap-connector) explica los ajustes del servidor.`,
};

export default translation;
