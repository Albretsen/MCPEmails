const translation = {
  title: 'Inbox Zero mit KI: Claude räumt Ihr echtes Postfach auf',
  description:
    'Inbox Zero mit KI erreichen: Claude sortiert, archiviert, labelt und entwirft Antworten in Ihrem echten Gmail-, Outlook- oder IMAP-Postfach über MCP. Eine wiederholbare Routine, die genauen Prompts, und warum nichts gespeichert wird.',
  coverAlt:
    'Inbox Zero mit KI erreichen: Claude sortiert, archiviert und entwirft Antworten in Ihrem echten Postfach über MCP',
  content: `Inbox Zero hatte schon immer dasselbe Problem: Dorthin zu kommen kostet eine Stunde, die Sie nicht haben, und morgen sind Sie wieder bei fünfzig ungelesenen Nachrichten. Ein KI-Agent verändert die Rechnung. Statt dass Sie eine Nachricht nach der anderen sortieren, sagen Sie Claude, was „erledigt“ bedeutet, und es arbeitet das ganze Postfach auf einmal durch: sortieren, archivieren, labeln und Antworten entwerfen, in Ihren *echten* E-Mails, live.

Diese Anleitung ist die Routine: eine wiederholbare Schleife für jeden Morgen, die genauen Prompts, die sie antreiben, und die eine Regel, die das Ganze sicher hält (nichts wird je gespeichert). Sie setzt voraus, dass Claude Ihr Postfach bereits sehen kann. Falls noch nicht, beginnen Sie mit [Gmail mit Claude verbinden](/blog/connect-gmail-to-claude) (oder der [Anleitung für Outlook und Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp)), das dauert etwa zwei Minuten, und kommen Sie dann zurück. Bei iCloud, Fastmail, GMX, web.de oder einem anderen IMAP-Anbieter nutzen Sie stattdessen die [Anleitung, Claude mit E-Mail zu verbinden](/blog/connect-claude-to-email).

## Warum „Inbox Zero“ mit KI endlich realistisch ist

Inbox Zero scheitert an Volumen plus Urteilsvermögen. Die meisten Nachrichten brauchen eine *Entscheidung* (archivieren, antworten, zurückstellen, löschen), und fünfzig kleine Entscheidungen zu treffen ist anstrengend. Genau darin ist Claude gut: Nachricht lesen, Ihre Regeln anwenden, handeln. Beim vierzigsten Newsletter wird es nicht müde.

Die entscheidende Verschiebung: Sie hören auf, E-Mails zu *bearbeiten*, und fangen an, sie zu *beaufsichtigen*. Sie legen die Regeln fest („archiviere jeden Newsletter, markiere alles von Kunden, entwirf Antworten, die ich freigeben kann“), und Claude setzt sie in einem Durchgang über das ganze Postfach um.

## Die Morgenroutine in fünf Prompts

Führen Sie sie der Reihe nach aus. Jeder ist ein normaler Satz; Claude ordnet ihn im Hintergrund dem richtigen Tool zu (\`email_read\`, \`email_organize\`, \`draft\`).

**1. Überblick verschaffen.**

> „Fassen Sie meine ungelesenen E-Mails der letzten 24 Stunden zusammen. Gruppieren Sie sie in: braucht eine Antwort, zur Kenntnis, und Rauschen.“

Claude listet Ihre ungelesenen E-Mails auf, liest sie und gibt Ihnen einen sortierten Überblick statt einer Wand aus Betreffzeilen. Sie wissen jetzt in einem Absatz, womit Sie es zu tun haben.

**2. Rauschen beseitigen.**

> „Archivieren Sie jeden Newsletter und jede Werbe-E-Mail in dieser Liste. Fassen Sie nichts an, was von einer echten Person kommt.“

Hier erledigt \`email_organize\` die langweilige Arbeit: Archivieren in großen Mengen, damit Ihr Posteingang nur noch enthält, was Sie vielleicht braucht. Die Hälfte des Postfachs verschwindet meist an dieser Stelle.

**3. Den Rest labeln.**

> „Labeln Sie alles von einem Kunden oder zu einer Rechnung als ‚Priorität‘ und alles, bei dem ich nur in Kopie bin, als ‚Zur Kenntnis‘.“

Jetzt sind die verbleibenden Nachrichten sortiert. Claude setzt Gmail-Labels (oder Ordner bei Outlook und IMAP), sodass die wichtigen Verläufe sichtbar gruppiert sind, bevor Sie auch nur eine Sekunde Aufmerksamkeit investieren.

**4. Antworten entwerfen, aber nicht senden.**

> „Schreiben Sie für jede E-Mail, die eine Antwort braucht, einen kurzen Entwurf in meinem Ton. Speichern Sie sie als Entwürfe; senden Sie nichts.“

Das ist der Teil, der die Stunde wirklich spart. Claude legt echte \`draft\`-Entwürfe in Ihrem Postfach an, bereit zum Überfliegen, Anpassen und Senden. Sie behalten die Kontrolle über jede ausgehende Nachricht. Lesen Sie [OAuth oder API-Schlüssel](/blog/oauth-vs-api-keys-ai-email-access), wenn Sie lieber nur Lesezugriff gewähren und Claude gar nicht senden lassen wollen.

**5. Den Rest zurückstellen.**

> „Planen Sie für die zwei Verläufe, bei denen ich mich noch nicht entschieden habe, eine Erinnerung für morgen früh.“

Alles, was Sie nicht klären können, bekommt einen \`schedule\`-Anstoß, sodass es Ihren Kopf verlässt, ohne für immer im Posteingang zu bleiben. Das ist Inbox Zero: nichts unerledigt, nichts vergessen.

## Zur Gewohnheit machen, nicht zur Pflicht

Die Routine oben dauert etwa fünf Minuten, sobald Claude die Arbeit macht. Ein paar Wege, wie Leute sie beibehalten:

- **Ein Auslösesatz.** Speichern Sie die ganze Abfolge als eine Nachricht: *„Führen Sie meine morgendliche Posteingangs-Triage aus.“* Claude merkt sich die Schritte innerhalb einer Unterhaltung, eine Zeile startet also die Schleife.
- **Regeln mit der Zeit verfeinern.** Wenn Claude etwas archiviert, das es nicht sollte, sagen Sie es einmal („Archivieren Sie nie etwas von meiner Vorgesetzten“) und nehmen es in Ihre festen Anweisungen auf.
- **Wöchentliche Grundreinigung.** Einmal pro Woche: *„Finden Sie jede ungelesene E-Mail, die älter als einen Monat ist, und archivieren oder löschen Sie sie.“* An diesen Altlasten stirbt Inbox Zero meistens; lassen Sie Claude sie abräumen. Mehr Muster finden Sie in [Die besten Wege, Claude Ihr Postfach verwalten zu lassen](/blog/best-ways-to-let-claude-manage-your-inbox) und im [Playbook zur Posteingangs-Triage](/blog/ai-agent-triage-summarize-inbox).

## Die eine Regel, die das Ganze sicher hält

Einer KI das ganze Postfach zu geben klingt riskant, bis Sie wissen, wohin die Daten gehen: **nirgendwohin.** Mit MCPEmails ruft jeder dieser Prompts Ihre E-Mails live von Gmail, Outlook oder IMAP ab, übergibt sie Claude für diese eine Aktion und verwirft sie sofort. Nachrichtentexte, Betreffzeilen und Anhänge der E-Mails, die Claude liest, werden nie gespeichert. Aufbewahrt wird pro Postfach ein verschlüsseltes Token, damit der nächste Aufruf möglich ist, plus die wenigen Angaben, die eine von Ihnen eingeschaltete Funktion braucht, etwa eine geplante Nachricht, die auf ihren Versand wartet. Das ist der Unterschied zwischen einem Agenten einen *Schlüssel* zu geben und ihm eine *dauerhafte Kopie von allem* zu geben; hier steht, [warum es wichtig ist, dass E-Mails nie gespeichert werden](/blog/why-email-never-stored-matters), und hier die vollständige [Sicherheitsanalyse](/blog/is-it-safe-to-give-ai-agent-email-access), wenn Sie das Bedrohungsmodell wollen.

Beim Senden behalten Sie außerdem eine harte Grenze: Entwürfe bleiben Entwürfe, bis Sie sie freigeben, und Sie können Nur-Lese-Zugriff gewähren, sodass Claude schlicht nicht senden kann.

## Heute auf null kommen

Sie brauchen weder eine neue E-Mail-App noch ein Produktivitätssystem, nur Ihr bestehendes Postfach und einen Agenten, der darin handeln kann. Verbinden Sie Ihr Postfach einmal, fügen Sie den Endpunkt in Claude ein und führen Sie die fünf Prompts oben aus. Der Free-Tarif braucht keine Karte und verbindet ein Postfach, dauerhaft.

[Verbinden Sie Ihr Postfach kostenlos](/signup) und bitten Sie Claude, Ihre ungelesenen E-Mails zu sortieren. Inbox Zero, beaufsichtigt statt erlitten.`,
};

export default translation;
