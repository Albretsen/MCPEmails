const translation = {
  title: 'ChatGPT mit E-Mail verbinden: Anleitung mit MCP (Gmail, Outlook, iCloud und IMAP)',
  description:
    'Schritt für Schritt: Gmail, Outlook, iCloud, Fastmail oder jedes IMAP-Postfach über einen benutzerdefinierten MCP-Konnektor mit ChatGPT verbinden, und mit OpenAI Codex über einen eingeschränkten Schlüssel. Keine E-Mail wird gespeichert.',
  coverAlt:
    'ChatGPT und OpenAI Codex mit Gmail, Outlook, iCloud, Fastmail und IMAP-E-Mail verbinden, mit MCP Emails',
  content: `ChatGPT kann ein Postfach nicht von sich aus erreichen. Es braucht einen MCP-Server vor Ihren E-Mails, und MCP Emails ist dieser Server: Sie verbinden ein Postfach einmal, geben ChatGPT eine einzige URL, und es erhält dieselben E-Mail-Tools, egal ob Ihre E-Mails bei Gmail, Outlook oder Microsoft 365, iCloud, Fastmail, Yahoo, Zoho oder auf einem selbst betriebenen IMAP-Server liegen.

Zwei Oberflächen von OpenAI sind beteiligt, und sie authentifizieren sich unterschiedlich. ChatGPT durchläuft einen OAuth-Ablauf im Browser, Sie müssen also keinen API-Schlüssel einfügen. OpenAI Codex läuft in Ihrem Terminal und nutzt stattdessen einen Bearer-Schlüssel mit eingeschränkten Berechtigungen. Gleicher Endpunkt, gleiche Tools.

**Direkt zu:** [Einrichtung in ChatGPT](#schritt-2-konnektor-in-chatgpt-hinzufügen) · [OpenAI Codex](#openai-codex-im-terminal) · [Fehlerbehebung](#fehlerbehebung)

## Was Sie brauchen

- **ChatGPT Plus, Pro, Business, Enterprise oder Edu, im Web.** Benutzerdefinierte MCP-Konnektoren liegen hinter dem Entwicklermodus, den OpenAI diesen Tarifen auf chatgpt.com anbietet. Mit Free- und Go-Konten lässt sich keiner hinzufügen, und die Mobil- und Desktop-Apps zeigen die Option nicht. Bei Business und Enterprise muss unter Umständen zuerst ein Admin den Entwicklermodus erlauben.
- **Ein kostenloses MCP-Emails-Konto.** [Hier erstellen](/signup). Der kostenlose Tarif umfasst ein verbundenes Postfach und braucht keine Karte.
- **Ein Postfach.** Gmail, Outlook oder Microsoft 365, iCloud, Fastmail, Yahoo, Zoho, Yandex oder alles, was IMAP und SMTP spricht.

Wenn Sie Free oder Go nutzen, funktionieren dasselbe Postfach und dieselbe URL bereits in [Claude](/docs/claude), [Cursor](/docs/cursor), [VS Code](/docs/vscode) und den anderen [unterstützten Clients](/docs/clients).

## Schritt 1: Postfach mit MCP Emails verbinden

Öffnen Sie im Dashboard von MCP Emails **Postfächer**, dann **Postfach verbinden**, und wählen Sie Ihren Anbieter.

### Gmail und Google Workspace

Gmail verbindet sich standardmäßig mit einem Google-App-Passwort über IMAP, die Anmeldung über Google OAuth ist ebenfalls möglich. Verwenden Sie das App-Passwort, wenn ein Workspace-Administrator den Zugriff von Drittanbieter-Apps einschränkt. Die [Gmail-Anleitung](/blog/connect-gmail-to-claude) enthält die Schritte.

### iCloud, Fastmail, Yahoo und Zoho

Diese Anbieter verlangen ein app-spezifisches Passwort, nicht das Passwort, das Sie im Web eingeben. Erstellen Sie eines beim Anbieter, wählen Sie den Anbieter in MCP Emails und fügen Sie es ein. Die [Anleitung für iCloud, Fastmail und IMAP](/blog/connect-icloud-fastmail-imap-to-claude) enthält die genauen Schritte.

### Outlook und Microsoft 365

Outlook verbindet sich über „Mit Microsoft anmelden“, nicht mit einem App-Passwort: Wählen Sie **Outlook**, klicken Sie auf **Mit Microsoft verbinden** und stimmen Sie zu. Private Konten bei Outlook.com, Hotmail, Live und MSN sind sofort verbunden. Bei Arbeits- oder Schulkonten von Microsoft 365 muss unter Umständen zuerst ein IT-Administrator die App einmal für die gesamte Organisation freigeben; das Dashboard gibt Ihnen dafür einen Link, den Sie weiterleiten können. Details stehen in der [Anleitung für Outlook und Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

### Jedes andere IMAP-Postfach

Wählen Sie **IMAP** und geben Sie Adresse und App-Passwort ein. Gängige Einstellungen werden automatisch erkannt; bei einer eigenen Domain brauchen Sie unter Umständen Host, Port und Sicherheitsmodus von Ihrem Anbieter. Die [Anbieter-Übersicht](/docs/providers) zeigt, was jeder Anbieter unterstützt, und unter [connect](/connect) gibt es eine Seite pro Anbieter, darunter [Gmail](/connect/gmail), [Outlook](/connect/outlook), [Microsoft 365](/connect/office365), [iCloud](/connect/icloud) und [allgemeines IMAP](/connect/imap).

Verbinden Sie mehr als ein Postfach, wenn Ihr Tarif das erlaubt. ChatGPT findet sie über \`inbox_list\`, Sie fügen also nie eine Postfach-ID in einen Prompt ein.

## Schritt 2: Konnektor in ChatGPT hinzufügen

1. Schalten Sie in den ChatGPT-Einstellungen unter **Apps und Konnektoren** in den erweiterten Einstellungen den **Entwicklermodus** ein.
2. Erstellen Sie einen neuen Konnektor und geben Sie ihm einen Namen.
3. Fügen Sie diese Konnektor-URL ein:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Wählen Sie **OAuth** als Authentifizierungsmethode, erstellen Sie den Konnektor und autorisieren Sie ihn dann bei MCP Emails.
5. Öffnen Sie einen neuen Chat, klicken Sie auf **+**, wählen Sie **Entwicklermodus** und dann die App MCP Emails. ChatGPT sieht die Tools nur in einem Chat, in dem Sie das getan haben, wiederholen Sie es also in jeder neuen Unterhaltung.

Wählen Sie OAuth, nicht „keine Authentifizierung“. Dieser Server lehnt anonyme Aufrufe ab. Ein Konnektor ohne Authentifizierung sieht bei der Einrichtung also gut aus und scheitert dann beim ersten Tool-Aufruf, was verwirrend ist. Mit OAuth registriert sich ChatGPT selbst und durchläuft einen Authorization-Code-Ablauf mit PKCE: keine Client-ID zu erstellen, nirgends ein Client-Secret. Die Menübezeichnungen ändern sich, während OpenAI an der Beta arbeitet. Den aktuellen Weg finden Sie auf der [Einrichtungsseite für ChatGPT](/docs/chatgpt).

## Schritt 3: Nur die nötigen Berechtigungen genehmigen

Der Zustimmungsbildschirm gehört uns, nicht OpenAI. Die erste Zustimmung beginnt bei \`read:email\`. Das reicht für Triage, Zusammenfassungen und das Finden von Dingen und schließt jede unumkehrbare Aktion aus, während Sie entscheiden, wie weit Sie gehen möchten. Die weiteren Berechtigungen sind \`send:email\`, \`search:email\` und \`manage:automations\`.

Zu wenig zu gewähren lässt sich beheben: Ein Aufruf, der eine Berechtigung braucht, die Ihrem Token fehlt, kommt als 403 mit einem Fehler wegen unzureichender Berechtigung zurück, sodass der Client für diese Berechtigung erneut um Zustimmung bitten und es nochmals versuchen kann. Der Inhaber eines Postfachs kann im Dashboard außerdem eine [Freigabe durch einen Menschen](/blog/approve-ai-agent-email-sends) verlangen. Dann wartet jedes Senden, Antworten, Weiterleiten, Senden eines Entwurfs und geplante Senden, bis eine Person es freigibt.

## Schritt 4: ChatGPT eine sichere erste Aufgabe geben

Beginnen Sie nur mit Lesen:

> Fassen Sie meine drei neuesten ungelesenen E-Mails zusammen und markieren Sie alles, was heute eine Antwort braucht. Senden, verschieben oder löschen Sie nichts.

ChatGPT sucht zuerst das Postfach und liest dann nur die Nachrichten, die es braucht. Wenn das funktioniert, probieren Sie:

- „Finden Sie die Rechnung von Stripe aus dem letzten Monat und nennen Sie mir den Betrag.“
- „Entwerfen Sie eine Antwort auf die letzte Nachricht von Alex, aber lassen Sie sie als Entwurf liegen.“
- „Zeigen Sie mir die Newsletter dieser Woche, die ich archivieren könnte, und warten Sie auf meine Bestätigung.“

Für wiederkehrende Abläufe beginnen Sie mit dem [Playbook zur Posteingangs-Triage](/blog/ai-agent-triage-summarize-inbox) oder der [Sammlung von Workflow-Prompts](/blog/ai-agent-email-workflows-and-prompts).

## Was ChatGPT nach der Verbindung kann

MCP Emails gibt ChatGPT gezielte Tools statt eines Passworts oder einer rohen IMAP-Verbindung:

- **Lesen und suchen:** \`email_read\` umfasst list, read, read_batch, search und attachment. Gmail-Suchen akzeptieren Operatoren wie \`from:\` und \`is:unread\`.
- **Senden, antworten und weiterleiten:** \`email_compose\` sendet über Ihren eigenen Anbieter und Ihre eigene Adresse.
- **Organisieren:** \`email_organize\`, \`email_search_and_move\` und \`email_delete\`.
- **Entwürfe, Ordner und Planung:** \`draft\`, \`draft_list\`, \`folder\`, \`folder_list\`, \`schedule\` und \`schedule_list\`.
- **Der Rest:** \`contact_search\`, \`signature_get\`, \`signature_set\`, dazu \`automation\` und \`automation_read\` für wiederkehrende Regeln.

Eine Grenze sollten Sie einplanen: MCP Emails arbeitet mit Abfragen. Es gibt keine Webhooks und keine vom Server ausgelösten Ereignisse, ChatGPT prüft also auf neue E-Mails, wenn Sie darum bitten, und nicht in dem Moment, in dem eine Nachricht eintrifft.

## OpenAI Codex im Terminal

Codex ist eine andere Oberfläche als die Konnektoren von ChatGPT, und der OAuth-Ablauf im Browser ist dort nicht der richtige Weg. Ein Terminal-Client authentifiziert sich stattdessen mit einem Bearer-Token:

1. Öffnen Sie im Dashboard **API-Schlüssel** und erstellen Sie einen Schlüssel. Wählen Sie nur die Berechtigungen aus, die dieser Agent braucht.
2. Kopieren Sie ihn sofort. Der Schlüssel sieht aus wie \`mcpe_\` gefolgt von 64 Hex-Zeichen und wird nur einmal angezeigt.
3. Registrieren Sie \`https://mcpemails.com/api/mcp\` in der MCP-Konfiguration von Codex als Streamable-HTTP-MCP-Server und übergeben Sie den Schlüssel als \`Authorization: Bearer\`-Header.

Verbindungen per Schlüssel und per OAuth treffen denselben Endpunkt und sehen denselben Tool-Katalog. Der einzige Unterschied ist, woher das Token stammt. Um den Endpunkt vorab zu prüfen, enthält die [Anleitung für rohes HTTP](/docs/curl) einen einzeiligen \`tools/list\`-Aufruf, und [OAuth oder API-Schlüssel](/blog/oauth-vs-api-keys-ai-email-access) erklärt, wann welcher Weg passt.

Schränken Sie den Schlüssel eng ein. Für einen Coding-Agenten ist Nur-Lese-Zugriff meist richtig: Einer, der einen Support-Verlauf zusammenfassen kann, ist nützlich, einer, der unbeaufsichtigt E-Mails senden kann, ist eine ganz andere Risikoklasse.

## Fehlerbehebung

- **Keine Option, einen benutzerdefinierten Konnektor zu erstellen.** Der Entwicklermodus erfordert Plus, Pro, Business, Enterprise oder Edu, auf chatgpt.com im Browser. Free- und Go-Konten haben ihn nicht. In einem Business- oder Enterprise-Workspace muss ein Admin ihn erlauben.
- **Der Konnektor scheitert beim ersten Tool-Aufruf.** Er wurde vermutlich ohne Authentifizierung erstellt. Löschen Sie ihn und erstellen Sie ihn mit OAuth neu.
- **Der Konnektor ist erstellt, aber ChatGPT antwortet, ohne Ihre E-Mails anzufassen.** Er ist in diesem Chat nicht eingeschaltet. Klicken Sie auf **+**, wählen Sie **Entwicklermodus** und die App MCP Emails, und fragen Sie dann erneut.
- **Der Anbieter lehnt Ihr Passwort ab.** Verwenden Sie ein vom Anbieter erzeugtes App-Passwort, nicht Ihr Passwort für die Anmeldung im Web. Manche Anbieter stellen eines erst aus, wenn die Zwei-Faktor-Authentifizierung aktiv ist.
- **Eine eigene IMAP-Verbindung läuft in ein Timeout.** Prüfen Sie Host, Port und TLS-Modus. Port 993 nutzt normalerweise implizites TLS, Port 143 normalerweise STARTTLS.
- **ChatGPT ist verbunden, sieht aber keine E-Mails.** Prüfen Sie, ob das Postfach im Dashboard aktiv ist, ob die Verbindung \`read:email\` hat, und bitten Sie ChatGPT, zuerst \`inbox_list\` aufzurufen.

## FAQ

**Kann ChatGPT meine E-Mails lesen und senden?**
Über einen benutzerdefinierten MCP-Konnektor, ja: lesen, suchen, senden, antworten, weiterleiten, organisieren und planen, jeweils beschränkt auf die Berechtigungen, die Sie bei der Einrichtung genehmigen.

**Brauche ich für ChatGPT einen API-Schlüssel?**
Nein. Wählen Sie OAuth, dann registriert sich ChatGPT selbst und schließt den Ablauf ab. API-Schlüssel sind für Clients gedacht, die keinen Ablauf im Browser durchlaufen können, etwa Codex und Skripte.

**Wird Codex genauso eingerichtet?**
Nein. Codex ist eine Terminal-Oberfläche und nutzt deshalb einen API-Schlüssel mit eingeschränkten Berechtigungen in einem \`Authorization: Bearer\`-Header statt des OAuth-Ablaufs im Browser. Gleicher Endpunkt, gleiche Tools.

**Werden meine E-Mails auf Ihren Servern gespeichert?**
Nein. Jede Nachricht wird für die Anfrage, die sie braucht, live von Ihrem Anbieter abgerufen und danach verworfen. Gespeichert bleibt nur die verschlüsselte Zugangsberechtigung für den Anbieter. [Warum es wichtig ist, E-Mails nie zu speichern](/blog/why-email-never-stored-matters), erklärt die Gründe.

**Was kostet es?**
Free umfasst ein verbundenes Postfach und 150 abrechenbare E-Mail-Aktionen pro Kalendermonat (UTC), wobei die ersten 3 Tage nicht mitzählen. Diese monatliche Obergrenze gilt für Workspaces, die am oder nach dem 2026-09-13 erstellt wurden; früher erstellte Workspaces sind ausgenommen. Kostenpflichtige Tarife bieten mehr Postfächer und heben die Obergrenze auf: siehe [Preise](/pricing).

## Nächster Schritt

[Kostenlos starten](/signup), ein Postfach verbinden, \`https://mcpemails.com/api/mcp\` zu ChatGPT hinzufügen und ChatGPT bitten, Ihre ungelesenen E-Mails zusammenzufassen. Die [Einrichtungsseite für ChatGPT](/docs/chatgpt) zeigt den aktuellen Klickpfad, die [Dokumentation](/docs) enthält die vollständige Tool-Referenz.`,
};

export default translation;
