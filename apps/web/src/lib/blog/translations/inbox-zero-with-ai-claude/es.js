export default {
  title: 'Cómo llegar al inbox zero con IA (usando Claude y tu bandeja de entrada real)',
  description:
    'Llega al inbox zero con IA: deja que Claude clasifique, archive, etiquete y redacte respuestas en tu bandeja real de Gmail o IMAP a través de MCP. Una rutina repetible, los prompts exactos y por qué no se almacena nada.',
  coverAlt: 'Llega al inbox zero con IA — Claude clasifica, archiva y redacta respuestas en tu bandeja real a través de MCP',
  content: `El inbox zero siempre ha tenido el mismo problema: alcanzarlo te cuesta una hora que no tienes, y mañana vuelves a tener cincuenta sin leer. Un agente de IA cambia las cuentas. En lugar de ordenar tú los mensajes uno a uno, le dices a Claude qué significa "gestionado" y trabaja toda la bandeja a la vez — clasificando, archivando, etiquetando y redactando respuestas sobre tu correo *real*, en directo.

Esta guía es la rutina: un bucle repetible que puedes ejecutar cada mañana, los prompts exactos que lo impulsan y la única regla que lo mantiene seguro (nunca se almacena nada). Da por hecho que Claude ya puede ver tu bandeja de entrada. Si todavía no puede, empieza por [cómo conectar Gmail con Claude](/blog/connect-gmail-to-claude) — lleva unos dos minutos — y luego vuelve.

## Por qué el "inbox zero" por fin es realista con IA

La razón por la que el inbox zero se derrumba es volumen más criterio. La mayoría de los mensajes necesitan una *decisión* — archivar, responder, posponer, eliminar — y tomar cincuenta pequeñas decisiones es agotador. Claude es bueno precisamente en eso: leer el mensaje, aplicar tus reglas, ejecutar la acción. No se aburre con el cuadragésimo boletín.

El cambio clave es que dejas de *procesar* el correo y pasas a *supervisarlo*. Tú fijas la política ("archiva todos los boletines, marca cualquier cosa de un cliente, redacta respuestas que yo pueda aprobar") y Claude la ejecuta sobre toda la bandeja en una sola pasada.

## La rutina matinal, en cinco prompts

Ejecútalos en orden. Cada uno es una frase normal — Claude lo asigna a la herramienta correcta (\`email_read\`, \`email_organize\`, \`draft\`) entre bastidores.

**1. Hazte una idea del panorama.**

> "Resume mis correos sin leer de las últimas 24 horas. Agrúpalos en: necesita respuesta, para tu información y ruido."

Claude lista y lee tu correo sin leer y te entrega una visión clasificada en lugar de un muro de asuntos. Ahora sabes a qué te enfrentas en un párrafo.

**2. Elimina el ruido.**

> "Archiva todos los boletines y correos promocionales de esa lista. No toques nada de una persona real."

Esto es \`email_organize\` haciendo el trabajo aburrido — archivando en masa para que tu bandeja solo contenga cosas que podrían necesitarte. Aquí suele desaparecer la mitad de la bandeja.

**3. Etiqueta lo que queda.**

> "Etiqueta como 'Prioritario' cualquier cosa de un cliente o sobre una factura, y como 'Para tu información' aquello en lo que solo estoy en copia."

Ahora los supervivientes están ordenados. Claude aplica etiquetas de Gmail (o carpetas IMAP) para que los hilos importantes queden agrupados visualmente antes de que dediques un segundo de atención.

**4. Redacta las respuestas — pero no las envíes.**

> "Por cada correo que necesite respuesta, escribe un borrador breve con mi tono. Guárdalos como borradores; no envíes nada."

Esta es la parte que de verdad te ahorra la hora. Claude crea \`draft\`s reales que quedan en tu bandeja, listos para que los revises, ajustes y envíes. Mantienes el control de cada mensaje saliente — consulta [OAuth frente a claves de API](/blog/oauth-vs-api-keys-ai-email-access) si prefieres conceder solo lectura y que nunca pueda enviar.

**5. Pospón el resto.**

> "Programa un recordatorio de seguimiento para los dos hilos que no he decidido, para mañana por la mañana."

Todo lo que no puedas resolver recibe un aviso \`schedule\` para que salga de tu cabeza sin desaparecer de tu bandeja para siempre. Eso es el inbox zero: nada sin gestionar, nada olvidado.

## Conviértelo en un hábito, no en una tarea pesada

La rutina anterior dura unos cinco minutos una vez que Claude hace el trabajo duro. Algunas formas en que la gente la mantiene constante:

- **Una frase desencadenante.** Guarda toda la secuencia como un único mensaje: *"Ejecuta mi clasificación matinal de la bandeja."* Claude recuerda los pasos dentro de una conversación, así que una sola línea arranca el bucle.
- **Ajusta las reglas con el tiempo.** Cuando Claude archive algo que no debería, díselo una vez — "nunca archives nada de mi jefe" — e incorpóralo a tus instrucciones permanentes.
- **Limpieza a fondo semanal.** Una vez por semana: *"Encuentra todos los correos sin leer de más de 30 días y archívalos o elimínalos."* La cola larga es donde el inbox zero suele morir; deja que Claude la despeje. Para más patrones, consulta [las mejores formas de dejar que Claude gestione tu bandeja](/blog/best-ways-to-let-claude-manage-your-inbox) y el [manual de clasificar y resumir](/blog/ai-agent-triage-summarize-inbox).

## La única regla que mantiene esto seguro

Entregar toda tu bandeja a una IA suena arriesgado hasta que sabes adónde van los datos: **a ninguna parte.** Con MCP Emails, cada uno de esos prompts obtiene tu correo en directo desde Gmail o IMAP, se lo entrega a Claude para esa única acción y lo descarta de inmediato. Los cuerpos de los mensajes, los asuntos y los archivos adjuntos nunca se almacenan — lo único que se guarda por bandeja es un token cifrado para que pueda producirse la siguiente llamada. Esa es la diferencia entre darle a un agente una *llave* y darle una *copia permanente de todo*; aquí tienes [por qué importa que "el correo nunca se almacena"](/blog/why-email-never-stored-matters), y el [desglose completo de seguridad](/blog/is-it-safe-to-give-ai-agent-email-access) si quieres el modelo de amenazas.

También mantienes una línea firme respecto al envío: los borradores siguen siendo borradores hasta que los apruebas, y puedes conceder acceso de solo lectura para que Claude literalmente no pueda enviar.

## Llega a cero hoy mismo

No necesitas una nueva aplicación de correo ni un sistema de productividad — solo tu bandeja de entrada actual y un agente que pueda actuar sobre ella. Conecta tu bandeja una vez, pega el endpoint en Claude y ejecuta los cinco prompts de arriba. Todos los planes son ilimitados y el plan Free no necesita tarjeta.

[Conecta tu bandeja gratis](/signup) y pídele a Claude que clasifique tu correo sin leer. Inbox zero, supervisado en lugar de sufrido.`,
};
