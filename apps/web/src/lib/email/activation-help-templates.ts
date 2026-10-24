/**
 * Copy for the two activation help emails, in every app locale.
 *
 *   E1 "connection help"  after an inbox connection failed and nothing worked
 *                         since. The body is chosen by what the failure was
 *                         (provider, auth reason, phase), from the same fix
 *                         table as the connect panel (activation rescue plan,
 *                         section 3).
 *   E2 "first call help"  after an inbox connected and no AI app has called a
 *                         tool yet. The body depends on whether an AI app was
 *                         linked (a credential exists) and which one was picked.
 *
 * SERVICE, NOT MARKETING. These are about a setup the reader started, carry no
 * offer, no price, no plan name and no upgrade link, so they go without the
 * marketing opt-in. They still honour the `lifecycle` unsubscribe category and
 * carry a one-click List-Unsubscribe header, a visible opt-out link built from
 * the reader's own token, and the legal entity and postal line. Composition
 * returns null without a token. Privacy policy section 3.10 names the purpose.
 *
 * DATA MINIMISATION. The body never prints a host name, an address or anything
 * from a mailbox. A provider appears only by its public name (Gmail, IONOS),
 * and only when the failure row or the connect error log already named it.
 *
 * LOCALES. en, nb, de, es, fr, zh, chosen from workspaces.acquisition_locale
 * with en as the fallback. German uses formal Sie, French vous, Spanish tu, as
 * the rest of the site does. Every locale except en needs a native read before
 * the first send.
 *
 * STYLE. Plain, short, first person from Asgeir. No em dashes, no fake "Re:",
 * no urgency. Strings never contain an angle bracket.
 */

import { unsubscribeUrl } from '@/lib/email/lifecycle';
import { POSTAL_ADDRESS_LINE } from '@/lib/email/legal';

export const ACTIVATION_HELP_CATEGORY = 'lifecycle' as const;

export const ACTIVATION_HELP_LOCALES = ['en', 'nb', 'de', 'es', 'fr', 'zh'] as const;
export type HelpLocale = (typeof ACTIVATION_HELP_LOCALES)[number];

/** Any stored locale (or junk, or a region tag like `fr-CA`) to one with copy. */
export function helpLocale(value: unknown): HelpLocale {
  if (typeof value !== 'string') return 'en';
  const base = value.trim().toLowerCase().split(/[-_]/)[0];
  if (base === 'no' || base === 'nn') return 'nb';
  return (ACTIVATION_HELP_LOCALES as readonly string[]).includes(base) ? (base as HelpLocale) : 'en';
}

/**
 * Every E1 body. The key is decided in activation-help.ts (connectionHelpKey)
 * from the latest failure; the label is the provider's public name.
 */
export const CONNECTION_HELP_KEYS = [
  'gmail_app_password',
  'yahoo_app_password',
  'icloud_app_password',
  'known_host',
  'imap_disabled',
  'consent_cancelled',
  'office365_basic_auth',
  'server_unreachable',
  'smtp_rejected',
  'generic_password',
  'generic',
] as const;
export type ConnectionHelpKey = (typeof CONNECTION_HELP_KEYS)[number];

export const FIRST_CALL_STATES = ['not_linked', 'linked_no_call'] as const;
export type FirstCallState = (typeof FIRST_CALL_STATES)[number];

export type HelpClient = 'chatgpt' | 'claude' | 'other';

/** App-password pages, by provider. Public URLs, the same in every locale. */
export const PROVIDER_LINKS = {
  googleTwoStep: 'https://myaccount.google.com/signinoptions/two-step-verification',
  googleAppPasswords: 'https://myaccount.google.com/apppasswords',
  yahooAppPasswords: 'https://login.yahoo.com/account/security/app-passwords',
  aolAppPasswords: 'https://login.aol.com/account/security/app-passwords',
  appleAccount: 'https://account.apple.com',
} as const;

const STARTER_PROMPT: Record<HelpLocale, string> = {
  en: 'Summarize my unread email from today.',
  nb: 'Oppsummer den uleste e-posten min fra i dag.',
  de: 'Fasse meine ungelesenen E-Mails von heute zusammen.',
  es: 'Resume mi correo sin leer de hoy.',
  fr: "Résume mes e-mails non lus d'aujourd'hui.",
  zh: '总结一下我今天的未读邮件。',
};

interface Copy {
  lang: string;
  greeting: string;
  replyLine: string;
  footerNote: string;
  unsubscribeReason: string;
  unsubscribeLink: string;
  notAffected: string;
  textUnsubscribe: string;
  e1: {
    subject: (label: string | null) => string;
    title: string;
    cta: string;
    ctaMicrosoft: string;
    body: Record<ConnectionHelpKey, (label: string, link: string | null) => string[]>;
  };
  e2: {
    clientName: Record<HelpClient, string>;
    subject: Record<FirstCallState, (client: string) => string>;
    title: string;
    cta: string;
    notLinked: (client: string) => string[];
    linkedNoCall: (client: string) => string[];
    toggle: Record<HelpClient, string>;
    tryLine: (prompt: string) => string;
  };
}

