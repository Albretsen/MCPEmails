const translation = {
  title: 'Yahoo Mail mit ChatGPT und Claude verbinden',
  description:
    'ChatGPT und Claude haben keinen Yahoo-Mail-Konnektor. So verbinden Sie Yahoo Mail mit beiden: ein Yahoo-App-Passwort und eine MCP-URL, danach kann die KI Ihre E-Mails lesen, durchsuchen, senden und ordnen.',
  coverAlt: 'Yahoo Mail über MCPEmails mit ChatGPT und Claude verbunden',
  content: `ChatGPT kann Yahoo Mail nicht von sich aus lesen, und Claude auch nicht. Die E-Mail-Plugins von ChatGPT decken Gmail, Outlook und iCloud Mail ab, die Konnektoren von Claude Gmail und geschäftliche Microsoft 365-Konten. Um Yahoo Mail mit einem der beiden zu verbinden, stellen Sie einen MCP-Server vor das Postfach. Mit MCPEmails brauchen Sie dafür ein Yahoo-App-Passwort und eine URL, und dasselbe Yahoo-Postfach funktioniert danach in ChatGPT, Claude und anderen KI-Apps.

**Direkt zu:** [Warum es keine eingebaute Option gibt](#warum-chatgpt-und-claude-yahoo-mail-noch-nicht-lesen-können) · [App-Passwort](#schritt-1-yahoo-app-passwort-erstellen) · [ChatGPT](#schritt-3a-in-chatgpt-hinzufügen) · [Claude](#schritt-3b-in-claude-hinzufügen) · [FAQ](#faq)

## Warum ChatGPT und Claude Yahoo Mail noch nicht lesen können

Die [Liste der verbundenen Apps](https://help.openai.com/en/articles/11487775-connectors-in-chatgpt) von OpenAI enthält Plugins für Gmail, Outlook und seit dem 27. Oktober 2026 für [iCloud Mail](/blog/chatgpt-icloud-mail-plugin). Ein Plugin für Yahoo Mail gibt es nicht. Die eigenen Konnektoren von Claude sind für Gmail und Microsoft 365 gedacht, wie [Kann Claude meine E-Mails lesen?](/blog/can-claude-read-my-email) erklärt.

Was man bei der Suche stattdessen findet:

- **Browser-Erweiterungen**, die in der Weboberfläche von Yahoo Mail einen ChatGPT-Button einblenden. Sie helfen beim Schreiben der Nachricht, die gerade offen ist. ChatGPT selbst hat weiterhin keinen Zugriff auf Ihr Postfach und kann es weder durchsuchen noch für Sie abarbeiten.
- **Automatisierungsplattformen**, die einzelne Nachrichten von Yahoo an ein KI-Modell weiterreichen, sobald ein Auslöser greift. Praktisch für einen festen Ablauf, nicht für Fragen zu Ihren E-Mails in einem Chat.
- **Kopieren und Einfügen** von Nachrichten in den Chat, was für eine E-Mail nach der anderen funktioniert.

Ein MCP-Server ist der Weg, der der KI Ihr tatsächliches Postfach gibt. ChatGPT und Claude akzeptieren ihn beide als benutzerdefinierten Konnektor, und die Anmeldung bei Yahoo übernimmt der Server. [So verbinden Sie jedes E-Mail-Konto mit Claude oder ChatGPT](/blog/connect-any-email-to-claude-and-chatgpt) vergleicht jeden Weg, gehostet und selbst betrieben.

## Was Sie brauchen

- Eine Yahoo-Mail-Adresse: yahoo.com, eine Länderversion wie yahoo.de, oder die Form ymail.com oder rocketmail.com, mit der Sie sich registriert haben.
- **Für ChatGPT:** Go oder ein kostenpflichtiger Tarif, auf chatgpt.com im Browser. OpenAI erlaubt im Free-Tarif keinen benutzerdefinierten MCP-Server, und in der Mobil-App lässt sich keiner hinzufügen.
- **Für Claude:** jeder Tarif, auch Free, der einen benutzerdefinierten Konnektor erlaubt.
- Ein kostenloses MCPEmails-Konto. [Hier erstellen](/signup); der kostenlose Tarif verbindet ein Postfach.

## Schritt 1: Yahoo-App-Passwort erstellen

Yahoo lässt andere Apps nicht mit Ihrem normalen Yahoo-Passwort anmelden, deshalb erstellen Sie ein App-Passwort für MCPEmails. Die [Hilfeseite von Yahoo](https://de.hilfe.yahoo.com/kb/SLN15241.html) beschreibt die Schritte:

1. Melden Sie sich bei Yahoo an und öffnen Sie die Seite **Account-Sicherheit**.
2. Klicken Sie unter **Externe Verbindungen** auf **App-Passwort erstellen**.
3. Geben Sie einen Namen ein, zum Beispiel MCPEmails, und klicken Sie auf **Passwort generieren**.
4. Kopieren Sie das Passwort. Yahoo zeigt es nur einmal an.

Wenn Sie die Option nicht finden, aktivieren Sie auf derselben Seite die Bestätigung in zwei Schritten und sehen Sie erneut nach. Um den Zugriff später zu entziehen, löschen Sie dieses App-Passwort auf demselben Bildschirm.

## Schritt 2: Yahoo Mail mit MCPEmails verbinden

1. Öffnen Sie im Dashboard von MCPEmails **Postfächer** und klicken Sie auf **Postfach verbinden**.
2. Wählen Sie **Yahoo Mail**.
3. Geben Sie Ihre vollständige Yahoo-Adresse ein und fügen Sie das App-Passwort ein.

Die Servereinstellungen werden für Sie ausgefüllt. MCPEmails prüft die Anmeldung bei Yahoo, bevor das Postfach gespeichert wird; ein falsches Passwort scheitert also hier und nicht später in einem Chat. Die [Seite mit den Yahoo-Mail-Einstellungen](/connect/yahoo) listet die IMAP- und SMTP-Daten und die häufigsten Fehler auf.

Eine AOL-Adresse ist ein eigenes Konto mit eigenem App-Passwort. Verbinden Sie sie als AOL, mit den [AOL-Einstellungen](/connect/aol).

## Schritt 3a: In ChatGPT hinzufügen

1. Öffnen Sie auf chatgpt.com **Plugins**, dann **Persönlich**, und klicken Sie auf **Hinzufügen**.
2. Wählen Sie **Benutzerdefinierten MCP-Server hinzufügen** und nennen Sie ihn MCPEmails.
3. Fügen Sie unter **Verbindung** diese URL ein:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Wählen Sie **OAuth**, setzen Sie das Häkchen bei **Ich verstehe und möchte fortfahren**, klicken Sie auf **Als Plugin erstellen** und melden Sie sich bei MCPEmails an.
5. Tippen Sie in einem Chat **@** und wählen Sie MCPEmails. Wiederholen Sie das, wenn eine Folgefrage Ihre E-Mails braucht.

OpenAI verschiebt diese Menüs von Zeit zu Zeit. Die [Einrichtungsseite für ChatGPT](/docs/chatgpt) zeigt den aktuellen Weg und Lösungen für die üblichen Fehler.

## Schritt 3b: In Claude hinzufügen

1. Öffnen Sie in claude.ai oder Claude Desktop **Anpassen**, dann **Konnektoren**.
2. Klicken Sie auf **+ Hinzufügen** und dann auf **Benutzerdefinierten Konnektor hinzufügen**.
3. Nennen Sie ihn MCPEmails, fügen Sie \`https://mcpemails.com/api/mcp\` ein, klicken Sie auf **Weiter** und dann auf **Hinzufügen**.
4. Klicken Sie auf **Verbinden**, melden Sie sich bei MCPEmails an und genehmigen Sie den Zugriff, den Claude haben soll.

Klicken Sie in einem Chat auf **+**, wählen Sie **Konnektoren** und schalten Sie MCPEmails ein. Die [Einrichtungsseite für Claude](/docs/claude) behandelt auch Team- und Enterprise-Tarife, in denen ein Owner den Konnektor zuerst hinzufügt.

Sie können beides tun. Ein MCPEmails-Konto bedient ChatGPT und Claude gleichzeitig, mit demselben Yahoo-Postfach.

## Was ChatGPT und Claude mit Yahoo Mail können

Beginnen Sie mit einer reinen Leseanfrage:

> Fassen Sie meine ungelesenen Yahoo-E-Mails von heute zusammen und sagen Sie mir, welche Nachrichten eine Antwort brauchen.

Sobald das funktioniert, kann die KI:

- Ihre E-Mails nach Absender, Betreff, Datum oder Ungelesen-Status lesen und durchsuchen.
- Von Ihrer Yahoo-Adresse aus senden, antworten und weiterleiten, auch mit Anhängen.
- Entwürfe speichern, die Sie fertigstellen, und einen Versand für später planen.
- Ordner anlegen und Nachrichten verschieben, archivieren, markieren oder löschen.
- Jede Nachricht mit der Signatur versehen, die Sie für das Postfach festgelegt haben.

Ein paar Prompts, die zu einem Yahoo-Postfach passen:

- „Finden Sie alle Newsletter dieses Monats und verschieben Sie sie in einen Ordner namens Lesestoff. Zeigen Sie mir zuerst die Liste.“
- „Entwerfen Sie eine Antwort auf die letzte E-Mail meines Vermieters, aber lassen Sie sie als Entwurf liegen.“
- „Was hat mir die Fluggesellschaft letzte Woche zu meiner Buchung geschickt?“

MCPEmails schickt neue E-Mails nicht von sich aus an die KI. Es prüft, wenn Sie danach fragen, was zum Aufarbeiten und Aufräumen gut passt.

## Ist das sicher?

Ihre Yahoo-E-Mails werden von MCPEmails nie gespeichert. Jede Nachricht wird live von Yahoo abgerufen, wenn ChatGPT oder Claude danach fragt, und danach verworfen. Aufbewahrt wird nur das App-Passwort, verschlüsselt. Ihr echtes Yahoo-Passwort geben Sie nirgends ein außer bei Yahoo.

Beim Genehmigen der Verbindung legen Sie fest, was jede KI-App darf: nur lesen oder auch senden. Der Inhaber eines Postfachs kann außerdem jeden Versand im Dashboard zur Freigabe anhalten. [Ist es sicher, einem KI-Agenten Zugriff auf E-Mails zu geben?](/blog/is-it-safe-to-give-ai-agent-email-access) behandelt die Risiken, die man kennen sollte, etwa Anweisungen, die in einer E-Mail versteckt sind.

## Fehlerbehebung

- **Yahoo lehnt das Passwort ab.** Verwenden Sie ein App-Passwort, nicht Ihr Yahoo-Passwort, und fügen Sie es ohne Leerzeichen ein.
- **Keine Option, ein App-Passwort zu erstellen.** Aktivieren Sie zuerst die Bestätigung in zwei Schritten auf der Seite Account-Sicherheit.
- **ChatGPT hat keine Option für einen benutzerdefinierten MCP-Server.** Sie brauchen Go oder einen kostenpflichtigen Tarif, auf chatgpt.com im Browser.
- **Die KI antwortet, ohne Ihre E-Mails zu lesen.** Erwähnen Sie MCPEmails in ChatGPT in dieser Nachricht mit @. Prüfen Sie in Claude, ob MCPEmails unter Konnektoren eingeschaltet ist.
- **Sie haben Yahoo und ein weiteres Postfach.** Verbinden Sie beide mit MCPEmails. [Mehrere E-Mail-Konten in Claude und ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) erklärt, wie die KI sie auseinanderhält.

## FAQ

**Kann ChatGPT Yahoo Mail lesen?**
Nicht von sich aus: ChatGPT hat kein Plugin für Yahoo Mail. Verbinden Sie Yahoo Mail mit einem Yahoo-App-Passwort mit einem MCP-Server wie MCPEmails, fügen Sie \`https://mcpemails.com/api/mcp\` in ChatGPT als benutzerdefinierten MCP-Server hinzu, und ChatGPT kann Ihre Yahoo-E-Mails lesen, durchsuchen und senden.

**Funktioniert Claude mit Yahoo Mail?**
Ja, über einen benutzerdefinierten Konnektor. Die eigenen E-Mail-Konnektoren von Claude decken Gmail und Microsoft 365 ab, Yahoo läuft deshalb über einen MCP-Server. Benutzerdefinierte Konnektoren funktionieren in jedem Claude-Tarif, auch in Free.

**Brauche ich mein Yahoo-Passwort?**
Nein. Yahoo akzeptiert es von anderen Apps nicht. Erstellen Sie auf der Seite Account-Sicherheit unter Externe Verbindungen ein App-Passwort und verwenden Sie dieses.

**Funktioniert dieselbe Einrichtung in ChatGPT und Claude?**
Ja. Verbinden Sie das Yahoo-Postfach einmal und fügen Sie dieselbe URL in jeder App hinzu. Jede App meldet sich getrennt bei MCPEmails an, mit eigenen Berechtigungen.

**Wie trenne ich die Verbindung?**
Entfernen Sie das Postfach in MCPEmails, oder löschen Sie das App-Passwort auf der Seite Account-Sicherheit bei Yahoo. Beides beendet den Zugriff.

## Nächster Schritt

[Kostenlos starten](/signup), Ihr Yahoo-Postfach mit einem App-Passwort verbinden und eine URL in ChatGPT oder Claude einfügen. [Was ist ein App-Passwort?](/blog/what-is-an-app-password) erklärt den Passwort-Schritt für Yahoo, AOL, iCloud und andere.`,
};

export default translation;
