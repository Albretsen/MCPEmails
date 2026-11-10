const translation = {
  title: 'KI-Agent mit E-Mail verbinden: die vollständige Anleitung 2026',
  description:
    'Geben Sie Ihrem KI-Agenten Lese- und Sendezugriff auf ein echtes Postfach über MCP: Gmail, Outlook, iCloud, Fastmail, GMX oder IMAP. Wie es funktioniert, die Tools, die Sicherheit und die Einrichtung.',
  coverAlt: 'So geben Sie Ihrem KI-Agenten Zugriff auf E-Mails über MCP, mit MCPEmails',
  content: `Um einem KI-Agenten Zugriff auf E-Mails zu geben, verbinden Sie Ihr Postfach mit einem MCP-Server und richten Ihren Agenten auf eine Endpunkt-URL. Der Agent bekommt dann einen kleinen Satz Tools zum Lesen, Suchen und Senden von E-Mails. Der schwierige Teil ist nicht der Agent, sondern das Ganze so zu tun, dass Ihr Passwort nicht in einen Prompt, ein Log oder einen Vektorspeicher gerät. Um diese letzte Meile geht es in dieser Anleitung.

Wenn Sie nur den schnellen Weg wollen: Verbinden Sie ein Postfach im Dashboard, fügen Sie den MCP-Endpunkt in [claude.ai](https://claude.ai), Claude Desktop, Cursor oder Ihren eigenen Agenten ein und rufen Sie zuerst \`inbox_list\` auf. Der Rest dieses Beitrags erklärt, was dabei tatsächlich passiert, warum das Sicherheitsmodell wichtig ist und wie Sie jeden unterstützten Anbieter anbinden.

## Was „E-Mail über MCP“ tatsächlich bedeutet

Das [Model Context Protocol](https://modelcontextprotocol.io) ist ein Standard, um einem Sprachmodell Tools über HTTP bereitzustellen. Ein MCP-E-Mail-Server präsentiert Ihr Postfach nicht als rohes IMAP, sondern als eine Handvoll typisierter Verben, die der Agent aufrufen kann: Nachrichten auflisten, eine lesen, suchen, senden, antworten. Der Agent denkt in diesen Verben. Er berührt nie das zugrunde liegende Postfachprotokoll, und er sieht nie Ihre Zugangsdaten.

Das ist die ganze Idee hinter [MCPEmails](/). Ein Endpunkt, ein Satz Tools, jeder MCP-kompatible Client. Wenn Sie die Erklärung der Architektur von Grund auf wollen, behandelt der Begleitbeitrag [Was ist ein MCP-E-Mail-Server?](/blog/what-is-an-mcp-email-server) sie in einfachen Worten.

## Warum die letzte Meile schwierig ist

Ein Modell an E-Mail anzuschließen sieht trivial aus, bis man es wirklich versucht. Drei Dinge machen Ärger:

1. **Die Authentifizierung ist bei jedem Anbieter anders.** Outlook und Microsoft 365 wollen OAuth über die Microsoft-Identität. Gmail will ein Google-App-Passwort, das Google erst erstellen lässt, wenn die Bestätigung in zwei Schritten aktiv ist. iCloud und Fastmail wollen ein App-spezifisches Passwort. GMX und web.de wollen, dass Sie IMAP erst in den Einstellungen freischalten. Jeder hat seinen eigenen Zyklus für das Erneuern von Tokens und seine eigenen Fehlerbilder.
2. **Zugangsdaten sind radioaktiv.** Ein Postfach-Passwort in einem Chat-Protokoll oder einer Log-Zeile ist ein Datenleck, das nur auf seinen Moment wartet. Sie dürfen das Geheimnis nicht dem Modell überlassen.
3. **E-Mail hat für Agenten eine unpassende Form.** MIME, Threading-Header, HTML gegen reinen Text, Anhänge, Ordner, die eigentlich Labels sind. Das Modell braucht eine saubere Antwort, nicht RFC 5322.

Die naive Selbstbau-Lösung, dem Modell eine IMAP-Bibliothek und Ihr Passwort zu geben, scheitert an allen drei Punkten gleichzeitig. Die meisten „Gmail-MCP-Server“-Repositories auf GitHub hören genau dort auf.

## Wie MCPEmails es löst

Vier Designentscheidungen tragen die Last. Sie sind der Grund, warum ich dem mein eigenes Postfach anvertraue.

### E-Mails werden live abgerufen und nie gespeichert

Jeder Tool-Aufruf geht in Echtzeit an Ihren Anbieter: IMAP/SMTP bei Gmail, iCloud, Fastmail, GMX und den übrigen, oder Microsoft Graph bei Outlook. Nachrichtentexte, Betreffzeilen und Anhänge werden an den Agenten übergeben und sofort verworfen. Nichts wird zwischengespeichert, indexiert oder gelagert. Das Einzige, was pro Postfach dauerhaft gespeichert wird, ist die Zugangsberechtigung für den nächsten Aufruf. Die lange Fassung, warum das wichtig ist, steht in [Warum es wichtig ist, dass E-Mails nie gespeichert werden](/blog/why-email-never-stored-matters).

### Zugangsdaten sind im Ruhezustand mit AES-256-GCM verschlüsselt

Das App-Passwort oder OAuth-Token jedes Postfachs wird verschlüsselt, bevor es in die Datenbank geschrieben wird. Es wird nur auf unseren Servern entschlüsselt, wenn eine Anfrage es braucht, und nie an Ihren Agenten gesendet. Der Schlüssel liegt als Server-Geheimnis getrennt von der Datenbank. Selbst ein Datenbankleck gibt einem Angreifer also Chiffretext, nicht Ihr Postfach.

### Gesendet wird über Ihren eigenen Anbieter

Wenn der Agent sendet oder antwortet, verlässt die E-Mail Ihr Gmail, Ihr Microsoft 365 oder Ihren SMTP-Server. MCPEmails leitet nie über die eigene Domain weiter. Ihre Zustellbarkeit und Domain-Reputation bleiben vollständig bei Ihnen, kein Spam-Ordner-Roulette über geteilte IPs.

### Es ist Standard-MCP über HTTP

Der Server spricht Streamable HTTP nach der MCP-Spezifikation vom 2025-06-18. Kein SDK zu installieren, kein eigener Client. Er passt in alles, was MCP spricht.

## Die Tools, die Ihr Agent bekommt

Eine Handvoll zusammengefasster, aktionsbasierter Tools deckt die gesamte Fläche ab: Lesen, Verfassen, Ordnen, dazu weitere für Ordner, Planung und Kontakte. Der Agent beginnt immer mit \`inbox_list\`, um herauszufinden, was verbunden ist, und die ID jedes Postfachs zu holen; eine UUID wird nie fest einprogrammiert.

- \`inbox_list\`: verbundene Konten und ihre Fähigkeiten erkennen
- \`email_read\` (Aktion \`list\`): seitenweise, neueste zuerst, pro Postfach
- \`email_read\` (Aktion \`read\`): geparster reiner Text, optional bereinigtes HTML, optional Anhänge
- \`email_read\` (Aktion \`search\`): anbietereigene Syntax (Gmail-Operatoren, Outlook KQL, IMAP-Textsuche)
- \`email_compose\` (Aktion \`send\`): verfassen mit CC/BCC, HTML und Anhängen bis insgesamt 10 MB
- \`email_compose\` (Aktion \`reply\`): dasselbe, und es setzt die Threading-Header (In-Reply-To, References) für Sie
- \`email_organize\`: verschieben, löschen, markieren oder archivieren (eine Aktion pro Aufruf)

Eine Grenze gehört gleich vorweg: Das ist **Polling, kein Push**. Es gibt keine Webhooks. Um auf neue E-Mails zu reagieren, fragt Ihr Agent nach einem Zeitplan ab, zum Beispiel mit \`email_read\` (Aktion \`list\`) und \`unread: true\`. Jede automatische Antwort, die Sie bauen, läuft nach Timer, nicht nach einem sofortigen Auslöser. Die [Bauanleitung für automatische Antworten](/blog/build-email-auto-responder-mcp-agent) zeigt, wie das gut geht.

Ein Morgen-Triage-Lauf liest sich so:

\`\`\`json
{
  "step1": "inbox_list                  → findet Ihr Arbeits-Gmail",
  "step2": "email_read (action list)    → letzte 24 h, unread: true",
  "step3": "email_read (action read)    → vollständiger Text für alles Dringende",
  "step4": "email_compose (action reply) → Entwurf, oder nur zusammenfassen und warten"
}
\`\`\`

Kein Passwort ging über die Leitung. Der Agent hielt Fähigkeiten, keine Zugangsdaten. Mehr Ideen finden Sie in [7 Dinge, die ein KI-Agent mit Postfachzugriff tun kann](/blog/7-things-ai-agent-can-do-with-inbox-access) und in der ausführlicheren [Anleitung zu Triage und Zusammenfassung](/blog/ai-agent-triage-summarize-inbox).

## Unterstützte Anbieter und wie sich jeder verbindet

Sie verbinden ein Postfach einmal unter **Dashboard → Postfächer → Postfach verbinden**. Wie Sie sich authentifizieren, hängt vom Anbieter ab.

### OAuth-Anbieter (anmelden, kein Passwort)

- **Outlook / Microsoft 365**: OAuth 2.0 über „Mit Microsoft anmelden“, über Microsoft Graph statt IMAP. Private Konten bei Outlook.com, Hotmail, Live und MSN sind sofort verbunden. Bei Arbeits- oder Schulkonten von Microsoft 365 muss unter Umständen zuerst ein IT-Administrator die App einmal für die gesamte Organisation freigeben; das Dashboard gibt Ihnen dafür einen Link, den Sie weiterleiten können. Details zur Einrichtung stehen in [Outlook und Microsoft 365 mit einem KI-Agenten verbinden](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

### Anbieter mit App-Passwort

Gmail, iCloud, Fastmail, Yahoo, Zoho, Yandex und jedes allgemeine IMAP-Postfach verbinden sich mit einem App-spezifischen Passwort statt OAuth. Sie erzeugen das Passwort in den Sicherheitseinstellungen Ihres Anbieters und fügen es in MCPEmails ein. Gmail-App-Passwörter kommen aus Ihrem Google-Konto, und Google verlangt die Bestätigung in zwei Schritten, bevor es eines erstellt. iCloud-Passwörter kommen von account.apple.com; Fastmail funktioniert **nur mit App-Passwort** (erstellen Sie eines in den Fastmail-Einstellungen). Bei GMX und web.de schalten Sie zuerst den IMAP-Zugriff in den E-Mail-Einstellungen frei und verbinden dann mit Ihrem Kontopasswort oder, bei aktiver Zwei-Faktor-Authentifizierung, mit einem App-Passwort; die Seiten zu [GMX](/connect/gmx) und [web.de](/connect/web-de) zeigen die Klickpfade. Alle laufen über denselben IMAP/SMTP-Transport und teilen sich einen identischen Funktionsumfang. Die vollständige Anleitung steht in [iCloud, Fastmail oder jedes IMAP-Postfach mit Claude verbinden](/blog/connect-icloud-fastmail-imap-to-claude).

## Ihren KI-Client verbinden

Derselbe Endpunkt, dieselben Tools, zwei Wege hinein, je nachdem, ob Ihr Client OAuth spricht.

### OAuth-fähige Clients (kein API-Schlüssel)

claude.ai, Claude Desktop, Cursor und ähnliche Clients verbinden sich mit OAuth 2.0 Authorization Code + PKCE und Dynamic Client Registration nach RFC 7591. In claude.ai öffnen Sie **Anpassen → Konnektoren**, klicken auf **+ Hinzufügen** und **Benutzerdefinierten Konnektor hinzufügen**, fügen die URL des MCP-Endpunkts ein, klicken auf Verbinden, melden sich bei Ihrem MCPEmails-Konto an und genehmigen. Tokens sind auf genau das beschränkt, was Sie genehmigen: \`read:email\`, \`send:email\` oder beides. Schritt-für-Schritt-Anleitungen finden Sie in [Claude mit Ihrem Postfach einrichten](/blog/connect-claude-to-email) und [Ihre E-Mail zu ChatGPT hinzufügen](/blog/connect-chatgpt-to-email).

### Clients ohne OAuth (API-Schlüssel)

Cline, JetBrains, eigene Skripte und rohes cURL verwenden einen API-Schlüssel mit eingeschränkten Berechtigungen. Erstellen Sie einen unter **Dashboard → API-Schlüssel**, wählen Sie seine Berechtigungen und kopieren Sie ihn (er wird nur einmal angezeigt). Übergeben Sie ihn im Header \`Authorization: Bearer\`, gefolgt vom Schlüssel. Die vollständige Einrichtung dafür steht in [E-Mail für KI-Agenten in Cursor, Cline und VS Code](/blog/email-for-ai-agents-cursor-cline-vscode), und die Abwägung zwischen den beiden Ansätzen in [OAuth oder API-Schlüssel für den KI-Zugriff auf E-Mails](/blog/oauth-vs-api-keys-ai-email-access).

So oder so widerrufen Sie jede Verbindung im Dashboard mit einem Klick. Die genaue Endpunkt-URL holen Sie sich aus der [Dokumentation](/docs); kopieren Sie sie von dort, statt sie abzutippen.

## Ist das sicher? Und die Rate-Limits

Kurze Antwort: ja, und der Beitrag [Ist es sicher, einem KI-Agenten Zugriff auf E-Mails zu geben?](/blog/is-it-safe-to-give-ai-agent-email-access) führt das vollständig aus. Das Modell hält eingeschränkte Fähigkeiten, nicht Ihr Passwort; Zugangsdaten sind verschlüsselt; nichts wird gespeichert; gesendet wird über Ihren Anbieter; der Zugriff lässt sich mit einem Klick widerrufen.

Zu den Rate-Limits: Jeder Workspace hat eine Obergrenze pro Minute, die mit Ihrem Tarif wächst (siehe [Preise](/pricing)), und jeder API-Schlüssel bekommt Fenster pro Minute, Stunde und Tag, die zu diesem Tarif passen, sodass ein Schlüssel die ganze Obergrenze nutzen kann und mehrere Schlüssel sie sich teilen. Wenn Sie ein Limit erreichen, gibt der Server einen wiederholbaren Fehler mit einem \`retry_after\`-Wert in Sekunden zurück. Halten Sie sich daran. Und wiederholen Sie ein \`email_compose\`-Senden nie blind automatisch: Sie würden Duplikate senden.

## Preise

Die Tarife bemessen sich nach verbundenen Postfächern. API-Schlüssel sind in jedem Tarif unbegrenzt, und die Tarife unterscheiden sich außerdem bei Burst-Rate, Aufbewahrung der Auswertungen, Team-Funktionen und Support.

- **Free**, dauerhaft kostenlos. Keine Karte. Ein verbundenes Postfach, Hilfe-Center und Support per E-Mail.
- **Personal**: mehrere verbundene Postfächer, höhere Burst-Rate, längere Auswertungen, bevorzugter Support per E-Mail.
- **Pro**: noch mehr verbundene Postfächer, höhere Burst-Rate, mehrjährige Auswertungen, bevorzugter Support per E-Mail.
- **Business**: alles aus Pro, dazu ein enthaltenes Kontingent an Postfächern mit weiteren gegen Aufpreis, unbegrenzt viele Mitglieder mit Rollen, Admins, die angehaltene Sendungen freigeben, ein eigener Workspace pro Kunde oder Unternehmen und die höchste Burst-Rate.

Die aktuellen Zahlen stehen auf der [Preisseite](/pricing).

## Loslegen

Verbinden Sie ein Postfach, fügen Sie den Endpunkt in Ihren Agenten ein und rufen Sie \`inbox_list\` auf. Das ist das ganze Onboarding. [Kostenlos starten](/signup) oder den [Schnellstart](/docs#quickstart) überfliegen: In ein paar Minuten liest Ihr Agent echte E-Mails.`,
};

export default translation;
