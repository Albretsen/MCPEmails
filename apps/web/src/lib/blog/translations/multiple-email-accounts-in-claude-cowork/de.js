const translation = {
  title: 'Mehrere E-Mail-Konten in Claude Cowork, auch privates Outlook',
  description:
    'Claude Cowork erreicht über seinen Gmail-Konnektor ein Google-Konto, und sein Microsoft 365-Konnektor lehnt private Outlook-Adressen ab. So geben Sie einer Cowork-Aufgabe mehrere Postfächer, geschäftlich und privat.',
  coverAlt:
    'Geschäftliche und private E-Mail-Konten, darunter Gmail und Outlook.com, verbunden mit einer Aufgabe in Claude Cowork',
  content: `**Claude Cowork nutzt dieselben Konnektoren wie der Chat in Claude und hat deshalb dieselben Grenzen bei E-Mails: ein Google-Konto über den Gmail-Konnektor und über den Microsoft 365-Konnektor nur geschäftliche Microsoft 365-Konten.** Für eine private Adresse bei Outlook.com oder Hotmail, ein zweites Gmail-Konto oder ein Firmenpostfach bei einem IMAP-Host brauchen Sie einen benutzerdefinierten Konnektor. Mit einem MCP-Server wie MCPEmails gibt ein einziger benutzerdefinierter Konnektor einer Cowork-Aufgabe jedes Postfach, das Sie verbinden, jeweils mit Namen.

**Direkt zu:** [Integrierte Konnektoren](#was-die-integrierten-e-mail-konnektoren-von-cowork-erreichen) · [Mehrere Postfächer](#mehrere-postfächer-in-einer-cowork-aufgabe) · [Einrichtung](#einrichtung) · [Berechtigungen](#den-versand-unter-kontrolle-behalten) · [FAQ](#faq)

## Was die integrierten E-Mail-Konnektoren von Cowork erreichen

Im [Cowork-Leitfaden von Anthropic](https://support.claude.com/en/articles/13345190-get-started-with-cowork) werden Konnektoren auf derselben Seite **Anpassen → Konnektoren** verwaltet wie im Chat, und Chat und Cowork teilen sich in der Claude-App inzwischen ein gemeinsames Zuhause. Was Ihr Claude-Konto verbunden hat, kann auch eine Cowork-Aufgabe nutzen.

- **Gmail.** Der Gmail-Konnektor von Claude liest, durchsucht, entwirft und sendet. Der [Artikel von Anthropic](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors) beschreibt den Zugriff auf „the Google account you've connected“, also das verbundene Google-Konto, und sagt nichts darüber, wie man ein zweites hinzufügt. Ein privates und ein geschäftliches Gmail-Konto lassen sich darüber nicht nebeneinander nutzen.
- **Microsoft 365.** Der [Microsoft 365-Konnektor](https://support.claude.com/en/articles/12542951-enabling-and-using-the-microsoft-365-connector) ist für Konten im Microsoft 365-Mandanten eines Unternehmens gedacht. Ein Globaler Administrator muss zuerst einwilligen, der Konnektor startet schreibgeschützt, und private Microsoft-Konten wie @outlook.com und @hotmail.com können sich nicht verbinden.
- **Alles andere.** Für Yahoo, iCloud, Fastmail, Zoho, IONOS oder Ihren eigenen Mailserver gibt es keinen integrierten Konnektor in Claude.

Die übliche Mischung, ein geschäftliches Postfach plus ein privates Outlook.com oder ein zweites Gmail-Konto, passt mit den integrierten Konnektoren allein also nicht in Cowork.

## Mehrere Postfächer in einer Cowork-Aufgabe

[Benutzerdefinierte Konnektoren](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) sind entfernte MCP-Server, und laut Anthropic sind sie in Claude, Cowork und Claude Desktop verfügbar. Claude erreicht sie aus der Cloud von Anthropic, was für Cowork eine Folge hat: Ein lokaler MCP-Server, den Sie in \`claude_desktop_config.json\` eingerichtet haben, ist dort nicht verfügbar. Der Server muss im Internet erreichbar sein.

MCPEmails ist ein gehosteter MCP-Server, das ist also bereits der Fall. Sie verbinden jedes Postfach einmal damit, fügen eine einzige URL zu Claude hinzu, und jedes Postfach steht Ihren Cowork-Aufgaben zur Verfügung:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

- **Jede Mischung von Anbietern.** [Gmail und Google Workspace](/connect/gmail) mit einem App-Passwort von Google, [privates Outlook.com, Hotmail und Live](/connect/outlook) und [geschäftliches Microsoft 365](/connect/office365) mit der Anmeldung bei Microsoft, [iCloud](/connect/icloud), [Yahoo](/connect/yahoo), [Fastmail](/connect/fastmail), [Zoho](/connect/zoho) und jedes Postfach, das [IMAP und SMTP](/connect/imap) spricht.
- **Jedes Postfach mit Namen.** Die Aufgabe ruft \`inbox_list\` auf und sieht jede verbundene Adresse mit ihrem Anzeigenamen, deshalb braucht „prüfe info@ und mein Outlook“ keine weitere Einrichtung.
- **Antworten von der richtigen Adresse.** Jedes Postfach sendet über seinen eigenen Anbieter, mit eigenem Absendernamen und eigener Signatur.
- **Nicht gespeichert.** E-Mails werden für jede Anfrage live bei Ihrem Anbieter abgerufen und nicht auf unseren Servern aufbewahrt.

Eine private Adresse bei Outlook.com verbindet sich mit der Anmeldung bei Microsoft und braucht keinen Admin. Bei einem geschäftlichen Microsoft 365-Konto muss eventuell ein IT-Admin MCPEmails einmal für die Organisation freigeben; [Admin-Genehmigung für Microsoft 365](/docs/microsoft-365-admin-consent) erklärt, was er genehmigt, und gibt ihm den Link.

## Einrichtung

1. **Ihre Postfächer verbinden.** [Kostenloses Konto bei MCPEmails erstellen](/signup), **Postfächer** öffnen, dann **Postfach verbinden**, einmal pro Postfach. Geben Sie jedem einen klaren Anzeigenamen wie „Privates Outlook“ oder „Acme Vertrieb“: Daran unterscheidet Claude die Postfächer.
2. **Den Konnektor zu Claude hinzufügen.** Öffnen Sie **Anpassen → Konnektoren**, klicken Sie auf **+ Hinzufügen** und dann auf **Benutzerdefinierten Konnektor hinzufügen**. Geben Sie den Namen MCPEmails und \`https://mcpemails.com/api/mcp\` ein, klicken Sie auf **Weiter**, übernehmen Sie die erkannten Anmeldeeinstellungen und klicken Sie auf **Hinzufügen**. In Team und Enterprise fügt ein Inhaber ihn hinzu, und Mitglieder klicken auf **Verbinden**.
3. **Anmelden und den Zugriff wählen.** **Nur-Lese-Zugriff** für Aufgaben, die nur lesen, **Standard**, um Entwürfe und Senden hinzuzufügen, oder **Vollzugriff**, um Planen, Ordner und Löschen hinzuzufügen.
4. **In Cowork einschalten.** Öffnen Sie in einer Aufgabe das Menü **+** und schalten Sie MCPEmails bei den Konnektoren ein.

Die [Einrichtungsanleitung für Claude](/blog/connect-claude-to-email) zeigt jeden Bildschirm, und [benutzerdefinierte Konnektoren in Claude erklärt](/blog/claude-custom-connectors-explained) behandelt, was ein benutzerdefinierter Konnektor kann und was nicht.

Cowork selbst gibt es in den Tarifen Pro, Max, Team und Enterprise von Claude. Der Free-Tarif von MCPEmails verbindet ein Postfach; für mehrere Postfächer brauchen Sie einen bezahlten Tarif, aufgeführt auf der [Preisseite](/pricing).

## Den Versand unter Kontrolle behalten

Eine Cowork-Aufgabe arbeitet viele Schritte selbstständig ab, legen Sie also vorher fest, was sie ohne Rückfrage tun darf.

- **In Claude.** Laut Cowork-Leitfaden von Anthropic können Sie jedes Konnektor-Tool auf **Immer zulassen**, **Genehmigung erforderlich** oder **Blockiert** stellen. Stellen Sie die Tools von MCPEmails zum Senden auf **Genehmigung erforderlich**, hält Claude vor jedem Versand an. In Team und Enterprise kann Ihre Organisation für Schreib-Tools ohnehin eine Genehmigung verlangen.
- **In MCPEmails.** Schalten Sie für ein Postfach **Vor dem Senden prüfen** ein und wählen Sie die Art: **Zuerst im Chat fragen** lässt Claude Ihnen die E-Mail zeigen und auf Ihr Ja warten, und **Auf mcpemails.com freigeben** hält jeden Versand zurück, bis ein angemeldeter Inhaber oder Admin des Workspace ihn freigibt, was Claude nicht für Sie tun kann. Siehe [menschliche Freigabe für E-Mails von KI-Agenten](/blog/approve-ai-agent-email-sends).
- **Zuerst ein Entwurf.** Wenn Sie um eine E-Mail bitten, weist MCPEmails Claude an, sie als Entwurf in diesem Postfach zu speichern, wo Sie sie lesen und bearbeiten können, bevor etwas gesendet wird.

E-Mails schreiben andere Leute, und manche davon sind darauf angelegt, eine KI zu steuern. Eine Aufgabe, die E-Mails liest und auch senden kann, sollte eine dieser Prüfungen eingeschaltet haben.

## Prompts für mehrere Postfächer

> Geh mit MCPEmails mein geschäftliches Postfach und mein privates Outlook durch und liste alles aus den letzten zwei Tagen auf, das eine Antwort von mir braucht. Eine Liste, jede Zeile mit dem Postfach markiert. Nichts senden oder verschieben.

> Finde mit MCPEmails die Flugbestätigung für nächste Woche. Durchsuche jedes verbundene Postfach und sag mir, in welchem sie liegt.

> Entwirf mit MCPEmails eine Antwort von sales@ auf die neueste Anfrage und speichere sie als Entwurf. Nicht senden.

Wenn Sie dieselbe Zusammenfassung jeden Morgen ohne Nachfragen möchten, legen Sie den ersten Prompt auf einen Zeitplan: [Tägliche E-Mail-Übersicht mit Claude und ChatGPT](/blog/daily-email-briefing-with-claude-and-chatgpt) behandelt die geplanten Aufgaben von Claude. [Mehrere E-Mail-Konten in Claude und ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) behandelt dieselbe Einrichtung im Chat von Claude und in ChatGPT.

## FAQ

**Kann Claude Cowork zwei Gmail-Konten nutzen?**
Nicht über den integrierten Gmail-Konnektor von Claude, der laut Anthropic das eine verbundene Google-Konto erreicht. Verbinden Sie beide Konten mit App-Passwörtern von Google bei MCPEmails und fügen Sie MCPEmails als benutzerdefinierten Konnektor hinzu; eine Cowork-Aufgabe sieht dann beide.

**Kann Cowork meine privaten E-Mails bei Outlook.com oder Hotmail lesen?**
Nicht mit dem Microsoft 365-Konnektor von Claude, der private Microsoft-Konten ablehnt. Verbinden Sie die Adresse mit der Anmeldung bei Microsoft mit MCPEmails und fügen Sie MCPEmails dann zu Claude hinzu. [Claude mit Outlook.com und Hotmail verbinden](/blog/connect-claude-to-outlook-com-hotmail) enthält die Schritte.

**Funktionieren benutzerdefinierte Konnektoren in Cowork?**
Ja. Laut Anthropic sind benutzerdefinierte Konnektoren in Claude, Cowork und Claude Desktop verfügbar. Es müssen entfernte Server sein, die im Internet erreichbar sind; ein lokaler Server aus der Konfigurationsdatei der Desktop-App ist in Cowork nicht verfügbar.

**Brauche ich einen Konnektor pro Postfach?**
Nein. Ein Konnektor von MCPEmails deckt jedes Postfach in Ihrem Workspace ab, und dieselbe URL funktioniert im Chat von Claude, in Cowork, in ChatGPT und in anderen MCP-Clients.

**Kann Claude aus Cowork E-Mails senden?**
Ja, aus jedem Postfach, das Sie mit Standard oder Vollzugriff verbunden haben. [Kann Claude meine E-Mails lesen und senden?](/blog/can-claude-read-my-email#kann-claude-e-mails-senden) vergleicht, wie jeder Konnektor mit dem Senden umgeht.

## Nächster Schritt

[Kostenlos starten](/signup), das Postfach verbinden, das Sie am häufigsten prüfen, MCPEmails zu Claude hinzufügen und eine Cowork-Aufgabe fragen, was heute eine Antwort braucht. Fügen Sie die anderen Postfächer hinzu, wenn Sie eine Antwort statt mehrerer wollen.`,
};

export default translation;
