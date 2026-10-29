const translation = {
  title: 'Claude mit Apple Mail verbinden: iCloud, Gmail, Outlook, Yahoo',
  description:
    'Claude mit den Konten in Apple Mail verbinden (iCloud, Gmail, Outlook.com, Yahoo, IMAP): E-Mails lesen, durchsuchen, entwerfen und senden, auf jedem Gerät, auch auf dem iPhone.',
  coverAlt: 'Die Konten für iCloud, Gmail, Outlook und Yahoo aus Apple Mail, über MCP mit Claude verbunden',
  content: `Um Claude mit Apple Mail zu verbinden, verbinden Sie die E-Mail-Konten, die Apple Mail anzeigt, nicht die Mail-App selbst. Apple Mail ist ein Client: Es synchronisiert ein Konto bei iCloud, Gmail, Outlook.com, Yahoo oder einem anderen IMAP-Anbieter von dessen Servern. MCPEmails verbindet Claude serverseitig mit genau diesen Konten. Claude sieht also denselben Posteingang, dieselben Ordner, Entwürfe und gesendeten E-Mails wie Apple Mail, und das funktioniert auf claude.ai, in Claude Desktop und in der Claude-App auf Ihrem iPhone. Ihr Mac muss dafür nicht eingeschaltet sein.

## Kann sich Claude mit Apple Mail verbinden?

Ja, über die Konten darin. Apple Mail hat keinen eigenen Zugang, bei dem sich Claude anmelden könnte. Der zuverlässige Weg sieht so aus:

1. Prüfen Sie, welche Konten Apple Mail nutzt.
2. Verbinden Sie jedes Konto mit MCPEmails, einem gehosteten MCP-Server.
3. Fügen Sie MCPEmails mit einer einzigen URL als benutzerdefinierten Konnektor zu Claude hinzu.

Danach kann Claude in jedem verbundenen Konto E-Mails lesen, durchsuchen, entwerfen, senden, zeitversetzt senden und organisieren, im Rahmen des Zugriffs, den Sie gewähren. Die Änderungen erscheinen in Apple Mail auf Ihrem Mac und iPhone bei der nächsten Synchronisierung, denn beide greifen auf dasselbe Postfach zu.

## Warum Sie das Konto verbinden und nicht die Mail-App

Die MCP-Server für Apple Mail, die Sie auf GitHub finden, laufen auf Ihrem Mac und arbeiten über die Mail-App selbst, per AppleScript oder indem sie den lokalen Index von Mail auslesen. Das funktioniert, mit Grenzen, die sich aus dem Aufbau ergeben:

- Es läuft nur auf einem Mac, auf dem der Server installiert und Mail verfügbar ist.
- Claude auf Ihrem iPhone, auf einem Windows-PC oder im Web erreicht ihn nicht, denn die Verbindung liegt auf diesem einen Mac.
- Schläft der Mac oder ist er zugeklappt, ist der Server nicht erreichbar.

Ein benutzerdefinierter Konnektor in Claude funktioniert umgekehrt. Laut dem Hilfe-Center von Anthropic geht die Verbindung zu einem MCP-Server von den Servern von Anthropic aus, nicht von Ihrem Gerät, und zwar in jedem Claude-Client, die mobilen Apps eingeschlossen. Eine serverseitige Verbindung zu Ihrem E-Mail-Konto passt genau dazu: Es gibt nichts zu installieren, und derselbe Konnektor funktioniert überall, wo Sie Claude öffnen.

## Schritt 1: Nachsehen, welche Konten Apple Mail nutzt

- **Auf dem Mac:** Wählen Sie in Mail **Mail → Einstellungen** und klicken Sie dann auf **Accounts**.
- **Auf iPhone oder iPad:** Öffnen Sie **Einstellungen → Apps → Mail → Mail-Accounts**.

Jedes Konto in dieser Liste wird auf eine dieser Arten mit MCPEmails verbunden:

- **iCloud** (@icloud.com, @me.com, @mac.com): ein App-spezifisches Passwort von Apple. Einstellungen auf der [iCloud-Seite](/connect/icloud).
- **Google**: ein Google-App-Passwort. Einstellungen auf der [Gmail-Seite](/connect/gmail).
- **Outlook.com, Hotmail, Live oder Microsoft 365**: Anmeldung mit Microsoft. Bei einem Arbeits- oder Schulkonto muss Ihr IT-Admin MCPEmails eventuell einmal freigeben. Details auf der [Outlook-Seite](/connect/outlook).
- **Yahoo**: ein Yahoo-App-Passwort. Einstellungen auf der [Yahoo-Mail-Seite](/connect/yahoo).
- **Andere (IMAP)**: die IMAP- und SMTP-Einstellungen Ihres Anbieters. Siehe die [Seite für eigenes IMAP](/connect/imap).

Steht Ihr Anbieter nicht in dieser Liste, hat [jeder unterstützte Anbieter](/connect) eine eigene Seite mit den Servereinstellungen.

## Schritt 2: Jedes Konto mit MCPEmails verbinden

Legen Sie ein kostenloses [MCPEmails-Konto](/signup) an, öffnen Sie das Dashboard, gehen Sie zu **Postfächer → Postfach verbinden** und wählen Sie den Anbieter.

### iCloud Mail

Apple akzeptiert Ihr Apple-Account-Passwort nicht in anderen Apps. Sie brauchen ein App-spezifisches Passwort:

1. Melden Sie sich bei [account.apple.com](https://account.apple.com) an.
2. Wählen Sie unter **Anmelden und Sicherheit** die Option **App-spezifische Passwörter**.
3. Wählen Sie **App-spezifisches Passwort erstellen**, nennen Sie es \`MCPEmails\` und kopieren Sie das Passwort, das Apple anzeigt.
4. Wählen Sie in MCPEmails **iCloud**, geben Sie Ihre iCloud-Adresse ein und fügen Sie dieses Passwort ein.

Dafür muss Ihr Apple Account die Zwei-Faktor-Authentifizierung nutzen. Gut zu wissen: Wenn Sie das Passwort Ihres Apple Accounts ändern, werden alle App-spezifischen Passwörter widerrufen. Nach einer Passwortänderung erstellen Sie also ein neues und verbinden das Konto erneut. Mehr Details stehen in der [Anleitung für iCloud, Fastmail und IMAP](/blog/connect-icloud-fastmail-imap-to-claude).

### Gmail

Apple Mail meldet sich mit Ihrem Google-Konto bei Google an. MCPEmails nutzt stattdessen ein Google-App-Passwort über IMAP, das Google anbietet, sobald die Bestätigung in zwei Schritten aktiv ist. Wählen Sie **Gmail** und fügen Sie das Passwort aus 16 Buchstaben zusammen mit Ihrer Adresse ein. Die [Gmail-Anleitung](/blog/connect-gmail-to-claude) behandelt auch Workspace-Konten, bei denen ein Administrator App-Passwörter abgeschaltet hat.

### Outlook.com, Hotmail und Microsoft 365

Wählen Sie **Outlook** und klicken Sie auf **Mit Microsoft verbinden**. Sie müssen kein Passwort einfügen.

### Yahoo und andere IMAP-Konten

Erstellen Sie bei Ihrem Anbieter ein App-Passwort, wählen Sie **Yahoo** oder **IMAP / SMTP** und geben Sie Adresse und Passwort ein. Bei verbreiteten Anbietern werden die Servereinstellungen anhand der Adresse automatisch ausgefüllt.

Verbinden Sie jedes Apple-Mail-Konto, das Claude erreichen soll. Wie viele Postfächer Sie hinzufügen können, hängt von Ihrem [Tarif](/pricing) ab. Claude findet sie mit \`inbox_list\`. Sie müssen also nie eine Konto-ID in einen Prompt einfügen.

## Schritt 3: MCPEmails zu Claude hinzufügen

Auf claude.ai oder in Claude Desktop:

1. Öffnen Sie **Anpassen → Konnektoren**.
2. Klicken Sie auf **+ Hinzufügen** und dann auf **Benutzerdefinierten Konnektor hinzufügen**.
3. Geben Sie einen Namen ein, etwa \`MCPEmails\`, und fügen Sie die Konnektor-URL ein:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Gehen Sie mit **Weiter** durch die Schritte und klicken Sie auf **Hinzufügen**. Klicken Sie dann auf **Verbinden**, melden Sie sich bei MCPEmails an und legen Sie fest, wie viel Claude darf: **Nur-Lese-Zugriff**, **Standard** (zusätzlich Senden, Entwürfe und Kontakte), **Vollzugriff** (zusätzlich Ordner, zeitversetztes Senden und Löschen) oder **Benutzerdefiniert**.

Es gibt keinen API-Schlüssel und keine Konfigurationsdatei. Bei einem Team- oder Enterprise-Tarif fügt zuerst ein Owner den Konnektor unter **Organisationseinstellungen → Konnektoren** hinzu, danach klicken die Mitglieder dort auf **Verbinden**. Die [Claude-Einrichtungsseite](/docs/claude) beschreibt jeden Schritt und die häufigsten Fehler.

### Auf dem iPhone nutzen

Laut dem Hilfe-Center von Anthropic steht ein Konnektor, den Sie auf claude.ai oder in Claude Desktop hinzufügen, bei der nächsten Anmeldung in der Claude-App für iOS oder Android bereit. Fügen Sie ihn einmal im Web hinzu und fragen Sie Claude dann vom Handy aus nach Ihren E-Mails. Die Mail-App auf dem iPhone muss dafür nicht geöffnet sein, und Ihr Mac muss nicht laufen.

## Was Claude sieht und was nicht

Claude arbeitet mit der Serverkopie jedes Kontos, also mit der Kopie, die Apple Mail synchronisiert. Das bedeutet:

- **Ordner, die Sie für das Konto angelegt haben, sind sichtbar.** Ein Postfach, das Sie unter Ihrem iCloud- oder Gmail-Konto erstellt haben, liegt auf dem Server. Claude kann es also auflisten und durchsuchen und E-Mails hineinverschieben, wenn Sie Zugriff auf Ordner gewährt haben.
- **Entwürfe landen in Apple Mail.** Speichert Claude einen Entwurf, landet er im Ordner „Entwürfe“ dieses Kontos. Sie können ihn in Apple Mail öffnen, bearbeiten und selbst senden.
- **Gesendete E-Mails werden abgelegt.** Eine Nachricht, die Claude sendet, wird im Ordner „Gesendet“ des Kontos gespeichert, wie eine aus Apple Mail gesendete. Lehnt ein Mailserver diese Kopie ab, steht das im Ergebnis von Claude.
- **Postfächer unter „Auf meinem Mac“ sind nicht sichtbar.** Apple speichert sie nur auf dem Mac, auf dem Sie sie angelegt haben, daher kann keine Serververbindung sie sehen. Verschieben Sie alles, was Claude finden soll, in ein Postfach unter dem Konto.
- **POP-Konten sind unter Umständen unvollständig.** Ein Konto, das Apple Mail über POP abruft, hat ältere E-Mails nach dem Herunterladen auf den Mac womöglich vom Server gelöscht. MCPEmails verbindet sich über IMAP, Claude erreicht also nur, was noch auf dem Server liegt.

E-Mails werden bei jeder Anfrage live von Ihrem Anbieter abgerufen und von MCPEmails nicht gespeichert. Die einzige Ausnahme ist eine Nachricht, die Sie für später planen: Sie wird aufbewahrt, bis sie gesendet ist.

## Prompts zum Ausprobieren

Beginnen Sie mit etwas, das nur liest:

> „Fassen Sie meine ungelesenen E-Mails von heute in iCloud und Gmail zusammen. Eine Liste, bei jeder Nachricht das Konto, aus dem sie stammt.“

> „Finden Sie die Flugbestätigung, die ich letzten Monat bekommen habe, und nennen Sie mir die Buchungsnummer.“

> „Entwerfen Sie eine Antwort auf die letzte Nachricht meines Vermieters, aber senden Sie sie nicht. Ich mache sie in Apple Mail fertig.“

Weitere Routinen finden Sie unter [Möglichkeiten, Claude Ihr Postfach verwalten zu lassen](/blog/best-ways-to-let-claude-manage-your-inbox) und im [Playbook für die Posteingangs-Triage](/blog/ai-agent-triage-summarize-inbox). Wenn Sie mehrere Konten nutzen, zeigt [mehrere E-Mail-Konten mit KI verwalten](/blog/manage-multiple-email-accounts-with-ai), wie Antworten von der richtigen Adresse kommen.

## ChatGPT mit denselben Konten verbinden

Die Konnektor-URL ist ein normaler MCP-Server, daher kann auch ChatGPT dieselben Apple-Mail-Konten erreichen. Sie fügen ihn auf chatgpt.com als benutzerdefinierten MCP-Server hinzu; laut dem Hilfe-Center von OpenAI geht dieser Schritt nur im Web. Welche Tarife und Workspace-Rollen einen hinzufügen dürfen, ändert sich oft. Die [ChatGPT-Einrichtungsseite](/docs/chatgpt) hält deshalb die aktuellen Schritte bereit, und die [ChatGPT-E-Mail-Anleitung](/blog/connect-chatgpt-to-email) behandelt die häufigsten Fehler.

## Behalten Sie die Kontrolle

- **Gewähren Sie nur, was nötig ist.** Wählen Sie auf dem Zustimmungsbildschirm **Nur-Lese-Zugriff**, wenn Claude nie senden soll.
- **Prüfen Sie den Versand vorab.** Schalten Sie im Dashboard für ein Konto **Vor dem Senden prüfen** ein, dann wartet jede E-Mail, die von diesem Konto gesendet werden soll, auf Ihre Freigabe. Siehe [menschliche Freigabe für E-Mails von KI](/blog/approve-ai-agent-email-sends).
- **Widerrufen Sie jederzeit.** Entfernen Sie das App-spezifische Passwort unter account.apple.com, oder widerrufen Sie die Verbindung von Claude unter **API-Schlüssel** im Dashboard von MCPEmails.

Behandeln Sie jede E-Mail als nicht vertrauenswürdigen Text: Eine Nachricht kann Anweisungen enthalten, die sich an eine KI richten. Die [Anleitung zur Sicherheit beim E-Mail-Zugriff](/blog/is-it-safe-to-give-ai-agent-email-access) erklärt die Risiken, und die Seite [Sicherheit](/security) beschreibt, wie Zugangsdaten verschlüsselt und wo Daten gespeichert werden.

## FAQ

**Wie verbinde ich Claude mit Apple Mail?**
Verbinden Sie die Konten, die Apple Mail nutzt (iCloud, Gmail, Outlook.com, Yahoo oder IMAP), mit MCPEmails und fügen Sie dann \`https://mcpemails.com/api/mcp\` in Claude unter Anpassen → Konnektoren als benutzerdefinierten Konnektor hinzu. Claude liest und sendet dann aus diesen Konten, und die Ergebnisse erscheinen in Apple Mail.

**Brauche ich dafür einen Mac?**
Nein. Auf Ihrem Mac läuft nichts. Claude erreicht Ihre E-Mail-Konten über MCPEmails, das funktioniert also auf claude.ai, in Claude Desktop unter Windows oder auf dem Mac und in der Claude-App auf iPhone und Android.

**Funktioniert das mit Apple Mail auf dem iPhone?**
Ja. Die Mail-App Ihres iPhones und Claude arbeiten mit denselben Konten. Fügen Sie den Konnektor einmal auf claude.ai hinzu, dann steht er bei der nächsten Anmeldung in der Claude-App auf dem iPhone bereit.

**Warum wird mein Apple-Account-Passwort abgelehnt?**
iCloud akzeptiert von anderen Apps nur ein App-spezifisches Passwort. Erstellen Sie eines unter account.apple.com im Bereich Anmelden und Sicherheit und fügen Sie stattdessen dieses ein.

**Kann Claude meine Ordner unter „Auf meinem Mac“ sehen?**
Nein. Diese Postfächer gibt es nur auf Ihrem Mac. Verschieben Sie die Nachrichten in ein Postfach unter Ihrem iCloud- oder einem anderen Konto, dann kann Claude sie sehen.

**Werden meine E-Mails gespeichert?**
Nein. Jede Anfrage ruft E-Mails live von Ihrem Anbieter ab und verwirft sie danach. Ausnahmen sind Nachrichten, die Sie planen und die bis zum Versand aufbewahrt werden, sowie die verschlüsselten Zugangsdaten jedes Kontos, die MCPEmails speichert. Die vollständige Schritt-für-Schritt-Anleitung für jeden Anbieter steht in der [Anleitung, um Claude mit E-Mail zu verbinden](/blog/connect-claude-to-email).

## Nächster Schritt

[Kostenlos starten](/signup), Ihr iCloud-Konto verbinden, den Konnektor in Claude hinzufügen und Claude fragen, was heute eine Antwort braucht. Öffnen Sie dann Apple Mail, und Sie sehen denselben Posteingang, den Claude gerade gelesen hat.`,
};

export default translation;
