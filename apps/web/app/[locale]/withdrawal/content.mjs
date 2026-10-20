// Copy for /withdrawal, in every locale.
//
// Kept next to the page rather than in messages/: a messages/ namespace is
// serialised into every marketing page, and this copy is only read here.
//
// What this page is: the withdrawal notice and the model withdrawal form of
// Directive 2011/83/EU Annex I (A) and (B), adapted to a subscription service
// that starts at checkout. The refund promise matches section 5.4 of the
// terms (messages/<locale>/terms.json, plansAndPayment.p54b): the first
// charge is refunded in full, so the "proportionate amount" clause of the
// model notice is deliberately left out. Change both together.
//
// Tokens, filled by the page: {entity} {address} {email} {cancelLink} {terms}.
// In `form.lines` they are filled as plain text, because the form is meant to
// be copied.

const en = {
  meta: {
    title: 'Right of withdrawal',
    description:
      'How to withdraw from an MCP Emails subscription within 14 days, the refund you get, and a model withdrawal form.',
  },
  eyebrow: 'Legal',
  title: 'Right of withdrawal',
  lead:
    'If you are a consumer, you can withdraw from a new MCP Emails subscription within 14 days without giving a reason. Below is the formal notice, followed by a form you can copy.',
  notice: {
    h: 'Withdrawal notice',
    paras: [
      'You have the right to withdraw from this contract within 14 days without giving any reason.',
      'The withdrawal period expires 14 days after the day the contract was concluded, which is the day you completed checkout.',
      'To exercise the right of withdrawal, you must inform us ({entity}, {address}, {email}) of your decision to withdraw from this contract by a clear statement, for example an email. You can use the online form at {cancelLink} or the model withdrawal form below, but you do not have to.',
      'To meet the withdrawal deadline, it is sufficient for you to send your notice before the withdrawal period has expired.',
    ],
  },
  effects: {
    h: 'Effects of withdrawal',
    paras: [
      'If you withdraw from this contract, we will reimburse all payments received from you without undue delay, and in any event no later than 14 days from the day we are informed of your decision. We use the same means of payment you used for the original transaction, unless you have expressly agreed otherwise. You will not be charged any fees for the reimbursement.',
      'Your plan starts as soon as checkout completes, so the service begins during the withdrawal period. We still refund the first charge in full, as section 5.4 of our {terms} promises, and we do not charge for the days you used.',
    ],
  },
  form: {
    h: 'Model withdrawal form',
    intro: 'Complete and return this form only if you wish to withdraw from the contract.',
    lines: [
      'To: {entity}, {address}, {email}',
      'I hereby give notice that I withdraw from my contract for the provision of the following service: MCP Emails subscription (plan: ______)',
      'Ordered on: ______',
      'Name of consumer: ______',
      'Address of consumer: ______',
      'Email address of the MCP Emails account: ______',
      'Signature of consumer (only if this form is sent on paper): ______',
      'Date: ______',
    ],
  },
  cancelling: {
    h: 'Cancelling at any other time',
    para:
      'You can cancel at any time, inside or outside the 14 days. Cancelling stops the next renewal, and your plan stays active until the end of the period you have paid for. Cancel from your dashboard, or without logging in at {cancelLink}.',
  },
  cta: 'Withdraw online',
  termsLabel: 'terms of service',
};

