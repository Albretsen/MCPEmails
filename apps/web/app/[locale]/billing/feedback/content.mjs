// Copy for /billing/feedback, in every locale.
//
// Kept next to the page rather than in messages/: a messages/ namespace is
// serialised into every marketing page, and this copy is only read here.
//
// The page is reached from the post-cancel email, AFTER the cancellation is
// done. It asks one optional question and then says thank you. Keep it that
// way (Documents/plans/pause-downgrade-20261024.md, section 0): no offer keyed
// to the answer, no "are you sure", nothing that suggests the cancellation
// depends on answering. German is formal (Sie).
//
// Reason keys match src/lib/billing/cancel-reasons.ts, in that order.

const en = {
  meta: { title: 'Why you cancelled' },
  title: 'Why you cancelled',
  lead: 'Your cancellation is already done and nothing here changes it. If you want to tell us why, pick one and press Send.',
  reasonsLegend: 'Reason',
  reasons: {
    too_expensive: 'Too expensive',
    not_using_enough: 'Not using it enough',
    missing_feature: 'Missing a feature',
    reliability: 'Connection or reliability problems',
    switched_tool: 'Switched to another tool',
    temporary_need: 'Only needed it for a while',
    other: 'Other',
  },
  detailLabel: 'Anything you want to add (optional)',
  send: 'Send',
  sending: 'Sending',
  thanks: 'Thanks, that helps.',
  invalid: 'This link has expired or is not valid. Your cancellation is not affected.',
  dashboard: 'Go to your dashboard',
  errors: {
    rate_limited: 'Too many tries from this connection. Please try again in an hour.',
    unknown: 'That did not go through. Please try again, or reply to the email instead.',
  },
};

const de = {
  meta: { title: 'Warum Sie gekündigt haben' },
  title: 'Warum Sie gekündigt haben',
  lead: 'Ihre Kündigung ist bereits erledigt, und nichts auf dieser Seite ändert daran etwas. Wenn Sie uns den Grund nennen möchten, wählen Sie einen aus und klicken Sie auf Senden.',
  reasonsLegend: 'Grund',
  reasons: {
    too_expensive: 'Zu teuer',
    not_using_enough: 'Ich nutze es zu wenig',
    missing_feature: 'Mir fehlt eine Funktion',
    reliability: 'Probleme mit Verbindung oder Zuverlässigkeit',
    switched_tool: 'Zu einem anderen Tool gewechselt',
    temporary_need: 'Nur vorübergehend gebraucht',
    other: 'Anderes',
  },
  detailLabel: 'Möchten Sie noch etwas ergänzen? (optional)',
  send: 'Senden',
  sending: 'Wird gesendet',
  thanks: 'Danke, das hilft uns.',
  invalid: 'Dieser Link ist abgelaufen oder ungültig. Ihre Kündigung ist davon nicht betroffen.',
  dashboard: 'Zum Dashboard',
  errors: {
    rate_limited: 'Zu viele Versuche von dieser Verbindung. Bitte versuchen Sie es in einer Stunde erneut.',
    unknown: 'Das hat nicht geklappt. Bitte versuchen Sie es erneut oder antworten Sie einfach auf die E-Mail.',
  },
};

const nb = {
  meta: { title: 'Hvorfor du sa opp' },
  title: 'Hvorfor du sa opp',
  lead: 'Oppsigelsen er allerede registrert, og ingenting her endrer den. Hvis du vil fortelle oss hvorfor, velg en grunn og trykk Send.',
  reasonsLegend: 'Grunn',
  reasons: {
    too_expensive: 'For dyrt',
    not_using_enough: 'Bruker det for lite',
    missing_feature: 'Mangler en funksjon',
    reliability: 'Problemer med tilkobling eller stabilitet',
    switched_tool: 'Byttet til et annet verktøy',
    temporary_need: 'Trengte det bare en periode',
    other: 'Annet',
  },
  detailLabel: 'Noe du vil legge til? (valgfritt)',
  send: 'Send',
  sending: 'Sender',
  thanks: 'Takk, det hjelper.',
  invalid: 'Denne lenken er utløpt eller ugyldig. Oppsigelsen din påvirkes ikke.',
  dashboard: 'Gå til dashbordet',
  errors: {
    rate_limited: 'For mange forsøk fra denne tilkoblingen. Prøv igjen om en time.',
    unknown: 'Det gikk ikke gjennom. Prøv igjen, eller svar på e-posten i stedet.',
  },
};

