const translation = {
  title: 'Reglas automáticas de triaje de correo que funcionan sin un modelo de por medio',
  description:
    'Cómo funcionan las automatizaciones de MCP Emails: una búsqueda guardada más una acción fija, con una cadencia y sin que ningún modelo interprete tu correo. Previsualiza, crea, activa y lee el registro de ejecuciones.',
  coverAlt:
    'Reglas de triaje de correo desatendidas en MCP Emails: una búsqueda guardada más una acción fija según un calendario',
  content: `> **Outlook y Microsoft 365 están en desarrollo.** Todavía no se pueden conectar en producción.

Cada mañana le pides a tu agente que despeje el ruido: archivar las notificaciones de compilación, marcar los recibos como leídos, reenviar las facturas a tu contable. Funciona. También cuesta una llamada al modelo cada vez, y el martes hace algo ligeramente distinto de lo que hizo el lunes.

MCP Emails tiene una segunda superficie para exactamente ese correo. Una **automatización** es una búsqueda guardada más una acción fija, evaluada con una cadencia y sin ningún modelo de por medio. El correo se compara, nunca se interpreta.

**Ir a:** [Qué es una regla](#qu-es-realmente-una-automatizacin) · [Crea una](#crea-una-previsualiza-crea-activa) · [Qué puede y qué no](#lo-que-una-regla-puede-y-no-puede-hacer) · [Cuándo no escribirla](#cundo-no-escribir-una-regla)

## Qué es realmente una automatización

Tres partes, y nada más.

- **Un filtro.** Los mismos criterios estructurados que acepta una búsqueda: \`from\`, \`to\`, \`cc\`, \`subject\`, \`body\`, \`text\`, \`unread\`, \`has_attachment\`, \`flagged\`, \`since\`, \`before\`. Se exige al menos un criterio. Un filtro vacío se rechaza de plano: con una cadencia rápida procesaría todo tu buzón, algo que es mucho más probable que sea una errata que una intención.
- **Una acción.** Exactamente una, de un conjunto cerrado, fijada al crear la regla.
- **Una cadencia.** \`interval_minutes\`, tomada de una escala fija: 15, 30, 60, 180, 360, 720 o 1440 minutos. Una escala en vez de un entero libre, porque una regla de un minuto no consigue nada salvo que te limiten la tasa de llamadas.

Define también \`max_messages_per_run\` (25 por defecto, 200 como máximo): es el radio de impacto por ejecución y limita cuánto correo puede tocar un filtro defectuoso antes de que una persona vea el registro de ejecuciones. Una regla se ejecuta con la credencial que la creó, y la autoridad se vuelve a derivar en cada ejecución, así que revocar la clave detiene la regla en su siguiente ejecución.

## Por qué una regla supera a pedírselo al agente cada mañana

- **Coste.** Una regla no gasta tokens. La conversación matutina los gasta a diario, sobre correo cuyo tratamiento decidiste hace meses.
- **Repetibilidad.** El mismo filtro produce la misma acción. No hay un «hoy decidió otra cosa» porque no hay ninguna decisión.
- **Sin movimientos alucinados.** Una regla no puede inventarse una carpeta, improvisar un destinatario ni actuar según una instrucción encontrada dentro del cuerpo de un correo.
- **Se ejecuta mientras duermes.** MCP Emails funciona por lo demás con sondeo: el agente comprueba si hay correo nuevo cuando se lo pides. La regla es la parte que no hay que pedir.

## El triaje con agente y las reglas desatendidas hacen cosas distintas

Las reglas se ocupan del correo identificable por su sobre: un remitente conocido, un prefijo de asunto estable, una marca de no leído, un adjunto. La conversación se ocupa del correo que requiere criterio. No expreses criterio como un filtro: una regla que adivina la intención a partir de una línea de asunto se equivocará sin supervisión, a escala y durante semanas. Si la decisión exige entender el cuerpo, mantenla en una conversación y usa el [manual de triaje y resumen](/blog/ai-agent-triage-summarize-inbox).

## Crea una: previsualiza, crea, activa

Tres pasos en ese orden. El orden es la propiedad de seguridad.

### Paso 1: prueba en seco el filtro

\`automation_read\` con la acción \`preview\` es una prueba en seco. Informa de lo que un filtro encuentra ahora mismo, no aplica nada, no envía nada y no reclama ningún mensaje en el registro de deduplicación, así que nunca consume correo que debería ver una ejecución real posterior. Previsualiza un \`filter\` sin guardar, o una regla guardada mediante \`automation_id\`.

> Previsualiza un filtro de automatización en mi buzón de trabajo: correo no leído de notifications@github.com. Muéstrame qué encontraría ahora mismo. No crees ni cambies nada.

Lee las coincidencias. Si algo de esa lista no debería moverse, el filtro está mal: ajústalo y previsualiza otra vez.

### Paso 2: crea la regla

\`automation\` con la acción \`create\` necesita cuatro cosas: \`name\`, \`filter\`, \`rule_action\` e \`interval_minutes\`. Fíjate en las dos claves, porque es fácil confundirlas. En la herramienta, \`action\` selecciona la operación (create, update, enable, disable, delete). \`rule_action\` es lo que la **regla** le hace al correo coincidente.

> Crea una automatización llamada «GitHub notifications» en mi buzón de trabajo. Filtro: de notifications@github.com. Acción de la regla: mover a la carpeta Notifications. Intervalo: 60 minutos.

La regla se crea **desactivada**, y eso no es un indicador que puedas cambiar en la misma llamada. Activarla es siempre un acto aparte y explícito, de modo que ningún trabajo desatendido sobre el buzón arranca como efecto secundario de crear una regla.

### Paso 3: actívala

\`automation\` con la acción \`enable\`. La regla pasa a estar pendiente de inmediato, se ejecuta y luego sigue su cadencia. Este es el momento en que el servidor empieza a tocar tu buzón sin que nadie mire, y por eso tiene su propio paso. \`delete\` elimina una regla pero conserva su historial de ejecuciones.

## Lo que una regla puede y no puede hacer

Las cinco acciones de regla:

- **move** a una carpeta que tú indiques.
- **label**, aplicada como etiqueta de Gmail, categoría de Outlook o palabra clave IMAP. En IMAP una etiqueta es un átomo, así que los espacios se convierten en guiones bajos.
- **mark_read**.
- **forward** hasta a diez destinatarios, con una nota breve opcional. Un reenvío queda **siempre** retenido para [aprobación humana](/blog/approve-ai-agent-email-sends), diga lo que diga el ajuste de aprobación del buzón: ese ajuste significa «una persona vigila los envíos de este buzón», y un ejecutor desatendido es justo lo que rompe esa premisa.
- **draft_reply**, que solo escribe un borrador y nunca envía. Su plantilla sustituye \`{{sender_name}}\`, \`{{sender_email}}\`, \`{{subject}}\` y \`{{date}}\`, y nada más. Los cuerpos de los mensajes no se interpolan nunca.

Lo que una regla no puede hacer:

- **Borrar correo.** Borrar no está disponible para una automatización. Mover a Papelera, Correo no deseado o Spam también se rechaza: todos los proveedores vacían esas carpetas con un temporizador, así que archivar ahí es un borrado con mecha retardada. Archiva en una carpeta tuya y bórrala tú mismo cuando hayas leído el registro de ejecuciones.
- **Interpretar nada.** Ni resúmenes ni «si suena urgente».
- **Encadenar dos acciones.** Etiquetar y marcar como leído son dos reglas sobre el mismo filtro.

## Seguimiento del historial de ejecuciones

\`automation_read\` con la acción \`runs\` lista las ejecuciones recientes y sus contadores: coincidencias, procesados, correctos, fallidos y omitidos. La acción \`list\` devuelve todas las reglas del espacio de trabajo con su calendario, su acción y su estado de salud; \`get\` lee una al completo, filtro y estado de fallos incluidos.

El contador que conviene entender es el de omitidos (**skipped**). Un recuento alto de omitidos frente a un recuento bajo de procesados no es un problema: significa que una ejecución solapada se deduplicó correctamente. Cada regla reclama un mensaje antes de actuar sobre él, así que una ejecución reenviada no puede mover el mismo correo dos veces. Las reglas además se detienen solas tras cinco ejecuciones fallidas consecutivas, en lugar de seguir chocando eternamente contra un nombre de carpeta incorrecto.

## Cuándo no escribir una regla

- La decisión exige leer y entender el cuerpo. Mantenla en una conversación.
- El remitente no es estable. Un filtro sobre un blanco móvil envejece mal.
- Es una limpieza puntual. Pide al agente que ejecute \`email_search_and_move\` una vez y obsérvalo.
- No la has previsualizado. Una regla sin prueba en seco es una conjetura programada.

## Una bandeja realista: unas pocas reglas y una conversación

Cuatro reglas que despejan todo lo mecánico, más una conversación matutina sobre lo que queda:

1. Notificaciones de despliegue de un remitente conocido, movidas a una carpeta, cada 60 minutos.
2. Recibos y confirmaciones de pedido, etiquetados, cada 180 minutos.
3. Facturas de una dirección de facturación conocida, reenviadas a tu contable y retenidas para tu aprobación, cada 720 minutos.
4. Un remitente de boletines que conservas pero nunca lees, marcado como leído, cada 1440 minutos.

Después preguntas a tu agente por los treinta mensajes que quedan en lugar de por los ciento ochenta que llegaron. Las reglas no intentan ser listas. Retiran todo lo que nunca necesitó inteligencia.

## Las reglas cuentan para las acciones de tu plan

Cada acción que aplica una regla se contabiliza igual que una interactiva, porque el efecto sobre el buzón es el mismo. En el plan **Free** son 150 acciones de correo facturables por mes natural UTC, con los primeros 7 días sin contar. Ese límite mensual se aplica a los espacios de trabajo creados a partir del 2026-09-13; los creados antes están exentos. Cuando un espacio de trabajo alcanza su cuota, la regla se **pausa** en lugar de fallar: sigue activada y su siguiente ejecución se traslada al momento en que termina el periodo de la cuota. **Personal**, por $5 al mes, elimina el límite mensual de acciones y permite 3 buzones conectados. Consulta los [precios](/pricing).

## Preguntas frecuentes

**¿Una automatización usa un LLM?**  
No. Una regla es una búsqueda guardada más una acción fija. El correo se compara, nunca se interpreta, y los cuerpos de los mensajes nunca se copian en nada de lo que produce una regla.

**¿Puede una regla borrar mi correo?**  
No. Borrar no está disponible para las automatizaciones, y mover correo a Papelera, Correo no deseado o Spam se rechaza por la misma razón.

**¿Qué permiso hace falta?**  
Toda acción de automatización requiere \`manage:automations\`, una concesión distinta de la de leer o enviar, porque tenerla significa que un cliente puede crear reglas permanentes que tocan tu buzón sin supervisión.

**¿Una regla de reenvío enviará correo por su cuenta?**  
Nunca. Un reenvío queda siempre retenido para aprobación humana con independencia del ajuste de aprobación de tu buzón, y una regla \`draft_reply\` solo escribe un borrador.

## Siguiente paso

[Crea una cuenta gratuita](/signup), conecta un buzón y pide a tu agente que previsualice un filtro antes de guardar nada. Cuando las coincidencias tengan buena pinta, crea la regla, actívala y lee mañana el registro de ejecuciones. La [documentación](/docs) tiene la referencia completa de herramientas.`,
};

export default translation;
