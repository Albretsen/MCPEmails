const translation = {
  title: '¿Qué es una contraseña de aplicación? Dónde crearla en cada proveedor de correo',
  description:
    'Qué es una contraseña de aplicación, por qué la piden los clientes de correo y los conectores de IA, dónde crearla en Gmail, iCloud, Yahoo, AOL, Fastmail y Zoho, y cómo revocarla.',
  coverAlt: 'Una contraseña de aplicación conecta un buzón de correo con un agente de IA a través de MCPEmails',
  content: `Una **contraseña de aplicación** es una contraseña aparte que tu proveedor de correo genera para una sola app, de modo que esa app pueda entrar en tu buzón sin conocer la contraseña real de tu cuenta. La creas en los ajustes de seguridad de tu cuenta, la pegas una vez en el cliente de correo o en el conector y la borras cuando quieras dejar fuera a esa app. Tu contraseña normal, y el resto de apps, siguen funcionando.

Si vas a conectar un buzón a Thunderbird, a Apple Mail o a un agente de IA mediante un servidor MCP como MCPEmails, una contraseña de aplicación que falta o que no es la correcta es el motivo más habitual de que falle el inicio de sesión. Esta guía explica qué es una contraseña de aplicación, por qué la necesitan los clientes IMAP, dónde tiene el generador cada proveedor importante y cómo revocarla.

**Ir a:** [Dónde crearla](#dónde-crear-una-contraseña-de-aplicación-en-cada-proveedor) · [Cómo revocarla](#cómo-revocar-una-contraseña-de-aplicación) · [Notas de seguridad](#notas-de-seguridad) · [Preguntas frecuentes](#preguntas-frecuentes)

## ¿Qué es una contraseña de aplicación?

Una contraseña de aplicación es una credencial larga, generada al azar, vinculada a tu cuenta de correo pero emitida para una única aplicación. Hay tres cosas que la distinguen de la contraseña que escribes en el correo web:

- **La genera el proveedor.** No la eliges tú. Google crea un código de 16 caracteres, Apple muestra uno con el formato \`abcd-efgh-ijkl-mnop\` y la mayoría de los proveedores lo enseñan una sola vez.
- **Sustituye a tu contraseña donde no se puede pedir un segundo factor.** Los clientes de correo se conectan por IMAP (para leer) y SMTP (para enviar), y esos protocolos no pueden mostrar una solicitud de verificación en dos pasos. La contraseña de aplicación es la forma que tiene el proveedor de dejar entrar a ese cliente sin debilitar el inicio de sesión en la web.
- **Se puede revocar de forma independiente.** Si la borras, solo pierde el acceso la app que la usaba. No cambia nada más en la cuenta.

Google la describe como un código de acceso de 16 dígitos que da permiso a una app o a un dispositivo para acceder a tu cuenta de Google (en la práctica el código son 16 letras). Apple llama a la misma idea **contraseña específica de app**, Zoho **contraseña específica de aplicación**, y GMX y WEB.DE **App-Passwort**. Todas significan lo mismo.

## Por qué la necesitan los clientes IMAP y los conectores de IA

Muchos proveedores de correo ya no aceptan tu contraseña normal desde una app de correo de terceros, sobre todo cuando tienes activada la autenticación en dos pasos. Un cliente de correo de escritorio, la app de correo integrada del móvil o un servidor que lee el correo en tu nombre usan IMAP y SMTP, y en Google, Apple, Yahoo, AOL, Fastmail y Yandex la credencial que aceptan esos protocolos es una contraseña de aplicación.

Un conector de IA está exactamente en la misma situación. Cuando Claude o ChatGPT trabajan con tu bandeja de entrada a través de [un servidor MCP de correo](/blog/what-is-an-mcp-email-server), la IA no inicia sesión en tu buzón. Lo hace el servidor MCP, por IMAP y SMTP, igual que lo haría Thunderbird. Por eso, con iCloud, Yahoo, AOL, Fastmail, Gmail y proveedores parecidos, el servidor necesita una contraseña de aplicación, y el cliente de IA solo recibe un token con permisos acotados para el servidor. La [guía sobre OAuth y claves de API para el acceso al correo](/blog/oauth-vs-api-keys-ai-email-access) explica esa segunda capa.

El error típico es pegar la contraseña que usas en la web del proveedor. Es el motivo más habitual por el que una app de correo o un conector de IA no consigue iniciar sesión. Las contraseñas de aplicación generadas tienen una forma reconocible, así que el formulario de conexión de MCPEmails comprueba lo que pegas para Gmail, iCloud, Yahoo, Yandex y Fastmail y te avisa antes de que el intento llegue al proveedor, que de lo contrario lo contaría como un inicio de sesión fallido. Si estás seguro de que el valor es correcto, al pulsar Conectar otra vez se envía de todos modos.

## Dónde crear una contraseña de aplicación en cada proveedor

Cada entrada indica dónde está el generador y qué hay que activar antes. La página de configuración enlazada de cada proveedor tiene los ajustes IMAP y SMTP y los pasos completos.

- **Gmail y Google Workspace:** activa la **Verificación en dos pasos** y luego crea una en \`myaccount.google.com/apppasswords\`. El código son 16 letras en cuatro grupos; los espacios dan igual. Google indica tres casos en los que la opción no aparece: algunas cuentas de trabajo, de centros educativos u otras organizaciones (en Workspace depende de un ajuste de tu administrador), la Protección Avanzada y la verificación en dos pasos configurada solo con llaves de seguridad. Configuración: [Gmail](/connect/gmail), [Google Workspace](/connect/google-workspace).
- **iCloud Mail:** necesitas la autenticación de doble factor. En \`account.apple.com\`, abre **Inicio de sesión y seguridad** (Sign-In and Security), luego **Contraseñas específicas de app** (App-Specific Passwords), y genera una. Puedes tener hasta 25 activas a la vez. Configuración: [iCloud Mail](/connect/icloud).
- **Yahoo Mail:** en la página **Account Security** de Yahoo, en **External connections**, elige **Create app password**, ponle un nombre y genérala. Configuración: [Yahoo Mail](/connect/yahoo).
- **AOL Mail:** en la página **Account Security** de AOL, elige **Generate app password** (algunas cuentas muestran **Generate and manage app passwords**), luego **Get Started**, ponle un nombre y genérala. AOL pide hacerlo en un navegador con el que hayas iniciado sesión en AOL Mail durante varios días, no en una ventana privada. Una contraseña de aplicación de Yahoo no abre un buzón de AOL, aunque los dos funcionen sobre la misma plataforma. Configuración: [AOL Mail](/connect/aol).
- **verizon.net:** Verizon cerró su servicio de correo y los buzones verizon.net que siguen activos son ahora cuentas de AOL, así que creas una contraseña de aplicación de **AOL** e inicias sesión con tu dirección verizon.net completa. Configuración: [verizon.net](/connect/verizon).
- **Fastmail:** ve a **Settings**, **Privacy & Security**, **Connected apps & API tokens**, **Manage app passwords and access**, **New app password**. Deja el nivel de acceso por defecto, **Mail, Contacts & Calendars**; una contraseña solo para Files no puede entrar en el correo. Fastmail se conecta únicamente con contraseña de aplicación, y el plan Basic de Fastmail no permite crearla. Configuración: [Fastmail](/connect/fastmail).
- **Zoho Mail:** primero activa **IMAP Access** en Zoho Mail, en **Settings**, **Mail Accounts**. Sin autenticación en dos pasos te sirve tu contraseña de Zoho; con autenticación en dos pasos, inicio de sesión federado (por ejemplo, entrar con Google) o SAML, crea una contraseña específica de aplicación en tu cuenta de Zoho y usa esa. Configuración: [Zoho Mail](/connect/zoho).
- **Yandex Mail:** activa IMAP en **Mail clients**, dentro de los ajustes de Yandex Mail, y después, en la página de seguridad de \`id.yandex.com\`, abre **App passwords** y crea una para un cliente de correo. Yandex la muestra una sola vez. Configuración: [Yandex Mail](/connect/yandex).
- **GMX:** activa primero el acceso **POP3/IMAP** en los ajustes de correo. Sin autenticación en dos pasos te sirve tu contraseña normal de GMX; con ella, crea un App-Passwort en **Account verwalten**, **Login & Sicherheit**, **App-Passwörter (für externe Apps)**, **Neues App-Passwort erstellen**. GMX lo muestra una sola vez. Configuración: [GMX](/connect/gmx).
- **WEB.DE:** igual que GMX: activa el acceso **POP3/IMAP** y crea un App-Passwort en el mismo sitio si tienes activada la autenticación en dos pasos. Configuración: [WEB.DE](/connect/web-de).
- **Outlook.com, Hotmail y Live:** sin contraseña de aplicación. Microsoft indica que la autenticación básica, el inicio de sesión con contraseña del que dependen las contraseñas de aplicación, dejó de estar disponible para cualquier cuenta de Outlook a partir del 16 de septiembre de 2024, así que una contraseña de aplicación no puede abrir el buzón. MCPEmails conecta estas cuentas con **Iniciar sesión con Microsoft** a través de Microsoft Graph. Configuración: [Outlook.com](/connect/outlook); las cuentas de trabajo se explican en la [guía de Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

Cualquier otro caso, como un buzón de tu proveedor de hosting o de tu propio dominio, sigue el mismo patrón: genera una contraseña de aplicación si el proveedor la ofrece; si no, usa la contraseña del buzón e introduce a mano los ajustes del servidor. La [página de IMAP genérico](/connect/imap) y la [lista completa de proveedores](/connect) cubren esos casos.

## Cómo crearla y conectar tu buzón

Los pasos son los mismos en todas partes; solo cambian los nombres de los menús:

1. Activa la autenticación en dos pasos en la cuenta de correo si el proveedor la exige.
2. Abre la página de contraseñas de aplicación indicada arriba, ponle a la contraseña el nombre de la app (por ejemplo \`MCPEmails\`) y genérala.
3. Cópiala enseguida. La mayoría de los proveedores no vuelven a mostrarla.
4. En MCPEmails, abre **Bandejas de entrada**, luego **Conectar bandeja**, elige tu proveedor y pega tu dirección de correo completa y la contraseña de aplicación.
5. Añade \`https://mcpemails.com/api/mcp\` a tu cliente de IA. La [guía de Claude](/blog/connect-claude-to-email) y la [guía de ChatGPT](/blog/connect-chatgpt-to-email) explican esa parte paso a paso.

Si el inicio de sesión sigue rechazándose, la [guía del conector IMAP](/blog/claude-imap-connector) repasa las otras causas habituales: IMAP desactivado, el servidor regional equivocado o un nombre de usuario que no es la dirección completa.

## Cómo revocar una contraseña de aplicación

Revocarla es la forma de quitarle el acceso a una app sin tocar nada más. Borra la contraseña en el mismo sitio donde la creaste:

- **Google:** \`myaccount.google.com/apppasswords\` y luego **Quitar** junto a la entrada. Cambiar la contraseña de tu cuenta de Google también revoca todas las contraseñas de aplicación.
- **Apple:** **Inicio de sesión y seguridad**, **Contraseñas específicas de app**, y luego elimina una o usa **Revocar todas** (Revoke All). Cambiar o restablecer la contraseña de tu cuenta de Apple las revoca todas automáticamente.
- **Yahoo y AOL:** la página **Account Security** (**External connections** en Yahoo, **Generate and manage app passwords** en AOL) y luego **Delete** junto a esa contraseña de aplicación. Aquí, cambiar la contraseña principal **no** revoca las contraseñas de aplicación, así que borrar la entrada es la única forma de cortarle el acceso a un cliente.
- **Fastmail, Zoho, Yandex, GMX, WEB.DE:** elimínala de la misma lista de contraseñas de aplicación donde la creaste. En Yandex, cerrar sesión en todos los dispositivos también restablece todas las contraseñas de aplicación.

En MCPEmails, **Desconectar bandeja** en el panel borra la contraseña de aplicación guardada junto con la conexión. Hacer las dos cosas es la forma limpia de retirar una integración: el proveedor deja de aceptar la contraseña y MCPEmails deja de tenerla.

## Notas de seguridad

- **Crea una por app.** Con una contraseña de aplicación distinta y con nombre para cada cliente puedes revocar una sin romper las demás, y la lista de tu cuenta muestra quién sigue teniendo acceso.
- **Trátala como una contraseña.** Una contraseña de aplicación inicia sesión sin pedir tu segundo factor; para eso existe. No la pegues en un chat con una IA, en un documento compartido ni en una incidencia de soporte. En MCPEmails solo va en el formulario de conexión.
- **Suele dar acceso completo al correo.** En la mayoría de los proveedores, una contraseña de aplicación puede leer, enviar y borrar correo, no solo una parte. Limita lo que puede hacer tu IA en el conector: MCPEmails te permite aprobar \`read:email\` sin \`send:email\`, y la [guía de seguridad del acceso al correo](/blog/is-it-safe-to-give-ai-agent-email-access) explica cómo revisar los envíos.
- **Ten claro dónde se guarda.** MCPEmails guarda la contraseña de aplicación cifrada con AES-256-GCM, la descifra solo en el servidor para conectar con tu proveedor y nunca se la pasa al cliente de IA. Tus mensajes se obtienen en vivo y no se almacenan. [Por qué importa](/blog/why-email-never-stored-matters).
- **Google recomienda Iniciar sesión con Google cuando la app lo ofrece.** Google dice que las contraseñas de aplicación no son recomendables y que en la mayoría de los casos no hacen falta. Existen para las apps que no pueden usar ese inicio de sesión, entre ellas los clientes IMAP que solo aceptan una contraseña.

## Preguntas frecuentes

**¿Qué es una contraseña de aplicación?**
Una contraseña de aplicación es una contraseña generada al azar que tu proveedor de correo emite para una sola app o dispositivo, como un cliente de correo o un conector de correo con IA. Permite a esa app iniciar sesión por IMAP y SMTP sin tu contraseña principal, y puedes borrarla en cualquier momento para revocar solo esa app.

**¿Una contraseña de aplicación es lo mismo que la contraseña de mi correo?**
No. La contraseña de tu correo es la que elegiste y escribes en el correo web. Una contraseña de aplicación la genera el proveedor, la usa una sola app y, en la mayoría de los proveedores, tu contraseña normal no funciona en su lugar.

**¿Por qué necesito una contraseña de aplicación para conectar el correo a un agente de IA?**
Porque el servidor MCP que da acceso a la IA inicia sesión en tu buzón por IMAP y SMTP, como cualquier cliente de correo, y la mayoría de los proveedores solo aceptan ahí una contraseña de aplicación. Outlook.com es la principal excepción: se conecta con Iniciar sesión con Microsoft.

**¿Caduca una contraseña de aplicación?**
Deja de funcionar cuando la borras. Google y Apple también revocan todas las contraseñas de aplicación cuando cambias la contraseña principal de la cuenta, mientras que Yahoo y AOL las mantienen válidas tras un cambio de contraseña hasta que las borres.

**He perdido mi contraseña de aplicación. ¿Puedo volver a verla?**
No. La mayoría de los proveedores solo la muestran una vez. Borra la antigua, genera una nueva y pégala en la app. En MCPEmails, abre la bandeja y elige **Reconectar**.

## Siguiente paso

[Crea una cuenta gratuita de MCPEmails](/signup), genera una contraseña de aplicación para tu proveedor y conecta el buzón. La [matriz de proveedores](/docs/providers) muestra qué admite cada proveedor una vez conectado.`,
};

export default translation;