const fr = {
  meta: { title: 'Pourquoi vous avez résilié' },
  title: 'Pourquoi vous avez résilié',
  lead: 'Votre résiliation est déjà effectuée et rien sur cette page ne la modifie. Si vous voulez nous dire pourquoi, choisissez une raison puis cliquez sur Envoyer.',
  reasonsLegend: 'Raison',
  reasons: {
    too_expensive: 'Trop cher',
    not_using_enough: "Je ne l'utilise pas assez",
    missing_feature: 'Il manque une fonctionnalité',
    reliability: 'Problèmes de connexion ou de fiabilité',
    switched_tool: 'Je suis passé à un autre outil',
    temporary_need: "Je n'en avais besoin que pour un temps",
    other: 'Autre',
  },
  detailLabel: 'Quelque chose à ajouter ? (facultatif)',
  send: 'Envoyer',
  sending: 'Envoi en cours',
  thanks: 'Merci, cela nous aide.',
  invalid: "Ce lien a expiré ou n'est pas valide. Votre résiliation n'est pas affectée.",
  dashboard: 'Aller au tableau de bord',
  errors: {
    rate_limited: 'Trop de tentatives depuis cette connexion. Réessayez dans une heure.',
    unknown: "Cela n'a pas fonctionné. Réessayez, ou répondez simplement à l'e-mail.",
  },
};

const es = {
  meta: { title: 'Por qué cancelaste' },
  title: 'Por qué cancelaste',
  lead: 'Tu cancelación ya está hecha y nada de esta página la cambia. Si quieres contarnos por qué, elige un motivo y pulsa Enviar.',
  reasonsLegend: 'Motivo',
  reasons: {
    too_expensive: 'Demasiado caro',
    not_using_enough: 'No lo uso lo suficiente',
    missing_feature: 'Falta una función',
    reliability: 'Problemas de conexión o fiabilidad',
    switched_tool: 'Me cambié a otra herramienta',
    temporary_need: 'Solo lo necesitaba por un tiempo',
    other: 'Otro',
  },
  detailLabel: '¿Algo que quieras añadir? (opcional)',
  send: 'Enviar',
  sending: 'Enviando',
  thanks: 'Gracias, nos ayuda.',
  invalid: 'Este enlace ha caducado o no es válido. Tu cancelación no se ve afectada.',
  dashboard: 'Ir al panel',
  errors: {
    rate_limited: 'Demasiados intentos desde esta conexión. Vuelve a intentarlo dentro de una hora.',
    unknown: 'No se ha podido enviar. Inténtalo de nuevo o responde al correo.',
  },
};

const zh = {
  meta: { title: '您取消的原因' },
  title: '您取消的原因',
  lead: '您的取消已经完成，此页面上的任何操作都不会改变它。如果您愿意告诉我们原因，请选择一项并点击发送。',
  reasonsLegend: '原因',
  reasons: {
    too_expensive: '太贵了',
    not_using_enough: '用得不够多',
    missing_feature: '缺少某个功能',
    reliability: '连接或稳定性问题',
    switched_tool: '换用了其他工具',
    temporary_need: '只是临时需要',
    other: '其他',
  },
  detailLabel: '还有想补充的吗？（可选）',
  send: '发送',
  sending: '正在发送',
  thanks: '谢谢，这对我们很有帮助。',
  invalid: '此链接已过期或无效。您的取消不受影响。',
  dashboard: '前往控制台',
  errors: {
    rate_limited: '此连接的尝试次数过多。请一小时后再试。',
    unknown: '提交未成功。请重试，或直接回复那封邮件。',
  },
};

export const FEEDBACK_COPY = { en, de, nb, fr, es, zh };

export function feedbackCopy(locale) {
  return FEEDBACK_COPY[locale] ?? en;
}
