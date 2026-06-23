export default {
  title: 'Firmas de correo: Claude ahora firma como lo harías tú',
  description:
    'Configura una firma por bandeja una vez y Claude la añade automáticamente a cada correo que envía: mensajes nuevos, respuestas, reenvíos, borradores y envíos programados. Funciona en Gmail, Outlook, Fastmail, iCloud y cualquier cuenta IMAP.',
  coverAlt:
    'Firmas de correo para Claude: configura una firma por bandeja una vez y Claude firma cada mensaje que envía, en todos los proveedores',
  content: `Cuando Claude envía un correo por ti, debería parecer que lo enviaste tú. Eso incluye la despedida: tu nombre, tu cargo, la línea de tu empresa, ese enlace a tu página de reservas. Hasta ahora, o bien escribías tu firma en cada prompt, o aceptabas correos que terminaban de forma un poco abrupta. Hoy eso cambia: **MCP Emails ahora aplica tu firma automáticamente a cada mensaje que Claude envía.**

Las firmas son **por bandeja**. Cada buzón conectado conserva la suya, así que el sombrero de fundador va en tu dirección de trabajo y un sencillo "— Sam" va en la personal. Una vez configurada, no vuelves a pensar en ella.

## Qué se firma

Configúrala una vez y la firma se añade automáticamente a todo lo que Claude envía desde esa bandeja:

- **Correos nuevos** — \`email_compose\` (acción \`send\`).
- **Respuestas y reenvíos** — \`email_compose\` (acciones \`reply\` y \`forward\`).
- **Borradores** — \`draft\`, así que lo que revisas ya lleva tu despedida en su sitio.
- **Envíos programados** — \`schedule\`, así que un mensaje en cola para el lunes por la mañana sale firmado.

No hay nada más que decir en tu prompt. "Responde a Dana y dile que la presentación va adjunta" produce un correo completo y firmado.

## Las respuestas y los reenvíos lo colocan bien

La parte delicada de las firmas es la colocación, y ahí es donde fallan la mayoría de las herramientas. En una respuesta o un reenvío, MCP Emails pone tu firma **después de tu texto nuevo y antes del hilo citado**, exactamente donde la pondría una persona, en lugar de dejarla varada al final bajo páginas de historial.

También es inteligente con el ida y vuelta. Hay un **modo de respuesta** para que la firma no se repita cada vez que Claude contesta dentro del mismo hilo. La primera respuesta va firmada; los seguimientos rápidos de esa conversación no se acumulan con despedidas duplicadas. Obtienes hilos limpios, no un muro de nombres repetidos.

## Funciona en todos los proveedores

Esto no es un detalle exclusivo de Gmail. Las firmas se aplican en **todos** los proveedores conectados: Gmail, Outlook, Fastmail, iCloud y cualquier otra cuenta IMAP. Como MCP Emails compone él mismo el mensaje saliente, el comportamiento es idéntico sin importar dónde resida el buzón. Conecta una nueva bandeja de cualquier tipo y las firmas simplemente funcionan.

## Dos formas de configurarla

**1. El editor de firmas en el panel.** Abre una bandeja en el panel de MCP Emails y edita su firma en línea. Cada bandeja tiene la suya, así que puedes darle a cada dirección la voz adecuada.

**2. Solo pídeselo a Claude.** Hay una nueva herramienta \`signature\`, así que puedes configurar o cambiar tu firma en lenguaje natural sin salir del chat:

> "Configura la firma de mi bandeja de trabajo como: Sam Rivera, Fundador, Acme — calendly.com/sam"

Claude la escribe para esa bandeja, y a partir de entonces cada envío va firmado. Pídele que actualice la firma más tarde y hace lo mismo.

## Cuando quieres un mensaje escueto

A veces una firma es ruido: un "¡Gracias!" de una palabra no necesita tres líneas de datos de contacto debajo. Para esos casos puntuales existe la **opción \`include_signature\`**: dile a Claude que omita la firma en un único mensaje y envía la versión escueta. Tu firma guardada permanece intacta para todo lo demás.

> "Responde 'Voy de camino' al último mensaje de la oficina, sin firma."

## Cómo encaja en el resto del flujo de trabajo

Las firmas se integran en las herramientas que ya usas. Si Claude está ejecutando tu triaje matutino y disparando respuestas, ahora cada una lleva tu despedida sin que la menciones. Lo mismo ocurre con los [patrones de autorespuesta](/blog/build-email-auto-responder-mcp-agent) y la [guía de triaje y resumen](/blog/ai-agent-triage-summarize-inbox): cualquier cosa que termine en un envío ahora termina firmada.

Y el modelo de privacidad no cambia: tu correo sigue [sin almacenarse nunca](/blog/why-email-never-stored-matters). La firma es una pequeña pieza de configuración por bandeja; tus mensajes se siguen obteniendo en directo y se descartan en cuanto Claude los tiene.

## Preguntas frecuentes

**¿Las firmas son por bandeja o por cuenta?**
Por bandeja. Cada buzón conectado tiene su propia firma, así que puedes firmar de forma distinta tus direcciones de trabajo y personal.

**¿Las respuestas y los reenvíos colocan bien la firma?**
Sí. Se coloca después de tu texto nuevo y antes del hilo citado, y el modo de respuesta evita que se repita a lo largo de un ida y vuelta en el mismo hilo.

**¿Qué proveedores admiten firmas?**
Todos: Gmail, Outlook, Fastmail, iCloud y cualquier otra cuenta IMAP. MCP Emails compone el mensaje saliente, así que el comportamiento es el mismo en todas partes.

**¿Puedo enviar un mensaje sin mi firma?**
Sí. Usa la opción \`include_signature\` (simplemente dile a Claude que omita la firma) para un mensaje escueto puntual. Tu firma guardada permanece para todo lo demás.

**¿Cómo configuro mi firma?**
De dos formas: edítala por bandeja en el panel, o pídeselo a Claude — por ejemplo, "configura mi firma como …" mediante la nueva herramienta \`signature\`.

## Conclusión

Configura tu firma una vez, por bandeja, y cada correo que Claude envíe desde ese buzón (nuevo, respuesta, reenvío, borrador o programado) sale firmado como si lo hubieras escrito tú. Funciona en todos los proveedores, se coloca correctamente en los hilos y se aparta con \`include_signature\` cuando quieres una respuesta escueta.

[Abre tu panel](/dashboard) para configurar una firma, o simplemente dile a Claude cuál debería ser la tuya. ¿Aún no te has conectado? [Empieza gratis](/signup) y conecta una bandeja en unos dos minutos.`,
};
