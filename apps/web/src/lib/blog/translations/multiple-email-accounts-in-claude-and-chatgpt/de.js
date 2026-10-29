const translation = {
  title: 'Mehrere E-Mail-Konten in Claude und ChatGPT: alle Postfächer, ein Konnektor',
  description:
    'So nutzen Sie mehrere E-Mail-Konten gleichzeitig in Claude und ChatGPT, auch Firmenpostfächer bei IONOS, Zoho, Namecheap, Google Workspace oder auf Ihrem eigenen Server, mit einem MCP-Konnektor, der in beiden funktioniert.',
  coverAlt:
    'Mehrere berufliche und private E-Mail-Konten über einen MCP-Konnektor mit Claude und ChatGPT verbunden',
  content: `Sie möchten eine Frage stellen und die Antwort aus allen Postfächern bekommen, die Sie betreuen: Ihre eigene Adresse, info@, vertrieb@, das Rechnungspostfach, vielleicht ein privates Gmail. Diese Anleitung zeigt, wie Sie mehrere E-Mail-Konten gleichzeitig in Claude und ChatGPT nutzen, was die integrierten Konnektoren bereits abdecken und wo Sie stattdessen einen MCP-Server brauchen.

**Direkt zu:** [Integrierte Konnektoren](#was-die-integrierten-konnektoren-können) · [Ein Konnektor für alle Postfächer](#ein-konnektor-für-alle-postfächer) · [Einrichtung in Claude](#in-claude-hinzufügen) · [Einrichtung in ChatGPT](#in-chatgpt-hinzufügen) · [Tarife](#wie-viele-postfächer-jeder-tarif-verbindet)

## Was die integrierten Konnektoren können

Beide Assistenten bringen eigene E-Mail-Konnektoren mit, und die haben sich schnell entwickelt. Hier der Stand zum Zeitpunkt dieses Artikels (September 2026).

- **ChatGPT.** Seit Ende August 2026 können die eigenen Plugins für Gmail, Google Calendar und Google Contacts bei Plus, Pro, Business und Enterprise mehr als ein Konto halten, sodass ein privates und ein berufliches Gmail in derselben Unterhaltung sein können. Im September hat OpenAI mehrere Konten auf weitere Plugins ausgeweitet. Wenn alle Ihre Postfächer Google-Konten sind, reicht Ihnen vielleicht das eigene Plugin von ChatGPT.
- **Claude.** Das Hilfecenter von Anthropic beschreibt den Gmail-Konnektor so, dass er „das Google-Konto, das Sie verbunden haben“ erreicht. Ein Google-Konto pro Verbindung.

Wofür keiner von beiden gebaut ist: das Postfach, das eine Firma tatsächlich auf ihrer eigenen Domain betreibt, wenn diese Domain nicht bei Google oder Microsoft liegt. IONOS, Zoho Mail, Namecheap Private Email, STRATO, Migadu, ein cPanel-Hoster oder Ihr eigener Server. Diese sprechen IMAP und SMTP, und um sie zu erreichen, braucht es etwas, das IMAP spricht.

## Ein Konnektor für alle Postfächer

MCPEmails ist ein gehosteter MCP-Server. Sie verbinden jedes Postfach einmal damit, und Ihr KI-Client erreicht alle über eine URL:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

- **Beliebige Mischung von Anbietern.** Gmail und Google Workspace (Google-App-Passwort), Outlook und Microsoft 365 („Mit Microsoft anmelden“), iCloud, Fastmail, Yahoo, Zoho, Yandex und jedes Postfach, das IMAP und SMTP spricht. Unter [connect](/connect) gibt es eine Seite pro Hoster, darunter [IONOS](/connect/ionos), [Zoho Mail](/connect/zoho), [Namecheap](/connect/namecheap), [STRATO](/connect/strato), [Migadu](/connect/migadu), [Google Workspace](/connect/google-workspace) und [Microsoft 365](/connect/office365).
- **Dieselben Postfächer in beiden Assistenten.** Es ist ein Standard-MCP-Server, die eine Verbindung funktioniert also in Claude und in ChatGPT, ebenso in Cursor, VS Code und anderen MCP-Clients. Fügen Sie ein Postfach einmal hinzu, und jeder Client sieht es.
- **Der Agent weiß, welches Postfach welches ist.** Er ruft \`inbox_list\` auf und erhält jede verbundene Adresse mit ihrem Anzeigenamen. Jedes andere Tool nennt das Postfach, mit dem es arbeitet, Sie sagen also einfach „in vertrieb@“.
- **Antworten gehen von der richtigen Adresse raus.** Jedes Postfach sendet über seinen eigenen Anbieter oder SMTP-Server, mit eigenem Absendernamen und eigener Signatur. Eine Antwort in einem Verlauf in support@ geht von support@ raus.

E-Mails werden für jede Anfrage live abgerufen und nicht gespeichert. Die einzige Ausnahme ist eine Nachricht, die Sie für später planen: Sie wird bis zum Versand vorgehalten.

## Die Postfächer verbinden

Öffnen Sie im Dashboard von MCPEmails **Postfächer**, dann **Postfach verbinden**, einmal pro Postfach:

- **Firmenpostfach auf eigener Domain.** Wählen Sie **IMAP** und geben Sie die Adresse ein. Gängige Hoster werden an der Adresse erkannt, eine Google-Workspace-Domain an ihren Mail-Einträgen, die Einstellungen füllen sich also selbst aus. Verwenden Sie das Passwort oder App-Passwort, das Ihr Hoster verlangt.
- **Gmail oder Google Workspace.** Ein Google-App-Passwort über IMAP. Google bietet es erst an, wenn die Bestätigung in zwei Schritten aktiv ist, und bei Workspace kann Ihr Administrator App-Passwörter und IMAP abschalten.
- **Outlook oder Microsoft 365.** „Mit Microsoft anmelden“. Bei einem Arbeits- oder Schulkonto muss unter Umständen der IT-Administrator die App einmal für die gesamte Organisation freigeben.

Geben Sie jedem Postfach einen klaren Anzeigenamen, etwa „Acme Vertrieb“ statt „arbeit2“. Daran unterscheidet der Agent die Postfächer, und diesen Namen sehen die Empfänger.

## In Claude hinzufügen

In claude.ai oder Claude Desktop:

1. Öffnen Sie **Anpassen → Konnektoren**.
2. Klicken Sie auf **+ Hinzufügen** und dann auf **Benutzerdefinierten Konnektor hinzufügen**. Nennen Sie ihn MCPEmails, fügen Sie \`https://mcpemails.com/api/mcp\` ein und klicken Sie auf **Weiter**.
3. Übernehmen Sie die erkannten Anmeldeeinstellungen, klicken Sie auf **Hinzufügen**, melden Sie sich bei MCPEmails an und stimmen Sie zu.
4. Klicken Sie in einem Chat unten links auf **+**, wählen Sie **Konnektoren** und schalten Sie MCPEmails ein.

Der Free-Tarif von Claude erlaubt einen benutzerdefinierten Konnektor, Pro und Max haben keine Begrenzung. Bei Team und Enterprise fügt ein Owner ihn unter **Organisationseinstellungen → Konnektoren** hinzu, und Mitglieder klicken unter **Anpassen → Konnektoren** auf **Verbinden**.

Jedes verbundene Postfach ist jetzt verfügbar. Details stehen in der [Anleitung für Claude](/blog/connect-claude-to-email).

## In ChatGPT hinzufügen

ChatGPT Go und die kostenpflichtigen Tarife können auf chatgpt.com im Browser einen benutzerdefinierten MCP-Server hinzufügen; in der Mobil-App geht das nicht. Bei Business und Enterprise muss ihn unter Umständen ein Admin oder Owner hinzufügen.

1. Öffnen Sie **Plugins**, dann **Personal**, klicken Sie oben rechts auf **Add** und wählen Sie **Add custom MCP server**.
2. Nennen Sie ihn MCPEmails, fügen Sie \`https://mcpemails.com/api/mcp\` unter **Connection** ein, wählen Sie **OAuth**, setzen Sie das Häkchen bei **I understand and want to continue** und klicken Sie auf **Create as a plugin**.
3. Melden Sie sich bei MCPEmails an und stimmen Sie zu.
4. Tippen Sie in einem Chat **@** und wählen Sie MCPEmails. Die Auswahl gilt für diese eine Nachricht. Erwähnen Sie MCPEmails also erneut mit @, wenn eine Folgefrage Ihre E-Mails braucht.

Die [Anleitung für ChatGPT](/blog/connect-chatgpt-to-email) behandelt die Menüs und die häufigen Fehler.

## Prompts, die mehrere Postfächer nutzen

> Gehen Sie vertrieb@ und info@ durch und listen Sie jede Anfrage aus dieser Woche auf, die noch niemand beantwortet hat. Eine gemeinsame Liste, jeweils mit dem Postfach, aus dem sie stammt. Senden oder verschieben Sie nichts.

> Finden Sie die Hetzner-Rechnung aus dem August. Durchsuchen Sie alle verbundenen Postfächer und sagen Sie mir, in welchem sie liegt.

> Entwerfen Sie von support@ eine Antwort auf die neueste Beschwerde zur Lieferung. Zeigen Sie sie mir, bevor Sie sie senden.

Ein Aufruf erreicht ein Postfach. „Alle Postfächer durchsuchen“ heißt also, dass der Agent die Suche einmal pro Postfach ausführt und die Antworten zusammenführt. Bitten Sie um eine gemeinsame Liste, sonst bekommen Sie einen Bericht pro Konto. [Mehrere E-Mail-Konten mit KI verwalten](/blog/manage-multiple-email-accounts-with-ai) geht tiefer auf Berechtigungen, Absenderidentität und die Prüfung pro Postfach ein.

## Ein Mensch bleibt am Senden-Knopf

Schalten Sie für ein Postfach **Vor dem Senden prüfen** ein, und jedes Senden, Antworten, Weiterleiten, Senden eines Entwurfs und geplante Senden aus diesem Postfach wartet im Dashboard auf Ihre Freigabe. Die Einstellung gilt pro Postfach: Das Rechnungspostfach kann zurückgehalten werden, während Ihr eigenes frei sendet. Sie ist in jedem Tarif enthalten, auch in Free. Siehe [Freigabe durch einen Menschen für KI-E-Mails](/blog/approve-ai-agent-email-sends).

## Wie viele Postfächer jeder Tarif verbindet

- **Free:** ein Postfach.
- **Personal:** drei Postfächer.
- **Pro:** bis zu 10 Postfächer, mit einem Login.
- **Business:** 10 Postfächer inklusive und $3 pro Monat für jedes weitere, und für den Fall, dass eine zweite Person einen eigenen Login braucht.

Eine Firma mit info@, vertrieb@ und rechnungen@ plus Ihrer eigenen Adresse hat vier Postfächer, das ist Pro. Aktuelle Preise stehen auf der [Preisseite](/pricing), und [MCPEmails für Unternehmen](/for/business) zeigt, wie eine Person alle Firmenpostfächer mit einem Agenten betreut.

## FAQ

**Kann Claude mehr als ein E-Mail-Konto gleichzeitig nutzen?**
Ja, über einen MCP-Server. Verbinden Sie jedes Postfach mit MCPEmails, fügen Sie Claude einen benutzerdefinierten Konnektor hinzu, und Claude sieht alle und nennt bei jedem Aufruf das Postfach.

**Kann ChatGPT mehr als ein E-Mail-Konto nutzen?**
Das eigene Gmail-Plugin kann inzwischen mehrere Google-Konten halten. Für Postfächer, die nicht bei Google liegen, etwa eine Firmenadresse bei IONOS, Zoho oder einem cPanel-Hoster, fügen Sie MCPEmails als benutzerdefinierten Konnektor hinzu, und jedes verbundene Postfach ist verfügbar.

**Brauche ich einen eigenen Konnektor pro Postfach?**
Nein. Eine Konnektor-URL deckt alle Postfächer in Ihrem MCPEmails-Workspace ab, und dieselbe URL funktioniert in Claude, ChatGPT und anderen MCP-Clients.

**Geht eine Antwort von der richtigen Adresse raus?**
Ja. Jedes Postfach sendet über seinen eigenen Anbieter oder Mailserver mit eigenem Anzeigenamen und eigener Signatur. Um bei einem IMAP-Postfach von einer anderen Adresse zu senden, fügen Sie diese in den Einstellungen des Postfachs im Dashboard hinzu und bestätigen sie mit dem Code, der an diese Adresse gesendet wird. Outlook sendet von der verbundenen Adresse, und eine nicht bestätigte Absenderadresse wird abgelehnt.

**Werden die E-Mails aus all diesen Konten gespeichert?**
Nein. Nachrichteninhalte werden bei jeder Anfrage live von Ihrem Anbieter abgerufen und verworfen. Gespeichert wird die verschlüsselte Zugangsberechtigung für jedes Postfach. Siehe [Sicherheit](/security).

## Nächster Schritt

[Kostenlos starten](/signup) mit Ihrem meistgenutzten Postfach, den Konnektor von MCPEmails zu Claude oder ChatGPT hinzufügen und fragen, was heute eine Antwort braucht. Verbinden Sie die anderen Postfächer, wenn Sie eine Antwort statt mehrerer möchten.`,
};

export default translation;