const nb = {
  meta: {
    title: 'Angrerett',
    description:
      'Slik går du fra et MCP Emails-abonnement innen 14 dager, hva du får tilbake, og et standardskjema for angrerett.',
  },
  eyebrow: 'Juridisk',
  title: 'Angrerett',
  lead:
    'Er du forbruker, kan du gå fra et nytt MCP Emails-abonnement innen 14 dager uten å oppgi grunn. Under finner du angrerettsinformasjonen og et skjema du kan kopiere.',
  notice: {
    h: 'Angrerettsinformasjon',
    paras: [
      'Du har rett til å gå fra denne avtalen innen 14 dager uten å oppgi noen grunn.',
      'Angrefristen utløper 14 dager etter den dagen avtalen ble inngått, altså dagen du fullførte betalingen.',
      'For å bruke angreretten må du gi oss ({entity}, {address}, {email}) en utvetydig melding om at du vil gå fra avtalen, for eksempel en e-post. Du kan bruke nettskjemaet på {cancelLink} eller standardskjemaet for angrerett nedenfor, men du må ikke.',
      'Det er nok at du sender meldingen før angrefristen har gått ut.',
    ],
  },
  effects: {
    h: 'Virkninger av å gå fra avtalen',
    paras: [
      'Går du fra avtalen, betaler vi tilbake alt du har betalt oss uten unødig opphold, og senest 14 dager etter at vi fikk beskjed om at du går fra avtalen. Vi bruker samme betalingsmiddel som du brukte da du betalte, med mindre du uttrykkelig har avtalt noe annet. Tilbakebetalingen koster deg ingenting.',
      'Planen starter så snart betalingen er fullført, så tjenesten begynner i angrefristen. Vi betaler likevel tilbake hele den første belastningen, slik punkt 5.4 i {terms} lover, og tar ikke betalt for dagene du brukte.',
    ],
  },
  form: {
    h: 'Standardskjema for angrerett',
    intro: 'Fyll ut og send dette skjemaet bare hvis du vil gå fra avtalen.',
    lines: [
      'Til: {entity}, {address}, {email}',
      'Jeg meddeler herved at jeg ønsker å gå fra min avtale om levering av følgende tjeneste: MCP Emails-abonnement (plan: ______)',
      'Bestilt den: ______',
      'Forbrukerens navn: ______',
      'Forbrukerens adresse: ______',
      'E-postadressen til MCP Emails-kontoen: ______',
      'Forbrukerens underskrift (bare hvis skjemaet sendes på papir): ______',
      'Dato: ______',
    ],
  },
  cancelling: {
    h: 'Oppsigelse ellers',
    para:
      'Du kan si opp når som helst, innenfor eller utenfor de 14 dagene. Oppsigelsen stopper neste fornyelse, og planen er aktiv ut perioden du har betalt for. Si opp fra dashbordet, eller uten å logge inn på {cancelLink}.',
  },
  cta: 'Gå fra avtalen på nett',
  termsLabel: 'vilkårene',
};

