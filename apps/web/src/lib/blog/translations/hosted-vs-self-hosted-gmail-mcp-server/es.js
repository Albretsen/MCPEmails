export default {
  title: 'Servidor MCP de Gmail alojado vs. autoalojado: ventajas, inconvenientes y costes',
  description:
    'Servidor MCP de Gmail alojado vs. autoalojado, comparado con honestidad: los repos DIY gratis te dan control total, pero asumes OAuth, cifrado y disponibilidad. Uno alojado cuesta minutos.',
  coverAlt: 'Comparativa de servidor MCP de Gmail alojado frente a autoalojado — MCP Emails',
  content: `Si quieres que tu agente de IA lea y envíe correo de Gmail, tienes dos opciones reales: ejecutar un servidor MCP de Gmail autoalojado a partir de un repo de código abierto, o apuntar tu cliente a uno alojado. La vía DIY cuesta cero dólares y te da control total, pero asumes personalmente la configuración de OAuth, el cifrado de tokens, el alojamiento, las actualizaciones y la seguridad. Un servidor alojado como MCP Emails cuesta minutos de configuración y mantiene las credenciales cifradas, a cambio de confiar la conexión a un proveedor.

Este es el análisis honesto. Yo construí un servidor alojado, así que tengo una postura, pero te diré exactamente dónde gana el autoalojamiento y qué tipo de persona debería elegirlo. Si primero quieres el modelo a nivel de verbos, la [guía completa para dar acceso al correo a un agente de IA](/blog/how-to-give-your-ai-agent-email-access) es el pilar que conviene leer junto a este artículo.

## Qué significa de verdad "servidor MCP de Gmail autoalojado"

Busca "servidor MCP de Gmail" y encontrarás una docena de repos en GitHub. Clonas uno, registras un proyecto de Google Cloud, generas credenciales de cliente OAuth, ejecutas un flujo local de consentimiento OAuth y el servidor guarda un refresh token en disco o en una variable de entorno. A partir de ahí tu cliente MCP habla con un proceso que se ejecuta en \`localhost\` o en una máquina que alquilas.

Ese es todo el discurso, y para una sola cuenta de Gmail en tu propio portátil funciona. El coste aparece después, y no se mide en dólares.

## El caso del autoalojamiento: dónde gana de verdad

No voy a fingir que el DIY sea mala idea. Para la persona adecuada es la decisión correcta.

### Obtienes control total y cero confianza en proveedores

El código se ejecuta en tu propio hardware. Ningún tercero se interpone jamás entre tu agente y Google. Si tu modelo de amenazas dice "ningún servicio externo toca mi buzón, punto", el autoalojamiento es la única respuesta que lo satisface. Puedes leer cada línea, hacer un fork y fijarla para siempre.

### Es gratis en dólares

Sin suscripción. La propia API de Gmail es gratuita en cualquier volumen que vaya a alcanzar un agente. Si tu tiempo es barato en relación con $12/month, las cuentas favorecen montártelo tú mismo.

### Puedes adaptarlo a cualquier cosa

Herramientas personalizadas, carpetas IMAP raras, una taxonomía de etiquetas privada, un pipeline de logging que alimenta tu SIEM. Cuando eres dueño del proceso puedes hacerlo todo. Un producto alojado te da la superficie que te da.

## El caso del autoalojamiento: dónde te cuesta de verdad

Ahora la parte que los README de los repos pasan por alto.

### Asumes la configuración de OAuth

Un proyecto de Google Cloud, una pantalla de consentimiento OAuth, los scopes correctos y —si quieres que lo use alguien más aparte de ti— el proceso de verificación de apps de Google, que es una revisión real con un plazo real. Equivócate en un scope y vuelves a la consola. Este es el paso que te come una tarde la primera vez y un bocado más pequeño cada vez que un token expira o Google cambia una política.

### Asumes el almacenamiento y el cifrado de credenciales

Este es el que me quita el sueño. Un refresh token para \`read:email\` y \`send:email\` es una llave maestra del buzón de alguien. La mayoría de los montajes DIY lo dejan en un archivo en texto plano o en una variable de entorno. Si esa máquina se ve comprometida, o el token se filtra en un log o en una copia de seguridad, el atacante lee y envía correo en tu nombre.

Hacerlo bien significa cifrar el token en reposo, mantener la clave de cifrado separada del almacén de tokens y descifrar solo en el momento de la llamada en un contexto aislado. Eso no es difícil de describir y es genuinamente engorroso de construir y mantener. Si te lo saltas, has construido un pasivo. [Por qué importa que "el correo nunca se almacena"](/blog/why-email-never-stored-matters) profundiza en el lado arquitectónico de esto.

### Asumes el alojamiento y la disponibilidad

Un servidor en localhost muere cuando tu portátil se suspende. Si quieres que el agente clasifique el correo a las 6 de la mañana o funcione sin supervisión, necesitas un proceso que esté siempre activo: un VPS, un contenedor, una política de reinicio, TLS, monitorización. Eso es trabajo de ops, y nunca deja de ser trabajo de ops.

### Asumes las actualizaciones y los parches de seguridad

MCP es joven. La especificación se mueve, Google rota requisitos y el repo que clonaste puede quedarse obsoleto o ser abandonado. Cuando una dependencia publica un CVE, ese aviso es tuyo. Fija una versión y te quedas atrás; sigue \`main\` y heredas los bugs de otra gente.

### El multiproveedor corre de tu cuenta

El repo que elegiste hace Gmail. El día que añadas una cuenta de Outlook o una dirección de iCloud, estarás integrando Microsoft Graph o cableando IMAP y SMTP tú mismo, con un segundo modelo de autenticación y un segundo conjunto de casos límite. La mayoría de los servidores DIY se quedan solo en Gmail porque el segundo proveedor es un proyecto en sí mismo.

## El caso del alojado: MCP Emails, con honestidad

Un servidor MCP alojado invierte el trato. Renuncias a ejecutar el código; recuperas todo el tiempo que te costaría la lista de arriba.

### La configuración son minutos, no una tarde

Te registras, vas a **Dashboard → Inboxes → Connect Inbox**, eliges Gmail y avanzas por el OAuth de un clic de Google. Sin proyecto de Cloud, sin pantalla de consentimiento, sin cola de verificación. Luego conectas tu agente. Para [claude.ai o Claude Desktop](/blog/connect-email-to-ai-agent-under-2-minutes) pegas la URL del endpoint MCP, inicias sesión y apruebas los scopes; sin API key. Para un cliente sin OAuth, como [Cursor, Cline o un script directo](/blog/email-for-ai-agents-cursor-cline-vscode), generas una API key con scopes en **Dashboard → API Keys** y la envías como bearer token.

### Las credenciales están cifradas y el correo nunca se almacena

El token OAuth es lo único que se persiste por buzón, y está cifrado con AES-256-GCM en reposo. La clave vive como un secreto de entorno, separada de la base de datos, y el descifrado ocurre solo dentro de una Edge Function aislada en el momento de la llamada. El correo en sí no se almacena en absoluto: cada llamada \`read_email\`, \`search_emails\` o \`list_messages\` consulta Gmail en vivo, entrega el resultado a tu agente y lo descarta. Ese es el trabajo de cifrado de la sección de autoalojamiento, hecho y mantenido. [¿Es seguro dar acceso al correo a un agente de IA?](/blog/is-it-safe-to-give-ai-agent-email-access) recorre el modelo de seguridad completo.

### El multiproveedor viene gratis

El mismo endpoint y las mismas seis herramientas principales —\`list_inboxes\`, \`list_messages\`, \`read_email\`, \`search_emails\`, \`send_email\`, \`reply_to_email\`, más algunas otras para flags, carpetas, programación y contactos— funcionan en Gmail, Outlook, iCloud, Fastmail y cualquier buzón IMAP. Añade una cuenta de Outlook la semana que viene y nada cambia en tu agente.

### El envío se queda en tu proveedor

MCP Emails nunca retransmite correo desde su propio dominio. \`send_email\` sale a través de tu Gmail (o Microsoft Graph, o tu propio SMTP), así que la reputación de tu dominio y la entregabilidad siguen siendo tuyas. Es la misma propiedad que obtendrías autoalojando, sin tener que construirla.

### El coste honesto: confías en un proveedor

Este es el verdadero compromiso, y no voy a maquillarlo. Con un servidor alojado, tu token cifrado se aloja en la base de datos de otra persona y las llamadas de tu agente pasan por el código de otra persona. Estás confiando en que el cifrado es real, en que el aislamiento se mantiene y en que la empresa no hace ninguna tontería. Para la mayoría de la gente esa confianza está bien depositada y ahorra muchísimo tiempo. Si tu modelo de amenazas lo prohíbe de plano, autoaloja: esa es la razón legítima para hacerlo.

## Cuánto cuesta en dólares

MCP Emails es gratis para empezar, y el plan Free es ilimitado: buzones, llamadas a herramientas y API keys ilimitadas, sin tarjeta de crédito. El plan Free funciona a 60 requests/minute con analíticas de 7 días y soporte de la comunidad. [Solo cuesta $12/month](/pricing) (300 req/min, analíticas de 90 días, soporte por correo) y Team cuesta $49/month por roles, varios espacios de trabajo, SSO y registros de auditoría. El autoalojamiento son $0 de suscripción más lo que cuesten tu VPS y tus horas. Sé honesto sobre las horas.

## ¿Cuál deberías elegir?

Elige **autoalojado** si eres un ingeniero que disfruta de la fontanería, necesitas control total o tienes una regla de cero-terceros, te sientes cómodo asumiendo OAuth, cifrado y disponibilidad, y solo vas a tocar una cuenta de Gmail. Es una opción real y defendible.

Elige **alojado** si quieres un endpoint funcionando hoy, prefieres no estar de guardia para tu propia infraestructura de correo, es probable que en algún momento añadas Outlook o iCloud o un buzón IMAP, y quieres que el cifrado de credenciales lo gestionen personas que lo mantienen a tiempo completo. Esa es la mayoría de la gente, incluidos la mayoría de los ingenieros que podrían construirlo pero tienen cosas mejores que hacer.

Si aún estás decidiendo cómo debería un agente llegar a tu buzón siquiera, [las mejores formas de dejar que Claude gestione tu bandeja de entrada](/blog/best-ways-to-let-claude-manage-your-inbox) compara las opciones más amplias. Cuando estés listo, [empieza gratis](/signup) o echa un vistazo a [la documentación](/docs): conectar un buzón de Gmail de verdad lleva como un minuto.`,
};
