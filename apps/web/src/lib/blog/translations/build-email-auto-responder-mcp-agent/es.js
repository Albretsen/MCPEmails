export default {
  title: 'Cómo crear un autorrespondedor de correo con un agente conectado por MCP',
  description: 'Crea un autorrespondedor de correo con un agente de IA conectado por MCP: sondea el correo sin leer, redacta y responde con seguridad usando scopes, límites y guardarraíles.',
  coverAlt: 'Cómo crear un autorrespondedor de correo con un agente conectado por MCP — MCPEmails',
  content: `Un autorrespondedor de correo construido sobre MCP Emails es un bucle, no un webhook. No hay eventos iniciados por el servidor, así que tu agente **sondea** el correo sin leer según una programación con \`email_read\` (acción \`list\`), lee cada mensaje con \`email_read\` (acción \`read\`), redacta una respuesta y llama a \`email_compose\` (acción \`reply\`). Este artículo recorre la construcción completa: el bucle de sondeo, los scopes que necesitas, cómo sobrevivir a los límites de tasa y los guardarraíles que evitan que un agente bombardee a tus contactos con respuestas alucinadas.

Esto es el extremo avanzado de la historia de [dale acceso al correo a tu agente de IA](/blog/how-to-give-your-ai-agent-email-access). Si solo quieres triaje y resúmenes matutinos sin enviar nada, lee antes [triaje y resumen de bandeja con un agente de IA](/blog/ai-agent-triage-summarize-inbox): es el sitio más seguro para empezar. Vuelve aquí cuando de verdad quieras que el agente le dé a enviar.

## La parte honesta: no hay webhook

La mayoría de los tutoriales de «autorrespondedor» dan por hecho que un evento push se dispara en el momento en que llega el correo. MCP Emails no funciona así, y tampoco ningún servidor MCP que yo conozca. MCP es un protocolo de herramientas de petición/respuesta. El servidor responde cuando tu agente pregunta; nunca te llama a ti.

Así que un autorrespondedor de verdad es un programador más un sondeo. Ejecutas un tick cada N segundos o minutos, pides los mensajes sin leer y procesas lo que sea nuevo. Eso es todo. Es menos elegante que un webhook, pero es predecible, y significa que *tú* controlas la cadencia y el radio de impacto.

Elige un intervalo de sondeo que equilibre tu tolerancia a la latencia con tu presupuesto de tasa. Cada 60 segundos está bien para respuestas tipo soporte. Cada 5 minutos sobra para la mayoría de las bandejas y apenas roza tus límites. No sondees cada segundo: quemarás cuota sin motivo y la bandeja rara vez cambia tan rápido.

## Lo que necesitas: una API key con scope de envío

Un autorrespondedor casi siempre se ejecuta como un script o un cron job, no dentro de un cliente de chat. Eso significa la [vía de la API key, no OAuth](/blog/oauth-vs-api-keys-ai-email-access).

En el dashboard, ve a **API Keys**, crea una key y concédele los scopes que realmente necesitas:

- \`read:email\` — para sondear, listar y leer mensajes con \`email_read\`.
- \`send:email\` — para llamar a \`email_compose\` (acción \`reply\`).

La key se muestra una sola vez. Cópiala. Tiene el aspecto \`mcpe_live_...\` y la pasas en cada petición:

\`\`\`
Authorization: Bearer mcpe_live_YOUR_KEY
\`\`\`

El endpoint MCP es una única URL:

\`\`\`
https://www.mcpemails.com/api/mcp
\`\`\`

Concede **solo** los scopes que use el trabajo. Si una versión futura de tu respondedor necesita reenviar o marcar correo, añade esas capacidades entonces. Una key que puede leer y responder es una key que, si se filtra, solo puede leer y responder. (Para el panorama completo sobre el manejo y la rotación de keys, consulta [la documentación](/docs).)

## El bucle

Aquí tienes la forma de un respondedor que funciona. Lo he escrito como pseudocódigo sobre las herramientas MCP para que quede claro qué llamadas ocurren y en qué orden. El cableado exacto del cliente MCP depende de tu stack, pero lo importante es la secuencia.

\`\`\`python
# Tools used: inbox_list, email_read, email_compose

inbox = inbox_list()[0]              # discover, never hardcode the UUID

while True:
    unread = email_read(
        action="list",
        inbox_id=inbox["inbox_id"],
        unread_only=True,
        limit=20,
    )

    for summary in unread["messages"]:
        if not should_handle(summary):   # allowlist + filters, see below
            continue

        msg = email_read(
            action="read",
            inbox_id=inbox["inbox_id"],
            message_id=summary["message_id"],
        )

        draft = generate_reply(msg)      # your LLM call

        if not passes_guardrails(draft, msg):
            queue_for_human(msg, draft)  # don't send; flag it
            continue

        send_with_backoff(
            inbox_id=inbox["inbox_id"],
            message_id=summary["message_id"],
            body=draft,
        )

    sleep(60)
\`\`\`

Fíjate en tres cosas. Primera, el agente llama a \`inbox_list\` para descubrir el \`inbox_id\` en lugar de pegar un UUID en el código: ese es el patrón de descubrimiento primero, y mantiene el script funcionando si reconectas una bandeja. Segunda, \`unread_only: true\` es lo que convierte esto en un respondedor de *correo nuevo* en vez de una máquina de re-responder-a-todos. Tercera, cada mensaje pasa por los guardarraíles antes de que se envíe nada.

### Marcar mensajes como gestionados

Si quieres que un mensaje deje de aparecer como sin leer una vez que has respondido, léelo con \`mark_as_read\` activado, o llama a \`mark_read\` explícitamente. Sé deliberado aquí: si tu bucle responde pero nunca marca el mensaje como leído, el siguiente tick volverá a responder. Marcar como gestionado es la forma de que el bucle siga siendo idempotente.

## Límites de tasa, y por qué nunca reintentas un envío a ciegas

Cada API key está limitada a **100 peticiones por minuto, 1000 por hora y 10 000 por día**, independientemente del plan. Tu workspace también tiene un techo de ráfaga según el tier: **60 req/min en Gratis, 120 en Personal, 300 en Pro, 1000 en Team** (consulta [precios](/pricing)). Un bucle educado de sondear y responder vive holgadamente dentro de eso, pero uno que se porta mal puede dispararlo.

Cuando alcanzas un límite de tasa, el servidor devuelve un error reintentable (código \`-32003\`) que lleva \`data.retry_after\` en segundos. Hónralo. Duerme ese tiempo y luego continúa.

La asignación mensual de acciones de tu plan es otro límite distinto, y no es reintentable. Cuando se agota, la llamada vuelve como un resultado de herramienta normal con \`isError: true\` y un bloque \`_meta["com.mcpemails/usage_limit"]\` en lugar de un error JSON-RPC, sin \`retry_after\`. Reintentar solo quema ciclos hasta \`reset_at\` o hasta que mejores de plan, así que detén el bucle y muéstralo.

Aquí está la regla que más importa: **nunca reintentes a ciegas un envío o una respuesta de \`email_compose\`.** Un envío no es idempotente. Si una llamada de envío agota el tiempo o devuelve un resultado ambiguo, un reintento ingenuo puede entregar la misma respuesta dos veces. Reintenta las *lecturas* sin problema; trata los *envíos* como una sola oportunidad y reintenta solo ante un error reintentable explícito, con backoff y un tope estricto.

\`\`\`python
def send_with_backoff(**kwargs):
    delay = 2
    for attempt in range(3):
        try:
            return email_compose(action="reply", **kwargs)
        except RateLimited as e:
            sleep(e.retry_after or delay)
            delay *= 2
        except RetryableError:
            sleep(delay)
            delay *= 2
        # any other error: do NOT retry a send. log it, move on.
        else:
            break
    raise SendFailed(kwargs)
\`\`\`

Fíjate en que solo reintenta ante errores de límite de tasa o explícitamente reintentables, se topa a tres intentos y nunca entra en un bucle infinito. Un envío que falla tres veces es problema de una persona, no del bucle.

## Guardarraíles: la diferencia entre una herramienta y un riesgo

Un autorrespondedor que envía sin supervisión está a un mal prompt de enviarle a tu CEO una respuesta segura de sí misma pero equivocada. Construye los frenos antes de construir el motor.

### Lista de permitidos para quién recibe autorrespuestas

No respondas a todos. Empieza con una lista de permitidos estrecha: un alias de soporte, un dominio de remitente concreto, mensajes que coincidan con un patrón de asunto. Todo lo demás se encola para una persona o se ignora. Una lista de permitidos es el guardarraíl con mayor relación impacto-esfuerzo que puedes añadir, porque acota el fallo a una población que tú elegiste.

### Mantén a una persona en el bucle, al menos al principio

La versión más segura de esto no es un autorrespondedor en absoluto: es un auto-*redactor*. El agente lee, redacta y prepara la respuesta, pero una persona aprueba el envío. MCP Emails admite borradores, así que puedes hacer que el bucle llame a \`draft\` (acción \`create\`) en lugar de \`email_compose\`, y luego enviar tú mismo los buenos. Ejecútalo en modo borrador durante una semana. Lee lo que habría enviado. Solo entonces pon en envío automático los que te merezcan confianza.

### Detén bucles y autorrespuestas a ti mismo

Dos modos de fallo clásicos:

- **Ping-pong de autorrespuestas.** Si respondes a una respuesta automática de vacaciones y esta responde a tu respuesta, has construido un bucle infinito con el bot de otra persona. Filtra los mensajes que parezcan automatizados (busca cabeceras \`Auto-Submitted\`, remitentes \`no-reply\` o asuntos conocidos de autorrespondedores) y nunca respondas a tu propia dirección.
- **Re-responder al mismo hilo.** Marca los mensajes como leídos tras gestionarlos y mantén un pequeño registro de los IDs de mensaje que ya has contestado. La idempotencia no es opcional cuando hay envíos de por medio.

### Limita lo que el modelo puede decir

Dale al modelo de redacción instrucciones ajustadas y un tope de longitud. Para respuestas de soporte, una plantilla con huecos gana a la generación libre. Y ejecuta una comprobación barata antes de enviar: ¿el borrador contiene una promesa de reembolso, un precio, un compromiso legal o un enlace que no esperabas? Si es así, redirígelo a una persona. Esa es la comprobación \`passes_guardrails\` del bucle de arriba, y es donde gastas la mayor parte de tu esfuerzo de ingeniería.

## Una primera versión realista

Si fuera a lanzar esto para una bandeja real mañana, empezaría pequeño y aburrido:

1. API key con \`read:email\` y \`send:email\`, acotada a una bandeja.
2. Sondear \`email_read(action: "list", unread_only: true)\` cada dos minutos.
3. Lista de permitidos con exactamente un alias de soporte.
4. Solo modo borrador: crea borradores, no envíes nada de forma automática.
5. Tras una semana leyendo los borradores, activa el envío automático para los casos obvios y sigue redactando el resto.

Ese es un sistema en el que de verdad puedes confiar, y se generaliza. El mismo bucle con un prompt distinto se convierte en un bot de triaje, un enrutador de leads o un notificador. Para ver el menú más amplio de lo que un agente puede hacer una vez conectado, consulta [7 cosas que un agente de IA puede hacer con acceso a la bandeja](/blog/7-things-ai-agent-can-do-with-inbox-access). Si aún estás decidiendo si darle a un agente acceso de envío siquiera, vale la pena leer [¿es seguro dar acceso al correo a un agente de IA?](/blog/is-it-safe-to-give-ai-agent-email-access) antes de lanzarlo.

¿Listo para construirlo? Crea una API key acotada y lee la referencia de herramientas en [la documentación](/docs), o [empieza gratis](/signup): Gratis conecta una bandeja, Personal (5 $/mes) conecta hasta tres y Pro conecta todas las que tengas, así que configura primero los guardarraíles antes de automatizar.`,
};
