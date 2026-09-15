const translation = {
  title: 'Correo con IA para agencias: un agente en todos los buzones de tus clientes',
  description:
    'Cómo una agencia o un profesional independiente da a un agente de IA acceso a varios buzones de clientes sin mezclarlos: un espacio de trabajo por cliente, claves acotadas, solo lectura primero y una aprobación humana en cada envío.',
  coverAlt:
    'Un agente de IA trabajando sobre buzones de clientes separados con acceso acotado, MCP Emails',
  content: `> **Outlook y Microsoft 365 están en desarrollo.** Todavía no se pueden conectar en producción, así que un cliente con Microsoft 365 tendrá que esperar. Hoy funcionan Google Workspace (con una contraseña de aplicación de Google sobre IMAP por defecto, y también OAuth), Zoho, Fastmail, Migadu, Titan, Rackspace, IONOS y cualquier proveedor IMAP estándar.

Si gestionas el correo de más de un cliente, vives con una regla: nada del cliente A puede aparecer en un hilo del cliente B. Un agente de IA no cambia la regla, solo hace que sea más fácil romperla. Un único agente con una única credencial que alcanza todos los buzones que administras está a un descuido de citar la factura equivocada a la persona equivocada.

Hay tres fallos contra los que conviene diseñar: la **fuga entre clientes**, cuando una credencial demasiado amplia permite que una búsqueda encuentre el buzón que no era; el **colaborador que se va**, cuyo portátil sigue guardando una clave de API que funciona; y el **envío sin revisar**, cuando un agente responde al cliente de tu cliente con educación y con datos incorrectos. Si construyes la separación dentro del propio acceso, el agente no puede cruzar la frontera ni aunque un mensaje se lo pida.

**Ir a:** [Un espacio de trabajo por cliente](#un-espacio-de-trabajo-por-cliente) · [Claves de API acotadas](#claves-de-api-acotadas-por-encargo) · [La aprobación previa al envío](#la-aprobacin-previa-al-envo)

## Un espacio de trabajo por cliente

El espacio de trabajo es la unidad de separación. Los buzones, los miembros, las claves de API y la actividad viven dentro de uno, y la frontera se aplica en la base de datos con seguridad a nivel de fila, no filtrando con cuidado en el código de la aplicación. Una clave emitida en el espacio de Acme no puede leer un buzón de Bolt, diga lo que diga la instrucción.

Tener más de un espacio de trabajo es una función de **Team** ($79/mes, $756/año), que además incluye miembros ilimitados con roles, SSO (SAML / OIDC), registro de auditoría y soporte prioritario. La suscripción va asociada a tu cuenta y no a un espacio concreto, así que una sola suscripción Team cubre todos los espacios de cliente que crees. Ponle a cada uno el nombre del cliente, conecta dentro solo los buzones de ese cliente y cambia entre ellos desde la barra lateral del panel.

Por debajo de Team, los planes son de una persona en un espacio: **Pro** ($15/mes, $144/año) conecta buzones ilimitados, **Personal** ($5/mes) tres y **Free** uno. Sale más barato, y todos los buzones comparten el mismo radio de impacto. Consulta los [precios](/pricing) y la [matriz de proveedores](/docs/providers).

## Miembros y roles

Cuatro roles: **owner** (propietario), **admin**, **member** y **viewer**. Solo el propietario puede cambiar roles. Los admins pueden invitar y quitar miembros, pero no pueden quitar a otro admin. Los viewers son de solo lectura, y eso se aplica también en la capa de credenciales: una clave en manos de un viewer solo puede llevar \`read:email\` y \`search:email\`.

Añadir personas es en sí una función de Team, porque Free, Personal y Pro son planes de una sola persona. El montaje que funciona: quien lleva la cuenta de un cliente es admin en el espacio de ese cliente y no es miembro de ningún otro, quien hace triaje es viewer en el único espacio donde trabaja, y nadie salvo tú tiene un acceso que abarque toda tu cartera.

## Claves de API acotadas por encargo

La clave de API es lo que usa tu agente cuando el cliente MCP no habla OAuth. Hay dos mandos para estrecharla. Gira los dos.

**Permisos.** Una clave lleva una lista explícita de este vocabulario: \`read:email\`, \`search:email\`, \`send:email\`, \`manage:folders\`, \`delete:email\`, \`manage:drafts\`, \`manage:contacts\`, \`schedule:email\`, \`manage:automations\`. Una clave de triaje necesita \`read:email\` y nada más. Trata \`manage:automations\` como el más fuerte de todos: una automatización sigue actuando cuando nadie mira.

**Buzones.** Una clave alcanza todos los buzones del espacio, incluidos los que conectes más adelante, o queda restringida a una lista explícita. Para el trabajo con clientes, restríngela.

Emite una clave por encargo o por automatización, con el nombre del trabajo, para que revocarla sea una decisión sobre ese trabajo y no sobre todo tu montaje. La clave en claro se muestra una sola vez, porque solo se guarda un hash SHA-256.

Si la herramienta del cliente habla OAuth, como Claude y la mayoría de clientes MCP, usa esa vía y añade el endpoint:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

La pantalla de consentimiento ofrece una concesión de solo lectura, una estándar y una completa, además de una opción permiso a permiso. [OAuth frente a claves de API](/blog/oauth-vs-api-keys-ai-email-access) explica cuál elegir.

## Primero solo lectura, el envío más tarde

Empieza cada encargo en solo lectura. Un agente que puede leer, buscar y resumir ya cubre el triaje, los informes y el "qué le prometimos en marzo", que es la mayor parte del valor.

> Resume el correo sin leer del buzón de soporte de Acme de los dos últimos días laborables. Agrúpalo en: necesita respuesta hoy, pendiente del cliente y ruido. No envíes, muevas ni borres nada.

Añade capacidad permiso a permiso, cuando una tarea lo necesite. Quedarte corto tiene arreglo: una llamada a la que le falta un permiso devuelve una respuesta clara de permiso insuficiente, así que el cliente puede pedir ese permiso concreto y reintentar.

## La aprobación previa al envío

Para todo lo que llegue al cliente de tu cliente, activa la revisión de envíos. Es un ajuste por buzón con tres modos: enviar de inmediato, una tarjeta de revisión dentro de la conversación con la IA, o revisión solo en el panel.

En los dos modos de revisión el correo se prepara pero no se entrega, y la aprobación ocurre en un único sitio: una sesión de navegador iniciada por un propietario o un admin del espacio. El asistente no tiene sesión de navegador, así que no puede aprobar su propio envío. Sí puede rechazarlo, que es la dirección segura. La tarjeta de revisión es una comodidad, no una frontera de permisos.

La pantalla de revisión muestra el remitente, los destinatarios de Para y CC, un recuento de los destinatarios en Cco, el asunto, los adjuntos y el texto, y el HTML se muestra como código fuente en lugar de renderizarse. Una solicitud pendiente caduca a las 24 horas. La retención funciona en todos los planes, Free incluido. Más en [aprobación humana de los envíos de un agente de IA](/blog/approve-ai-agent-email-sends).

## Buzones compartidos como support@ y billing@

Aquí las direcciones compartidas son buzones normales. Conecta support@ o billing@ con una contraseña de aplicación del proveedor, dentro del espacio del cliente al que pertenecen. El nombre visible del remitente es un ajuste por buzón, así que las respuestas salen como "Acme Support" y no como tú.

Tu agente encuentra los buzones con \`inbox_list\` y se dirige a ellos por su nombre, así que nunca pegas identificadores en una instrucción. A partir de ahí el conjunto es pequeño: \`email_read\` y \`email_compose\`, \`email_organize\` y \`email_search_and_move\` para el triaje, y \`draft\` y \`schedule\` para todo lo que deba esperar a una persona.

Deja clara una expectativa desde el principio: MCP Emails funciona por consulta. El agente comprueba el correo nuevo cuando se lo pides, o cuando se ejecuta una automatización programada, así que "respondemos en 60 segundos" no es una promesa que permita esta arquitectura.

## Traspaso y cierre de accesos

Ensáyalo antes de necesitarlo. Cada punto es una acción en el panel.

- **Revocar una clave.** Deja de funcionar al instante, en todos los sitios donde estuviera pegada.
- **Quitar a un miembro.** Eso revoca también las claves de API que esa persona creó en el espacio, y el mismo desmontaje ocurre cuando alguien se va por su cuenta.
- **Bajar a viewer.** La bajada de rol revoca sus claves con permisos más allá de la lectura, en vez de debilitar en silencio una credencial de la que alguien todavía depende.
- **Desconectar el buzón.** La credencial guardada es el único dato del buzón que se conserva, y desconectarlo la elimina.
- **Revocar también en el proveedor.** Pide al cliente que borre la contraseña de aplicación o retire la concesión de Google. Ese camino no pasa por ti, y por eso tranquiliza.

No existe la transferencia de propiedad, así que no puedes entregar un espacio de trabajo al terminar un proyecto. El cliente que se lleva el correo a casa abre su propia cuenta y conecta sus propios buzones.

## Qué puedes y qué no puedes prometer a un cliente

Afirmaciones que puedes poner por escrito:

- El contenido de los mensajes nunca se almacena. Se obtiene en vivo del proveedor del cliente en cada petición y se descarta.
- El único dato del buzón que se conserva es la credencial del proveedor, cifrada en reposo con AES-256-GCM y con la clave guardada por separado.
- La actividad se registra solo como metadatos: nombre de la herramienta, buzón, marca de tiempo y estado, nunca contenido.
- Ningún proveedor de IA es subencargado. MCP Emails ni envía tu correo a un modelo propio ni entrena con él. Los subencargados son Supabase, Vercel y Stripe.
- La única excepción al "nunca se almacena" es un mensaje programado para más tarde, que se guarda cifrado hasta su hora de envío.

No prometas que la inyección de instrucciones está resuelta. Está contenida, no resuelta, y por eso existen las claves de solo lectura, los buzones restringidos y la aprobación previa. No prometas reacción instantánea ni certificaciones que el producto no ha reclamado. Manda a quien revise la seguridad a [/security](/security) y redacta tu contrato para que encaje con esa página, no por delante de ella. El código es público y se puede autoalojar, lo que responde a una auditoría mejor que cualquier promesa.

## Preguntas frecuentes

**¿Necesito una cuenta de MCP Emails distinta para cada cliente?**  
No. Una cuenta, una suscripción Team y un espacio de trabajo por cliente. La suscripción sigue a tu usuario, así que cada espacio hereda el plan.

**¿Puede un cliente ver el correo de otro?**  
No, si los buzones de cada cliente viven en su propio espacio. La separación se aplica con seguridad a nivel de fila, y una clave emitida en un espacio no puede leer los buzones de otro.

**¿Qué pasa el día que se va un colaborador?**  
Quítalo del espacio de trabajo, lo que revoca en la misma acción las claves que creó allí. Si se queda pero debe dejar de escribir, bájalo a viewer.

**¿Funciona con un cliente que usa Microsoft 365?**  
Todavía no. El soporte está en desarrollo y no se puede conectar en producción. Google Workspace, Zoho, Fastmail, Titan, IONOS y los proveedores IMAP genéricos funcionan hoy.

## Siguiente paso

[Crea una cuenta gratis](/signup), conecta un buzón de cliente en solo lectura y lanza una instrucción de triaje antes de tocar nada más. Cuando la separación importe, pasa a Team desde la [página de precios](/pricing). La [documentación](/docs) tiene la referencia completa de herramientas y permisos, y [/security](/security) es la página que le pasas a quien revise la seguridad en casa del cliente.`,
};

export default translation;