const es = {
  meta: {
    title: 'Derecho de desistimiento',
    description:
      'Cómo desistir de una suscripción a MCP Emails en un plazo de 14 días, el reembolso que recibes y un modelo de formulario de desistimiento.',
  },
  eyebrow: 'Legal',
  title: 'Derecho de desistimiento',
  lead:
    'Si eres consumidor, puedes desistir de una nueva suscripción a MCP Emails en un plazo de 14 días sin dar ninguna razón. Abajo tienes la información formal y un formulario que puedes copiar.',
  notice: {
    h: 'Información sobre el desistimiento',
    paras: [
      'Tienes derecho a desistir del presente contrato en un plazo de 14 días sin necesidad de justificación.',
      'El plazo de desistimiento expira a los 14 días del día de la celebración del contrato, es decir, el día en que completaste el pago.',
      'Para ejercer el derecho de desistimiento, debes notificarnos ({entity}, {address}, {email}) tu decisión de desistir del contrato mediante una declaración inequívoca, por ejemplo un correo electrónico. Puedes usar el formulario en línea de {cancelLink} o el modelo de formulario de desistimiento que figura a continuación, aunque su uso no es obligatorio.',
      'Para cumplir el plazo de desistimiento, basta con que envíes tu comunicación antes de que venza el plazo.',
    ],
  },
  effects: {
    h: 'Consecuencias del desistimiento',
    paras: [
      'En caso de desistimiento, te devolveremos todos los pagos recibidos de ti sin ninguna demora indebida y, en todo caso, a más tardar 14 días a partir de la fecha en que se nos informe de tu decisión. Utilizaremos el mismo medio de pago que empleaste para la transacción inicial, salvo que hayas dispuesto expresamente lo contrario, y no incurrirás en ningún gasto como consecuencia del reembolso.',
      'Tu plan empieza en cuanto se completa el pago, así que el servicio comienza durante el plazo de desistimiento. Aun así, reembolsamos el primer cargo completo, como promete la sección 5.4 de nuestros {terms}, y no cobramos los días que usaste.',
    ],
  },
  form: {
    h: 'Modelo de formulario de desistimiento',
    intro: 'Cumplimenta y envía este formulario solo si deseas desistir del contrato.',
    lines: [
      'A la atención de: {entity}, {address}, {email}',
      'Por la presente les comunico que desisto de mi contrato de prestación del siguiente servicio: suscripción a MCP Emails (plan: ______)',
      'Pedido el: ______',
      'Nombre del consumidor: ______',
      'Domicilio del consumidor: ______',
      'Correo electrónico de la cuenta de MCP Emails: ______',
      'Firma del consumidor (solo si el formulario se presenta en papel): ______',
      'Fecha: ______',
    ],
  },
  cancelling: {
    h: 'Cancelar en cualquier otro momento',
    para:
      'Puedes cancelar en cualquier momento, dentro o fuera de los 14 días. La cancelación detiene la próxima renovación y tu plan sigue activo hasta el final del periodo que ya has pagado. Cancela desde tu panel o sin iniciar sesión en {cancelLink}.',
  },
  cta: 'Desistir en línea',
  termsLabel: 'términos del servicio',
};

const fr = {
  meta: {
    title: 'Droit de rétractation',
    description:
      "Comment vous rétracter d'un abonnement MCP Emails sous 14 jours, le remboursement que vous recevez et un modèle de formulaire de rétractation.",
  },
  eyebrow: 'Juridique',
  title: 'Droit de rétractation',
  lead:
    "Si vous êtes un consommateur, vous pouvez vous rétracter d'un nouvel abonnement MCP Emails sous 14 jours sans avoir à vous justifier. Vous trouverez ci-dessous l'information officielle, puis un formulaire à copier.",
  notice: {
    h: "Informations concernant l'exercice du droit de rétractation",
    paras: [
      'Vous avez le droit de vous rétracter du présent contrat sans donner de motif dans un délai de 14 jours.',
      "Le délai de rétractation expire 14 jours après le jour de la conclusion du contrat, c'est-à-dire le jour où vous avez finalisé le paiement.",
      "Pour exercer le droit de rétractation, vous devez nous notifier ({entity}, {address}, {email}) votre décision de rétractation du présent contrat au moyen d'une déclaration dénuée d'ambiguïté, par exemple un e-mail. Vous pouvez utiliser le formulaire en ligne sur {cancelLink} ou le modèle de formulaire de rétractation ci-dessous, mais ce n'est pas obligatoire.",
      "Pour que le délai de rétractation soit respecté, il suffit que vous transmettiez votre communication avant l'expiration du délai.",
    ],
  },
  effects: {
    h: 'Effets de la rétractation',
    paras: [
      "En cas de rétractation de votre part du présent contrat, nous vous rembourserons tous les paiements reçus de vous sans retard excessif et, en tout état de cause, au plus tard 14 jours à compter du jour où nous sommes informés de votre décision. Nous procéderons au remboursement en utilisant le même moyen de paiement que celui que vous avez utilisé pour la transaction initiale, sauf si vous convenez expressément d'un moyen différent. Ce remboursement n'occasionnera aucun frais pour vous.",
      "Votre formule démarre dès que le paiement est finalisé, donc le service commence pendant le délai de rétractation. Nous remboursons malgré tout l'intégralité du premier prélèvement, comme le promet la section 5.4 de nos {terms}, et nous ne facturons pas les jours utilisés.",
    ],
  },
  form: {
    h: 'Modèle de formulaire de rétractation',
    intro: 'Veuillez compléter et renvoyer le présent formulaire uniquement si vous souhaitez vous rétracter du contrat.',
    lines: [
      "À l'attention de : {entity}, {address}, {email}",
      'Je vous notifie par la présente ma rétractation du contrat portant sur la prestation de services ci-dessous : abonnement MCP Emails (formule : ______)',
      'Commandé le : ______',
      'Nom du consommateur : ______',
      'Adresse du consommateur : ______',
      'Adresse e-mail du compte MCP Emails : ______',
      'Signature du consommateur (uniquement en cas de notification du présent formulaire sur papier) : ______',
      'Date : ______',
    ],
  },
  cancelling: {
    h: 'Résilier à tout autre moment',
    para:
      "Vous pouvez résilier à tout moment, pendant ou après les 14 jours. La résiliation arrête le prochain renouvellement, et votre formule reste active jusqu'à la fin de la période déjà payée. Résiliez depuis votre tableau de bord, ou sans vous connecter sur {cancelLink}.",
  },
  cta: 'Se rétracter en ligne',
  termsLabel: "conditions d'utilisation",
};

