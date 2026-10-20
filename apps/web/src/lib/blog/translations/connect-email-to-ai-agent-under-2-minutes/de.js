const translation = {
  title: 'E-Mail in unter 2 Minuten mit einem KI-Agenten verbinden (Gmail, Outlook, iCloud, Fastmail und IMAP)',
  description:
    'Verbinden Sie Ihre E-Mail in unter 2 Minuten mit einem KI-Agenten. Schritt-für-Schritt-Einrichtung für Gmail, Outlook, iCloud, Fastmail und jedes IMAP-Postfach über MCP: Keine E-Mail wird je gespeichert.',
  coverAlt:
    'E-Mail in unter 2 Minuten mit einem KI-Agenten verbinden: Gmail, Outlook, iCloud, Fastmail und IMAP über MCP',
  content: `Sie verbinden Ihre E-Mail in zwei Schritten mit einem KI-Agenten: Postfach im Dashboard von MCP Emails verbinden, dann Ihren Agenten auf eine einzige Endpunkt-URL ausrichten. Mit einem OAuth-fähigen Client wie claude.ai war es das. Kein Code, kein SDK, und Ihre E-Mails werden nirgends gespeichert: Jeder Lese- und Sendevorgang geht live an Ihren Anbieter und wird verworfen, sobald der Agent die Daten hat.

Dies ist die Schnellanleitung. Wählen Sie unten Ihren Anbieter, folgen Sie den vier oder fünf Schritten, und Claude (oder Cursor oder ein eigenes Skript) liest und sendet echte E-Mails, ungefähr in der Zeit, die Sie brauchen, um diesen Absatz zweimal zu lesen. Für die ausführliche Version zu „Was ist das, und ist es sicher?“ beginnen Sie mit dem [vollständigen Leitfaden zum E-Mail-Zugriff für Ihren KI-Agenten](/blog/how-to-give-your-ai-agent-email-access).

## Der Schritt, den alle Anbieter teilen: Client verbinden

Bevor Sie sich um einen Anbieter kümmern, legen Sie fest, wie Ihr KI-Agent mit MCP Emails spricht. Es gibt zwei Wege, und beide nutzen denselben Endpunkt und dieselben Tools.

**Weg A: OAuth-Client (claude.ai, Claude Desktop, Cursor).** Kein API-Schlüssel. Sie fügen eine URL ein und bestätigen eine Anmeldung:

1. Gehen Sie in claude.ai zu **Anpassen → Konnektoren → Konnektor hinzufügen**.
2. Fügen Sie den Endpunkt ein: \`https://www.mcpemails.com/api/mcp\`
3. Klicken Sie auf **Verbinden**, melden Sie sich bei Ihrem MCP-Emails-Konto an und genehmigen Sie die gewünschten Berechtigungen (\`read:email\`, \`send:email\` oder beide).

Das ist die gesamte Client-Seite. Tokens sind genau auf das beschränkt, was Sie genehmigt haben, und Sie können die Verbindung mit einem Klick im Dashboard widerrufen. Die Vor- und Nachteile im Detail stehen in [OAuth oder API-Schlüssel für den E-Mail-Zugriff von KI](/blog/oauth-vs-api-keys-ai-email-access).

**Weg B: Client mit API-Schlüssel (Cline, JetBrains, cURL, eigene Agenten).** Für alles ohne eingebautes OAuth:

1. Gehen Sie zu **Dashboard → API-Schlüssel** und erstellen Sie einen Schlüssel.
2. Wählen Sie seine Berechtigungen (\`read:email\`, \`send:email\`).
3. Kopieren Sie ihn (er wird nur einmal angezeigt) und übergeben Sie ihn als Header: \`Authorization: Bearer <Ihr-API-Schlüssel>\`, ebenfalls an \`https://www.mcpemails.com/api/mcp\`.

Wenn Sie hauptsächlich im Editor arbeiten, deckt die [E-Mail-Einrichtung für Cursor, Cline und VS Code](/blog/email-for-ai-agents-cursor-cline-vscode) diesen Weg vollständig ab.

Jetzt das Postfach. Jeder Anbieter unten beginnt gleich: **Dashboard → Postfächer → Postfach verbinden**, dann wählen Sie Ihren Anbieter.

## Jeden Anbieter verbinden

### Gmail (App-Passwort oder „Mit Google anmelden“)

Gmail verbindet sich standardmäßig mit einem Google-App-Passwort über IMAP.

1. Aktivieren Sie die Bestätigung in zwei Schritten in Ihrem Google-Konto und erstellen Sie dann unter **myaccount.google.com/apppasswords** ein App-Passwort. Es besteht aus 16 Kleinbuchstaben in vier Gruppen.
2. **Dashboard → Postfächer → Postfach verbinden → Gmail.**
3. Geben Sie Ihre vollständige Gmail-Adresse ein, fügen Sie das App-Passwort ein und klicken Sie auf **Postfach verbinden**.
4. Die Verbindung wird gegen Gmail getestet, und das Postfach erscheint als verbunden. Fertig.

Ihr normales Google-Passwort funktioniert hier nicht und wird nie gebraucht. Wenn Sie sich lieber mit Google anmelden, öffnen Sie im selben Fenster **Lieber mit Google anmelden?** und klicken Sie auf **Mit Google verbinden**; Google zeigt zuerst einen Warnhinweis zu einer nicht überprüften App (klicken Sie auf **Erweitert** und dann auf den Link, der zu mcpemails.com weiterführt). Dieser Weg nutzt die Gmail API, Suchen können also die Gmail-eigenen Operatoren verwenden (\`from:\`, \`is:unread\`, \`after:\`), und Claude arbeitet mit echten Labels. Der Weg über das App-Passwort nutzt die IMAP-Textsuche, zeigt Labels als Ordner und kann endgültig löschen. Details stehen in der [Gmail-Anleitung](/blog/connect-gmail-to-claude).

### Outlook / Microsoft 365 („Mit Microsoft anmelden“)

Outlook verbindet sich über eine Microsoft-Anmeldung statt mit einem Passwort. Kein App-Passwort und keine IMAP-Einstellungen.

1. **Dashboard → Postfächer → Postfach verbinden → Outlook.**
2. Klicken Sie auf **Mit Microsoft verbinden** und melden Sie sich auf der Seite von Microsoft mit Ihrem Microsoft-Konto an.
3. Genehmigen Sie die Berechtigungen.
4. Das Postfach erscheint als verbunden. Gesendet wird über Microsoft Graph, es ist also eine normale Nachricht von Ihrem eigenen Konto.

Private Konten bei Outlook.com, Hotmail, Live und MSN verbinden sich so, ohne dass ein Admin beteiligt ist. Bei Arbeits- oder Schulkonten von Microsoft 365 muss unter Umständen zuerst ein IT-Administrator die App freigeben: Viele Organisationen verhindern, dass Mitarbeitende den Postfachzugriff selbst genehmigen. In dem Fall gibt Ihnen das Dashboard einen Link für Ihren IT-Administrator, der die App einmal für die gesamte Organisation freigibt, und danach verbinden Sie sich wie oben. Die [Anleitung für Outlook und Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp) geht Schritt für Schritt durch.

### iCloud (app-spezifisches Passwort)

iCloud bietet Drittanbietern kein OAuth an, Sie erzeugen also ein app-spezifisches Passwort. Das kostet eine Minute mehr.

1. Rufen Sie [appleid.apple.com](https://appleid.apple.com) auf, melden Sie sich an und öffnen Sie den Bereich **Anmeldung und Sicherheit**.
2. Erstellen Sie unter **App-spezifische Passwörter** ein neues und benennen Sie es „MCP Emails“.
3. Kopieren Sie das erzeugte Passwort (es sieht aus wie \`xxxx-xxxx-xxxx-xxxx\`).
4. Geben Sie unter **Dashboard → Postfächer → Postfach verbinden → iCloud** Ihre iCloud-Adresse ein und fügen Sie das App-Passwort ein.

iCloud läuft im Hintergrund über IMAP/SMTP, Sie erhalten also dieselben Tools wie bei allen anderen.

### Fastmail (app-spezifisches Passwort, kein OAuth)

Eine kurze Korrektur, falls Sie ältere Dokumentation gelesen haben: **Fastmail verbindet sich mit einem App-Passwort, nicht über OAuth.** Suchen Sie nicht nach einem Button „Mit Fastmail anmelden“, hier gibt es keinen.

1. Öffnen Sie in Fastmail **Settings → Privacy & Security → Integrations** (oder **App Passwords**).
2. Erstellen Sie ein neues App-Passwort. Geben Sie ihm Mail-Zugriff (IMAP/SMTP) und nennen Sie es „MCP Emails“.
3. Kopieren Sie das Passwort, das Fastmail erzeugt.
4. Geben Sie unter **Dashboard → Postfächer → Postfach verbinden → Fastmail** Ihre Fastmail-Adresse ein und fügen Sie das Passwort ein.

Das war es. Aus Sicht des Agenten verhält sich Fastmail genau wie die anderen IMAP-Anbieter.

### Allgemeines IMAP (Yahoo, Zoho, Yandex und alle anderen)

Alles, was IMAP/SMTP spricht, funktioniert über einen Konnektor. Das Muster ist dasselbe wie bei iCloud und Fastmail: App-Passwort beim Anbieter erstellen, dann einfügen.

1. Erstellen Sie in den Sicherheitseinstellungen Ihres Anbieters ein **App-Passwort** (Yahoo, Zoho und Yandex verstecken es alle in der Kontosicherheit). Verwenden Sie ein echtes App-Passwort, nicht Ihr Anmeldepasswort; die meisten Anbieter blockieren IMAP mit normalem Passwort inzwischen ohnehin.
2. **Dashboard → Postfächer → Postfach verbinden → IMAP.**
3. Geben Sie Ihre E-Mail-Adresse und das App-Passwort ein. MCP Emails erkennt gängige Server automatisch; ist Ihrer ungewöhnlich, tragen Sie den IMAP- und SMTP-Host und Port ein, die Ihr Anbieter angibt.
4. Speichern. Das Postfach ist verbunden und einsatzbereit.

Für die Eigenheiten von iCloud, Fastmail und den vielen kleineren IMAP-Hostern ist der [ausführliche Leitfaden zu iCloud, Fastmail und IMAP](/blog/connect-icloud-fastmail-imap-to-claude) die Referenz zur Fehlerbehebung.

## Erster Aufruf: erst finden, dann handeln

Egal welchen Anbieter Sie gewählt haben, der erste Schritt des Agenten ist immer derselbe. Lassen Sie ihn \`inbox_list\` aufrufen, um zu sehen, was verbunden ist, und die \`inbox_id\` jedes Postfachs zu holen. Der Agent kopiert nie eine UUID. Danach arbeitet er mit einer kleinen Zahl zusammengefasster Tools: \`email_read\` (mit einer \`action\` aus \`list\`, \`read\` oder \`search\`), \`email_compose\` (\`send\`, \`reply\` oder \`forward\`) und \`email_organize\` zum Verschieben, Markieren und Archivieren, dazu \`folder\`, \`draft\`, \`schedule\` und \`contact_search\`:

\`\`\`json
{
  "tools": [
    "inbox_list",
    "email_read",
    "email_compose",
    "email_organize"
  ]
}
\`\`\`

Ein guter Funktionstest: Bitten Sie Ihren Agenten: „Fassen Sie meine drei neuesten ungelesenen E-Mails zusammen.“ Er ruft \`inbox_list\` auf, dann \`email_read\` mit \`action: "list"\` und \`unread: true\`, dann \`email_read\` mit \`action: "read"\` für jede Nachricht. Wenn das funktioniert, steht Ihre Verbindung.

Ein Hinweis, den Sie vorab kennen sollten: MCP Emails arbeitet mit Abfragen. Es gibt keine Webhooks oder Push-Ereignisse, ein Agent reagiert auf neue E-Mails also, indem er in festen Abständen nachsieht, nicht durch eine Benachrichtigung. Für die meisten Workflows ist das das richtige Modell, und so funktionieren auch die Muster für [Triage und Zusammenfassung des Posteingangs](/blog/ai-agent-triage-summarize-inbox).

## Warum das schnell und trotzdem sicher geht

Die Geschwindigkeit entsteht nicht dadurch, dass bei der Sicherheit gespart wird. E-Mails werden bei jedem Aufruf live abgerufen und nie gespeichert: Texte, Betreffzeilen und Anhänge werden an den Agenten übergeben und sofort verworfen. Pro Postfach bleibt nur Ihr OAuth-Token oder App-Passwort gespeichert, verschlüsselt mit AES-256-GCM und nur zum Zeitpunkt des Aufrufs in einer isolierten Funktion entschlüsselt. Gesendet wird immer über Ihren eigenen Anbieter, die Reputation Ihrer Domain bleibt also Ihre. Die Architektur im Detail steht in [warum „E-Mails werden nie gespeichert“ wirklich zählt](/blog/why-email-never-stored-matters).

## Fazit

Das ist alles: eine Postfachverbindung, ein Endpunkt, eine Handvoll Tools. Der Tarif Free verbindet ein Postfach und braucht keine Karte; Personal kostet $9/Monat für bis zu drei Postfächer, und Pro verbindet bis zu 10. Siehe [Preise](/pricing). Bereit für einen Versuch? [Kostenlos starten](/signup), Postfach verbinden und den Endpunkt in Ihren Agenten einfügen.`,
};

export default translation;
