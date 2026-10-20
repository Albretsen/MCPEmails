const translation = {
  title: 'Gmail mit Claude verbinden: in 2 Minuten, ohne Code',
  description:
    'Gmail in etwa zwei Minuten über MCP mit Claude verbinden: ein Google-App-Passwort (oder „Mit Google anmelden“), eine Endpunkt-URL, kein API-Schlüssel, kein Code. Claude liest, durchsucht und sendet Ihre E-Mails live, und Ihre E-Mails werden nie gespeichert.',
  coverAlt:
    'Gmail in zwei Minuten über MCP mit Claude verbinden: ein Google-App-Passwort, eine Endpunkt-URL, keine E-Mail gespeichert',
  content: `Um Gmail mit Claude zu verbinden, erledigen Sie zwei Dinge: Sie verbinden Ihr Gmail-Postfach einmal im Dashboard von MCP Emails mit einem Google-App-Passwort, dann fügen Sie eine einzige Endpunkt-URL in die Konnektor-Einstellungen von Claude ein und bestätigen eine Anmeldung. Das ist alles: kein Code, kein SDK, kein API-Schlüssel. Es dauert etwa zwei Minuten, und Ihre E-Mails werden nie gespeichert: Jeder Lese- und Sendevorgang geht live an Gmail und wird verworfen, sobald Claude die Daten hat.

Dies ist die Anleitung nur für Gmail. Wenn Sie mehrere Postfächer oder einen anderen Anbieter nutzen, deckt die Anleitung [beliebige E-Mail in unter zwei Minuten verbinden](/blog/connect-email-to-ai-agent-under-2-minutes) auch Outlook, iCloud, Fastmail und IMAP ab.

## Was Sie brauchen

- Ein Konto bei **Gmail oder Google Workspace**.
- Eine Version von **Claude, die benutzerdefinierte Konnektoren unterstützt**: claude.ai mit einem kostenpflichtigen Tarif oder Claude Desktop. (Über Konnektoren spricht Claude mit MCP-Servern.)
- Ein kostenloses **MCP Emails**-Konto. Keine Kreditkarte, ein verbundenes Postfach, dauerhaft. [Kostenlos starten](/signup) und diesen Tab geöffnet lassen.

MCP Emails ist die Brücke dazwischen: Auf der einen Seite spricht es das Model Context Protocol mit Claude, auf der anderen spricht es mit Gmail, standardmäßig über IMAP oder über die Gmail API, wenn Sie sich mit Google anmelden. Wenn Sie den Hintergrund dazu wissen möchten, lesen Sie, [was ein MCP-E-Mail-Server eigentlich ist](/blog/what-is-an-mcp-email-server).

## Schritt 1: Gmail-Postfach verbinden

Öffnen Sie im Dashboard von MCP Emails **Postfächer → Postfach verbinden** und wählen Sie **Gmail**. Gmail verbindet sich standardmäßig mit einem Google-App-Passwort:

1. Aktivieren Sie die Bestätigung in zwei Schritten in Ihrem Google-Konto, falls sie noch nicht aktiv ist. Google bietet App-Passwörter nur für Konten an, bei denen sie eingeschaltet ist.
2. Rufen Sie **myaccount.google.com/apppasswords** auf und erstellen Sie ein App-Passwort. Es besteht aus 16 Kleinbuchstaben in vier Gruppen, die Leerzeichen spielen keine Rolle.
3. Geben Sie in MCP Emails Ihre vollständige Gmail-Adresse ein, fügen Sie das App-Passwort ein und klicken Sie auf **Postfach verbinden**. Die Verbindung wird gegen Gmail getestet, bevor sie gespeichert wird. Fertig.

Ihr normales Google-Passwort wird nie verwendet. Das App-Passwort ist eine separate Zugangsberechtigung, MCP Emails verschlüsselt es mit AES-256-GCM, und Sie können es jederzeit auf derselben Google-Seite widerrufen. Technisch verbindet sich das Postfach über IMAP und SMTP (\`imap.gmail.com\`).

### Lieber mit Google anmelden?

Das Verbindungsfenster bietet noch einen zweiten Weg: Öffnen Sie **Lieber mit Google anmelden?** und klicken Sie auf **Mit Google verbinden**. Sie wählen Ihr Konto auf der Seite von Google und genehmigen Lese- und Sendezugriff. Google zeigt zuerst einen Warnhinweis, weil Google die App nicht überprüft hat. Um fortzufahren, klicken Sie auf **Erweitert** und dann auf den Link, der zu mcpemails.com weiterführt.

### Welchen Weg Sie wählen sollten

Beide Wege funktionieren weiterhin, und Ihre Wahl entscheidet, was Claude danach kann:

- **App-Passwort (IMAP):** Gmail-Labels erscheinen als Ordner, die Suche nutzt die IMAP-Textsuche, und Claude kann Nachrichten kopieren und endgültig löschen.
- **Mit Google anmelden (Gmail API):** Claude arbeitet mit echten Gmail-Labels und kann mit Gmail-Operatoren wie \`from:\`, \`is:unread\` und \`after:\` suchen. Löschen verschiebt E-Mails in den Papierkorb.

Bei einem Google-Workspace-Konto kann ein Administrator App-Passwörter für die gesamte Domain abschalten oder Drittanbieter-Apps beim Weg über die Google-Anmeldung blockieren. Ist ein Weg gesperrt, versuchen Sie den anderen oder fragen Sie Ihren Administrator. Auf der Seite [Gmail-Einstellungen und -Limits](/connect/gmail) finden Sie alle Gmail-spezifischen Details an einem Ort.

## Schritt 2: MCP Emails zu Claude hinzufügen

Richten Sie Claude jetzt auf denselben Endpunkt aus. Da Claude ein OAuth-Client ist, brauchen Sie überhaupt keinen API-Schlüssel: Sie fügen eine URL ein und bestätigen eine Anmeldung.

1. Öffnen Sie in **claude.ai oder Claude Desktop** **Einstellungen → Konnektoren**.
2. Klicken Sie auf **Benutzerdefinierten Konnektor hinzufügen**.
3. Fügen Sie dies als Konnektor-URL ein und klicken Sie auf **Hinzufügen**:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Klicken Sie auf **Verbinden**, melden Sie sich mit Ihrem MCP-Emails-Konto an und genehmigen Sie die gewünschten Berechtigungen: \`read:email\`, \`send:email\` oder beide.

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

- **Lesen und suchen:** \`email_read\` (auflisten, lesen, Volltextsuche, mit Gmail-Operatoren, wenn Sie sich mit Google angemeldet haben).
- **Senden und antworten:** \`email_compose\` (senden, antworten, weiterleiten). Nachrichten gehen über Gmail als normale E-Mails von Ihrer eigenen Adresse hinaus, die Reputation Ihrer Domain bleibt also Ihre.
- **Organisieren:** \`email_organize\` (verschieben, markieren, archivieren und Labels beim Weg über die Google-Anmeldung).
- **Entwürfe, Ordner, Planung, Kontakte:** \`draft\`, \`folder\`, \`schedule\` und \`contact_search\` runden das Set ab.

Eines sollten Sie vorab wissen: MCP Emails arbeitet mit Abfragen. Es gibt keine Push-Webhooks, Claude reagiert also auf neue E-Mails, wenn Sie es zum Nachsehen auffordern, nicht in dem Moment, in dem eine Nachricht eintrifft. Für fast jeden Assistenten-Workflow ist das genau das richtige Modell.

## Ist es sicher, Gmail mit Claude zu verbinden?

Kurz gesagt: ja, und das Design ist darauf ausgelegt.

- **Ihre E-Mails werden nie gespeichert.** Texte, Betreffzeilen und Anhänge werden bei jedem Aufruf live abgerufen, an Claude übergeben und sofort verworfen. Pro Postfach bleibt nur die verschlüsselte Zugangsberechtigung gespeichert: Ihr App-Passwort oder das OAuth-Token, wenn Sie sich mit Google angemeldet haben. Hier steht, [warum „E-Mails werden nie gespeichert“ wirklich zählt](/blog/why-email-never-stored-matters).
- **Sie bestimmen die Berechtigungen.** Genehmigen Sie nur Lesezugriff, kann Claude schlicht nicht senden. Genehmigen Sie beides, können Sie trotzdem jeden Zugriff jederzeit widerrufen.
- **Kein Teilen von Passwörtern.** Ihr normales Google-Passwort erreicht MCP Emails nie. Ein App-Passwort ist eine separate Zugangsberechtigung, die Sie unter myaccount.google.com/apppasswords widerrufen können, die Google-Anmeldung nutzt OAuth, und in beiden Fällen können Sie das Postfach im Dashboard trennen.

Das vollständige Bedrohungsmodell (was verschlüsselt ist, was ein Angreifer sehen würde und was nicht) steht in [Ist es sicher, einem KI-Agenten E-Mail-Zugriff zu geben?](/blog/is-it-safe-to-give-ai-agent-email-access)

## FAQ

**Brauche ich einen API-Schlüssel, um Gmail mit Claude zu verbinden?**
Nein. Claude unterstützt OAuth, Sie fügen also die Endpunkt-URL ein und bestätigen eine Anmeldung. API-Schlüssel sind nur für Clients ohne eingebautes OAuth gedacht.

**Speichert Claude meine Gmail-Nachrichten?**
Nein. E-Mails werden bei jeder Anfrage live von Gmail abgerufen und direkt verworfen, nachdem Claude sie gelesen hat. Gespeichert bleibt nur Ihre verschlüsselte Zugangsberechtigung (das App-Passwort oder das Zugriffstoken, wenn Sie sich mit Google angemeldet haben).

**Kann Claude E-Mails von meinem Gmail senden?**
Ja, wenn Sie die Berechtigung \`send:email\` gewähren. Gesendet wird über Gmail als normale Nachricht von Ihrem eigenen Konto. Gewähren Sie nur Lesezugriff, wenn Claude nie senden soll.

**Funktioniert das mit dem kostenlosen Claude-Tarif?**
Benutzerdefinierte Konnektoren erfordern einen Claude-Tarif, der sie unterstützt (claude.ai kostenpflichtig oder Claude Desktop). Die Seite von MCP Emails ist kostenlos und ohne Karte.

**Sieht MCP Emails mein Google-Passwort?**
Nein. Sie fügen ein App-Passwort ein, eine separate Zugangsberechtigung, die Google erzeugt und die Sie widerrufen können, oder Sie melden sich per OAuth mit Google an. Ihr normales Google-Passwort wird nirgends in MCP Emails eingegeben.

## Fazit

Das ist alles: ein Google-App-Passwort, eine Endpunkt-URL, und Claude kann Ihre echten E-Mails lesen, durchsuchen und senden, ohne sie je zu speichern. Der Tarif Free kostet nichts, braucht keine Karte und verbindet ein Postfach; Personal kostet $9/Monat für bis zu drei Postfächer, und Pro verbindet bis zu 10 (siehe [Preise](/pricing)).

Bereit? [Verbinden Sie Ihr Gmail kostenlos](/signup), fügen Sie den Endpunkt in Claude ein und bitten Sie Claude, Ihre ungelesenen E-Mails zusammenzufassen.`,
};

export default translation;