const COPY: Record<HelpLocale, Copy> = {
  en: {
    lang: 'en',
    greeting: 'Hi, Asgeir here.',
    replyLine: 'If it still does not work, reply to this email and I will look at it with you.',
    footerNote: 'Replies go to our support inbox, and I read them myself.',
    unsubscribeReason: 'You are getting this because you started setting up MCPEmails.',
    unsubscribeLink: 'Unsubscribe from these',
    notAffected: 'Account and billing notices are not affected.',
    textUnsubscribe: 'Unsubscribe',
    e1: {
      subject: (label) => (label ? `Your ${label} connection to MCPEmails` : 'Your inbox connection to MCPEmails'),
      title: 'Getting your inbox connected',
      cta: 'Open the connect step',
      ctaMicrosoft: 'Connect with Microsoft',
      body: {
        gmail_app_password: () => [
          'I saw your Gmail inbox did not connect earlier. Gmail does not accept your normal Google password from apps like this one. It wants an app password, and that needs 2-Step Verification turned on first.',
          `1. Turn on 2-Step Verification: ${PROVIDER_LINKS.googleTwoStep}`,
          `2. Create an app password: ${PROVIDER_LINKS.googleAppPasswords}`,
          '3. Paste the 16 letters into MCPEmails. Spaces are fine.',
          'On a work Google account the app password page can be missing because an admin turned it off. Then your admin has to allow it.',
        ],
        yahoo_app_password: (label, link) => [
          `I saw your ${label} inbox did not connect earlier. ${label} rejects your normal password for apps like this one and wants an app password instead.`,
          `You can make one here: ${link}. Name it MCPEmails, then paste it into the connect step.`,
        ],
        icloud_app_password: () => [
          'I saw your iCloud inbox did not connect earlier. iCloud Mail does not accept your Apple Account password from other apps. It wants an app-specific password.',
          `Go to ${PROVIDER_LINKS.appleAccount}, open Sign-In and Security, then App-Specific Passwords, and create one named MCPEmails. Use your full iCloud address as the username.`,
        ],
        known_host: (label) => [
          `I saw your ${label} inbox did not connect earlier. ${label} often wants something other than the password you sign in with: a separate mailbox password, an app password, or IMAP switched on in its settings.`,
          `The button below opens the connect step with ${label} picked, and it lists what to check for ${label}.`,
        ],
        imap_disabled: (label) => [
          `I saw your ${label} inbox did not connect earlier. ${label} told us IMAP access is turned off for your mailbox, so no password can work until it is on.`,
          `Turn on IMAP (sometimes called access from other mail apps) in your ${label} mail settings, then try again. On a work or school account an admin may have to do this.`,
        ],
        consent_cancelled: (label) => [
          `I saw the ${label} sign-in page was closed before your inbox connected.`,
          `That page lists the access MCPEmails asks for, so your AI app can read, organise and send mail when you ask it to. You can remove that access again at any time. When you are ready, start again and accept on the ${label} page.`,
        ],
        office365_basic_auth: () => [
          'I saw your Microsoft 365 mailbox did not connect with a password. Microsoft 365 blocks password logins from apps like this one, so the password itself was not the problem.',
          'Use the Outlook option instead. It signs in with Microsoft directly, with no password to type. If your company has to approve new apps, the connect step gives you a link to send to your IT admin.',
        ],
        server_unreachable: () => [
          'I saw MCPEmails could not reach your mail server earlier. It never answered.',
          'Usually the server name has a typo, or the server only accepts connections from inside its own network. School, university and company servers often work that way.',
          "Check the server name on your provider's help pages and try again. If it is a school or work server that does not allow outside apps, connecting a different address is the quicker way.",
        ],
        smtp_rejected: () => [
          'I saw your inbox got halfway earlier: reading mail worked, but the login for sending was refused.',
          'Some providers use a different login for sending. If you only want to read and organise mail for now, open Advanced settings in the connect step and choose Receive only (IMAP).',
        ],
        generic_password: () => [
          'I saw your inbox did not connect earlier: the mail server turned down the login.',
          'With most providers that means one of two things. Either it wants an app password (one you create in its security settings) instead of the password you sign in with, or the login name is not your email address. You can enter a different login name under Advanced settings in the connect step.',
        ],
        generic: () => [
          'I saw your inbox did not connect to MCPEmails earlier.',
          'The connect step shows what went wrong on the last try. Most failures come down to the kind of password or one setting at the mail provider, and both are quick to fix.',
        ],
      },
    },
    e2: {
      clientName: { chatgpt: 'ChatGPT', claude: 'Claude', other: 'your AI app' },
      subject: {
        not_linked: (client) => `One step left to use your inbox in ${client}`,
        linked_no_call: (client) => `Try your first question in ${client}`,
      },
      title: 'Your inbox is ready',
      cta: 'Open the dashboard',
      notLinked: (client) => [
        `Your inbox is connected to MCPEmails, but ${client} is not linked to it yet.`,
        `It takes about a minute. The dashboard has the steps for ${client}.`,
      ],
      linkedNoCall: (client) => [
        `Your inbox and ${client} are both connected to MCPEmails, but nothing has been asked yet.`,
      ],
      toggle: {
        chatgpt: 'In ChatGPT, MCPEmails has to be turned on in the chat you are using. Start a new chat, turn on MCPEmails from the + menu.',
        claude: "In Claude, MCPEmails has to be turned on in the chat you are using. Start a new chat, switch MCPEmails on in the chat's tools menu.",
        other: 'Check that MCPEmails is switched on in the chat you are using.',
      },
      tryLine: (prompt) => `Then try: "${prompt}"`,
    },
  },

  nb: {
    lang: 'nb',
    greeting: 'Hei, det er Asgeir.',
    replyLine: 'Hvis det fortsatt ikke virker, svar på denne e-posten, så ser jeg på det sammen med deg.',
    footerNote: 'Svar går til support-innboksen vår, og jeg leser dem selv.',
    unsubscribeReason: 'Du får denne fordi du begynte å sette opp MCPEmails.',
    unsubscribeLink: 'Meld deg av disse',
    notAffected: 'Konto- og faktureringsvarsler påvirkes ikke.',
    textUnsubscribe: 'Meld av',
    e1: {
      subject: (label) => (label ? `Tilkoblingen av ${label} til MCPEmails` : 'Tilkoblingen av innboksen din til MCPEmails'),
      title: 'Få innboksen din tilkoblet',
      cta: 'Åpne tilkoblingssteget',
      ctaMicrosoft: 'Koble til med Microsoft',
      body: {
        gmail_app_password: () => [
          'Jeg så at Gmail-innboksen din ikke ble koblet til tidligere. Gmail godtar ikke det vanlige Google-passordet ditt fra apper som denne. Den vil ha et app-passord, og det krever at totrinnsbekreftelse er slått på først.',
          `1. Slå på totrinnsbekreftelse: ${PROVIDER_LINKS.googleTwoStep}`,
          `2. Lag et app-passord: ${PROVIDER_LINKS.googleAppPasswords}`,
          '3. Lim inn de 16 bokstavene i MCPEmails. Mellomrom går fint.',
          'På en Google-jobbkonto kan siden for app-passord mangle fordi en administrator har slått den av. Da må administratoren tillate det.',
        ],
        yahoo_app_password: (label, link) => [
          `Jeg så at ${label}-innboksen din ikke ble koblet til tidligere. ${label} avviser det vanlige passordet ditt fra apper som denne og vil ha et app-passord i stedet.`,
          `Du kan lage et her: ${link}. Kall det MCPEmails, og lim det inn i tilkoblingssteget.`,
        ],
        icloud_app_password: () => [
          'Jeg så at iCloud-innboksen din ikke ble koblet til tidligere. iCloud Mail godtar ikke Apple-konto-passordet ditt fra andre apper. Den vil ha et appspesifikt passord.',
          `Gå til ${PROVIDER_LINKS.appleAccount}, åpne Pålogging og sikkerhet, deretter Appspesifikke passord, og lag et som heter MCPEmails. Bruk hele iCloud-adressen din som brukernavn.`,
        ],
        known_host: (label) => [
          `Jeg så at ${label}-innboksen din ikke ble koblet til tidligere. ${label} vil ofte ha noe annet enn passordet du logger inn med: et eget passord for e-postkontoen, et app-passord, eller IMAP slått på i innstillingene.`,
          `Knappen under åpner tilkoblingssteget med ${label} valgt, og der står det hva du bør sjekke for ${label}.`,
        ],
        imap_disabled: (label) => [
          `Jeg så at ${label}-innboksen din ikke ble koblet til tidligere. ${label} sa at IMAP-tilgang er slått av for e-postkontoen din, så ingen passord virker før det er slått på.`,
          `Slå på IMAP (noen ganger kalt tilgang fra andre e-postprogrammer) i e-postinnstillingene hos ${label}, og prøv igjen. På en jobb- eller skolekonto kan det hende en administrator må gjøre det.`,
        ],
        consent_cancelled: (label) => [
          `Jeg så at påloggingssiden hos ${label} ble lukket før innboksen din ble koblet til.`,
          `Den siden viser tilgangen MCPEmails ber om, slik at AI-appen din kan lese, organisere og sende e-post når du ber den om det. Du kan fjerne tilgangen igjen når som helst. Når du er klar, start på nytt og godta på siden hos ${label}.`,
        ],
        office365_basic_auth: () => [
          'Jeg så at Microsoft 365-innboksen din ikke ble koblet til med passord. Microsoft 365 blokkerer passordinnlogging fra apper som denne, så det var ikke passordet som var problemet.',
          'Bruk Outlook-valget i stedet. Det logger inn direkte hos Microsoft, uten passord å skrive inn. Hvis firmaet ditt må godkjenne nye apper, gir tilkoblingssteget deg en lenke du kan sende til IT-administratoren.',
        ],
        server_unreachable: () => [
          'Jeg så at MCPEmails ikke nådde e-postserveren din tidligere. Den svarte aldri.',
          'Som regel er det en skrivefeil i servernavnet, eller serveren godtar bare tilkoblinger fra sitt eget nettverk. Servere hos skoler, universiteter og bedrifter fungerer ofte slik.',
          'Sjekk servernavnet på hjelpesidene til leverandøren din og prøv igjen. Hvis det er en skole- eller jobbserver som ikke slipper inn eksterne apper, er det raskere å koble til en annen adresse.',
        ],
        smtp_rejected: () => [
          'Jeg så at innboksen din kom halvveis tidligere: lesing av e-post virket, men innloggingen for sending ble avvist.',
          'Noen leverandører bruker en annen innlogging for sending. Hvis du bare vil lese og organisere e-post foreløpig, åpne Avanserte innstillinger i tilkoblingssteget og velg Kun motta (IMAP).',
        ],
        generic_password: () => [
          'Jeg så at innboksen din ikke ble koblet til tidligere: e-postserveren avviste innloggingen.',
          'Hos de fleste leverandører betyr det én av to ting. Enten vil den ha et app-passord (et du lager i sikkerhetsinnstillingene) i stedet for passordet du logger inn med, eller så er brukernavnet ikke e-postadressen din. Du kan skrive inn et annet brukernavn under Avanserte innstillinger i tilkoblingssteget.',
        ],
        generic: () => [
          'Jeg så at innboksen din ikke ble koblet til MCPEmails tidligere.',
          'Tilkoblingssteget viser hva som gikk galt sist. De fleste feil handler om hva slags passord som brukes, eller én innstilling hos e-postleverandøren, og begge er raske å fikse.',
        ],
      },
    },
    e2: {
      clientName: { chatgpt: 'ChatGPT', claude: 'Claude', other: 'AI-appen din' },
      subject: {
        not_linked: (client) => `Ett steg igjen før du kan bruke innboksen i ${client}`,
        linked_no_call: (client) => `Prøv det første spørsmålet ditt i ${client}`,
      },
      title: 'Innboksen din er klar',
      cta: 'Åpne dashbordet',
      notLinked: (client) => [
        `Innboksen din er koblet til MCPEmails, men ${client} er ikke koblet til ennå.`,
        `Det tar omtrent ett minutt. Dashbordet har stegene for ${client}.`,
      ],
      linkedNoCall: (client) => [
        `Både innboksen din og ${client} er koblet til MCPEmails, men ingenting er spurt om ennå.`,
      ],
      toggle: {
        chatgpt: 'I ChatGPT må MCPEmails være slått på i chatten du bruker. Start en ny chat, slå på MCPEmails fra +-menyen.',
        claude: 'I Claude må MCPEmails være slått på i chatten du bruker. Start en ny chat, slå på MCPEmails i verktøymenyen i chatten.',
        other: 'Sjekk at MCPEmails er slått på i chatten du bruker.',
      },
      tryLine: (prompt) => `Prøv for eksempel: «${prompt}»`,
    },
  },

  de: {
    lang: 'de',
    greeting: 'Hallo, hier ist Asgeir.',
    replyLine: 'Wenn es weiterhin nicht klappt, antworten Sie einfach auf diese E-Mail, dann sehe ich es mir mit Ihnen an.',
    footerNote: 'Antworten gehen an unser Support-Postfach, und ich lese sie selbst.',
    unsubscribeReason: 'Sie erhalten diese E-Mail, weil Sie mit der Einrichtung von MCPEmails begonnen haben.',
    unsubscribeLink: 'Diese E-Mails abbestellen',
    notAffected: 'Konto- und Rechnungshinweise sind davon nicht betroffen.',
    textUnsubscribe: 'Abbestellen',
    e1: {
      subject: (label) => (label ? `Ihre ${label}-Verbindung zu MCPEmails` : 'Die Verbindung Ihres Postfachs zu MCPEmails'),
      title: 'Ihr Postfach verbinden',
      cta: 'Verbindungsschritt öffnen',
      ctaMicrosoft: 'Mit Microsoft verbinden',
      body: {
        gmail_app_password: () => [
          'Ich habe gesehen, dass sich Ihr Gmail-Postfach vorhin nicht verbinden ließ. Gmail akzeptiert Ihr normales Google-Passwort nicht von Apps wie dieser. Es braucht ein App-Passwort, und dafür muss zuerst die Bestätigung in zwei Schritten aktiviert sein.',
          `1. Bestätigung in zwei Schritten aktivieren: ${PROVIDER_LINKS.googleTwoStep}`,
          `2. App-Passwort erstellen: ${PROVIDER_LINKS.googleAppPasswords}`,
          '3. Die 16 Buchstaben in MCPEmails einfügen. Leerzeichen sind kein Problem.',
          'Bei einem geschäftlichen Google-Konto kann die Seite für App-Passwörter fehlen, weil ein Administrator sie abgeschaltet hat. Dann muss Ihr Administrator sie freigeben.',
        ],
        yahoo_app_password: (label, link) => [
          `Ich habe gesehen, dass sich Ihr ${label}-Postfach vorhin nicht verbinden ließ. ${label} lehnt Ihr normales Passwort bei Apps wie dieser ab und verlangt stattdessen ein App-Passwort.`,
          `Sie können hier eines erstellen: ${link}. Nennen Sie es MCPEmails und fügen Sie es im Verbindungsschritt ein.`,
        ],
        icloud_app_password: () => [
          'Ich habe gesehen, dass sich Ihr iCloud-Postfach vorhin nicht verbinden ließ. iCloud Mail akzeptiert Ihr Apple-Account-Passwort nicht von anderen Apps. Es braucht ein app-spezifisches Passwort.',
          `Öffnen Sie ${PROVIDER_LINKS.appleAccount}, dann Anmeldung und Sicherheit und App-spezifische Passwörter, und erstellen Sie eines mit dem Namen MCPEmails. Verwenden Sie Ihre vollständige iCloud-Adresse als Benutzernamen.`,
        ],
        known_host: (label) => [
          `Ich habe gesehen, dass sich Ihr ${label}-Postfach vorhin nicht verbinden ließ. ${label} verlangt oft etwas anderes als das Passwort, mit dem Sie sich anmelden: ein eigenes Postfach-Passwort, ein App-Passwort oder ein in den Einstellungen aktiviertes IMAP.`,
          `Die Schaltfläche unten öffnet den Verbindungsschritt mit ${label} vorausgewählt, und dort steht, was Sie bei ${label} prüfen sollten.`,
        ],
        imap_disabled: (label) => [
          `Ich habe gesehen, dass sich Ihr ${label}-Postfach vorhin nicht verbinden ließ. ${label} hat uns gemeldet, dass der IMAP-Zugriff für Ihr Postfach ausgeschaltet ist. Solange er aus ist, funktioniert kein Passwort.`,
          `Aktivieren Sie IMAP (manchmal Zugriff durch andere Mailprogramme genannt) in den Mail-Einstellungen von ${label} und versuchen Sie es erneut. Bei einem Firmen- oder Schulkonto muss das unter Umständen ein Administrator tun.`,
        ],
        consent_cancelled: (label) => [
          `Ich habe gesehen, dass die Anmeldeseite von ${label} geschlossen wurde, bevor Ihr Postfach verbunden war.`,
          `Diese Seite zeigt den Zugriff, den MCPEmails anfragt, damit Ihre KI-App Mails lesen, ordnen und senden kann, wenn Sie sie darum bitten. Sie können diesen Zugriff jederzeit wieder entfernen. Wenn Sie so weit sind, starten Sie neu und stimmen Sie auf der Seite von ${label} zu.`,
        ],
        office365_basic_auth: () => [
          'Ich habe gesehen, dass sich Ihr Microsoft-365-Postfach nicht mit einem Passwort verbinden ließ. Microsoft 365 sperrt Passwort-Anmeldungen von Apps wie dieser, das Passwort selbst war also nicht das Problem.',
          'Nutzen Sie stattdessen die Option Outlook. Sie meldet sich direkt bei Microsoft an, ohne Passwort. Wenn Ihr Unternehmen neue Apps freigeben muss, erhalten Sie im Verbindungsschritt einen Link für Ihre IT-Administration.',
        ],
        server_unreachable: () => [
          'Ich habe gesehen, dass MCPEmails Ihren Mailserver vorhin nicht erreicht hat. Er hat nie geantwortet.',
          'Meist steckt ein Tippfehler im Servernamen, oder der Server nimmt nur Verbindungen aus dem eigenen Netz an. Server von Schulen, Hochschulen und Unternehmen sind oft so eingerichtet.',
          'Prüfen Sie den Servernamen auf den Hilfeseiten Ihres Anbieters und versuchen Sie es erneut. Wenn es ein Schul- oder Firmenserver ist, der keine externen Apps zulässt, geht es schneller mit einer anderen Adresse.',
        ],
        smtp_rejected: () => [
          'Ich habe gesehen, dass Ihr Postfach vorhin auf halbem Weg stehen geblieben ist: Das Lesen hat funktioniert, aber die Anmeldung zum Senden wurde abgelehnt.',
          'Manche Anbieter verwenden zum Senden eine andere Anmeldung. Wenn Sie vorerst nur lesen und ordnen möchten, öffnen Sie im Verbindungsschritt Erweiterte Einstellungen und wählen Sie Nur empfangen (IMAP).',
        ],
        generic_password: () => [
          'Ich habe gesehen, dass sich Ihr Postfach vorhin nicht verbinden ließ: Der Mailserver hat die Anmeldung abgelehnt.',
          'Bei den meisten Anbietern bedeutet das eines von zwei Dingen. Entweder verlangt er ein App-Passwort (das Sie in den Sicherheitseinstellungen erstellen) statt Ihres Anmeldepassworts, oder der Benutzername ist nicht Ihre E-Mail-Adresse. Einen anderen Benutzernamen können Sie im Verbindungsschritt unter Erweiterte Einstellungen eingeben.',
        ],
        generic: () => [
          'Ich habe gesehen, dass sich Ihr Postfach vorhin nicht mit MCPEmails verbinden ließ.',
          'Der Verbindungsschritt zeigt, was beim letzten Versuch schiefging. Meist liegt es an der Art des Passworts oder an einer Einstellung beim Mailanbieter, und beides ist schnell behoben.',
        ],
      },
    },
    e2: {
      clientName: { chatgpt: 'ChatGPT', claude: 'Claude', other: 'Ihre KI-App' },
      subject: {
        not_linked: (client) => `Noch ein Schritt: ${client} mit Ihrem Postfach verbinden`,
        linked_no_call: (client) => `Ihre erste Frage an ${client}`,
      },
      title: 'Ihr Postfach ist bereit',
      cta: 'Dashboard öffnen',
      notLinked: (client) => [
        `Ihr Postfach ist mit MCPEmails verbunden, aber ${client} ist noch nicht damit verknüpft.`,
        `Das dauert etwa eine Minute. Im Dashboard finden Sie die Schritte für ${client}.`,
      ],
      linkedNoCall: (client) => [
        `Ihr Postfach und ${client} sind beide mit MCPEmails verbunden, aber es wurde noch nichts gefragt.`,
      ],
      toggle: {
        chatgpt: 'In ChatGPT muss MCPEmails in dem Chat aktiviert sein, den Sie gerade nutzen. Starten Sie einen neuen Chat, aktivieren Sie MCPEmails über das +-Menü.',
        claude: 'In Claude muss MCPEmails in dem Chat aktiviert sein, den Sie gerade nutzen. Starten Sie einen neuen Chat, schalten Sie MCPEmails im Tools-Menü des Chats ein.',
        other: 'Prüfen Sie, ob MCPEmails in dem Chat eingeschaltet ist, den Sie gerade nutzen.',
      },
      tryLine: (prompt) => `Versuchen Sie zum Beispiel: „${prompt}“`,
    },
  },

  es: {
    lang: 'es',
    greeting: 'Hola, soy Asgeir.',
    replyLine: 'Si sigue sin funcionar, responde a este correo y lo miro contigo.',
    footerNote: 'Las respuestas llegan a nuestro buzón de soporte y las leo yo mismo.',
    unsubscribeReason: 'Recibes esto porque empezaste a configurar MCPEmails.',
    unsubscribeLink: 'Darte de baja de estos correos',
    notAffected: 'Los avisos de cuenta y facturación no se ven afectados.',
    textUnsubscribe: 'Darte de baja',
    e1: {
      subject: (label) => (label ? `Tu conexión de ${label} con MCPEmails` : 'La conexión de tu buzón con MCPEmails'),
      title: 'Conectar tu buzón',
      cta: 'Abrir el paso de conexión',
      ctaMicrosoft: 'Conectar con Microsoft',
      body: {
        gmail_app_password: () => [
          'He visto que tu buzón de Gmail no se conectó hace un rato. Gmail no acepta tu contraseña normal de Google desde apps como esta. Necesita una contraseña de aplicación, y para eso primero hay que activar la verificación en dos pasos.',
          `1. Activa la verificación en dos pasos: ${PROVIDER_LINKS.googleTwoStep}`,
          `2. Crea una contraseña de aplicación: ${PROVIDER_LINKS.googleAppPasswords}`,
          '3. Pega las 16 letras en MCPEmails. Los espacios no importan.',
          'En una cuenta de Google del trabajo, la página de contraseñas de aplicación puede no aparecer porque un administrador la desactivó. En ese caso tu administrador tiene que permitirla.',
        ],
        yahoo_app_password: (label, link) => [
          `He visto que tu buzón de ${label} no se conectó hace un rato. ${label} rechaza tu contraseña normal en apps como esta y pide una contraseña de aplicación.`,
          `Puedes crear una aquí: ${link}. Ponle de nombre MCPEmails y pégala en el paso de conexión.`,
        ],
        icloud_app_password: () => [
          'He visto que tu buzón de iCloud no se conectó hace un rato. iCloud Mail no acepta la contraseña de tu cuenta de Apple desde otras apps. Necesita una contraseña específica para apps.',
          `Entra en ${PROVIDER_LINKS.appleAccount}, abre Inicio de sesión y seguridad y luego Contraseñas específicas para apps, y crea una llamada MCPEmails. Usa tu dirección completa de iCloud como nombre de usuario.`,
        ],
        known_host: (label) => [
          `He visto que tu buzón de ${label} no se conectó hace un rato. ${label} suele pedir algo distinto de la contraseña con la que inicias sesión: una contraseña propia del buzón, una contraseña de aplicación o IMAP activado en su configuración.`,
          `El botón de abajo abre el paso de conexión con ${label} ya elegido, y ahí se indica qué revisar en ${label}.`,
        ],
        imap_disabled: (label) => [
          `He visto que tu buzón de ${label} no se conectó hace un rato. ${label} nos dijo que el acceso IMAP está desactivado en tu buzón, así que ninguna contraseña funcionará hasta que lo actives.`,
          `Activa IMAP (a veces se llama acceso desde otras apps de correo) en la configuración de correo de ${label} y vuelve a intentarlo. En una cuenta del trabajo o de un centro educativo, puede que tenga que hacerlo un administrador.`,
        ],
        consent_cancelled: (label) => [
          `He visto que la página de inicio de sesión de ${label} se cerró antes de que tu buzón quedara conectado.`,
          `Esa página muestra el acceso que pide MCPEmails para que tu app de IA pueda leer, organizar y enviar correo cuando se lo pidas. Puedes retirar ese acceso cuando quieras. Cuando estés listo, empieza de nuevo y acepta en la página de ${label}.`,
        ],
        office365_basic_auth: () => [
          'He visto que tu buzón de Microsoft 365 no se conectó con contraseña. Microsoft 365 bloquea el inicio de sesión con contraseña desde apps como esta, así que el problema no era la contraseña.',
          'Usa la opción de Outlook. Inicia sesión directamente con Microsoft, sin escribir ninguna contraseña. Si tu empresa tiene que aprobar las apps nuevas, el paso de conexión te da un enlace para enviar a tu administrador de TI.',
        ],
        server_unreachable: () => [
          'He visto que MCPEmails no pudo llegar a tu servidor de correo hace un rato. Nunca respondió.',
          'Normalmente hay una errata en el nombre del servidor, o el servidor solo acepta conexiones desde su propia red. Los servidores de colegios, universidades y empresas suelen funcionar así.',
          'Revisa el nombre del servidor en las páginas de ayuda de tu proveedor y vuelve a intentarlo. Si es un servidor de estudios o de trabajo que no admite apps externas, lo más rápido es conectar otra dirección.',
        ],
        smtp_rejected: () => [
          'He visto que tu buzón se quedó a medias hace un rato: la lectura del correo funcionó, pero se rechazó el inicio de sesión para enviar.',
          'Algunos proveedores usan un inicio de sesión distinto para enviar. Si por ahora solo quieres leer y organizar el correo, abre Configuración avanzada en el paso de conexión y elige Solo recibir (IMAP).',
        ],
        generic_password: () => [
          'He visto que tu buzón no se conectó hace un rato: el servidor de correo rechazó el inicio de sesión.',
          'Con la mayoría de los proveedores eso significa una de dos cosas. O pide una contraseña de aplicación (una que creas en su configuración de seguridad) en lugar de la contraseña con la que inicias sesión, o el nombre de usuario no es tu dirección de correo. Puedes escribir otro nombre de usuario en Configuración avanzada, en el paso de conexión.',
        ],
        generic: () => [
          'He visto que tu buzón no se conectó a MCPEmails hace un rato.',
          'El paso de conexión muestra qué falló en el último intento. La mayoría de los fallos se deben al tipo de contraseña o a un ajuste del proveedor de correo, y las dos cosas se arreglan rápido.',
        ],
      },
    },
    e2: {
      clientName: { chatgpt: 'ChatGPT', claude: 'Claude', other: 'tu app de IA' },
      subject: {
        not_linked: (client) => `Te queda un paso para usar tu buzón en ${client}`,
        linked_no_call: (client) => `Haz tu primera pregunta en ${client}`,
      },
      title: 'Tu buzón está listo',
      cta: 'Abrir el panel',
      notLinked: (client) => [
        `Tu buzón está conectado a MCPEmails, pero todavía no has vinculado ${client}.`,
        `Se tarda un minuto más o menos. En el panel están los pasos para ${client}.`,
      ],
      linkedNoCall: (client) => [
        `Tu buzón y ${client} ya están conectados a MCPEmails, pero todavía no se ha preguntado nada.`,
      ],
      toggle: {
        chatgpt: 'En ChatGPT, MCPEmails tiene que estar activado en el chat que usas. Abre un chat nuevo, activa MCPEmails desde el menú +.',
        claude: 'En Claude, MCPEmails tiene que estar activado en el chat que usas. Abre un chat nuevo, activa MCPEmails en el menú de herramientas del chat.',
        other: 'Comprueba que MCPEmails está activado en el chat que usas.',
      },
      tryLine: (prompt) => `Prueba por ejemplo: «${prompt}»`,
    },
  },

  fr: {
    lang: 'fr',
    greeting: "Bonjour, c'est Asgeir.",
    replyLine: 'Si ça ne fonctionne toujours pas, répondez à cet e-mail et je regarderai avec vous.',
    footerNote: 'Les réponses arrivent dans notre boîte de support, et je les lis moi-même.',
    unsubscribeReason: 'Vous recevez cet e-mail parce que vous avez commencé à configurer MCPEmails.',
    unsubscribeLink: 'Se désinscrire de ces e-mails',
    notAffected: 'Les avis liés au compte et à la facturation ne sont pas concernés.',
    textUnsubscribe: 'Se désinscrire',
    e1: {
      subject: (label) => (label ? `Votre connexion ${label} à MCPEmails` : 'La connexion de votre boîte mail à MCPEmails'),
      title: 'Connecter votre boîte mail',
      cta: "Ouvrir l'étape de connexion",
      ctaMicrosoft: 'Se connecter avec Microsoft',
      body: {
        gmail_app_password: () => [
          "J'ai vu que votre boîte Gmail ne s'est pas connectée tout à l'heure. Gmail n'accepte pas votre mot de passe Google habituel depuis des applications comme celle-ci. Il faut un mot de passe d'application, et pour cela la validation en deux étapes doit d'abord être activée.",
          `1. Activez la validation en deux étapes : ${PROVIDER_LINKS.googleTwoStep}`,
          `2. Créez un mot de passe d'application : ${PROVIDER_LINKS.googleAppPasswords}`,
          '3. Collez les 16 lettres dans MCPEmails. Les espaces ne posent pas de problème.',
          "Sur un compte Google professionnel, la page des mots de passe d'application peut être absente parce qu'un administrateur l'a désactivée. Votre administrateur doit alors l'autoriser.",
        ],
        yahoo_app_password: (label, link) => [
          `J'ai vu que votre boîte ${label} ne s'est pas connectée tout à l'heure. ${label} refuse votre mot de passe habituel dans des applications comme celle-ci et demande un mot de passe d'application.`,
          `Vous pouvez en créer un ici : ${link}. Nommez-le MCPEmails, puis collez-le dans l'étape de connexion.`,
        ],
        icloud_app_password: () => [
          "J'ai vu que votre boîte iCloud ne s'est pas connectée tout à l'heure. iCloud Mail n'accepte pas le mot de passe de votre compte Apple depuis d'autres applications. Il faut un mot de passe pour app.",
          `Allez sur ${PROVIDER_LINKS.appleAccount}, ouvrez Connexion et sécurité, puis Mots de passe pour app, et créez-en un nommé MCPEmails. Utilisez votre adresse iCloud complète comme nom d'utilisateur.`,
        ],
        known_host: (label) => [
          `J'ai vu que votre boîte ${label} ne s'est pas connectée tout à l'heure. ${label} demande souvent autre chose que le mot de passe avec lequel vous vous connectez : un mot de passe propre à la boîte mail, un mot de passe d'application, ou IMAP activé dans ses réglages.`,
          `Le bouton ci-dessous ouvre l'étape de connexion avec ${label} déjà choisi, et indique quoi vérifier chez ${label}.`,
        ],
        imap_disabled: (label) => [
          `J'ai vu que votre boîte ${label} ne s'est pas connectée tout à l'heure. ${label} nous a indiqué que l'accès IMAP est désactivé pour votre boîte : aucun mot de passe ne fonctionnera tant qu'il ne sera pas activé.`,
          `Activez IMAP (parfois appelé accès depuis d'autres logiciels de messagerie) dans les réglages de messagerie de ${label}, puis réessayez. Sur un compte professionnel ou scolaire, un administrateur devra peut-être le faire.`,
        ],
        consent_cancelled: (label) => [
          `J'ai vu que la page de connexion ${label} a été fermée avant que votre boîte ne soit connectée.`,
          `Cette page indique l'accès que demande MCPEmails, pour que votre application d'IA puisse lire, classer et envoyer des e-mails quand vous le lui demandez. Vous pouvez retirer cet accès à tout moment. Quand vous êtes prêt, recommencez et acceptez sur la page ${label}.`,
        ],
        office365_basic_auth: () => [
          "J'ai vu que votre boîte Microsoft 365 ne s'est pas connectée avec un mot de passe. Microsoft 365 bloque les connexions par mot de passe depuis des applications comme celle-ci : le mot de passe lui-même n'était donc pas en cause.",
          "Utilisez plutôt l'option Outlook. Elle se connecte directement chez Microsoft, sans mot de passe à saisir. Si votre entreprise doit approuver les nouvelles applications, l'étape de connexion vous donne un lien à transmettre à votre service informatique.",
        ],
        server_unreachable: () => [
          "J'ai vu que MCPEmails n'a pas pu joindre votre serveur de messagerie tout à l'heure. Il n'a jamais répondu.",
          "Le plus souvent, le nom du serveur contient une faute de frappe, ou le serveur n'accepte que les connexions venant de son propre réseau. Les serveurs des établissements scolaires, des universités et des entreprises fonctionnent souvent ainsi.",
          "Vérifiez le nom du serveur dans l'aide de votre fournisseur et réessayez. S'il s'agit d'un serveur scolaire ou professionnel qui n'accepte pas les applications extérieures, le plus rapide est de connecter une autre adresse.",
        ],
        smtp_rejected: () => [
          "J'ai vu que votre boîte s'est arrêtée à mi-chemin tout à l'heure : la lecture des e-mails a fonctionné, mais la connexion pour l'envoi a été refusée.",
          "Certains fournisseurs utilisent un identifiant différent pour l'envoi. Si vous voulez seulement lire et classer vos e-mails pour l'instant, ouvrez Paramètres avancés dans l'étape de connexion et choisissez Réception uniquement (IMAP).",
        ],
        generic_password: () => [
          "J'ai vu que votre boîte ne s'est pas connectée tout à l'heure : le serveur de messagerie a refusé la connexion.",
          "Chez la plupart des fournisseurs, cela veut dire l'une de deux choses. Soit il demande un mot de passe d'application (que vous créez dans ses réglages de sécurité) au lieu du mot de passe avec lequel vous vous connectez, soit l'identifiant n'est pas votre adresse e-mail. Vous pouvez saisir un autre identifiant dans Paramètres avancés, à l'étape de connexion.",
        ],
        generic: () => [
          "J'ai vu que votre boîte ne s'est pas connectée à MCPEmails tout à l'heure.",
          "L'étape de connexion montre ce qui a échoué lors du dernier essai. La plupart des échecs viennent du type de mot de passe ou d'un réglage chez le fournisseur de messagerie, et les deux se corrigent vite.",
        ],
      },
    },
    e2: {
      clientName: { chatgpt: 'ChatGPT', claude: 'Claude', other: "votre application d'IA" },
      subject: {
        not_linked: (client) => `Plus qu'une étape pour utiliser votre boîte dans ${client}`,
        linked_no_call: (client) => `Posez votre première question dans ${client}`,
      },
      title: 'Votre boîte mail est prête',
      cta: 'Ouvrir le tableau de bord',
      notLinked: (client) => [
        `Votre boîte est connectée à MCPEmails, mais le lien avec ${client} n'est pas encore fait.`,
        `Cela prend environ une minute. Le tableau de bord indique les étapes pour ${client}.`,
      ],
      linkedNoCall: (client) => [
        `Votre boîte et ${client} sont tous les deux connectés à MCPEmails, mais aucune question n'a encore été posée.`,
      ],
      toggle: {
        chatgpt: "Dans ChatGPT, MCPEmails doit être activé dans la conversation que vous utilisez. Ouvrez une nouvelle conversation, activez MCPEmails depuis le menu +.",
        claude: "Dans Claude, MCPEmails doit être activé dans la conversation que vous utilisez. Ouvrez une nouvelle conversation, activez MCPEmails dans le menu des outils de la conversation.",
        other: 'Vérifiez que MCPEmails est activé dans la conversation que vous utilisez.',
      },
      tryLine: (prompt) => `Essayez par exemple : « ${prompt} »`,
    },
  },

  zh: {
    lang: 'zh',
    greeting: '你好，我是 Asgeir。',
    replyLine: '如果还是不行，直接回复这封邮件，我会和你一起看看。',
    footerNote: '回复会进入我们的支持邮箱，我会亲自阅读。',
    unsubscribeReason: '你收到这封邮件，是因为你开始设置 MCPEmails。',
    unsubscribeLink: '退订此类邮件',
    notAffected: '账户和账单通知不受影响。',
    textUnsubscribe: '退订',
    e1: {
      subject: (label) => (label ? `你的 ${label} 与 MCPEmails 的连接` : '你的邮箱与 MCPEmails 的连接'),
      title: '连接你的邮箱',
      cta: '打开连接步骤',
      ctaMicrosoft: '使用 Microsoft 连接',
      body: {
        gmail_app_password: () => [
          '我看到你的 Gmail 邮箱刚才没有连接成功。Gmail 不接受这类应用使用你的普通 Google 密码，需要使用应用专用密码，而这需要先开启两步验证。',
          `1. 开启两步验证：${PROVIDER_LINKS.googleTwoStep}`,
          `2. 创建应用专用密码：${PROVIDER_LINKS.googleAppPasswords}`,
          '3. 把这 16 个字母粘贴到 MCPEmails。带空格也没关系。',
          '如果是工作用的 Google 账号，管理员可能关闭了应用专用密码页面。这种情况需要管理员开启。',
        ],
        yahoo_app_password: (label, link) => [
          `我看到你的 ${label} 邮箱刚才没有连接成功。${label} 不接受这类应用使用你的普通密码，需要使用应用专用密码。`,
          `你可以在这里创建：${link}。把它命名为 MCPEmails，然后粘贴到连接步骤中。`,
        ],
        icloud_app_password: () => [
          '我看到你的 iCloud 邮箱刚才没有连接成功。iCloud 邮件不接受其他应用使用你的 Apple 账户密码，需要使用 App 专用密码。',
          `前往 ${PROVIDER_LINKS.appleAccount}，打开“登录与安全”，再打开“App 专用密码”，创建一个名为 MCPEmails 的密码。用户名请填写完整的 iCloud 邮箱地址。`,
        ],
        known_host: (label) => [
          `我看到你的 ${label} 邮箱刚才没有连接成功。${label} 通常需要的不是你的登录密码，而是单独的邮箱密码、应用专用密码，或者在设置中开启 IMAP。`,
          `下面的按钮会打开已选好 ${label} 的连接步骤，并列出 ${label} 需要检查的地方。`,
        ],
        imap_disabled: (label) => [
          `我看到你的 ${label} 邮箱刚才没有连接成功。${label} 告诉我们，你的邮箱关闭了 IMAP 访问，开启之前任何密码都无法使用。`,
          `请在 ${label} 的邮件设置中开启 IMAP（有时叫“允许其他邮件客户端访问”），然后再试一次。如果是工作或学校账号，可能需要管理员来开启。`,
        ],
        consent_cancelled: (label) => [
          `我看到 ${label} 的登录页面在邮箱连接完成之前被关闭了。`,
          `那个页面列出了 MCPEmails 申请的权限，让你的 AI 应用在你要求时可以读取、整理和发送邮件。你可以随时撤销这些权限。准备好后，请重新开始，并在 ${label} 的页面上同意。`,
        ],
        office365_basic_auth: () => [
          '我看到你的 Microsoft 365 邮箱没能用密码连接。Microsoft 365 会阻止这类应用用密码登录，所以问题并不在密码本身。',
          '请改用 Outlook 选项。它直接通过 Microsoft 登录，不需要输入密码。如果你的公司需要审批新应用，连接步骤会提供一个链接，可以发给你的 IT 管理员。',
        ],
        server_unreachable: () => [
          '我看到 MCPEmails 刚才无法连接到你的邮件服务器，服务器一直没有响应。',
          '通常是服务器名称有拼写错误，或者服务器只接受来自其内部网络的连接。学校、大学和公司的服务器经常是这样。',
          '请在邮件服务商的帮助页面核对服务器名称后再试一次。如果是不允许外部应用的学校或工作服务器，换一个邮箱地址连接会更快。',
        ],
        smtp_rejected: () => [
          '我看到你的邮箱刚才只连接了一半：读取邮件成功了，但发送邮件的登录被拒绝。',
          '有些服务商发送邮件时使用不同的登录信息。如果你暂时只想读取和整理邮件，可以在连接步骤中打开“高级设置”，选择“仅接收 (IMAP)”。',
        ],
        generic_password: () => [
          '我看到你的邮箱刚才没有连接成功：邮件服务器拒绝了登录。',
          '对大多数服务商来说，这意味着两种情况之一：要么它需要应用专用密码（在其安全设置中创建），而不是你的登录密码；要么登录名不是你的邮箱地址。你可以在连接步骤的“高级设置”中填写其他登录名。',
        ],
        generic: () => [
          '我看到你的邮箱刚才没有成功连接到 MCPEmails。',
          '连接步骤会显示上一次尝试出了什么问题。大多数失败都和密码类型或邮件服务商的某个设置有关，两者都能很快解决。',
        ],
      },
    },
    e2: {
      clientName: { chatgpt: 'ChatGPT', claude: 'Claude', other: '你的 AI 应用' },
      subject: {
        not_linked: (client) => `只差一步，就能在 ${client} 中使用你的邮箱`,
        linked_no_call: (client) => `在 ${client} 中问出第一个问题`,
      },
      title: '你的邮箱已准备就绪',
      cta: '打开控制台',
      notLinked: (client) => [
        `你的邮箱已经连接到 MCPEmails，但还没有关联 ${client}。`,
        `大约只需要一分钟。控制台里有 ${client} 的操作步骤。`,
      ],
      linkedNoCall: (client) => [
        `你的邮箱和 ${client} 都已连接到 MCPEmails，但还没有提出任何问题。`,
      ],
      toggle: {
        chatgpt: '在 ChatGPT 中，需要在当前对话里开启 MCPEmails。新建一个对话，从 + 菜单中开启 MCPEmails。',
        claude: '在 Claude 中，需要在当前对话里开启 MCPEmails。新建一个对话，在对话的工具菜单中打开 MCPEmails。',
        other: '请确认当前对话中已开启 MCPEmails。',
      },
      tryLine: (prompt) => `然后试试：“${prompt}”`,
    },
  },
};

