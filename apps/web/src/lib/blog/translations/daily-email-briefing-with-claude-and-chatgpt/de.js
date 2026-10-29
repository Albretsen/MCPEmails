const translation = {
  title: 'Tägliche E-Mail-Übersicht mit Claude und ChatGPT: Posteingang nach Zeitplan zusammenfassen',
  description:
    'Drei Wege zu einer täglichen Zusammenfassung Ihres Posteingangs: eine geplante Aufgabe in Claude, eine geplante Aufgabe in ChatGPT oder eine Morgenübersicht, die MCPEmails ganz ohne Chat in Ihr Postfach legt. Einrichtung, Prompts und Grenzen.',
  coverAlt:
    'Eine tägliche E-Mail-Übersicht von Claude und ChatGPT fasst neue E-Mails aus verbundenen Postfächern zusammen',
  content: `**Eine tägliche E-Mail-Übersicht von Claude oder ChatGPT bekommen Sie, wenn Sie dem Assistenten zwei Dinge geben: Zugriff auf Ihr Postfach und einen Zeitplan.** Beide Assistenten führen inzwischen geplante Aufgaben aus. Claude führt einen Prompt stündlich, täglich, wöchentlich oder an Werktagen aus, ChatGPT zu einer festen Uhrzeit, und das in jedem Tarif. Verbinden Sie die Aufgabe über einen Konnektor mit Ihrem Postfach, und jeden Morgen wartet die Zusammenfassung auf Sie.

Es gibt einen dritten Weg, der ganz ohne Chat auskommt: MCPEmails kann zur gewünschten Uhrzeit eine Morgenübersicht direkt in Ihr Postfach legen. Dieser Leitfaden behandelt alle drei, mit den passenden Prompts und den Grenzen jedes Wegs.

**Direkt zu:** [Claude](#eine-tägliche-e-mail-zusammenfassung-mit-claude) · [ChatGPT](#eine-geplante-posteingangsübersicht-in-chatgpt) · [Morgenübersicht](#die-morgenübersicht-ganz-ohne-chat) · [Welcher Weg passt](#welcher-weg-passt) · [Prompts](#prompts-für-eine-nützliche-übersicht) · [FAQ](#faq)

## Zuerst: Geben Sie dem Assistenten Ihr Postfach

Eine geplante Aufgabe kann nur E-Mails zusammenfassen, die sie erreicht. Der eigene Gmail-Konnektor von Claude erreicht ein Google-Konto, und sein Microsoft 365-Konnektor erreicht geschäftliche Konten, sobald ein Administrator ihn genehmigt hat. ChatGPT hat eine eigene Gmail-App. Für alles andere, oder für mehrere Postfächer in einer Übersicht, verbinden Sie die Postfächer über einen MCP-Server.

MCPEmails ist ein gehosteter MCP-Server. Sie verbinden jedes Postfach einmal und fügen dann eine einzige Konnektor-URL zu Claude oder ChatGPT hinzu:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

Das funktioniert mit Gmail und Google Workspace, Outlook und Microsoft 365, iCloud, Yahoo, Fastmail, Zoho und jedem Postfach, das IMAP und SMTP spricht. Jedes verbundene Postfach erscheint im Assistenten mit Namen, sodass eine Übersicht Ihre eigene Adresse, info@ und ein privates Gmail-Konto zusammen abdecken kann. [Mehrere E-Mail-Konten in Claude und ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) erklärt diese Einrichtung.

Eine Übersicht liest nur, verbinden Sie also mit **Nur-Lese-Zugriff**, wenn der Einwilligungsbildschirm danach fragt. Eine Aufgabe, die läuft, während Sie weg sind, kann dann nichts senden, verschieben oder löschen, egal was in den gelesenen E-Mails steht. [Nur-Lese-Zugriff](/docs/read-only-access) listet genau auf, was diese Verbindung kann.

## Eine tägliche E-Mail-Zusammenfassung mit Claude

Die geplanten Aufgaben von Claude gehören zu Cowork in der Claude-App und sind in jedem bezahlten Tarif enthalten (Pro, Max, Team und Enterprise). Laut [Hilfeartikel von Anthropic](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-cowork) kann eine Aufgabe stündlich, täglich, wöchentlich, an Werktagen oder nur auf Ihren Start hin laufen, und sie nutzt dieselben Konnektoren wie Ihre anderen Aufgaben. Aufgaben laufen in der Cloud, halten ihren Zeitplan also auch ein, wenn Ihr Computer schläft oder die App geschlossen ist, es sei denn, die Aufgabe braucht lokale Dateien oder Apps.

1. **MCPEmails zu Claude hinzufügen.** Öffnen Sie **Anpassen → Konnektoren**, klicken Sie auf **+ Hinzufügen** und dann auf **Benutzerdefinierten Konnektor hinzufügen**. Geben Sie den Namen MCPEmails und \`https://mcpemails.com/api/mcp\` ein, klicken Sie auf **Weiter**, übernehmen Sie die erkannten Anmeldeeinstellungen und klicken Sie auf **Hinzufügen**. Melden Sie sich bei MCPEmails an und wählen Sie **Nur-Lese-Zugriff**. Die [Einrichtungsanleitung für Claude](/blog/connect-claude-to-email) zeigt jeden Bildschirm.
2. **Die Aufgabe anlegen.** Klicken Sie in der Seitenleiste auf **Scheduled**, dann auf **New task**, und wählen Sie **Create with Claude** oder **Set up manually**. Sie können die Aufgabe auch in einer Unterhaltung beschreiben („fasse an jedem Werktag um 7 Uhr meinen Posteingang zusammen“), und Claude schlägt Name, Zeitplan und Anweisungen vor, die Sie mit **Schedule** bestätigen.
3. **Den Prompt für die Übersicht einfügen**, aus dem [Abschnitt mit den Prompts](#prompts-für-eine-nützliche-übersicht), und **Weekdays** oder **Daily** wählen.
4. **Einmal von Hand ausführen**, um das Ergebnis vor dem ersten geplanten Lauf zu prüfen.

In Claude lässt sich jedes Konnektor-Tool auf **Immer zulassen**, **Genehmigung erforderlich** oder **Blockiert** stellen. Blockieren Sie für eine Übersicht die Tools von MCPEmails zum Senden und Organisieren, oder lassen Sie die Verbindung bei Nur-Lese-Zugriff, damit die Aufgabe eine Zusammenfassung bleibt.

## Eine geplante Posteingangsübersicht in ChatGPT

Laut [Hilfeartikel von OpenAI zu Aufgaben](https://help.openai.com/en/articles/10291617-tasks-in-chatgpt) gibt es geplante Aufgaben in jedem Tarif, auch in Free und Go. Free führt eine Aufgabe höchstens einmal am Tag in einem groben Zeitfenster wie „morgens“ aus. Bezahlte Tarife können Aufgaben bis zu stündlich zu einer genauen Uhrzeit ausführen. Jeder Tarif begrenzt die Zahl aktiver Aufgaben, von 3 in Free bis 15 in Pro und Enterprise. Sie legen eine Aufgabe auf der Seite **Scheduled** an oder bitten im Chat darum, und ChatGPT kann Sie per Push oder E-Mail benachrichtigen, wenn sie fertig ist.

Aufgaben können unterstützte Apps nutzen, und OpenAI nennt Gmail, Slack und GitHub. Liegen Ihre E-Mails in einem Gmail-Konto, ist die eigene Gmail-App von ChatGPT die einfachste Quelle für die Aufgabe.

Der Artikel von OpenAI sagt nicht, ob ein selbst hinzugefügter MCP-Server innerhalb einer Aufgabe verfügbar ist. Um MCPEmails zu nutzen, fügen Sie es wie in der [Einrichtungsanleitung für ChatGPT](/docs/chatgpt) beschrieben hinzu, planen die Aufgabe dann ein paar Minuten im Voraus und prüfen, ob der erste Lauf Ihre E-Mails liest, bevor Sie sich darauf verlassen. OpenAI weist außerdem darauf hin, dass eine Aktion, die eine Nachricht sendet oder Daten ändert, Ihre Freigabe brauchen und die Aufgabe anhalten kann, ein weiterer Grund, eine Übersicht schreibgeschützt zu halten.

## Die Morgenübersicht: ganz ohne Chat

Die Tarife Pro und Business von MCPEmails enthalten eine **Morgenübersicht**: eine tägliche Zusammenfassung, die MCPEmails auf seinen eigenen Servern erstellt und zur eingestellten Uhrzeit direkt in eines Ihrer Postfächer legt. Kein Assistent, kein Chat und keine geöffnete App ist beteiligt, sie kommt also auch an Tagen an, an denen Sie Claude oder ChatGPT gar nicht öffnen.

Jede Übersicht deckt Ihren Tag in Ihrer Zeitzone ab:

- **VIP-Absender zuerst.** Neue E-Mails von den Adressen oder Domains, die Sie angeben, über alle Ihre Postfächer hinweg.
- **Neue E-Mails pro Postfach** seit der letzten Übersicht: wie viele Nachrichten und die neuesten Absender und Betreffzeilen.
- **Fällige Nachfassungen.** Erinnerungen, die Ihre KI für E-Mails ohne Antwort gesetzt hat.
- **Zurückgestellte E-Mails**, die später am Tag wieder auftauchen.
- **Geplante Sendungen**, die später am Tag rausgehen.

Sie deckt bis zu 10 verbundene Postfächer ab. Tage ohne Neues werden übersprungen statt leer verschickt. Die Übersicht wird direkt in das Postfach eingefügt, es wird also nichts gesendet und nichts verlässt Ihr Postfach. Sie entsteht nach festen Regeln, ohne dass ein KI-Modell Ihre E-Mails liest.

Zum Einschalten öffnen Sie im Dashboard **Einstellungen**, suchen bei den Workspace-Einstellungen **Morgenübersicht**, setzen das Häkchen bei **Jeden Tag eine Morgenübersicht in meinen Posteingang legen** und wählen Uhrzeit, Ihre Zeitzone, das Zielpostfach und eventuelle VIP-Absender. Nur Inhaber und Admins des Workspace können das ändern.

Die Nachfassungen und zurückgestellten E-Mails in der Übersicht kommen von Ihrer KI und gehören zu denselben Tarifen. Sagen Sie Claude oder ChatGPT „erinnere mich, wenn Dana bis Freitag nicht geantwortet hat“ oder „stell das bis Montagmorgen zurück“, und MCPEmails verfolgt das auf seinen Servern weiter, auch wenn der Chat geschlossen ist.

## Welcher Weg passt

- **Sie wollen die Zusammenfassung in klarer Sprache, mit einer Einschätzung, was wichtig ist:** eine geplante Aufgabe in Claude oder ChatGPT. Das Modell liest die E-Mails und entscheidet, was es hervorhebt.
- **Sie wollen sie jeden Tag, ohne von einer Chat-App oder deren Aufgabenlimits abzuhängen:** die Morgenübersicht. Sie kommt zur eingestellten Uhrzeit in Ihr Postfach und improvisiert nie.
- **Sie wollen beides:** Die beiden ergänzen sich. Die Übersicht liefert jeden Morgen die feste Liste, und zu allem darin fragen Sie den Assistenten.

Wenn Sie E-Mails lieber sortiert als zusammengefasst haben möchten: [Automatische Regeln für die E-Mail-Triage](/blog/automated-email-triage-rules) verschieben, labeln und markieren neue E-Mails nach Zeitplan, ohne Modell.

## Prompts für eine nützliche Übersicht

Bitten Sie um ein kurzes, festes Format. Eine Übersicht, die Sie in einer Minute lesen, lesen Sie auch weiterhin.

> Gib mir mit MCPEmails meine Morgenübersicht für alle verbundenen Postfächer: was seit gestern um diese Zeit eingegangen ist, was heute eine Antwort von mir braucht und alles mit einer Frist in dieser Woche. Nach Postfach gruppiert, höchstens 10 Zeilen. Nichts senden, verschieben oder ändern.

> Liste mit MCPEmails die ungelesenen E-Mails der letzten 24 Stunden in sales@ und info@ auf, die von Kunden oder Interessenten stammen. Für jede: Absender, eine Zeile Zusammenfassung und ob sie heute eine Antwort braucht. Newsletter und Benachrichtigungen weglassen. Nur lesen.

> Durchsuche mit MCPEmails meinen Posteingang nach Rechnungen, Verträgen und allem, was eine Zahlung oder ein Fälligkeitsdatum erwähnt und in der letzten Woche eingegangen ist. Eine Zeile pro Treffer, mit Betrag und Datum, falls angegeben. Nur lesen.

„Nur lesen“ in den Prompt zu schreiben ist eine gute Gewohnheit, der verlässliche Schutz ist aber die Verbindung selbst: Eine Verbindung mit Nur-Lese-Zugriff kann nicht senden, auch wenn eine Nachricht das Modell dazu auffordert. E-Mails schreiben andere Leute, und manche davon sind darauf angelegt, KI-Assistenten zu steuern. [Ist es sicher, einem KI-Agenten Zugriff auf E-Mails zu geben?](/blog/is-it-safe-to-give-ai-agent-email-access) erklärt, warum.

Weitere Prompts für die Triage finden Sie unter [Triage und Posteingangszusammenfassungen mit KI-Agenten](/blog/ai-agent-triage-summarize-inbox). Wenn Sie nach Zeitplan eine Antwort schreiben statt lesen wollen, behandelt [E-Mail mit Claude oder ChatGPT planen](/blog/schedule-email-with-claude-and-chatgpt) den zeitversetzten Versand.

## FAQ

**Kann Claude meine E-Mails jeden Tag zusammenfassen?**
Ja. Legen Sie in Claude (Pro, Max, Team oder Enterprise) eine geplante Aufgabe an, die täglich oder an Werktagen läuft, mit einem Konnektor zu Ihrem Postfach. Der Gmail-Konnektor von Claude deckt ein Google-Konto ab, MCPEmails deckt jeden Anbieter und mehrere Postfächer gleichzeitig ab.

**Kann ChatGPT meinen Posteingang nach Zeitplan zusammenfassen?**
Ja. Die geplanten Aufgaben von ChatGPT können in jedem Tarif die Gmail-App nutzen, in Free höchstens einmal am Tag. OpenAI sagt nicht, ob ein benutzerdefinierter MCP-Server innerhalb einer Aufgabe funktioniert, testen Sie also einen Lauf, bevor Sie sich darauf verlassen.

**Läuft die Aufgabe, wenn mein Computer aus ist?**
Die geplanten Aufgaben von Claude laufen in der Cloud, außer sie brauchen lokale Dateien oder Apps. Die Aufgaben von ChatGPT laufen bei OpenAI. Die Morgenübersicht von MCPEmails läuft auf unseren Servern und landet in jedem Fall in Ihrem Postfach.

**Werden meine E-Mails für die Übersicht gespeichert?**
Nicht von MCPEmails. E-Mails werden für jede Anfrage live bei Ihrem Anbieter abgerufen und verworfen, sobald die Antwort gesendet ist. Die Morgenübersicht wird in Ihr eigenes Postfach geschrieben, nicht von uns aufbewahrt. Siehe [Sicherheit](/security).

**Welcher Tarif enthält die Morgenübersicht?**
Pro und Business. Eine geplante Aufgabe in Claude oder ChatGPT kann in jedem Tarif von MCPEmails über MCPEmails lesen, auch in Free mit einem Postfach. Die aktuellen Tarife stehen auf der [Preisseite](/pricing).

## Nächster Schritt

[Kostenlos starten](/signup), Ihr meistgenutztes Postfach mit Nur-Lese-Zugriff verbinden, MCPEmails zu Claude oder ChatGPT hinzufügen und den Prompt für die Übersicht einmal von Hand ausführen. Wenn das Ergebnis passt, legen Sie einen Zeitplan dafür fest.`,
};

export default translation;
