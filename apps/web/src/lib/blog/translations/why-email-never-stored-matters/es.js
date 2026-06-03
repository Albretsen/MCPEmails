export default {
  title: 'Por qué importa que «el correo nunca se almacene» al conectar la IA a tu bandeja',
  description:
    'Que el correo nunca se almacene significa que MCP Emails obtiene tu correo en vivo y lo descarta, guardando solo un token cifrado. Mira por qué supera a las herramientas que copian toda tu bandeja.',
  coverAlt: 'Correo obtenido en vivo y descartado frente a una segunda copia almacenada en la base de datos de un proveedor',
  content: `Cuando conectas un agente de IA a tu bandeja de entrada, la pregunta más importante de todas es dónde acaba tu correo. Con MCP Emails la respuesta es: en ningún sitio. Cada llamada a una herramienta obtiene tu correo en vivo desde Gmail, Microsoft Graph o tu servidor IMAP, se lo entrega al agente y lo desecha. Lo único que conservamos es un token cifrado para que la siguiente llamada pueda producirse.

Eso suena a un detalle de implementación menor. No lo es. Es la diferencia entre darle a un agente una *llave de tu casa* y darle una *fotocopia de todo lo que hay en tu casa*, guardada para siempre en el archivador de otra persona. Muchas herramientas de «IA para el correo» hacen lo segundo sin decirlo. Esta publicación trata de por qué eso importa y de cómo difiere de verdad la arquitectura.

## Dos formas de darle tu correo a un agente

En realidad solo hay dos diseños, y la mayoría de los productos encajan claramente en uno de los dos bandos.

**Copiarlo todo (sincronizar y almacenar).** La herramienta se conecta a tu buzón una vez y luego vuelca tus mensajes en su propia base de datos, a menudo de forma continua. Tu bandeja queda reflejada en su infraestructura para poder indexarse, incrustarse en un almacén vectorial, alimentar a un modelo o servirse de vuelta con rapidez. El agente lee de *su* copia, no de tu proveedor.

**Obtención en vivo (nunca almacenado).** La herramienta solo guarda una credencial. Cuando el agente necesita un mensaje, el servidor llama a tu proveedor en tiempo real, devuelve el resultado y descarta el cuerpo. No se retiene nada del contenido. Así funciona MCP Emails.

El modelo de copiarlo todo es popular porque es fácil de construir y hace que la búsqueda parezca instantánea. Pero cambia lo que realmente aceptas cuando haces clic en «Connect». No estás concediendo acceso. Estás autorizando un duplicado.

## Qué acumula de verdad una bandeja «sincronizada»

Una vez que una herramienta copia tu correo, ocurren cuatro cosas, las anuncie el proveedor o no.

### Una segunda copia de tu correo que no controlas

Tu bandeja real vive en Google, Microsoft o Fastmail, detrás de sus equipos de seguridad y su historial de brechas. Una herramienta de sincronización crea una segunda copia completa y fiel en otro sitio: la instancia de Postgres de una startup, un bucket de S3, un índice de búsqueda. Cada enlace de restablecimiento de contraseña, hilo legal, resultado médico y código de respaldo de doble factor que hayas recibido pasa a existir en un lugar que no examinaste y que no puedes auditar.

### Una superficie de brecha mayor

Esta es la parte que la gente subestima. Si la base de datos del proveedor se filtra, el atacante no obtiene tus *credenciales*: obtiene tu *correo*, ya descifrado e indexado, listo para leer. No hace falta iniciar sesión en tu cuenta. La parte más dañina de una brecha de correo es el correo en sí, y una herramienta que lo copia todo lo ha reunido amablemente en un solo lugar. Heredas su postura de seguridad encima de la de tu proveedor.

### Una retención que tienes que tener en cuenta

¿A dónde va la copia cuando te desconectas? En una herramienta de sincronización bien gestionada, el borrado es una tarea en segundo plano que *debería* ejecutarse. En una chapucera, tus mensajes se quedan en las copias de seguridad y en las incrustaciones mucho después de que te hayas ido. Con un diseño de obtención en vivo no hay nada que borrar, porque no se guardó nada. Revocar el acceso en el panel es toda la historia.

### Riesgo de entrenamiento y «mejora del producto»

Un corpus almacenado de correo real es irresistible. Resulta tentador usarlo para mejorar el ranking de búsqueda, afinar un modelo o entrenar un clasificador. Incluso con buenas intenciones, una vez que tu correo está en una base de datos, la pregunta «¿podría esto usarse para algo a lo que no me apunté?» queda abierta para siempre. Si los datos nunca se almacenaron, la pregunta ni siquiera surge.

## Cómo funciona de verdad la obtención en vivo

Este es el recorrido que hace una sola llamada \`email_read\` (acción \`read\`) a través de MCP Emails:

\`\`\`
agente  →  servidor MCP  →  Edge Function aislada
                              ↓ descifra el token (en memoria)
                         tu proveedor (Gmail / Graph / IMAP)
                              ↓ cuerpo del mensaje
agente  ←  resultado analizado  ←  Edge Function
                         (cuerpo descartado, nada escrito)
\`\`\`

La credencial es lo único que queda en reposo, y está cifrada con **AES-256-GCM**. El descifrado ocurre solo dentro de una Edge Function aislada en el momento de la llamada, y la clave de cifrado es un secreto de entorno almacenado por separado de la base de datos, de modo que un volcado de la base de datos por sí solo no sirve de nada. El mensaje en sí nunca toca el almacenamiento duradero. Se analiza, se devuelve a tu agente y desaparece.

El envío funciona igual y añade una garantía más: el correo saliente pasa por *tu* proveedor: la API de Gmail, Microsoft Graph o tu propio SMTP. Nunca lo retransmitimos desde nuestro propio dominio, así que tu entregabilidad y la reputación de tu dominio siguen siendo enteramente tuyas. No hay ningún grupo de envío compartido que te haga caer en la reputación de spam de otra persona.

Si quieres la mecánica más profunda del modelo de credenciales —tokens de OAuth frente a contraseñas de aplicación y por qué ambos siguen cifrados—, lo expliqué en [OAuth frente a claves API para el acceso de la IA al correo](/blog/oauth-vs-api-keys-ai-email-access).

## El compromiso honesto

Lo de nunca almacenar no sale gratis. Hay un coste real, y prefiero nombrarlo a fingir que no existe.

Como no tenemos un índice local, la búsqueda se ejecuta contra la búsqueda de tu proveedor cada vez. Obtienes la [búsqueda nativa del proveedor](/docs) —operadores de Gmail, KQL de Outlook, búsqueda de texto de IMAP—, que es potente, pero es su latencia y su semántica de consultas, no un índice a medida ajustado por nosotros. Y no hay push: no podemos avisar a tu agente en el instante en que llega el correo porque no estamos vigilando una copia sincronizada. Para reaccionar al correo nuevo, tu agente hace polling (por ejemplo, \`email_read\` con la acción \`list\` y \`unread_only: true\` de forma programada).

Para la mayoría de la gente es un intercambio fácil. Una búsqueda algo más lenta y un bucle de polling, a cambio de no crear nunca una segunda copia de tus datos más sensibles. Yo lo acepto encantado.

## Qué preguntarle a cualquier herramienta de IA para el correo

Antes de conectar nada a tu bandeja, hazle al proveedor cuatro preguntas directas. Las respuestas te dicen en qué bando está.

- **¿Almacenas el contenido de mi correo o lo obtienes en vivo en cada petición?** «Obtenerlo en vivo, descartarlo de inmediato» es la respuesta que quieres.
- **¿Qué se persiste exactamente?** Debería ser una única credencial cifrada, nada sobre el contenido de los mensajes.
- **¿La credencial está cifrada en reposo y dónde vive la clave?** Separada de la base de datos es la respuesta correcta.
- **¿El envío pasa por mi proveedor o por el tuyo?** El tuyo protege la reputación de tu dominio; el suyo la mezcla con desconocidos.

Si una herramienta no puede responder a esto con claridad, eso también es información. Esta es la misma lente que aplicaría a la pregunta más amplia sobre seguridad en [¿Es seguro darle a un agente de IA acceso a tu correo?](/blog/is-it-safe-to-give-ai-agent-email-access): la arquitectura que hay bajo el marketing es lo que de verdad determina tu riesgo.

## Dónde encaja esto

El modelo de nunca almacenar es una pieza de una decisión más grande: cómo conectar un agente a una bandeja real sin hacer algo de lo que te arrepentirás. La [guía completa de 2026 para darle acceso al correo a tu agente de IA](/blog/how-to-give-your-ai-agent-email-access) cubre el panorama entero, y si estás sopesando ejecutar tu propio servidor, [Gmail MCP alojado frente a autoalojado](/blog/hosted-vs-self-hosted-gmail-mcp-server) entra en quién tiene la clave de cifrado en cada caso.

No tienes que elegir entre darle a tu agente un acceso útil a la bandeja y mantener tu correo fuera de la base de datos de un tercero. Con la obtención en vivo consigues ambas cosas. [Conecta una bandeja](/signup) y podrás revocarla con un solo clic, y no queda nada atrás cuando lo haces.`,
};
