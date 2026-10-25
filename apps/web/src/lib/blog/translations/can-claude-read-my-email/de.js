const translation = {
  title: 'Kann Claude meine E-Mails lesen und senden? Postfach für Postfach',
  description:
    'Ja, bei Gmail und geschäftlichen Microsoft 365-Konten über die eigenen Konnektoren von Claude. Für Yahoo, iCloud, Outlook.com, IMAP-Postfächer und mehrere Anbieter gleichzeitig brauchen Sie einen MCP-Server.',
  coverAlt:
    'Claude liest und sendet E-Mails aus Postfächern bei Gmail, Microsoft 365, Yahoo, iCloud und IMAP',
  content: `**Ja, Claude kann Ihre E-Mails lesen und E-Mails senden, aber nur aus einem Postfach, das Sie mit Claude verbunden haben.** Claude hat zwei eigene E-Mail-Konnektoren, einen für Gmail und einen für geschäftliche Microsoft 365-Konten. Der Gmail-Konnektor liest, durchsucht und sendet und fragt standardmäßig vor jedem Versand nach Ihrer Zustimmung. Der Microsoft 365-Konnektor liest und durchsucht und kann erst senden, wenn ein Administrator seine Schreib-Tools einschaltet. Für Yahoo, iCloud, eine private Adresse bei Outlook.com, ein Firmenpostfach bei einem IMAP-Host oder mehrere Anbieter hinter einer Verbindung brauchen Sie einen MCP-Server wie MCPEmails.

Diese Seite klärt, welcher Fall auf Sie zutrifft. Die Angaben zu den Produkten von Anthropic und Google stammen von deren eigenen Seiten, gelesen im Oktober 2026. Diese Produkte ändern sich oft, deshalb verlinkt jeder Abschnitt die Seite, auf die er sich stützt.

**Direkt zu:** [Gmail](#gmail-der-eigene-konnektor-von-claude) · [Microsoft 365](#outlook-und-microsoft-365-nur-geschäftliche-konten) · [Was die integrierten Konnektoren nicht abdecken](#was-die-integrierten-konnektoren-nicht-abdecken) · [MCPEmails](#wie-mcpemails-die-lücke-schließt) · [FAQ](#faq)

## Gmail: der eigene Konnektor von Claude

Der Gmail-Konnektor ist im Konnektorverzeichnis von Claude mit Google als Hersteller aufgeführt und läuft auf dem Gmail-MCP-Server von Google (\`gmailmcp.googleapis.com\`). Sie schalten ihn in den Konnektor-Einstellungen von Claude ein und melden sich mit Ihrem Google-Konto an.

Was er kann, laut [Hilfeartikel von Anthropic](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors) und [Eintrag im Verzeichnis](https://claude.com/connectors/gmail):

- **Lesen und suchen.** Ihre E-Mails mit Fragen in normaler Sprache durchsuchen und ganze Konversationen lesen.
- **Entwerfen, senden, antworten und weiterleiten.** Der Artikel von Anthropic nennt alle vier.
- **Organisieren.** Mit Labels ordnen und Nachrichten oder Konversationen in den Papierkorb verschieben.
- **Vorher fragen.** Standardmäßig bittet Claude vor jedem Senden, Antworten oder Weiterleiten um Ihre Zustimmung. In den Tarifen Team und Enterprise muss ein Inhaber den Konnektor zuerst für die Organisation aktivieren und entscheidet, ob Mitglieder diese Aktionen ohne Rückfrage laufen lassen dürfen.

Wo er an Grenzen stößt:

- **Anhänge.** Laut Artikel von Anthropic sieht Claude nur die Metadaten eines Anhangs, nicht seinen Inhalt.
- **Ein Google-Konto.** Der Artikel beschreibt den Zugriff auf „the Google account you've connected“, also das verbundene Google-Konto, und erwähnt kein zweites.

Google dokumentiert denselben Gmail-MCP-Server außerdem als Teil seines [Workspace Developer Preview Program](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server). Mitglieder dieses Programms können ihn mit einem eigenen OAuth-Client aus Google Cloud selbst zu anderen MCP-Clients hinzufügen. Diese dokumentierte Version nennt Tools zum Suchen, zum Lesen von Konversationen, zum Erstellen von Entwürfen und zum Ändern von Labels, aber kein Tool zum Senden: Sie prüfen den Entwurf und senden ihn selbst aus Gmail.

Wenn Gmail Ihr einziges Postfach und Claude Ihre einzige KI-App ist, reicht der integrierte Konnektor vielleicht schon aus.

## Outlook und Microsoft 365: nur geschäftliche Konten

Der Microsoft 365-Konnektor von Claude liest Outlook-E-Mails von Konten, die zum Microsoft 365-Mandanten eines Unternehmens gehören.

- **Lesen und Suchen** umfassen Ihr Hauptpostfach, dessen Archivordner und freigegebene Postfächer, die Sie öffnen dürfen.
- **Senden ist standardmäßig deaktiviert.** Der Konnektor startet schreibgeschützt. Sobald die Schreib-Tools aktiviert sind, kann Claude E-Mails senden und weiterleiten sowie Entwürfe erstellen, bearbeiten und löschen. Nachrichten mit Anhängen lehnen die Schreib-Tools ab.
- **Ein Administrator muss zustimmen.** Ein Globaler Administrator von Microsoft Entra in Ihrer Organisation muss einwilligen, bevor sich dort jemand verbinden kann, und noch einmal, bevor die Schreib-Tools funktionieren.
- **Private Konten werden abgelehnt.** Der [Artikel von Anthropic](https://support.claude.com/en/articles/12542951-enabling-and-using-the-microsoft-365-connector) ist eindeutig: Adressen wie @outlook.com und @hotmail.com lassen sich für die Verbindung nicht verwenden.

Eine private Adresse bei Outlook.com, Hotmail oder Live hat also keinen integrierten Weg in Claude. [Claude mit Outlook.com und Hotmail verbinden](/blog/connect-claude-to-outlook-com-hotmail) zeigt den Weg, der funktioniert.

## Was die integrierten Konnektoren nicht abdecken

Legt man beide nebeneinander, erreicht keiner der integrierten Konnektoren diese Postfächer:

- **Yahoo Mail und AOL.**
- **iCloud Mail.**
- **Private Adressen bei Outlook.com, Hotmail und Live.**
- **Firmenpostfächer bei einem IMAP-Host**: Fastmail, Zoho Mail, IONOS, STRATO, ein cPanel-Hoster oder Ihr eigener Server.
- **Ein zweites Google-Konto.** Der Artikel von Anthropic beschreibt ein verbundenes Google-Konto und erwähnt nicht, wie man ein weiteres hinzufügt.
- **Mehrere Anbieter hinter einer Verbindung**, sodass eine einzige Frage info@, Ihre eigene Adresse und ein privates Gmail-Konto zusammen durchsucht.

Fastmail und Zoho Mail betreiben eigene MCP-Server, die Sie als benutzerdefinierte Konnektoren zu Claude hinzufügen können. Jeder davon erreicht nur die Postfächer seines eigenen Anbieters. Keiner der beiden Hilfeartikel von Claude erwähnt, dass sich ein Versand für später planen lässt. Der [Vergleich der integrierten Konnektoren von Claude und ChatGPT](/native-connectors-vs-mcp) führt jede Funktion mit Quelle und Prüfdatum auf.

## Wie MCPEmails die Lücke schließt

MCPEmails ist ein gehosteter MCP-Server. Sie verbinden jedes Postfach einmal damit, fügen dann eine einzige Konnektor-URL zu Claude hinzu, und Claude kann aus jedem verbundenen Postfach lesen, suchen und senden:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

- **Jeder Anbieter.** [Yahoo Mail](/connect/yahoo), [iCloud Mail](/connect/icloud), [privates Outlook.com](/connect/outlook) und [geschäftliches Microsoft 365](/connect/office365) (beide mit Anmeldung bei Microsoft), [Gmail](/connect/gmail) mit einem App-Passwort von Google, [Fastmail](/connect/fastmail) mit einem App-Passwort, [Zoho Mail](/connect/zoho) und jedes Postfach, das [IMAP und SMTP](/connect/imap) spricht. Die [vollständige Anbieterliste](/connect) hat für jeden Host eine Seite mit den Einstellungen.
- **Mehrere Postfächer in einem Chat.** Claude ruft \`inbox_list\` auf und sieht jede verbundene Adresse mit Namen, deshalb funktioniert „Durchsuche sales@ und mein Gmail“ in einer einzigen Unterhaltung. [Mehrere E-Mail-Konten in Claude](/blog/multiple-email-accounts-in-claude-and-chatgpt) erklärt diese Einrichtung.
- **Von der richtigen Adresse senden.** Jedes Postfach sendet über seinen eigenen Anbieter, mit eigenem Absendernamen und eigener Signatur.
- **Planen und organisieren.** Mit Vollzugriff kann Claude einen Versand für später planen und E-Mails in jedem verbundenen Postfach verschieben, kennzeichnen, archivieren oder löschen.
- **Anhänge lesen.** Claude kann [den Text aus einem PDF-, CSV- oder HTML-Anhang auslesen](/blog/extract-email-attachments-for-ai), ohne dass die Datei aufbewahrt wird.
- **Dieselben Postfächer in anderen Apps.** Es ist ein Standard-MCP-Server, dieselbe Einrichtung funktioniert also auch in ChatGPT, Cursor, VS Code und anderen MCP-Clients.

E-Mails werden für jede Anfrage live bei Ihrem Anbieter abgerufen und nicht gespeichert. Gespeichert bleiben: die verschlüsselten Zugangsdaten jedes Postfachs, eine geplante Nachricht bis zu ihrem Versand und ein zur Prüfung zurückgehaltener Versand, bis er freigegeben oder abgelehnt wird oder abläuft. Die Daten werden in Stockholm gespeichert.

### In Claude hinzufügen

1. [Kostenloses Konto bei MCPEmails erstellen](/signup) und unter **Postfächer** mit **Postfach verbinden** ein Postfach hinzufügen.
2. In claude.ai oder Claude Desktop \`https://mcpemails.com/api/mcp\` als benutzerdefinierten Konnektor hinzufügen.
3. Bei MCPEmails anmelden, wenn Claude danach fragt, und festlegen, wie viel Zugriff Claude bekommt: **Nur-Lese-Zugriff**, **Standard** (dazu Senden und Entwürfe) oder **Vollzugriff** (dazu Planen, Ordner und Löschen).

Die [Schritt-für-Schritt-Anleitung für Claude](/blog/connect-claude-to-email) geht jeden Bildschirm und jeden Anbieter durch, und die [Einrichtungsseite für Claude](/docs/claude) behandelt Fehler beim Konnektor.

## Kann Claude E-Mails senden, ohne zu fragen?

Das hängt vom Konnektor ab und von Ihnen.

- **Der Gmail-Konnektor von Claude** fragt standardmäßig vor jedem Senden, Antworten und Weiterleiten.
- **Der Microsoft 365-Konnektor von Claude** kann überhaupt nicht senden, bis die Schreib-Tools aktiviert sind.
- **MCPEmails** sendet nur, wenn Sie Claude beim Verbinden Zugriff zum Senden gegeben haben. Mit **Nur-Lese-Zugriff** kann Claude nicht senden. Für ein Postfach, bei dem jede ausgehende Nachricht geprüft werden soll, schalten Sie in den Einstellungen dieses Postfachs **Vor dem Senden prüfen** ein: Jeder Versand wartet dann, bis ein Inhaber oder Admin des Workspace ihn freigibt, der dazu im Browser bei MCPEmails angemeldet ist. Claude kann ihn nicht selbst freigeben. Siehe [menschliche Freigabe für E-Mails von KI-Agenten](/blog/approve-ai-agent-email-sends).

Welchen Weg Sie auch nutzen: Behandeln Sie den Inhalt einer E-Mail als Daten, nicht als Anweisungen. Eine Nachricht kann Text enthalten, der eine KI steuern soll, und ein Prüfschritt fängt ihn ab, bevor etwas Ihr Postfach verlässt. Der [Leitfaden zur Sicherheit beim E-Mail-Zugriff](/blog/is-it-safe-to-give-ai-agent-email-access) erklärt die Risiken genauer.

## FAQ

**Kann Claude meine E-Mails lesen?**
Ja, sobald ein Postfach verbunden ist. Gmail und geschäftliche Microsoft 365-Konten verbinden sich über die eigenen Konnektoren von Claude. Postfächer bei Yahoo, iCloud, privatem Outlook.com und IMAP verbinden sich über einen MCP-Server wie MCPEmails, den Sie als benutzerdefinierten Konnektor zu Claude hinzufügen.

**Kann Claude E-Mails senden?**
Ja. Der Gmail-Konnektor von Claude kann senden, antworten und weiterleiten und fragt standardmäßig vorher nach Ihrer Zustimmung. Der Microsoft 365-Konnektor kann senden, sobald die Schreib-Tools aktiviert sind. Über MCPEmails sendet Claude aus jedem verbundenen Postfach, wenn Sie beim Verbinden Zugriff zum Senden gegeben haben.

**Kann Claude mein Gmail lesen?**
Ja, mit dem integrierten Gmail-Konnektor von Claude, für das Google-Konto, das Sie verbinden. Um mehr als ein Google-Konto zu nutzen oder Gmail im selben Chat zusammen mit anderen Anbietern, verbinden Sie die Konten mit einem App-Passwort von Google über MCPEmails.

**Kann Claude auf meine E-Mails bei Outlook oder Hotmail zugreifen?**
Geschäfts- und Schulkonten bei Microsoft 365 können den Microsoft 365-Konnektor von Claude nutzen, nachdem ein Administrator ihn genehmigt hat. Private Adressen bei Outlook.com und Hotmail können das nicht. MCPEmails verbindet beide mit der Anmeldung bei Microsoft, wobei bei einem geschäftlichen Konto der IT-Administrator die App eventuell einmal für die Organisation freigeben muss.

**Kann Claude E-Mails bei Yahoo oder iCloud lesen?**
Nicht mit einem integrierten Konnektor. Verbinden Sie das Postfach mit einem App-Passwort von Yahoo oder Apple bei MCPEmails und fügen Sie MCPEmails dann zu Claude hinzu.

**Kann Claude mehrere E-Mail-Konten gleichzeitig lesen?**
Ja, über MCPEmails. Jedes Postfach, das Sie verbinden, erscheint in Claude über die eine Konnektor-URL, und Claude nennt bei jedem Aufruf das Postfach.

**Speichert MCPEmails meine E-Mails?**
Nein. Der Inhalt von Nachrichten wird bei jeder Anfrage live bei Ihrem Anbieter abgerufen und verworfen, sobald die Antwort gesendet ist. Unter [Sicherheit](/security) steht, was gespeichert wird.

## Nächster Schritt

Wenn alle Ihre E-Mails in einem Gmail-Konto liegen, probieren Sie zuerst den Gmail-Konnektor von Claude aus. Für alles andere: [kostenlos starten](/signup), ein Postfach verbinden, \`https://mcpemails.com/api/mcp\` zu Claude hinzufügen und Claude fragen, welche E-Mails heute eine Antwort brauchen.`,
};

export default translation;
