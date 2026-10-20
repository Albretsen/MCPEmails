const translation = {
  title: 'E-Mail für KI-Agenten in Cursor, Cline und VS Code einrichten',
  description: 'Geben Sie Ihrem Coding-Agenten in Cursor, Cline und VS Code Zugriff auf E-Mail. Cursor nutzt OAuth, Cline und eigene Clients nutzen einen API-Schlüssel mit begrenzten Scopes über MCP. Die komplette Einrichtung.',
  coverAlt: 'E-Mail-Zugriff für KI-Coding-Agenten in Cursor, Cline und VS Code über MCP einrichten',
  content: `Die Kurzfassung: Damit ein Coding-Agent in Ihrem Editor auf ein echtes Postfach zugreifen kann, richten Sie ihn auf einen einzigen MCP-Endpunkt aus: \`https://www.mcpemails.com/api/mcp\`. Cursor beherrscht OAuth, also fügen Sie die URL ein und melden sich an. Cline, die reine MCP-Konfiguration von VS Code und eigene Skripte machen den OAuth-Ablauf nicht mit. Sie authentifizieren sich deshalb mit einem API-Schlüssel mit begrenzten Scopes, der als \`Authorization: Bearer\`-Header mitgeschickt wird. Gleicher Endpunkt, gleiche Tools, zwei Wege hinein.

Diese Anleitung behandelt beide Wege, zeigt, wie Sie einen API-Schlüssel erstellen, der genau auf \`read:email\` und \`send:email\` begrenzt ist, und endet mit einem Entwickler-Workflow, den ich selbst nutze: Der Agent sortiert mein Postfach und verschickt Antworten, ohne dass ich den Editor verlasse. Wenn Sie zuerst den Überblick möchten, beginnen Sie mit der Grundlagenanleitung, [wie Sie Ihrem KI-Agenten Zugriff auf E-Mail geben](/blog/how-to-give-your-ai-agent-email-access).

## Bevor Sie einen Client anbinden: Postfach verbinden

Der MCP-Server besitzt Ihre E-Mails nicht. Er vermittelt eine Live-Verbindung zu dem Anbieter, den Sie ohnehin nutzen, ruft Nachrichten beim Aufruf ab und verwirft sie danach. Von Ihren E-Mails wird nichts gespeichert. Schritt eins findet deshalb im Dashboard statt, nicht im Editor.

Öffnen Sie **Dashboard → Postfächer → Postfach verbinden** und wählen Sie einen Anbieter:

- **Gmail** → ein Google-App-Passwort über IMAP. Aktivieren Sie die Bestätigung in zwei Schritten, erstellen Sie unter myaccount.google.com/apppasswords ein App-Passwort und fügen Sie die 16 Buchstaben zusammen mit Ihrer vollständigen Gmail-Adresse ein. Ein Google-Workspace-Administrator kann App-Passwörter für die Domain abschalten.
- **Outlook / Microsoft 365** → OAuth über „Mit Microsoft anmelden“, kein App-Passwort. Private Konten bei Outlook.com, Hotmail, Live und MSN verbinden sich sofort. Bei einem Microsoft-365-Konto von Arbeit oder Schule muss eventuell zuerst ein IT-Administrator die App einmal für die ganze Organisation freigeben. Das Dashboard gibt Ihnen einen Link, den Sie weiterleiten können.
- **iCloud, Fastmail, Yahoo, Zoho oder ein beliebiger IMAP-Host** → ein app-spezifisches Passwort. Erstellen Sie es in den Einstellungen des Anbieters (bei iCloud unter appleid.apple.com) und fügen Sie es ein.

Fastmail funktioniert nur mit App-Passwort, nicht mit OAuth. Suchen Sie dort also keinen Zustimmungsbildschirm wie bei Google. Für iCloud oder Fastmail finden Sie die Details pro Anbieter in der [Anleitung für iCloud, Fastmail und IMAP](/blog/connect-icloud-fastmail-imap-to-claude). Für Outlook lesen Sie [Outlook und Microsoft 365 verbinden](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

Sobald ein Postfach verbunden ist, erreicht Ihr Agent es über Tools. Sie fügen nie eine UUID oder ein Passwort in Ihre Editor-Konfiguration ein.

## Cursor: URL einfügen, anmelden, fertig

Cursor unterstützt OAuth 2.0 für MCP-Server, und das ist der bequeme Weg. Es gibt keinen API-Schlüssel und kein Geheimnis, das Sie in einer Konfigurationsdatei verwalten müssen.

1. Öffnen Sie die Einstellungen von Cursor und suchen Sie den Bereich für MCP-Server.
2. Fügen Sie einen neuen Server mit der URL \`https://www.mcpemails.com/api/mcp\` hinzu.
3. Cursor öffnet ein Browserfenster. Melden Sie sich bei Ihrem MCPEmails-Konto an und genehmigen Sie die Scopes, die der Agent erhalten soll: \`read:email\`, \`send:email\` oder beide.
4. Die Verbindung wird grün, und die E-Mail-Tools erscheinen in der Tool-Liste von Cursor.

Technisch ist das der OAuth-2.0-Authorization-Code-Flow mit PKCE, und das Token in Cursor ist genau auf das begrenzt, was Sie genehmigt haben. Haben Sie nur \`read:email\` erteilt, kann der Agent schlicht nicht senden. Wenn Sie fertig sind, widerrufen Sie die Verbindung mit einem Klick unter **Dashboard → API-Schlüssel** (dort liegen auch die OAuth-Freigaben), und Cursor verliert den Zugriff sofort.

Claude Desktop und claude.ai folgen demselben Ablauf aus Einfügen und Genehmigen, falls Sie diese ebenfalls nutzen.

## Cline, reines VS Code und eigene Skripte: API-Schlüssel verwenden

Cline, die einfache \`mcp\`-Konfiguration in VS Code, JetBrains und alles, was Sie selbst skripten, implementieren den OAuth-Handshake nicht. Für diese Clients erstellen Sie einen API-Schlüssel und senden ihn als Bearer-Token. Das ist auch die richtige Wahl für CI-Jobs und Automatisierung per Cron, bei denen niemand einen Freigabebildschirm anklicken kann.

### Schritt 1: API-Schlüssel mit begrenzten Scopes erstellen

Klicken Sie unter **Dashboard → API-Schlüssel** auf **Schlüssel erstellen**. Geben Sie ihm einen Namen, den Sie später wiedererkennen (\`cline-laptop\`, \`triage-cron\`), und wählen Sie die Scopes:

- \`read:email\` zum Auflisten, Suchen und Lesen.
- \`send:email\` zum Senden und Antworten.

Erteilen Sie nur, was der Client braucht. Ein Triage-Assistent mit Lesezugriff hat mit \`send:email\` nichts zu tun. Der Schlüssel wird genau einmal angezeigt. Kopieren Sie ihn sofort, denn Sie können ihn später nicht mehr ansehen. Geht er verloren, erstellen Sie einen neuen, wiederherstellen lässt er sich nicht.

### Schritt 2: Schlüssel in die Client-Konfiguration eintragen

Für Cline (und die meisten MCP-Setups in VS Code) fügen Sie den Server mit dem Bearer-Header in die MCP-Konfigurations-JSON ein:

\`\`\`json
{
  "mcpServers": {
    "mcpemails": {
      "url": "https://www.mcpemails.com/api/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
\`\`\`

Ein einfacher cURL-Aufruf, um den Schlüssel zu prüfen, bevor Sie einen Editor anfassen:

\`\`\`bash
curl -s https://www.mcpemails.com/api/mcp \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
\`\`\`

Kommt eine Tool-Liste zurück, sind Sie verbunden. Der Fehler \`-32001\` bedeutet, dass der Schlüssel ungültig ist, und \`-32004\` (HTTP 403), dass ihm ein Scope fehlt, den das Tool braucht. Beide lassen sich nicht durch Wiederholen beheben: Korrigieren Sie den Schlüssel, statt in einer Schleife zu wiederholen. Committen Sie den Schlüssel nicht. Lesen Sie ihn aus einer Umgebungsvariable und halten Sie ihn aus Git heraus. Wenn Sie abwägen, welches Authentifizierungsmodell wo passt, erklärt [OAuth oder API-Schlüssel für den E-Mail-Zugriff von KI](/blog/oauth-vs-api-keys-ai-email-access) die Vor- und Nachteile.

## Die Tools, die Ihr Agent erhält

Beide Wege bieten dieselben Funktionen. Eine Handvoll zusammengefasster, aktionsbasierter Tools deckt die Arbeit ab:

- \`inbox_list\`: immer zuerst aufrufen, um verbundene Postfächer und ihre IDs zu ermitteln.
- \`email_read\` (Aktion \`list\`): seitenweise, neueste zuerst.
- \`email_read\` (Aktion \`read\`): geparster Klartext, optional bereinigtes HTML, Anhänge.
- \`email_read\` (Aktion \`search\`): Suche nach Absender, Betreff, Datum, Ungelesen-Status und weiteren strukturierten Feldern, übersetzt in die eigene Suche des jeweiligen Anbieters.
- \`email_compose\` (Aktion \`send\`): Verfassen mit CC/BCC, HTML und Anhängen bis 10 MB.
- \`email_compose\` (Aktion \`reply\`): setzt die Header In-Reply-To und References für Sie, damit der Verlauf erhalten bleibt.

Es gibt weitere Tools für Markierungen und Verschieben (\`email_organize\`), Ordner, geplantes Senden und Kontakte, aber diese wenigen erledigen den Großteil der echten Arbeit.

## Ein Entwickler-Workflow, der sich lohnt

Hier zahlt es sich aus. Ich habe einen Schlüssel mit Lese- und Senderecht in meinem Editor eingerichtet und überlasse dem Agenten die Teile des Tages, die ich sonst im Postfach verlieren würde.

Die Morgen-Triage, direkt ins Chat-Panel getippt:

> Rufe inbox_list auf und liste dann die ungelesenen E-Mails der letzten 12 Stunden aus meinem Arbeitspostfach auf. Gruppiere sie: braucht eine Antwort, zur Info und unwichtig. Für die Gruppe „zur Info“ gib mir jeweils eine Zeile.

Der Agent führt \`inbox_list\` aus, dann \`email_read\` mit der Aktion \`list\` und gesetztem \`unread\`, liest die wichtigen Nachrichten und gibt mir eine sortierte Übersicht zurück. Wenn ich eine sehe, die ich beantworten will, schreibe ich weiter:

> Antworte auf die Nachricht der Design-Agentur und bestätige, dass Donnerstag um 14 Uhr passt. Halte es kurz.

Er ruft \`email_compose\` mit der Aktion \`reply\` auf, der Verlauf bleibt erhalten, und die Antwort geht über mein eigenes Gmail hinaus. Sie kommt also von meiner Adresse mit der Reputation meiner Domain an. Mehr zu Triage-Prompts lesen Sie unter [wie ein KI-Agent Ihr Postfach sortiert und zusammenfasst](/blog/ai-agent-triage-summarize-inbox).

Eine Einschränkung gibt es: Es gibt keine Webhooks. Der Server schickt Ihnen neue E-Mails nicht von selbst. Soll der Agent auf eingehende Nachrichten reagieren, fragen Sie regelmäßig ab: \`email_read\` mit der Aktion \`list\` und \`unread: true\` nach Zeitplan. Das ist eine bewusste Designentscheidung, und sie bestimmt, wie Sie alles Reaktive bauen, etwa einen [automatischen Antwortdienst über MCP](/blog/build-email-auto-responder-mcp-agent).

## Ratenlimits für Zugriff per Skript

Wenn Sie den Server aus einem Cron-Job oder einer engen Agenten-Schleife ansteuern, beachten Sie die Limits. Jeder API-Schlüssel ist in jedem Tarif auf **100 Anfragen pro Minute, 1.000 pro Stunde und 10.000 pro Tag** begrenzt. Dazu kommt eine Burst-Grenze pro Workspace, die von Ihrem Tarif abhängt: 60/Min. bei Free, 120/Min. bei Personal ($9/Monat), 300/Min. bei Pro ($15/Monat), 1.000/Min. bei Business ($39/Monat). Die vollständige Übersicht finden Sie auf der [Preisseite](/pricing).

Erreichen Sie ein Ratenlimit, gibt der Server einen wiederholbaren Fehler (Code \`-32003\`) mit \`data.retry_after\` in Sekunden zurück. Halten Sie sich daran: Warten Sie so lange und versuchen Sie es dann erneut. Nicht alles lässt sich wiederholen: Wenn Sie das monatliche Aktionskontingent Ihres Tarifs aufgebraucht haben, liefert der Aufruf ein normales Tool-Ergebnis mit \`isError: true\` und einem \`_meta["com.mcpemails/usage_limit"]\`-Block. Es gibt kein \`retry_after\`, und kein Wiederholen hilft vor \`reset_at\`. Wiederholen Sie außerdem nie blind einen Versand mit \`email_compose\` nach einem allgemeinen Fehler, sonst verschicken Sie Duplikate. Prüfen Sie zuerst, ob die E-Mail tatsächlich gesendet wurde.

## Fazit

Mit Cursor sind Sie über eine URL und eine Anmeldung verbunden. Alles andere braucht einen Schlüssel mit begrenzten Scopes und einen Bearer-Header. Beide Wege nutzen denselben Endpunkt und dieselben Tools, und beide halten Ihre Zugangsdaten aus Ihrem Repository und aus dem Kontext des Modells heraus. Sie nutzen ChatGPT oder Codex außerhalb des Editors? Die [Anleitung für E-Mail in ChatGPT](/blog/connect-chatgpt-to-email) deckt beides ab.

[Kostenlos starten](/signup) und Ihr erstes Postfach verbinden, oder lesen Sie die [Dokumentation](/docs) mit der vollständigen Tool-Referenz.`,
};

export default translation;
