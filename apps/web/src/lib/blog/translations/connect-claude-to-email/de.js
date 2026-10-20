const translation = {
  title: 'Claude mit E-Mail verbinden: Anleitung mit MCP (Gmail, Outlook, iCloud und IMAP)',
  description:
    'Praktische Anleitung: So verbinden Sie Claude über MCP mit Gmail, Outlook und Microsoft 365, iCloud, Fastmail, Yahoo, Zoho oder jedem IMAP-Postfach. Ohne Code, und keine E-Mail wird gespeichert.',
  coverAlt:
    'Claude mit Gmail, Outlook, iCloud, Fastmail, Yahoo, Zoho und IMAP-E-Mail verbinden, mit MCP Emails',
  content: `Claude kann Ihre E-Mails lesen, durchsuchen, organisieren und senden, braucht dafür aber einen MCP-Server, um ein echtes Postfach zu erreichen. MCP Emails ist diese Brücke: Sie verbinden ein Postfach einmal, fügen Claude einen sicheren Endpunkt hinzu, und Claude erhält dieselben E-Mail-Tools für Gmail, Outlook und Microsoft 365, iCloud, Fastmail, Yahoo, Zoho und andere IMAP-Anbieter.

Sie schreiben keinen Code, installieren kein SDK und brauchen keinen API-Schlüssel, wenn Sie sich über den OAuth-Ablauf von Claude verbinden. E-Mails werden bei jeder Anfrage live von Ihrem Anbieter abgerufen und von MCP Emails nicht gespeichert.

**Direkt zu Ihrem Anbieter:** [Gmail](#gmail-und-google-workspace) · [iCloud](#icloud-mail) · [Fastmail](#fastmail) · [Outlook](#outlook-und-microsoft-365) · [Yahoo, Zoho, Yandex oder eigener IMAP-Server](#yahoo-zoho-yandex-und-eigener-imap-server)

## Was Sie brauchen

- Einen **Claude-Tarif oder eine Claude-App, die benutzerdefinierte Konnektoren unterstützt**.
- Ein kostenloses **MCP Emails**-Konto: [hier erstellen](/signup).
- Ein E-Mail-Postfach. Outlook verbindet sich über „Mit Microsoft anmelden“. Gmail, iCloud, Fastmail, Yahoo, Zoho und die meisten anderen Anbieter nutzen ein App-Passwort, und Gmail bietet zusätzlich „Mit Google anmelden“ an.

## Schritt 1: Postfach mit MCP Emails verbinden

Öffnen Sie im Dashboard von MCP Emails **Postfächer → Postfach verbinden** und wählen Sie Ihren Anbieter.

### Gmail und Google Workspace

Wählen Sie **Gmail**, erstellen Sie ein Google-App-Passwort (dafür braucht Ihr Google-Konto die Bestätigung in zwei Schritten) und fügen Sie es zusammen mit Ihrer Gmail-Adresse ein. Alternativ können Sie „Mit Google anmelden“ wählen. In beiden Fällen erhält MCP Emails nie Ihr normales Google-Passwort. Folgen Sie der [Gmail-Anleitung](/blog/connect-gmail-to-claude), wenn ein Workspace-Administrator den App-Zugriff steuert.

### iCloud Mail

Erstellen Sie in Ihrem Apple Account ein app-spezifisches Passwort, wählen Sie **iCloud** und geben Sie dieses Passwort ein, nicht Ihr normales Apple-Account-Passwort. Die [Anleitung für iCloud und IMAP](/blog/connect-icloud-fastmail-imap-to-claude) enthält die genauen Schritte beim Anbieter.

### Fastmail

Erstellen Sie in Fastmail ein App-Passwort mit Mail-Zugriff, wählen Sie **Fastmail** und fügen Sie es in MCP Emails ein. Bewahren Sie das erzeugte Passwort auf, bis der Verbindungstest erfolgreich war.

### Outlook und Microsoft 365

Outlook verbindet sich über „Mit Microsoft anmelden“, nicht mit einem App-Passwort: Wählen Sie **Outlook**, klicken Sie auf **Mit Microsoft verbinden** und stimmen Sie zu. Private Konten bei Outlook.com, Hotmail, Live und MSN sind sofort verbunden. Bei Arbeits- oder Schulkonten von Microsoft 365 muss unter Umständen zuerst ein IT-Administrator die App einmal für die gesamte Organisation freigeben; das Dashboard gibt Ihnen dafür einen Link, den Sie weiterleiten können. Details stehen in der [Anleitung für Outlook und Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

### Yahoo, Zoho, Yandex und eigener IMAP-Server

Erstellen Sie ein App-Passwort, wählen Sie **IMAP** und geben Sie Adresse und Passwort ein. Gängige Einstellungen werden automatisch erkannt; bei eigenen Domains brauchen Sie unter Umständen IMAP/SMTP-Host, Port und Sicherheitsmodus von Ihrem Anbieter.

Sie können mehr als ein Postfach verbinden. Claude findet sie über \`inbox_list\`, Sie müssen also keine Postfach-IDs in einen Prompt kopieren.

Sie brauchen Hilfe für einen bestimmten Anbieter? Lesen Sie die [Zwei-Minuten-Anleitung für mehrere Anbieter](/blog/connect-email-to-ai-agent-under-2-minutes), die eigene [Gmail-Anleitung](/blog/connect-gmail-to-claude) oder die [Anleitung für iCloud, Fastmail und IMAP](/blog/connect-icloud-fastmail-imap-to-claude).

## Schritt 2: MCP Emails zu Claude hinzufügen

In claude.ai oder Claude Desktop:

1. Öffnen Sie **Einstellungen → Konnektoren**.
2. Wählen Sie **Benutzerdefinierten Konnektor hinzufügen**.
3. Fügen Sie diese URL ein:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Wählen Sie **Verbinden**, melden Sie sich bei MCP Emails an und genehmigen Sie die gewünschten Berechtigungen: \`read:email\`, \`send:email\` oder beide.

Mehr ist auf der Claude-Seite nicht nötig. OAuth beschränkt die Verbindung auf die Berechtigungen, die Sie genehmigen, und Sie können sie jederzeit in MCP Emails widerrufen. Nutzen Sie einen Client ohne OAuth-Unterstützung, verwenden Sie stattdessen einen API-Schlüssel mit eingeschränkten Berechtigungen; [OAuth oder API-Schlüssel](/blog/oauth-vs-api-keys-ai-email-access) erklärt diesen Weg.

## Schritt 3: Claude eine sichere erste Aufgabe geben

Beginnen Sie mit einer reinen Leseanfrage:

> Fassen Sie meine drei neuesten ungelesenen E-Mails zusammen und markieren Sie alles, was heute eine Antwort braucht.

Claude sucht zuerst das verbundene Postfach, listet dann die relevanten Nachrichten auf und liest sie. Wenn das funktioniert, probieren Sie:

- „Finden Sie die Rechnung von Stripe aus dem letzten Monat und nennen Sie mir den Betrag.“
- „Entwerfen Sie eine Antwort auf die letzte Nachricht von Alex, aber senden Sie sie nicht.“
- „Zeigen Sie mir die Newsletter dieser Woche, die ich archivieren kann.“
- „Was habe ich im E-Mail-Verlauf mit Acme zugesagt?“

Für wiederkehrende Abläufe nutzen Sie das [Playbook zur Posteingangs-Triage](/blog/ai-agent-triage-summarize-inbox) oder die [Möglichkeiten, Claude Ihr Postfach verwalten zu lassen](/blog/best-ways-to-let-claude-manage-your-inbox).

## Was Claude nach der Verbindung kann

MCP Emails gibt Claude gezielte E-Mail-Tools statt eines Passworts oder einer rohen IMAP-Verbindung:

- **Lesen und suchen:** \`email_read\` listet Nachrichten auf, liest vollständige Nachrichten und durchsucht E-Mails. Gmail-Suchen unterstützen auch Gmail-Operatoren wie \`from:\` und \`is:unread\`.
- **Senden, antworten und weiterleiten:** \`email_compose\` sendet über Ihren eigenen Anbieter und Ihre eigene Adresse.
- **Organisieren:** \`email_organize\` verschiebt, labelt, markiert und archiviert Nachrichten.
- **Entwürfe, Ordner, Planung und Kontakte:** \`draft\`, \`folder\`, \`schedule\` und \`contact_search\` decken den Rest eines praktischen E-Mail-Workflows ab.

MCP Emails arbeitet mit Abfragen: Claude prüft auf neue E-Mails, wenn Sie darum bitten, und erhält kein Push-Ereignis in dem Moment, in dem eine E-Mail eintrifft.

## Fehlerbehebung bei Verbindung und Claude-Einrichtung

- **Der Anbieter lehnt das Passwort ab:** Verwenden Sie ein vom Anbieter erzeugtes App-Passwort, nicht das Passwort, mit dem Sie sich im Web anmelden. Erzeugen Sie es neu, nachdem Sie die Zwei-Faktor-Authentifizierung aktiviert haben, falls das verlangt wird.
- **Eine eigene IMAP-Verbindung läuft in ein Timeout:** Prüfen Sie IMAP/SMTP-Host, Port und TLS-Modus des Anbieters. Port 993 nutzt normalerweise implizites TLS, Port 143 normalerweise STARTTLS.
- **Claude ist verbunden, sieht aber keine E-Mails:** Prüfen Sie zuerst, ob das Postfach in MCP Emails aktiv ist, verbinden Sie Claude dann neu und genehmigen Sie **read:email**. Bitten Sie Claude, **inbox_list** aufzurufen, bevor es Nachrichten liest.
- **Claude kann lesen, aber nicht senden:** Verbinden Sie sich neu mit **send:email** und prüfen Sie, ob die Verbindung zum Anbieter SMTP oder das native Senden des Anbieters unterstützt.

Kommen Sie immer noch nicht weiter? Prüfen Sie in der [Anbieter-Übersicht](/docs/providers) die Funktionen, [öffnen Sie dann die Einrichtungsanleitung](/docs#quickstart) und testen Sie eine reine Leseanfrage, bevor Sie das Senden freischalten.

## Ist es sicher, Claude mit E-Mail zu verbinden?

Ja, sofern Sie der Verbindung nur den Zugriff geben, den sie braucht, und ein Mensch bei ausgehenden Aktionen beteiligt bleibt.

- **E-Mails werden nicht gespeichert.** MCP Emails ruft Nachrichteninhalte bei jedem Aufruf live ab und verwirft sie nach der Übergabe. Gespeichert bleibt nur die verschlüsselte Zugangsberechtigung, die für die erneute Verbindung zu Ihrem Anbieter nötig ist.
- **Ihr Anbieter behält die Kontrolle über die Authentifizierung.** Outlook und die Option „Mit Google anmelden“ bei Gmail nutzen OAuth, MCP Emails erhält also nie Ihr Passwort. Für das App-Passwort bei Gmail und andere IMAP-Anbieter verwenden Sie ein widerrufbares app-spezifisches Passwort statt Ihres normalen Passworts.
- **Berechtigungen sind ausdrücklich.** Geben Sie Nur-Lese-Zugriff, wenn Claude nie senden soll. Fügen Sie Sendezugriff nur hinzu, wenn Sie ihn brauchen, und widerrufen Sie jeden Zugriffsweg jederzeit.

Behandeln Sie jeden E-Mail-Text als nicht vertrauenswürdige Eingabe. Lassen Sie Claude erst einen Entwurf schreiben, bevor es sendet, prüfen Sie Nachrichten an Externe, und lassen Sie Anweisungen in einer E-Mail nie Ihre eigene Absicht übersteuern. Der [Sicherheitsleitfaden zum E-Mail-Zugriff](/blog/is-it-safe-to-give-ai-agent-email-access) erklärt das Bedrohungsmodell ausführlicher.

## FAQ

**Kann sich Claude mit Gmail, Outlook oder iCloud verbinden?**
Gmail verbindet sich mit einem Google-App-Passwort oder über „Mit Google anmelden“, Outlook über „Mit Microsoft anmelden“ und iCloud über ein app-spezifisches Passwort. Bei einem Arbeits- oder Schulkonto von Microsoft 365 muss unter Umständen zuerst ein IT-Administrator die App einmal freigeben. MCP Emails unterstützt außerdem Fastmail und allgemeines IMAP, womit auch Dienste wie Yahoo und Zoho abgedeckt sind.

**Brauche ich einen API-Schlüssel?**
Nein, nicht für den OAuth-Konnektor von Claude. Fügen Sie die Endpunkt-URL ein und melden Sie sich an. API-Schlüssel sind für MCP-Clients ohne eingebautes OAuth gedacht.

**Kann Claude E-Mails senden?**
Ja, wenn Sie \`send:email\` gewähren. Beginnen Sie mit Nur-Lese-Zugriff oder lassen Sie Claude zuerst Antwortentwürfe schreiben, wenn Sie einen Prüfschritt möchten.

**Speichert MCP Emails mein Postfach?**
Nein. Nachrichten werden live von Ihrem Anbieter gelesen und verworfen. MCP Emails speichert nur die verschlüsselte Zugangsberechtigung, die für diese Live-Anfragen nötig ist.

## Nächster Schritt

[Kostenlos starten](/signup), Postfach verbinden, \`https://mcpemails.com/api/mcp\` zu Claude hinzufügen und Claude bitten, Ihre ungelesenen E-Mails zusammenzufassen. Die vollständige Referenz der MCP-Tools und die Funktionen je Anbieter finden Sie in der [Dokumentation](/docs).`,
};

export default translation;
