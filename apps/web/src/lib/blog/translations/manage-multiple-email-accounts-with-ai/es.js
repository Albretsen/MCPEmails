const translation = {
  title: 'Cómo gestionar varias cuentas de correo con un solo agente de IA',
  description:
    'Gestiona los buzones de trabajo, personales y de tu negocio paralelo con un solo agente de IA: cómo descubre los buzones, cómo acotar una solicitud, nombres de remitente que siguen siendo correctos y revisión de envíos por buzón.',
  coverAlt:
    'Un agente de IA conectado a cuentas de correo de trabajo, personales y de negocio paralelo con MCP Emails',
  content: `> **Outlook y Microsoft 365 están en desarrollo.** Todavía no se pueden conectar en producción. Todo lo que sigue se aplica a Gmail, iCloud, Fastmail, Yahoo, Zoho y otros buzones IMAP.

Casi nadie tiene un solo buzón. Tienes una dirección de trabajo, una personal y al menos una más para un negocio paralelo o para un dominio que todavía conservas. Cada pregunta que cruza dos cuentas se convierte en una búsqueda manual en dos sitios.

Un solo agente de IA sobre todas ellas elimina el cambio constante, pero solo si el agente sabe qué buzón es cuál y si las respuestas salen desde la dirección correcta.

**Ir a:** [Descubrimiento](#el-agente-encuentra-los-buzones-por-su-cuenta) · [Acotar una solicitud](#limita-una-solicitud-a-un-solo-buzn) · [Límites del plan](#dnde-caen-los-lmites-del-plan)

## Por qué un solo agente supera cambiar de cliente de correo

Un cliente de correo te muestra cuentas. No responde preguntas. «¿En cuál de mis cuentas llegó el recibo de Stripe?» es una búsqueda en tres buzones más un juicio propio. Un agente con acceso a todos los buzones hace eso en una sola solicitud, y dejas de ser tú quien enruta. La segunda ventaja: un único conjunto de hábitos, porque las mismas herramientas están detrás de cada cuenta.

## El agente encuentra los buzones por su cuenta

Nunca pegas el identificador de un buzón en un prompt. El agente llama a \`inbox_list\`, que devuelve todos los buzones que tu clave puede usar, cada uno con su UUID, su dirección de correo, su nombre visible, su proveedor, una marca de servicio opcional y un objeto de capacidades. Todas las demás herramientas toman o bien \`inbox_id\` (un UUID, o una dirección) o bien \`inbox\` (una dirección), rellenado a partir de ese resultado.

Dos detalles que conviene conocer:

- **El descubrimiento es gratis.** \`inbox_list\` es la única herramienta que no cuenta contra la asignación mensual de acciones del plan Free, así que un agente puede reorientarse sin coste alguno.
- **Los selectores contradictorios se rechazan, no se adivinan.** Una llamada que lleva un \`inbox_id\` de un buzón y una dirección \`inbox\` de otro distinto se rechaza, y el error nombra los dos. La causa habitual es un identificador antiguo arrastrado desde antes en la conversación. Dile al agente que lo reintente solo con la dirección.

## Limita una solicitud a un solo buzón

Nombra la cuenta. Las direcciones funcionan en todos los sitios donde funciona un identificador, así que basta con lenguaje llano:

> Solo en jane@acme.com, lista todo lo no leído de los dos últimos días y dime qué necesita respuesta hoy. No toques mis otras cuentas.

También puedes imponer el alcance fuera del prompt. En el panel, cada clave de API tiene un ajuste **Acceso a buzones** (Inbox access): todos los buzones, o una lista explícita. Una clave limitada al buzón de tu negocio paralelo no puede leer los otros dos, diga lo que diga un prompt.

## El fan-out es el agente llamando una vez por buzón

Esta es la parte que la gente entiende mal: **una llamada llega a un solo buzón.** Listar, leer, buscar, mover y eliminar están siempre acotados a un único buzón, y no hay fan-out automático. Así que «busca en todas mis cuentas» es el agente ejecutando la búsqueda una vez por buzón y combinando él mismo los resultados. Funciona bien, con tres consecuencias:

- Deja que llame primero a \`inbox_list\`, o dile cuántas cuentas tienes. Si supone que hay una, informará con total seguridad sobre una sola.
- Pide una respuesta combinada («una sola lista, etiquetada con la cuenta de la que viene»), o recibirás tres informes separados.
- El volumen crece con el número de buzones. Un triaje de tres buzones son al menos tres acciones facturables, no una.

## Nombres e identidad de remitente

Un solo campo hace tres trabajos. Cada buzón tiene un nombre visible: es la **Etiqueta** (Label) en la lista de tu panel, el \`display_name\` que el agente lee de \`inbox_list\`, y el nombre que los destinatarios ven en la cabecera From, delante de la dirección.

Por eso «work2» es un mal nombre por partida doble: el agente no puede saber para qué sirve el buzón, y algún cliente de correo mostrará «work2» junto a tu dirección. Usa algo que un desconocido pueda leer, como «Jane Doe (Acme)» o «Northside Studio». Configúralo en el panel, en el **Nombre del remitente** (Sender name) del buzón, o con \`signature_set\`, y léelo de vuelta con \`signature_get\`. Los nombres tienen un límite de 100 caracteres.

Enviar desde un alias es más estrecho de lo que la gente espera:

- Tu propia dirección conectada siempre funciona como valor de From, en todos los proveedores.
- Una dirección **distinta** tiene que ser una identidad Send As de Gmail verificada, listada en \`sender_identities\` dentro de la entrada de ese buzón en \`inbox_list\`.
- En un proveedor que no sea Gmail, una dirección From que no sea la propia del buzón se rechaza en lugar de reescribirse en silencio.

Las firmas también son por buzón: una formal en la dirección de trabajo, ninguna en la personal. Consulta [firmas de correo para Claude](/blog/email-signatures-for-claude).

## Revisión de envíos por buzón

La revisión se configura buzón a buzón. Cada uno tiene un ajuste **Revisar antes de enviar** (Review before sending) con tres opciones: enviar de inmediato, mostrar una tarjeta de revisión en la conversación con la IA, o revisar solo en el panel.

Eso es lo que hace cómoda una configuración mixta: deja el buzón del negocio paralelo en envío inmediato y retén para revisión cada envío del trabajo. En los dos modos de revisión el correo se prepara pero no se entrega, y la aprobación ocurre únicamente en una sesión de navegador iniciada por un propietario o un administrador. La tarjeta dentro de la conversación es una comodidad, no un límite de permisos. [Aprobación humana para los envíos de correo de un agente de IA](/blog/approve-ai-agent-email-sends) profundiza en el tema.

## Tres rutinas entre buzones que merece la pena copiar

**Un triaje matinal sobre todo.** Pide una única lista ordenada, no un resumen por cuenta:

> Revisa todos mis buzones conectados. Dame una sola lista combinada de lo que necesita respuesta hoy, de más reciente a más antiguo, etiquetada con la cuenta en la que llegó. No muevas, envíes ni elimines nada.

El [manual de triaje de la bandeja de entrada](/blog/ai-agent-triage-summarize-inbox) tiene rúbricas para pegar en ese prompt.

**Encontrar un hilo cuando olvidas la cuenta.**

> Busca la factura de Hetzner de agosto. Busca en todos los buzones conectados y dime en qué cuenta está y cuál es el importe.

**Mover una conversación entre roles.** Cuando un contacto personal se convierte en cliente, reenvía el hilo al buzón del negocio y haz que la respuesta se redacte desde la dirección del negocio. Pide al agente que confirme primero desde qué buzón está enviando.

## Qué cambia cuando mezclas Gmail e IMAP

Las configuraciones mixtas son lo normal, y los proveedores no se ponen de acuerdo sobre qué es una carpeta.

- **Gmail tiene etiquetas.** Un movimiento añade una etiqueta y quita el mensaje de la bandeja de entrada. Las demás etiquetas siguen puestas, así que un mensaje puede estar en varios sitios a la vez.
- **IMAP tiene carpetas.** Un movimiento es un movimiento: el mensaje sale de una carpeta y llega a otra.
- **Los nombres de carpeta cambian.** Archive, All Mail, Spam, Junk y los nombres localizados varían según el proveedor. Haz que el agente llame a \`folder_list\` en el buzón que va a tocar.
- **El alcance por carpetas es por buzón.** Restringir una búsqueda a un conjunto de carpetas se aplica dentro de un solo buzón, así que una búsqueda acotada por carpetas en varias cuentas sigue siendo una llamada por cuenta.

[Etiquetas de Gmail frente a carpetas IMAP](/blog/gmail-labels-vs-imap-folders-ai-agents) explica qué significa de verdad «archivar» en cada lado.

## Dónde caen los límites del plan

Los buzones conectados son lo que marca el precio de los planes:

- **Free, $0.** Un buzón conectado. 150 acciones de correo facturables por mes natural UTC, con los primeros 7 días sin contar. Ese límite mensual se aplica a los espacios de trabajo creados el 2026-09-13 o después; los espacios de trabajo creados antes están exentos.
- **Personal, $5 al mes o $48 al año.** Tres buzones conectados, sin límite mensual de acciones, límite de ráfaga 2x y soporte por correo.
- **Pro, $15 al mes o $144 al año.** Buzones conectados ilimitados, límite de ráfaga 5x e historial de analítica más largo.
- **Team, $79 al mes o $756 al año.** Miembros ilimitados con roles, un espacio de trabajo separado por cliente o negocio, SSO (SAML/OIDC) y registro de auditoría, soporte prioritario.

Una rutina entre buzones cuesta una acción por buzón, así que tu número de buzones marca el volumen tanto como tus hábitos. Detalles en [precios](/pricing).

## Preguntas frecuentes

**¿Cómo sabe el agente a qué buzón me refiero?**
Por \`inbox_list\`, que devuelve la dirección y el nombre visible de cada buzón que puede usar. Nombra la dirección en tu solicitud. Un identificador de buzón y una dirección que no coinciden se rechazan, no se adivinan.

**¿Saldrán las respuestas desde la dirección correcta?**
Sí, cuando envías desde el buzón dueño de esa dirección: cada buzón envía a través de su propio proveedor, su nombre visible y su firma. Una dirección From distinta requiere una identidad Send As de Gmail verificada, y se rechaza en otros proveedores.

**¿Puedo dejar que el agente envíe libremente desde un buzón y retener otro?**
Sí. Revisar antes de enviar es un ajuste por buzón, así que un buzón puede enviar de inmediato mientras otro espera tu aprobación en un navegador con la sesión iniciada.

**¿Se almacena en algún sitio el correo de todas esas cuentas?**
No. El contenido de los mensajes se obtiene en tiempo real de tu proveedor en cada solicitud y luego se descarta. Solo se conserva la credencial cifrada del proveedor. Consulta [seguridad](/security).

## Siguiente paso

[Empieza gratis](/signup), conecta tu buzón más activo y pregunta a tu agente qué necesita respuesta hoy. Añade la segunda y la tercera cuenta cuando quieras una sola respuesta en vez de tres. La [documentación](/docs) tiene la referencia completa de herramientas, y los [detalles por proveedor](/docs/providers) cubren lo que admite cada tipo de buzón.`,
};

export default translation;