/** Exported for the tests, which check every locale for banned wording. */
export function helpCopy(locale: HelpLocale): Copy {
  return COPY[locale];
}

export function starterPrompt(locale: HelpLocale): string {
  return STARTER_PROMPT[locale];
}

// ---------------------------------------------------------------------------
// HTML shell: same markup and colours as abandoned-checkout-templates.ts
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Escape, then make bare https URLs clickable. Only our own fixed URLs appear. */
function linkify(text: string): string {
  return escapeHtml(text).replace(
    /https:\/\/[A-Za-z0-9./_-]+[A-Za-z0-9/]/g,
    (url) => `<a href="${url}" style="color:#2563eb;">${url}</a>`,
  );
}

function p(text: string): string {
  return `<p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">${linkify(text)}</p>`;
}

function shell(o: {
  lang: string;
  title: string;
  html: string;
  ctaUrl: string;
  ctaLabel: string;
  footerNote: string;
  unsubscribeUrl: string;
  unsubscribeReason: string;
  unsubscribeLink: string;
  notAffected: string;
}): string {
  return `<!DOCTYPE html>
<html lang="${escapeHtml(o.lang)}">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${escapeHtml(o.title)}</title>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
          <tr>
            <td style="background:#0f172a;padding:28px 40px;">
              <span style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:-0.3px;">MCPEmails</span>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 40px 8px;">
              <p style="margin:0 0 18px;font-size:22px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">
                ${escapeHtml(o.title)}
              </p>
              ${o.html}
              <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
                <tr>
                  <td style="background:#0f172a;border-radius:8px;">
                    <a href="${escapeHtml(o.ctaUrl)}" style="display:inline-block;padding:12px 28px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">
                      ${escapeHtml(o.ctaLabel)}
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background:#f8fafc;padding:20px 40px;border-top:1px solid #e2e8f0;">
              <p style="margin:0;font-size:13px;color:#64748b;line-height:1.6;">${escapeHtml(o.footerNote)}</p>
              <p style="margin:12px 0 0;font-size:12px;color:#94a3b8;line-height:1.6;">
                ${escapeHtml(o.unsubscribeReason)}
                <a href="${escapeHtml(o.unsubscribeUrl)}" style="color:#94a3b8;text-decoration:underline;">${escapeHtml(o.unsubscribeLink)}</a>.
                ${escapeHtml(o.notAffected)}
              </p>
              <p style="margin:14px 0 0;font-size:11px;color:#94a3b8;line-height:1.6;">${escapeHtml(POSTAL_ADDRESS_LINE)}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export type ActivationHelpContent =
  | {
      email: 'connection_help';
      key: ConnectionHelpKey;
      /** Provider's public name, or null when the failure did not name one. */
      label: string | null;
      /** The provider's own app-password page, for keys that need one. */
      providerLink: string | null;
    }
  | { email: 'first_call_help'; state: FirstCallState; client: HelpClient };

export interface ComposeInput {
  content: ActivationHelpContent;
  locale: HelpLocale;
  /** The one link back into the product (dashboard connect step or overview). */
  ctaUrl: string;
  /** The recipient's own users.unsubscribe_token. Required; null = no email. */
  unsubscribeToken: string | null | undefined;
}

export interface ComposedActivationHelp {
  subject: string;
  text: string;
  html: string;
  unsubscribeUrl: string;
  headers: Record<string, string>;
}

function body(c: Copy, content: ActivationHelpContent, locale: HelpLocale): {
  subject: string;
  title: string;
  paragraphs: string[];
  cta: string;
} {
  if (content.email === 'connection_help') {
    const label = content.label ?? '';
    const paragraphs = c.e1.body[content.key](label, content.providerLink);
    return {
      subject: c.e1.subject(content.label),
      title: c.e1.title,
      paragraphs: [...paragraphs, c.replyLine],
      cta: content.key === 'office365_basic_auth' ? c.e1.ctaMicrosoft : c.e1.cta,
    };
  }
  const client = c.e2.clientName[content.client];
  const intro = content.state === 'not_linked' ? c.e2.notLinked(client) : [
    ...c.e2.linkedNoCall(client),
    c.e2.toggle[content.client],
  ];
  return {
    subject: c.e2.subject[content.state](client),
    title: c.e2.title,
    paragraphs: [...intro, c.e2.tryLine(STARTER_PROMPT[locale]), c.replyLine],
    cta: c.e2.cta,
  };
}

export function composeActivationHelp(input: ComposeInput): ComposedActivationHelp | null {
  const token = typeof input.unsubscribeToken === 'string' ? input.unsubscribeToken.trim() : '';
  if (!token) return null;
  const c = COPY[input.locale] ?? COPY.en;
  const unsub = unsubscribeUrl(token, ACTIVATION_HELP_CATEGORY);
  const b = body(c, input.content, input.locale);

  const text = [
    c.greeting,
    '',
    ...b.paragraphs.flatMap((para, i) => {
      // Numbered steps sit together without blank lines between them.
      const next = b.paragraphs[i + 1];
      const tight = /^\d\. /.test(para) && next !== undefined && /^\d\. /.test(next);
      return tight ? [para] : [para, ''];
    }),
    `${b.cta}: ${input.ctaUrl}`,
    '',
    'Asgeir',
    'MCPEmails',
    '',
    `${c.unsubscribeReason} ${c.textUnsubscribe}: ${unsub}`,
    c.notAffected,
    '',
    POSTAL_ADDRESS_LINE,
  ].join('\n');

  const html = shell({
    lang: c.lang,
    title: b.title,
    html: p(c.greeting) + b.paragraphs.map((para) => p(para)).join('') + p('Asgeir'),
    ctaUrl: input.ctaUrl,
    ctaLabel: b.cta,
    footerNote: c.footerNote,
    unsubscribeUrl: unsub,
    unsubscribeReason: c.unsubscribeReason,
    unsubscribeLink: c.unsubscribeLink,
    notAffected: c.notAffected,
  });

  return {
    subject: b.subject,
    text,
    html,
    unsubscribeUrl: unsub,
    headers: {
      'List-Unsubscribe': `<${unsub}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}
