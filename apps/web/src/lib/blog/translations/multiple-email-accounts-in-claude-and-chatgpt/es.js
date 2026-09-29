const translation = {
  title: 'Varias cuentas de correo en Claude y ChatGPT: todos los buzones, un solo conector',
  description:
    'Cómo tener varias cuentas de correo a la vez en Claude y ChatGPT, incluidos los buzones de empresa en IONOS, Zoho, Namecheap, Google Workspace o tu propio servidor, con un solo conector MCP que funciona en los dos.',
  coverAlt:
    'Varias cuentas de correo de trabajo y personales conectadas a Claude y ChatGPT a través de un solo conector MCP',
  content: `Quieres hacer una sola pregunta y que se responda con todos los buzones que llevas: tu propia dirección, info@, ventas@, la bandeja de facturas y quizá un Gmail personal. Esta guía explica cómo tener varias cuentas de correo en Claude y ChatGPT al mismo tiempo, qué cubren ya los conectores integrados y en qué casos necesitas un servidor MCP.

**Ir a:** [Conectores integrados](#lo-que-hacen-los-conectores-integrados) · [Un conector para todos los buzones](#un-solo-conector-para-todos-los-buzones) · [Configuración en Claude](#añádelo-a-claude) · [Configuración en ChatGPT](#añádelo-a-chatgpt) · [Planes](#cuántos-buzones-conecta-cada-plan)

## Lo que hacen los conectores integrados

Los dos asistentes traen sus propios conectores de correo, y han avanzado rápido, así que esta es la situación en el momento de escribir esto (septiembre de 2026).

- **ChatGPT.** Desde finales de agosto de 2026, sus propios plugins de Gmail, Google Calendar y Google Contacts admiten más de una cuenta en Plus, Pro, Business y Enterprise, así que un Gmail personal y uno del trabajo pueden estar en la misma conversación. En septiembre, OpenAI extendió las cuentas múltiples a otros plugins. Si todos tus buzones son cuentas de Google, puede que el plugin propio de ChatGPT sea todo lo que necesitas.
- **Claude.** El centro de ayuda de Anthropic describe que el conector de Gmail llega a «the Google account you've connected», es decir, a la cuenta de Google que has conectado. Una cuenta de Google por conexión.

Lo que ninguno de los dos está pensado para cubrir es el buzón que una empresa usa de verdad en su propio dominio cuando ese dominio no está en Google ni en Microsoft: IONOS, Zoho Mail, Namecheap Private Email, STRATO, Migadu, un hosting con cPanel o tu propio servidor. Esos hablan IMAP y SMTP, y para llegar a ellos hace falta algo que hable IMAP.

## Un solo conector para todos los buzones

MCP Emails es un servidor MCP alojado. Conectas cada buzón una vez y tu cliente de IA llega a todos a través de una sola URL:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

- **Cualquier combinación de proveedores.** Gmail y Google Workspace (contraseña de aplicación o Iniciar sesión con Google), Outlook y Microsoft 365 (Iniciar sesión con Microsoft), iCloud, Fastmail, Yahoo, Zoho, Yandex y cualquier buzón que hable IMAP y SMTP. Hay una página por proveedor en [connect](/connect), incluidas [IONOS](/connect/ionos), [Zoho Mail](/connect/zoho), [Namecheap](/connect/namecheap), [STRATO](/connect/strato), [Migadu](/connect/migadu), [Google Workspace](/connect/google-workspace) y [Microsoft 365](/connect/office365).
- **Los mismos buzones en los dos asistentes.** Es un servidor MCP estándar, así que la misma conexión funciona en Claude y en ChatGPT, y también en Cursor, VS Code y otros clientes MCP. Añade un buzón una vez y todos los clientes lo ven.
- **El agente sabe qué buzón es cuál.** Llama a \`inbox_list\` y obtiene todas las direcciones conectadas con su nombre visible. Todas las demás herramientas indican el buzón sobre el que actúan, así que basta con decir «en ventas@» con tus propias palabras.
- **Las respuestas salen desde la dirección correcta.** Cada buzón envía a través de su propio proveedor o servidor SMTP, con su propio nombre de remitente y su propia firma. Una respuesta a un hilo de soporte@ sale desde soporte@.

El correo se obtiene en vivo en cada solicitud y no se almacena. La única excepción es un mensaje que programas para más tarde, que se guarda hasta que se envía.

## Conecta los buzones

En el panel de MCP Emails, abre **Inboxes**, luego **Connect Inbox**, una vez por buzón:

- **Buzón de empresa en su propio dominio.** Elige **IMAP** y escribe la dirección. Los proveedores habituales se reconocen a partir de la dirección, y un dominio de Google Workspace se reconoce por sus registros de correo, así que los ajustes se rellenan solos. Usa la contraseña o la contraseña de aplicación que pida tu proveedor.
- **Gmail o Google Workspace.** Una contraseña de aplicación, o Iniciar sesión con Google. En Workspace, tu administrador decide si se permiten las contraseñas de aplicación e IMAP.
- **Outlook o Microsoft 365.** Iniciar sesión con Microsoft. Una cuenta de trabajo o educativa puede necesitar que su administrador de TI apruebe la aplicación una sola vez para toda la organización.

Dale a cada buzón un nombre visible claro, como «Acme Ventas» en lugar de «trabajo2». Es lo que lee el agente para distinguirlos, y es el nombre que ven los destinatarios.

## Añádelo a Claude

En claude.ai o Claude Desktop:

1. Abre **Settings**, luego **Connectors**.
2. Elige **Add custom connector** y pega \`https://mcpemails.com/api/mcp\`.
3. Selecciona **Connect**, inicia sesión en MCP Emails y aprueba.

Todos los buzones que conectaste quedan disponibles. La [guía de Claude](/blog/connect-claude-to-email) tiene los detalles.

## Añádelo a ChatGPT

Los conectores personalizados requieren ChatGPT Plus, Pro, Business, Enterprise o Edu en la web, con el modo de desarrollador activado. En Business y Enterprise, puede que un administrador tenga que permitirlo antes.

1. Activa el **modo de desarrollador** en los ajustes de ChatGPT, dentro de la configuración avanzada de aplicaciones y conectores.
2. Crea un conector, pega \`https://mcpemails.com/api/mcp\`, elige **OAuth** y autoriza con MCP Emails.
3. En cada chat nuevo, haz clic en **+**, elige **Developer mode** y selecciona la app de MCP Emails.

La [guía de ChatGPT](/blog/connect-chatgpt-to-email) explica los menús y los errores habituales.

## Prompts que usan varios buzones

> Revisa ventas@ e info@ y haz una lista de todas las consultas de esta semana que nadie ha respondido. Una sola lista combinada, con el buzón del que viene cada una. No envíes ni muevas nada.

> Busca la factura de Hetzner de agosto. Busca en todos los buzones conectados y dime en cuál está.

> Redacta una respuesta desde soporte@ a la última queja sobre una entrega. Enséñamela antes de enviarla.

Una llamada llega a un solo buzón, así que «busca en todos los buzones» es el agente ejecutando la búsqueda una vez por buzón y combinando las respuestas. Pide una sola lista combinada, o recibirás un informe por cuenta. [Cómo gestionar varias cuentas de correo con IA](/blog/manage-multiple-email-accounts-with-ai) profundiza en cómo acotar solicitudes, la identidad del remitente y la revisión por buzón.

## Deja a una persona en el botón de enviar

Activa **Revisar antes de enviar** (Review before sending) en cualquier buzón y cada envío, respuesta, reenvío, envío de borrador y envío programado desde él esperará tu aprobación en el panel. Se configura por buzón, así que la bandeja de facturas puede quedar retenida mientras la tuya envía libremente. Está incluido en todos los planes, también en el gratuito. Consulta [aprobación humana para los envíos de correo de un agente de IA](/blog/approve-ai-agent-email-sends).

## Cuántos buzones conecta cada plan

- **Free:** un buzón.
- **Personal:** tres buzones.
- **Pro:** todos los buzones que lleves, sin límite, con un solo inicio de sesión.
- **Team:** para cuando una segunda persona necesita su propio inicio de sesión.

Una empresa con info@, ventas@ y facturas@ más tu propia dirección son cuatro buzones, es decir, Pro. Los precios actuales están en la [página de precios](/pricing), y [MCP Emails para empresas](/for/business) muestra cómo una sola persona lleva todos los buzones de la empresa desde un solo agente.

## Preguntas frecuentes

**¿Puede Claude usar más de una cuenta de correo a la vez?**
Sí, a través de un servidor MCP. Conecta cada buzón a MCP Emails, añade un conector personalizado a Claude y Claude los verá todos e indicará el buzón en cada llamada.

**¿Puede ChatGPT usar más de una cuenta de correo?**
Su propio plugin de Gmail ya admite varias cuentas de Google. Para los buzones que no están en Google, como una dirección de empresa en IONOS, Zoho o un hosting con cPanel, añade MCP Emails como conector personalizado y todos los buzones conectados quedarán disponibles.

**¿Necesito un conector distinto para cada buzón?**
No. Una sola URL de conector cubre todos los buzones de tu espacio de trabajo de MCP Emails, y la misma URL funciona en Claude, ChatGPT y otros clientes MCP.

**¿Saldrá la respuesta desde la dirección correcta?**
Sí. Cada buzón envía a través de su propio proveedor o servidor de correo, con su propio nombre visible y su propia firma. Enviar desde una dirección que no es la del propio buzón solo funciona con una dirección Send As de Gmail verificada en un buzón conectado con Iniciar sesión con Google, y se rechaza en los demás casos.

**¿Se almacena el correo de todas esas cuentas?**
No. El contenido de los mensajes se obtiene en vivo de tu proveedor en cada solicitud y se descarta. Lo que se conserva es la credencial cifrada de cada buzón. Consulta [seguridad](/security).

## Siguiente paso

[Empieza gratis](/signup) con tu buzón más activo, añade el conector de MCP Emails a Claude o ChatGPT y pregunta qué necesita respuesta hoy. Añade los demás buzones cuando quieras una sola respuesta en lugar de varias.`,
};

export default translation;
