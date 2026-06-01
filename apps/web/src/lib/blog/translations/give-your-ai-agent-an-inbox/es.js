export default {
  title: 'Dale una bandeja de entrada a tu agente de IA: guía práctica del correo sobre MCP',
  description:
    'Por qué conectar el correo a tu agente de IA es más difícil de lo que parece, y cómo el Model Context Protocol convierte Gmail, Outlook e IMAP en un único endpoint seguro que tu agente puede usar de verdad.',
  coverAlt: 'Dale una bandeja de entrada a tu agente de IA — MCPEmails',
  content: `La mayoría de las demos de "correo con IA" se quedan en una captura de pantalla. El agente redacta una respuesta, todos aplauden y nadie hace la pregunta incómoda: **¿cómo llega realmente el modelo a una bandeja de entrada de verdad?** De forma segura, entre proveedores distintos y sin que tengas que pegar una contraseña de aplicación en un prompt.

Este artículo recorre por qué esa última milla es engañosamente difícil, y cómo el [Model Context Protocol](https://modelcontextprotocol.io) (MCP) convierte Gmail, Outlook, Fastmail e IMAP genérico en un único endpoint que tu agente puede invocar como cualquier otra herramienta.

## El problema de "simplemente dale mi correo"

El correo parece un problema resuelto. No lo es, al menos no para un agente autónomo. Hay tres cosas que se interponen:

1. **La autenticación depende del proveedor.** Gmail quiere OAuth con los scopes adecuados. Outlook quiere identidad de Microsoft. Fastmail quiere una contraseña de aplicación. Cada uno tiene su propio ciclo de vida del token y sus propios modos de fallo.
2. **Las credenciales son radiactivas.** No quieres una contraseña de buzón en una transcripción de chat, en una línea de log o en un almacén vectorial. Nunca.
3. **La "forma" del correo es caótica.** MIME, hilos, HTML frente a texto plano, adjuntos, carpetas que en realidad son etiquetas. Un agente necesita una interfaz limpia y predecible, no RFC 5322 en crudo.

El arreglo ingenuo —darle al modelo una librería IMAP y tu contraseña— falla en los tres puntos a la vez.

## Qué cambia MCP en realidad

MCP es una forma estándar de exponer **herramientas** y **recursos** a un modelo de lenguaje. En lugar de enseñar a cada agente a hablar IMAP, ejecutas un único servidor que presenta el correo como un conjunto pequeño y bien tipado de herramientas:

\`\`\`json
{
  "tools": [
    "list_inboxes",
    "list_messages",
    "read_email",
    "search_emails",
    "send_email",
    "reply_to_email"
  ]
}
\`\`\`

El agente nunca ve una contraseña. Ve verbos. Ese único cambio es lo que hace que el correo sea seguro de automatizar.

> Las mejores integraciones de agentes son aburridas a propósito: un verbo estable, una respuesta predecible y ningún secreto en el prompt.

### Descubrir antes de actuar

Una buena herramienta de correo es **sin estado desde el punto de vista del agente**. El agente no debería tener fijada a fuego el UUID de un buzón. En su lugar, llama primero a \`list_inboxes\`, descubre qué hay disponible y luego actúa:

- \`list_inboxes\` → devuelve las cuentas conectadas y sus capacidades
- \`list_messages\` → paginado, lo más reciente primero, por bandeja
- \`read_email\` → el cuerpo analizado, el remitente y los metadatos de un mensaje
- \`send_email\` → redacta y envía, con el proveedor elegido por ti

Este patrón de descubrir primero es la diferencia entre una demo y algo en lo que confiarías un martes por la tarde.

## Un recorrido concreto

Imagina que quieres que Claude clasifique tu bandeja de entrada por la mañana. Con el correo expuesto sobre MCP, la conversación se ve así:

1. El agente llama a \`list_inboxes\` y encuentra tu Gmail del trabajo.
2. Llama a \`list_messages\` para las últimas 24 horas.
3. Para cualquier cosa que parezca urgente, llama a \`read_email\` para obtener el cuerpo completo.
4. Redacta respuestas y llama a \`reply_to_email\`, o simplemente resume y espera tu visto bueno.

Ninguna contraseña cruzó el cable. Ningún código específico de proveedor vivió en tu prompt. El agente razonó sobre verbos e hizo trabajo de verdad.

## La seguridad es la funcionalidad

La razón por la que esto funciona es que las partes aburridas se gestionan donde corresponde —en el servidor, no en el modelo:

- **Los tokens de OAuth se cifran en reposo** y nunca se devuelven al cliente.
- **Los scopes son mínimos**: leer y enviar, nada más.
- **El agente se autentica ante el servidor**, el servidor se autentica ante el proveedor. Dos saltos, un solo almacén de secretos.

Si recuerdas una sola cosa de este artículo, que sea esta: *el modelo debe tener capacidades, nunca credenciales.*

## Por dónde seguir

Conectar una bandeja de entrada debería llevar minutos, no una tarde depurando OAuth. Si quieres probar el flujo de descubrir primero que vimos arriba, la [guía de inicio rápido](/docs#quickstart) te lleva de cero a un endpoint en marcha, y la [matriz de proveedores](/docs/providers) muestra exactamente qué funciones se activan para Gmail, Outlook, Fastmail y compañía.

Dale a tu agente verbos, no contraseñas, y deja que se ponga a trabajar.`,
};