const zh = {
  meta: {
    title: '撤回权',
    description: '如何在 14 天内撤回 MCP Emails 订阅、你将获得的退款，以及撤回表格范本。',
  },
  eyebrow: '法律',
  title: '撤回权',
  lead: '如果你是消费者，你可以在 14 天内撤回新的 MCP Emails 订阅，无需说明理由。下面是正式通知，以及一份可以复制的表格。',
  notice: {
    h: '撤回通知',
    paras: [
      '你有权在 14 天内撤回本合同，无需说明任何理由。',
      '撤回期在合同订立之日（即你完成付款之日）起 14 天后届满。',
      '如需行使撤回权，你必须以明确的声明（例如电子邮件）告知我们（{entity}，{address}，{email}）你决定撤回本合同。你可以使用 {cancelLink} 上的在线表格或下方的撤回表格范本，但这不是必需的。',
      '只要你在撤回期届满前发出通知，即视为在期限内行使了撤回权。',
    ],
  },
  effects: {
    h: '撤回的效力',
    paras: [
      '如果你撤回本合同，我们将在得知你的撤回决定之日起不无故拖延地、且最迟在 14 天内退还你支付的全部款项。我们将使用你原交易所用的同一支付方式退款，除非你另有明确约定。退款不会向你收取任何费用。',
      '你的套餐在付款完成后立即生效，因此服务在撤回期内就已开始。我们仍会按照{terms}第 5.4 节的承诺全额退还首笔费用，且不对你已使用的天数收费。',
    ],
  },
  form: {
    h: '撤回表格范本',
    intro: '仅在你希望撤回合同时填写并发送此表格。',
    lines: [
      '致：{entity}，{address}，{email}',
      '本人特此通知，撤回本人关于提供以下服务的合同：MCP Emails 订阅（套餐：______）',
      '订购日期：______',
      '消费者姓名：______',
      '消费者地址：______',
      'MCP Emails 账户的电子邮件地址：______',
      '消费者签名（仅在以纸质形式发送本表格时需要）：______',
      '日期：______',
    ],
  },
  cancelling: {
    h: '在其他时间取消',
    para: '你可以随时取消，无论是否在 14 天内。取消会停止下一次续订，你的套餐在已付费期间结束前保持有效。你可以在控制台中取消，也可以无需登录在 {cancelLink} 取消。',
  },
  cta: '在线撤回',
  termsLabel: '服务条款',
};

export const WITHDRAWAL_COPY = { en, nb, es, fr, zh };

export function withdrawalCopy(locale) {
  return WITHDRAWAL_COPY[locale] ?? en;
}
