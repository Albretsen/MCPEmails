// German copy for /docs/microsoft-365-admin-consent. Same shape as `en` in
// content.mjs; the source notes for every claim are there.

import { MS_GRANT, MS_ASSIGN, CLAUDE_M365 } from './links.mjs';

const de = {
  meta: {
    title: 'Administratorgenehmigung für Outlook oder Microsoft 365 nötig? MCPEmails freigeben',
    description:
      'Warum Microsoft "Need admin approval" anzeigt, wenn Sie ein geschäftliches Postfach bei Outlook oder Microsoft 365 mit Claude oder ChatGPT verbinden, welchen Link Sie Ihrer IT-Abteilung schicken und welche Berechtigungen der Admin genau genehmigt.',
  },
  breadcrumb: 'Admin-Genehmigung für Microsoft 365',
  eyebrow: 'Dokumentation',
  title: 'Microsoft 365: "Need admin approval"',
  lead:
    'Microsoft zeigt "Need admin approval" an, wenn Ihre Organisation Mitarbeitenden nicht erlaubt, einer App selbst den Zugriff auf E-Mails zu genehmigen. Ein IT-Admin genehmigt MCPEmails einmal, danach kann jede Person in der Organisation ihr eigenes Postfach verbinden. Diese Seite ist für Sie beide: was die Person tut, die das Postfach verbindet, und was der Admin genehmigt.',
  sections: [
    {
      id: 'why',
      h: 'Warum Microsoft nach einem Admin fragt',
      items: [
        'Seit Ende 2025 verhindert die Standard-Einwilligungsrichtlinie von Microsoft für Geschäfts- und Schulmandanten, dass Mitarbeitende einer App E-Mail-Berechtigungen wie `Mail.Read` und `Mail.ReadWrite` genehmigen. Statt des üblichen Einwilligungsbildschirms zeigt Microsoft **Need admin approval** an.',
        'Das legt Ihre Organisation fest, nicht Ihr Konto und nicht MCPEmails. Auch ein verifizierter Herausgeber kommt mit seiner App nicht daran vorbei, und manche Organisationen haben die Benutzereinwilligung für alle Apps abgeschaltet.',
        'Private Microsoft-Konten (Outlook.com, Hotmail, Live) haben keine Organisation und keinen Admin, deshalb sehen sie diesen Bildschirm nie.',
        `Für den eigenen Microsoft 365-Konnektor von Claude gilt dasselbe: Laut [Hilfeartikel von Anthropic](${CLAUDE_M365}) muss ein Globaler Administrator von Microsoft Entra einwilligen, bevor ihn jemand in der Organisation nutzen kann. Die Schritte unten gelten für MCPEmails, das das Postfach mit Claude, ChatGPT und anderen MCP-Clients verbindet.`,
      ],
    },
    {
      id: 'connecting',
      h: 'Wenn Sie Ihr Postfach verbinden',
      ordered: true,
      items: [
        'Öffnen Sie im Dashboard von MCPEmails **Postfächer**, dann **Postfach verbinden**, wählen Sie Outlook und klicken Sie auf **Mit Microsoft verbinden**.',
        'Antwortet Microsoft mit **Need admin approval**, kehren Sie zum Dashboard zurück. Dort steht, dass Ihre Organisation den Postfachzugriff freigeben muss, und Sie finden **Link für Ihre IT-Abteilung holen**. Die Outlook-Option im Verbindungsfenster bietet denselben Link unter **Genehmigungslink für Ihre IT-Abteilung holen**.',
        'Kopieren Sie den Link und schicken Sie ihn per E-Mail oder Chat an Ihre IT-Abteilung. Er ist 7 Tage gültig und kann mehrmals geöffnet werden. Ihr Admin braucht kein Konto bei MCPEmails.',
        'Sobald Ihr Admin genehmigt hat, klicken Sie erneut auf **Mit Microsoft verbinden**. Sie melden sich mit Ihrem eigenen Konto an, und das Postfach wird verbunden.',
      ],
    },
    {
      id: 'self-admin',
      h: 'Wenn Sie selbst der Admin sind',
      items: [
        'Klicken Sie im selben Dialog auf **Ich bin der Admin, jetzt genehmigen**. Die Genehmigungsseite von Microsoft öffnet sich in Ihrem Tab, und nach der Genehmigung kehren Sie zum Dashboard zurück, um das Postfach zu verbinden.',
        'Melden Sie sich auf dieser Seite mit einem Konto an, das eine der Rollen aus dem nächsten Abschnitt hat. Ein Benutzerkonto ohne Rolle kann nicht genehmigen, auch nicht in einem kleinen Mandanten.',
      ],
    },
    {
      id: 'admin',
      h: 'Wenn Sie der IT-Admin sind',
      items: [
        'Der Link öffnet die Seite von Microsoft selbst für die Administratoreinwilligung (`login.microsoftonline.com/organizations/v2.0/adminconsent`) für MCPEmails. Sie melden sich auf der Seite von Microsoft mit Ihrem geschäftlichen Microsoft-Konto an. MCPEmails sieht Ihr Passwort nie.',
        `Zum Genehmigen brauchen Sie eine Rolle, die mandantenweite Einwilligung für delegierte Berechtigungen erteilen darf. [Microsoft nennt](${MS_GRANT}) Administrator für privilegierte Rollen, Cloudanwendungsadministrator, Anwendungsadministrator und KI-Administrator, und ein Globaler Administrator kann es ebenfalls.`,
        'Prüfen Sie die Berechtigungen und stimmen Sie zu. Die Genehmigung gilt einmal für die ganze Organisation. Jede Person meldet sich beim Verbinden trotzdem mit ihrem eigenen Konto an und erhält nur Zugriff auf ihr eigenes Postfach.',
        'Danach landen Sie auf einer Seite von MCPEmails, die anzeigt, ob Microsoft die Genehmigung bestätigt hat. Mehr ist von Ihnen nicht nötig.',
        'Der Link selbst gewährt nichts. Er startet nur den Ablauf bei Microsoft, und in Ihrem Mandanten ändert sich nichts, bis Sie dort zustimmen.',
        `Lieber über das Admin Center? Wenn MCPEmails bereits unter **Entra ID**, **Enterprise apps**, **All applications** erscheint, öffnen Sie es, wählen Sie **Permissions** und klicken Sie auf **Grant admin consent**. [Die Anleitung von Microsoft](${MS_GRANT}) beschreibt diesen Weg.`,
      ],
    },
    {
      id: 'permissions',
      h: 'Was der Admin genehmigt',
      items: [
        '`Mail.ReadWrite` (delegiert): E-Mails im Postfach der angemeldeten Person lesen und ändern, damit die KI suchen, lesen, Entwürfe schreiben, verschieben, markieren, Ordner verwalten und löschen kann.',
        '`Mail.Send` (delegiert): E-Mails als die angemeldete Person senden. `Mail.ReadWrite` deckt das Senden nicht ab, deshalb ist es eine eigene Berechtigung.',
        '`offline_access`: die Verbindung ohne erneute Anmeldung aufrechterhalten, bis die Person sie trennt oder der Zugriff entzogen wird.',
        'Bei der Anmeldung jeder Person fragt MCPEmails außerdem nach `openid`, `profile` und `email`, um Name und Adresse zu lesen. Einwilligungsrichtlinien schränken diese Anmeldegrundlagen nicht ein, deshalb sind sie nicht Teil der Admin-Genehmigung.',
        'Jede Berechtigung ist delegiert. MCPEmails fragt nach keinen Anwendungsberechtigungen, handelt also nur für die angemeldete Person und kann keine anderen Postfächer in Ihrem Mandanten öffnen.',
        'Nachrichten werden für jede Anfrage live bei Microsoft abgerufen und nicht gespeichert. Das Token aus jeder Anmeldung wird verschlüsselt gespeichert, und die Daten liegen in Stockholm. Siehe [Sicherheit](/security).',
      ],
    },
    {
      id: 'control',
      h: 'Zugriff später einschränken oder entfernen',
      items: [
        `Damit sich nur bestimmte Personen verbinden können, schalten Sie für MCPEmails unter **Enterprise apps** die Option **Assignment required** ein und weisen die Benutzer oder Gruppen zu, die sich anmelden dürfen. [Die Anleitung von Microsoft](${MS_ASSIGN}) enthält die Schritte.`,
        'Um den Zugriff für die ganze Organisation zu entfernen, löschen oder deaktivieren Sie MCPEmails unter **Enterprise apps**.',
        'Jede Person kann ihr eigenes Postfach jederzeit trennen, indem sie es im Dashboard von MCPEmails löscht.',
      ],
    },
    {
      id: 'problems',
      h: 'Wenn es immer noch nicht klappt',
      items: [
        '**"Die Genehmigung hat nicht geklappt".** Microsoft hat die Genehmigung nicht bestätigt, Outlook bleibt also gesperrt. Der Admin öffnet den Link erneut und meldet sich mit einem Konto an, das eine der oben genannten Rollen hat.',
        '**"Nicht genehmigt".** Die Genehmigung wurde auf dem Bildschirm von Microsoft abgebrochen, und nichts hat sich geändert. Öffnen Sie den Link erneut, sobald Sie bereit sind.',
        '**"Dieser Link ist abgelaufen" oder "Dieser Link ist ungültig".** Links sind 7 Tage gültig und müssen vollständig kopiert werden. Holen Sie sich im Dashboard einen neuen.',
        '**"Bitte beginnen Sie erneut".** Die Genehmigung hat länger als 10 Minuten gedauert oder wurde in einem anderen Browser abgeschlossen. Öffnen Sie den Link erneut und schließen Sie den Vorgang in diesem Browser ab.',
        '**Kein Outlook-Postfach.** Ein Konto ohne Postfach in Exchange Online, etwa ein Admin-Konto ohne Exchange-Lizenz, hat nichts zu verbinden, deshalb lehnt MCPEmails es ab. Liegen Ihre E-Mails woanders, verbinden Sie sie stattdessen per IMAP.',
        '**Ein Anfrageformular statt der Genehmigungsseite.** Hat Ihre Organisation den Workflow für Administratoreinwilligungen von Microsoft eingeschaltet, sieht eine Person beim Verbinden womöglich ein Formular, um die Genehmigung anzufragen. Der Admin kann diese Anfrage genehmigen oder einfach den Link von MCPEmails öffnen.',
      ],
    },
  ],
  evidence: {
    h: 'Selbst nachprüfen',
    intro: 'MCPEmails ist Open Source. Diese Dateien erstellen den Link, starten die Genehmigung und legen die Berechtigungen fest, die diese Seite beschreibt:',
    labels: {
      link: 'Der signierte, sieben Tage gültige Genehmigungslink und die Ergebnisstatus',
      route: 'Die öffentliche Route, die der Link öffnet, und die Berechtigungen, um die sie den Admin bittet',
      oauth: 'Die Berechtigungen, die jede Person bei der Anmeldung erteilt, und wie eine "Need admin approval"-Antwort erkannt wird',
    },
  },
  cta: {
    title: 'Verbinden Sie Ihr Postfach bei Microsoft 365',
    sub: 'Ein Postfach ist kostenlos, für immer.',
    button: 'Jetzt starten',
    providers: 'Einrichtung für Microsoft 365',
  },
};

export default de;
