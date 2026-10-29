const translation = {
  title: 'Gmail mit Claude verbinden: integrierter Konnektor oder MCP',
  description:
    'Gmail in etwa zwei Minuten über MCP mit Claude verbinden: ein Google-App-Passwort, eine Endpunkt-URL, kein API-Schlüssel, kein Code. Claude liest, durchsucht und sendet Ihre E-Mails live, und Ihre E-Mails werden nie gespeichert.',
  coverAlt:
    'Gmail in zwei Minuten über MCP mit Claude verbinden: ein Google-App-Passwort, eine Endpunkt-URL, keine E-Mail gespeichert',
  content: `Claude hat einen eigenen Gmail-Konnektor. Wenn Sie nur ein Gmail-Konto in Claude nutzen wollen, schalten Sie ihn in den Konnektor-Einstellungen von Claude ein, und Sie sind fertig. MCPEmails lohnt sich, wenn Sie mehr brauchen: Outlook, iCloud, Yahoo oder ein beliebiges IMAP-Postfach neben Gmail, mehrere Postfächer im selben Chat oder dasselbe Postfach in ChatGPT, Cursor und anderen MCP-Apps. Der Rest dieser Anleitung richtet das ein.

Um Gmail über MCPEmails mit Claude zu verbinden, erledigen Sie zwei Dinge: Sie verbinden Ihr Gmail-Postfach einmal im Dashboard von MCPEmails mit einem Google-App-Passwort, dann fügen Sie eine einzige Endpunkt-URL in die Konnektor-Einstellungen von Claude ein und bestätigen eine Anmeldung. Das ist alles: kein Code, kein SDK, kein API-Schlüssel. Es dauert etwa zwei Minuten, und Ihre E-Mails werden nie gespeichert: Jeder Lese- und Sendevorgang geht live an Gmail und wird verworfen, sobald Claude die Daten hat.

Dies ist die Anleitung nur für Gmail. Wenn Sie mehrere Postfächer oder einen anderen Anbieter nutzen, deckt die Anleitung [beliebige E-Mail in unter zwei Minuten verbinden](/blog/connect-email-to-ai-agent-under-2-minutes) auch Outlook, iCloud, Fastmail und IMAP ab.

## Was Sie brauchen

- Ein Konto bei **Gmail oder Google Workspace**.
- **Claude** im Web (claude.ai) oder in Claude Desktop. Jeder Claude-Tarif kann benutzerdefinierte Konnektoren hinzufügen, über die Claude mit MCP-Servern spricht. Der Free-Tarif erlaubt einen, Pro und Max haben keine Begrenzung.
- Ein kostenloses **MCPEmails**-Konto. Keine Kreditkarte, ein verbundenes Postfach, dauerhaft. [Kostenlos starten](/signup) und diesen Tab geöffnet lassen.

MCPEmails ist die Brücke dazwischen: Auf der einen Seite spricht es das Model Context Protocol mit Claude, auf der anderen spricht es mit Gmail über IMAP und SMTP. Wenn Sie den Hintergrund dazu wissen möchten, lesen Sie, [was ein MCP-E-Mail-Server eigentlich ist](/blog/what-is-an-mcp-email-server).

## Schritt 1: Gmail-Postfach verbinden

Öffnen Sie im Dashboard von MCPEmails **Postfächer → Postfach verbinden** und wählen Sie **Gmail**. Gmail verbindet sich standardmäßig mit einem Google-App-Passwort:

1. Aktivieren Sie die Bestätigung in zwei Schritten in Ihrem Google-Konto, falls sie noch nicht aktiv ist. Google bietet App-Passwörter nur für Konten an, bei denen sie eingeschaltet ist.
2. Rufen Sie **myaccount.google.com/apppasswords** auf und erstellen Sie ein App-Passwort. Es besteht aus 16 Kleinbuchstaben in vier Gruppen, die Leerzeichen spielen keine Rolle.
3. Geben Sie in MCPEmails Ihre vollständige Gmail-Adresse ein, fügen Sie das App-Passwort ein und klicken Sie auf **Postfach verbinden**. Die Verbindung wird gegen Gmail getestet, bevor sie gespeichert wird. Fertig.

Ihr normales Google-Passwort wird nie verwendet. Das App-Passwort ist eine separate Zugangsberechtigung, MCPEmails verschlüsselt es mit AES-256-GCM, und Sie können es jederzeit auf derselben Google-Seite widerrufen. Technisch verbindet sich das Postfach über IMAP und SMTP (\`imap.gmail.com\`).

### Bei einem Google-Workspace-Konto

Ein Google-Workspace-Administrator kann App-Passwörter für die gesamte Domain abschalten. Ist **myaccount.google.com/apppasswords** für Sie nicht verfügbar, bitten Sie Ihren Administrator, App-Passwörter einzuschalten. Auf der Seite [Gmail-Einstellungen und -Limits](/connect/gmail) finden Sie alle Gmail-spezifischen Details an einem Ort.

## Schritt 2: MCPEmails zu Claude hinzufügen

Richten Sie Claude jetzt auf denselben Endpunkt aus. Da Claude ein OAuth-Client ist, brauchen Sie überhaupt keinen API-Schlüssel: Sie fügen eine URL ein und bestätigen eine Anmeldung.

1. Öffnen Sie in **claude.ai oder Claude Desktop** **Anpassen → Konnektoren**.
2. Klicken Sie auf **+ Hinzufügen** und dann auf **Benutzerdefinierten Konnektor hinzufügen**.
3. Nennen Sie ihn MCPEmails und fügen Sie dies als Konnektor-URL ein:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Klicken Sie auf **Weiter**, prüfen Sie die erkannten Anmeldeeinstellungen (die Standardwerte passen) und klicken Sie auf **Hinzufügen**.
5. Melden Sie sich mit Ihrem MCPEmails-Konto an und genehmigen Sie die gewünschten Berechtigungen: \`read:email\`, \`send:email\` oder beide.
6. Klicken Sie in einem Chat unten links auf **+**, wählen Sie **Konnektoren** und schalten Sie MCPEmails ein.

In einem Team- oder Enterprise-Tarif fügt ein Owner den Konnektor einmal unter **Organisationseinstellungen → Konnektoren** hinzu. Mitglieder öffnen dann **Anpassen → Konnektoren**, suchen MCPEmails und klicken auf **Verbinden**.

Das ist die gesamte Client-Seite. Die Verbindung ist genau auf das beschränkt, was Sie genehmigt haben, und Sie können sie mit einem Klick im Dashboard widerrufen. Wenn Sie den Weg über API-Schlüssel verstehen möchten (für Clients ohne eingebautes OAuth, etwa Cline oder ein eigenes Skript), lesen Sie [OAuth oder API-Schlüssel für den E-Mail-Zugriff von KI](/blog/oauth-vs-api-keys-ai-email-access). Sie möchten auch ein anderes Postfach verbinden? Die [Schritt-für-Schritt-Anleitung für E-Mail in Claude](/blog/connect-claude-to-email) behandelt Outlook, iCloud, Fastmail und IMAP.

## Schritt 3: Claude den ersten Prompt geben

Testen Sie mit etwas Kleinem. Fragen Sie Claude:

> „Fassen Sie meine drei neuesten ungelesenen E-Mails zusammen.“

Im Hintergrund ruft Claude \`inbox_list\` auf, um Ihr verbundenes Gmail zu finden, dann \`email_read\`, um die Nachrichten aufzulisten und zu lesen. Wenn eine Antwort kommt, steht Ihre Verbindung. Probieren Sie danach:

- „Finden Sie die Rechnung von Stripe aus dem letzten Monat und nennen Sie mir den Betrag.“
- „Entwerfen Sie eine höfliche Antwort auf die letzte E-Mail meines Vermieters, aber senden Sie sie noch nicht.“
- „Archivieren Sie alle Newsletter dieser Woche in meinem Posteingang.“
- „Was habe ich im E-Mail-Verlauf mit Acme zugesagt?“

Für weitere Muster (tägliche Triage, automatische Zusammenfassungen und Aufräumroutinen) lesen Sie [die besten Möglichkeiten, Claude Ihr Postfach verwalten zu lassen](/blog/best-ways-to-let-claude-manage-your-inbox) und das [Playbook für Triage und Zusammenfassung](/blog/ai-agent-triage-summarize-inbox).

## Was Claude mit Ihrem Gmail kann

Nach der Verbindung arbeitet Claude mit einer kleinen Zahl zusammengefasster Tools und kann deshalb weit mehr als nur lesen:

- **Lesen und suchen:** \`email_read\` (auflisten, lesen und suchen nach Absender, Empfänger, Betreff, Ungelesen-Status oder Zeitraum).
- **Senden und antworten:** \`email_compose\` (senden, antworten, weiterleiten). Nachrichten gehen über Gmail als normale E-Mails von Ihrer eigenen Adresse hinaus, die Reputation Ihrer Domain bleibt also Ihre.
- **Organisieren:** \`email_organize\` (verschieben, kopieren, markieren, archivieren). Gmail-Labels erscheinen als Ordner: Eine Nachricht mit mehreren Labels taucht in mehreren Ordnern auf, Verschieben ändert ihre Labels, und Archivieren entfernt sie aus dem Posteingang.
- **Entwürfe, Ordner, Planung, Kontakte:** \`draft\`, \`folder\`, \`schedule\` und \`contact_search\` runden das Set ab.

Eines sollten Sie vorab wissen: MCPEmails arbeitet mit Abfragen. Es gibt keine Push-Webhooks, Claude reagiert also auf neue E-Mails, wenn Sie es zum Nachsehen auffordern, nicht in dem Moment, in dem eine Nachricht eintrifft. Für fast jeden Assistenten-Workflow ist das genau das richtige Modell.

## Ist es sicher, Gmail mit Claude zu verbinden?

Kurz gesagt: ja, und das Design ist darauf ausgelegt.

- **Ihre E-Mails werden nie gespeichert.** Texte, Betreffzeilen und Anhänge werden bei jedem Aufruf live abgerufen, an Claude übergeben und sofort verworfen. Pro Postfach bleibt nur die verschlüsselte Zugangsberechtigung gespeichert, Ihr App-Passwort. Hier steht, [warum „E-Mails werden nie gespeichert“ wirklich zählt](/blog/why-email-never-stored-matters).
- **Sie bestimmen die Berechtigungen.** Genehmigen Sie nur Lesezugriff, kann Claude schlicht nicht senden. Genehmigen Sie beides, können Sie trotzdem jeden Zugriff jederzeit widerrufen.
- **Kein Teilen von Passwörtern.** Ihr normales Google-Passwort erreicht MCPEmails nie. Ein App-Passwort ist eine separate Zugangsberechtigung, die Sie jederzeit unter myaccount.google.com/apppasswords widerrufen können, oder Sie löschen das Postfach in MCPEmails.

Das vollständige Bedrohungsmodell (was verschlüsselt ist, was ein Angreifer sehen würde und was nicht) steht in [Ist es sicher, einem KI-Agenten E-Mail-Zugriff zu geben?](/blog/is-it-safe-to-give-ai-agent-email-access)

## FAQ

**Brauche ich einen API-Schlüssel, um Gmail mit Claude zu verbinden?**
Nein. Claude unterstützt OAuth, Sie fügen also die Endpunkt-URL ein und bestätigen eine Anmeldung. API-Schlüssel sind nur für Clients ohne eingebautes OAuth gedacht.

**Speichert Claude meine Gmail-Nachrichten?**
Nein. E-Mails werden bei jeder Anfrage live von Gmail abgerufen und direkt verworfen, nachdem Claude sie gelesen hat. Gespeichert bleibt nur Ihre verschlüsselte Zugangsberechtigung (das App-Passwort).

**Kann Claude E-Mails von meinem Gmail senden?**
Ja, wenn Sie die Berechtigung \`send:email\` gewähren. Gesendet wird über Gmail als normale Nachricht von Ihrem eigenen Konto. Gewähren Sie nur Lesezugriff, wenn Claude nie senden soll.

**Funktioniert das mit dem kostenlosen Claude-Tarif?**
Ja. Im Free-Tarif von Claude können Sie einen benutzerdefinierten Konnektor hinzufügen, und das reicht für MCPEmails. Pro und Max haben keine Begrenzung. Die Seite von MCPEmails ist kostenlos und ohne Karte.

**Sieht MCPEmails mein Google-Passwort?**
Nein. Sie fügen ein App-Passwort ein, eine separate Zugangsberechtigung, die Google erzeugt und die Sie jederzeit widerrufen können. Ihr normales Google-Passwort wird nirgends in MCPEmails eingegeben.

## Fazit

Das ist alles: ein Google-App-Passwort, eine Endpunkt-URL, und Claude kann Ihre echten E-Mails lesen, durchsuchen und senden, ohne sie je zu speichern. Der Tarif Free kostet nichts, braucht keine Karte und verbindet ein Postfach; Personal kostet $9/Monat für bis zu drei Postfächer, und Pro verbindet bis zu 10 (siehe [Preise](/pricing)).

Bereit? [Verbinden Sie Ihr Gmail kostenlos](/signup), fügen Sie den Endpunkt in Claude ein und bitten Sie Claude, Ihre ungelesenen E-Mails zusammenzufassen.`,
};

export default translation;
