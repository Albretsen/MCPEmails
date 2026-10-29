// Spanish copy for /docs/microsoft-365-admin-consent. Same shape as `en` in
// content.mjs; the sources for every claim are listed there.

import { MS_GRANT, MS_ASSIGN, CLAUDE_M365 } from './links.mjs';

const es = {
  meta: {
    title: '¿Outlook o Microsoft 365 pide aprobación del administrador? Aprueba MCPEmails',
    description:
      'Por qué Microsoft muestra "Need admin approval" al conectar un buzón de Outlook o Microsoft 365 del trabajo a Claude o ChatGPT, el enlace que debes enviar a tu administrador de TI y qué permisos aprueba exactamente.',
  },
  breadcrumb: 'Aprobación del administrador de Microsoft 365',
  eyebrow: 'Documentación',
  title: 'Microsoft 365: "Need admin approval"',
  lead:
    'Microsoft muestra "Need admin approval" cuando tu organización no permite que los empleados aprueben por su cuenta el acceso al correo de una aplicación. Un administrador de TI aprueba MCPEmails una vez y, a partir de ahí, todas las personas de la organización pueden conectar su propio buzón. Esta página es para los dos: lo que hace quien conecta el buzón y lo que aprueba el administrador.',
  sections: [
    {
      id: 'why',
      h: 'Por qué Microsoft pide un administrador',
      items: [
        'Desde finales de 2025, la directiva de consentimiento predeterminada de Microsoft para inquilinos de trabajo y educativos impide que los empleados aprueben permisos de correo como `Mail.Read` y `Mail.ReadWrite` para una aplicación. En lugar de la pantalla de consentimiento habitual, Microsoft muestra **Need admin approval**.',
        'Esto lo decide tu organización, no tu cuenta ni MCPEmails. Ser un editor verificado no permite a una aplicación saltárselo, y algunas organizaciones han desactivado el consentimiento de usuario para todas las aplicaciones.',
        'Las cuentas personales de Microsoft (Outlook.com, Hotmail, Live) no tienen organización ni administrador, así que nunca ven esta pantalla.',
        `El conector de Microsoft 365 propio de Claude tiene el mismo requisito: el [artículo de ayuda de Anthropic](${CLAUDE_M365}) dice que un administrador global de Microsoft Entra debe dar su consentimiento antes de que nadie de la organización pueda usarlo. Los pasos de abajo son para MCPEmails, que conecta el buzón a Claude, ChatGPT y otros clientes MCP.`,
      ],
    },
    {
      id: 'connecting',
      h: 'Si eres quien conecta el buzón',
      ordered: true,
      items: [
        'En el panel de MCPEmails, abre **Bandejas de entrada**, luego **Conectar bandeja de entrada**, elige Outlook y haz clic en **Conectar con Microsoft**.',
        'Si Microsoft responde con **Need admin approval**, vuelve al panel. Te indicará que tu organización debe aprobar el acceso al buzón y te ofrecerá **Obtener un enlace para tu administrador de TI**. La opción de Outlook en la ventana de conexión tiene el mismo enlace en **Obtener el enlace de aprobación para tu administrador**.',
        'Copia el enlace y envíaselo a tu administrador de TI por correo o por chat. Funciona durante 7 días y se puede abrir más de una vez. Tu administrador no necesita una cuenta de MCPEmails.',
        'Cuando tu administrador lo haya aprobado, vuelve a hacer clic en **Conectar con Microsoft**. Inicias sesión con tu propia cuenta y la bandeja de entrada se conecta.',
      ],
    },
    {
      id: 'self-admin',
      h: 'Si tú mismo eres el administrador',
      items: [
        'En el mismo cuadro de diálogo, haz clic en **Soy el administrador, aprobar ahora**. Se abre la página de aprobación de Microsoft en tu pestaña y, después de aprobar, vuelves al panel para conectar el buzón.',
        'Inicia sesión en esa página con una cuenta que tenga uno de los roles de la sección siguiente. Una cuenta de usuario sin rol no puede aprobar, ni siquiera en un inquilino pequeño.',
      ],
    },
    {
      id: 'admin',
      h: 'Si eres el administrador de TI',
      items: [
        'El enlace abre la propia página de consentimiento de administrador de Microsoft (`login.microsoftonline.com/organizations/v2.0/adminconsent`) para MCPEmails. Inicias sesión con tu cuenta de trabajo de Microsoft en la página de Microsoft. MCPEmails nunca ve tu contraseña.',
        `Para aprobar hace falta un rol que pueda conceder consentimiento para permisos delegados en todo el inquilino. [Microsoft enumera](${MS_GRANT}) Administrador de roles con privilegios, Administrador de aplicaciones en la nube, Administrador de aplicaciones y Administrador de IA, y un administrador global también puede hacerlo.`,
        'Revisa los permisos y acepta. La aprobación cubre a toda la organización de una vez. Cada persona sigue iniciando sesión con su propia cuenta al conectarse y solo obtiene acceso a su propio buzón.',
        'Después llegas a una página de MCPEmails que indica si Microsoft confirmó la aprobación. No necesitas hacer nada más.',
        'El enlace no concede nada por sí solo. Solo inicia el flujo de Microsoft, y nada cambia en tu inquilino hasta que aceptas allí.',
        `¿Prefieres el centro de administración? Si MCPEmails ya aparece en **Entra ID**, **Enterprise apps**, **All applications**, ábrelo, elige **Permissions** y haz clic en **Grant admin consent**. La [guía de Microsoft](${MS_GRANT}) describe ese camino.`,
      ],
    },
    {
      id: 'permissions',
      h: 'Qué aprueba el administrador',
      items: [
        '`Mail.ReadWrite` (delegado): leer y modificar el correo del buzón de la persona que ha iniciado sesión, para que la IA pueda buscar, leer, escribir borradores, mover, marcar, gestionar carpetas y eliminar.',
        '`Mail.Send` (delegado): enviar correo en nombre de la persona que ha iniciado sesión. `Mail.ReadWrite` no cubre el envío, así que es un permiso aparte.',
        '`offline_access`: mantener la conexión sin volver a iniciar sesión, hasta que la persona la desconecte o se retire el acceso.',
        'Cuando cada persona inicia sesión, MCPEmails también pide `openid`, `profile` y `email` para leer su nombre y su dirección. Las directivas de consentimiento no restringen estos datos básicos de inicio de sesión, así que la aprobación del administrador no los incluye.',
        'Todos los permisos son delegados. MCPEmails no pide permisos de aplicación, así que solo actúa en nombre de la persona que ha iniciado sesión y no puede abrir otros buzones de tu inquilino.',
        'Los mensajes se obtienen en directo de Microsoft en cada solicitud y no se almacenan. El token de cada inicio de sesión se guarda cifrado, y los datos se almacenan en Estocolmo. Consulta [seguridad](/security).',
      ],
    },
    {
      id: 'control',
      h: 'Limitar o retirar el acceso más adelante',
      items: [
        `Para que solo algunas personas puedan conectarse, activa **Assignment required** para MCPEmails en **Enterprise apps** y asigna los usuarios o grupos que pueden iniciar sesión. La [guía de Microsoft](${MS_ASSIGN}) tiene los pasos.`,
        'Para retirarlo en toda la organización, elimina o deshabilita MCPEmails en **Enterprise apps**.',
        'Cada persona puede desconectar su propio buzón en cualquier momento eliminando la bandeja de entrada en el panel de MCPEmails.',
      ],
    },
    {
      id: 'problems',
      h: 'Si sigue sin funcionar',
      items: [
        '**"La aprobación no se completó".** Microsoft no confirmó la aprobación, así que Outlook sigue bloqueado. El administrador vuelve a abrir el enlace con una cuenta que tenga uno de los roles indicados arriba.',
        '**"No aprobado".** La aprobación se canceló en la pantalla de Microsoft y no cambió nada. Abre el enlace de nuevo cuando quieras.',
        '**"Este enlace ha caducado" o "Este enlace no es válido".** Los enlaces duran 7 días y hay que copiarlos completos. Obtén uno nuevo desde el panel.',
        '**"Empieza de nuevo".** La aprobación tardó más de 10 minutos o terminó en otro navegador. Abre el enlace de nuevo y termina en ese mismo navegador.',
        '**Sin buzón de Outlook.** Una cuenta sin buzón de Exchange Online, como una cuenta de administrador sin licencia de Exchange, no tiene nada que conectar, así que MCPEmails la rechaza. Si tu correo está alojado en otro sitio, conéctalo por IMAP.',
        '**Un formulario de solicitud en lugar de la página de aprobación.** Si tu organización ha activado el flujo de trabajo de consentimiento de administrador de Microsoft, quien intenta conectarse puede ver un formulario para solicitar la aprobación. El administrador puede aprobar esa solicitud o, simplemente, abrir el enlace de MCPEmails.',
      ],
    },
  ],
  evidence: {
    h: 'Compruébalo tú mismo',
    intro: 'MCPEmails es de código abierto. Estos archivos crean el enlace, inician la aprobación y enumeran los permisos que describe esta página:',
    labels: {
      link: 'El enlace de aprobación firmado, válido durante siete días, y los estados del resultado',
      route: 'La ruta pública que abre el enlace y los permisos que pide al administrador',
      oauth: 'Los permisos que concede cada persona al iniciar sesión y cómo se reconoce una respuesta "Need admin approval"',
    },
  },
  cta: {
    title: 'Conecta tu buzón de Microsoft 365',
    sub: 'Una bandeja de entrada es gratis, para siempre.',
    button: 'Empezar',
    providers: 'Configuración de Microsoft 365',
  },
};

export default es;
