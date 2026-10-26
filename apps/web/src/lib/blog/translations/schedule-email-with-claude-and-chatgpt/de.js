const translation = {
  title: 'E-Mail mit Claude oder ChatGPT planen: später senden, zur gewünschten Uhrzeit',
  description:
    'So planen Sie mit Claude oder ChatGPT eine E-Mail, die später von Ihrem eigenen Gmail-, Outlook-, iCloud- oder IMAP-Postfach verschickt wird: Einrichtung, Zeitzonen, Abbrechen und Grenzen.',
  coverAlt:
    'Claude und ChatGPT planen mit MCPEmails eine E-Mail, die später von einem verbundenen Postfach gesendet wird',
  content: `Damit Claude oder ChatGPT eine E-Mail zeitversetzt senden kann, braucht der Assistent ein E-Mail-Tool, das eine Nachricht vorhält und später verschickt. MCPEmails hat eines. Verbinden Sie Ihr Postfach, fügen Sie MCPEmails als Konnektor hinzu und sagen Sie, wann: „Schick das am Montag um 9:00 Uhr an Dana, Osloer Zeit.“ Die Nachricht wartet in einer Warteschlange auf dem Server von MCPEmails und wird zu diesem Zeitpunkt von Ihrer eigenen Adresse verschickt, ganz gleich, ob der Chat, die App oder Ihr Computer dann noch geöffnet ist.

Das funktioniert in Claude, in ChatGPT und in anderen MCP-Clients auf dieselbe Weise, und zwar mit Gmail und Google Workspace, Outlook und Microsoft 365, iCloud, Fastmail, Yahoo, Zoho und jedem Postfach, das IMAP und SMTP spricht.

**Direkt zu:** [Integrierte Konnektoren](#was-die-integrierten-e-mail-konnektoren-können) · [Einrichtung](#so-planen-sie-eine-e-mail-mit-claude-oder-chatgpt) · [Zeitzonen](#zeitzonen) · [Abbrechen oder ändern](#geplante-e-mail-prüfen-abbrechen-oder-ändern) · [FAQ](#faq)

## Was die integrierten E-Mail-Konnektoren können

Beide Assistenten bringen eigene E-Mail-Konnektoren mit. Das ist der Stand vom 20. Oktober 2026:

- **Claude.** Der Hilfeartikel von Anthropic zum Gmail-Konnektor nennt Suchen, Lesen, Entwürfe erstellen, Senden, Antworten und Weiterleiten. Das Planen einer Nachricht für später fehlt in dieser Liste.
- **ChatGPT.** Die Hilfeseite von OpenAI zur App Outlook Email behandelt das Suchen und Lesen von Nachrichten, Aktionen zu Personen und Kontakten sowie das Senden von reinen Text-E-Mails aus freigegebenen oder delegierten Postfächern. Die FAQ zur Google-App behandelt die Datennutzung und Aufgaben, die durch Gmail ausgelöst werden. Keine der beiden Seiten beschreibt zeitversetztes Senden.

ChatGPT hat allerdings **geplante Aufgaben**, die einen Prompt zu einer von Ihnen gewählten Zeit ausführen. Das ist nicht dasselbe wie eine E-Mail in der Warteschlange. Die Nachricht wird erst geschrieben, wenn die Aufgabe läuft, nicht wenn Sie den Wortlaut freigeben, und OpenAI weist darauf hin, dass Aktionen, die Ihre Freigabe brauchen, die Aufgabe anhalten können.

Ein geplanter Versand über MCPEmails ist eine fertige Nachricht: Sie lesen jetzt den genauen Text, und genau dieser Text wird zur festgelegten Zeit gesendet.

## So planen Sie eine E-Mail mit Claude oder ChatGPT

1. **Verbinden Sie Ihr Postfach mit MCPEmails.** Öffnen Sie im Dashboard **Postfächer**, dann **Postfach verbinden**, und wählen Sie Ihren Anbieter. Unter [connect](/connect) gibt es eine Seite pro Anbieter.
2. **Fügen Sie MCPEmails Ihrem Assistenten hinzu.** Öffnen Sie in Claude **Anpassen**, dann **Konnektoren**, klicken Sie auf **+ Hinzufügen**, wählen Sie **Benutzerdefinierten Konnektor hinzufügen** und fügen Sie \`https://mcpemails.com/api/mcp\` ein. Die [Anleitung für Claude](/blog/connect-claude-to-email) enthält jeden Schritt. In ChatGPT wird MCPEmails als benutzerdefinierter MCP-Konnektor hinzugefügt; welche Tarife das anbieten und wo das Menü liegt, hat sich dieses Jahr mehr als einmal geändert, folgen Sie also den aktuellen Schritten in der [Einrichtungsanleitung für ChatGPT](/docs/chatgpt).
3. **Erlauben Sie bei der Autorisierung das zeitversetzte Senden.** Der Zustimmungsbildschirm von MCPEmails bietet Zugriffsstufen an. Wählen Sie **Vollzugriff** oder **Benutzerdefiniert** mit aktiviertem zeitversetztem Senden. **Standard** enthält kein zeitversetztes Senden, eine Planungsanfrage wird dann abgelehnt.
4. **Beschreiben Sie die E-Mail und nennen Sie die Uhrzeit.** Geben Sie die Empfänger an, was drinstehen soll, Datum und Uhrzeit sowie Ihre Zeitzone.

Im Hintergrund ruft der Assistent das Tool \`schedule\` mit der Aktion \`create\` auf und übergibt Empfänger, Betreff, Text und Sendezeitpunkt. MCPEmails prüft Adressen, Betreff und Text sofort, eine fehlerhafte Adresse oder ein leerer Text wird also jetzt abgelehnt, statt am Montagmorgen zu scheitern. Eine gültige Adresse, die Sie nicht gemeint haben, kann es allerdings nicht von der gemeinten unterscheiden. Deshalb bitten die Prompts unten darum, den Empfänger vorher zu sehen. Das Ergebnis enthält den geplanten Zeitpunkt und eine ID, mit der der Assistent die Nachricht später abbrechen kann.

Zum Sendezeitpunkt verschickt ein Dispatcher auf dem Server von MCPEmails, der die Warteschlange jede Minute prüft, die Nachricht über den eigenen Anbieter des Postfachs: Gmail, Microsoft oder den SMTP-Server des Postfachs. Sie wird von Ihrer Adresse gesendet, mit Ihrer [Signatur](/blog/email-signatures-for-claude), die in diesem Moment angefügt wird. Rechnen Sie mit dem Versand innerhalb von etwa einer Minute nach der eingestellten Zeit; auf die Sekunde genau ist das nicht ausgelegt.

Weist der Mailserver die Nachricht ab, bevor er irgendetwas davon angenommen hat, versucht es der Dispatcher jede Minute erneut, bis zu 15 Minuten nach dem Sendezeitpunkt. Wurde das Postfach in der Zwischenzeit getrennt, wird die Nachricht gar nicht gesendet.

## Prompts, mit denen das Planen sauber klappt

> Schreib eine kurze Dankesmail an dana@example.com für das Gespräch heute und plane sie für Montag um 09:00 Uhr, Europe/Oslo. Zeig mir den Text und den Sendezeitpunkt, bevor du sie einplanst.

> Plane die Zahlungserinnerung unten von buchhaltung@ an die drei Adressen darin ein, für den 1. des nächsten Monats um 08:30 Uhr New Yorker Zeit.

> Welche E-Mails habe ich geplant? Liste Empfänger, Betreff und Sendezeitpunkt in meiner Zeitzone auf.

> Brich die geplante E-Mail an Dana ab.

Text und Uhrzeit vorher anzusehen kostet eine Nachricht mehr und fängt die zwei häufigsten Fehler ab: den falschen Empfänger und die falsche Stunde. Wenn Sie mehrere Postfächer betreuen, nennen Sie das Absenderpostfach („von buchhaltung@“); [mehrere E-Mail-Konten in Claude und ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) erklärt, wie der Assistent sie auseinanderhält.

## Zeitzonen

Das Tool \`schedule\` erwartet den Sendezeitpunkt als Zeitstempel mit Zeitzonen-Offset, zum Beispiel \`2026-11-02T09:00:00+01:00\`. Der Assistent macht aus „Montag um 9“ dieses Format, er muss also Ihre Zeitzone kennen. Nennen Sie im Prompt eine Stadt oder Zone („Osloer Zeit“, „Europe/Oslo“, „US Eastern“); ohne diese Angabe muss das Modell raten.

Gerade bei der Sommerzeit geht Raten schief. Oslo liegt bis zum letzten Sonntag im Oktober bei +02:00 und danach bei +01:00, 09:00 Uhr Osloer Zeit am 2. November 2026 ist also \`+01:00\`. Wenn Sie die Stadt nennen, kann der Assistent den richtigen Offset für dieses Datum wählen.

Die Bestätigung nennt die Zeit in UTC. Lassen Sie sich die Zeit vom Assistenten in Ihrer Ortszeit nennen, bevor Sie sich darauf verlassen. Ein Zeitpunkt, der schon in der Vergangenheit liegt, wird abgelehnt.

## Geplante E-Mail prüfen, abbrechen oder ändern

- **Sehen, was ansteht.** \`schedule_list\` liefert die ausstehenden Nachrichten, die früheste zuerst, mit Empfängern, Betreff, Sendezeitpunkt und Status. Fragen Sie nach allen Postfächern oder nach einem.
- **Abbrechen.** Das Tool \`schedule\` mit der Aktion \`cancel\` stoppt eine Nachricht, solange sie noch aussteht. Hat der Dispatcher mit dem Senden begonnen, lässt sie sich nicht mehr abbrechen.
- **Ändern.** Bearbeiten gibt es nicht. Bitten Sie den Assistenten, die Nachricht abzubrechen und die korrigierte Fassung neu zu planen; beides geht in einem Schritt.
- **Änderungen an der Signatur werden übernommen.** Die Signatur wird beim Senden angefügt, es gilt also auch eine Änderung, die Sie nach dem Planen vornehmen.

## Was geplantes Senden nicht kann

- **Innerhalb eines Verlaufs antworten.** Eine geplante E-Mail ist eine neue Nachricht mit eigenem Betreff und wird deshalb nicht als Antwort in den Verlauf eingeordnet. Für eine Antwort, die in die Unterhaltung gehört, lassen Sie den Assistenten einen Antwortentwurf speichern (\`draft\` mit der Aktion \`reply\`) und senden ihn selbst, wenn es so weit ist.
- **Auf einen Anhang in einer anderen E-Mail verweisen.** Die Datei muss in der Anfrage selbst enthalten sein, insgesamt 10 MB. Beim sofortigen Senden kann eine Datei direkt aus einer Nachricht in Ihrem Postfach angehängt werden; beim Planen nicht.
- **Wiederholen.** Jede geplante E-Mail wird einmal gesendet. Für eine wöchentliche Erinnerung planen Sie jede einzeln.
- **Die exakte Sekunde treffen.** Die Warteschlange wird einmal pro Minute geprüft.

Eine Planungsanfrage kann einen Idempotenzschlüssel mitbringen. Wiederholt der Assistent sie nach einem Verbindungsabbruch mit demselben Schlüssel, stellt MCPEmails die Nachricht nur einmal in die Warteschlange, nicht zweimal. [Doppelte E-Mails durch KI verhindern](/blog/prevent-duplicate-ai-agent-email-sends) erklärt, wie das geht.

## Wo die Nachricht wartet

Das meiste, was MCPEmails tut, passiert live: E-Mails werden für jede Anfrage von Ihrem Anbieter abgerufen und nicht gespeichert. Eine geplante E-Mail kann so nicht funktionieren, denn sie muss bis zu ihrem Sendezeitpunkt irgendwo liegen. MCPEmails speichert sie verschlüsselt (AES-256-GCM) in seiner Datenbank in Stockholm und entschlüsselt sie nur, um sie zu senden oder um Empfänger und Betreff anzuzeigen, wenn Sie Ihre geplanten E-Mails auflisten. Eine abgebrochene Nachricht wird nie gesendet. Details stehen auf der [Sicherheitsseite](/security).

## FAQ

**Kann Claude eine E-Mail planen, die später gesendet wird?**
Ja, über einen MCP-Server mit einem Tool für zeitversetztes Senden. Verbinden Sie Ihr Postfach mit MCPEmails, fügen Sie es Claude als benutzerdefinierten Konnektor hinzu, erlauben Sie das Planen und bitten Sie Claude, die Nachricht zu einem bestimmten Datum und einer bestimmten Uhrzeit in Ihrer Zeitzone zu senden. Der eigene Gmail-Konnektor von Anthropic nennt das Planen nicht.

**Kann ChatGPT eine E-Mail planen?**
Ja, auf dieselbe Weise: Fügen Sie MCPEmails als benutzerdefinierten MCP-Konnektor hinzu ([Einrichtung](/docs/chatgpt)) und fragen Sie. Die geplanten Aufgaben von ChatGPT führen einen Prompt später aus, das ist etwas anderes, als eine fertige Nachricht in die Warteschlange zu stellen.

**Muss Claude oder ChatGPT offen bleiben, bis die E-Mail verschickt ist?**
Nein. Die Nachricht liegt in der Warteschlange auf dem Server von MCPEmails und wird von dort gesendet. Sie können den Chat, die App und Ihren Computer schließen.

**Mit welchen E-Mail-Anbietern funktioniert das Planen?**
Mit jedem Postfach, von dem MCPEmails senden kann: Gmail und Google Workspace, Outlook und Microsoft 365, iCloud, Fastmail, Yahoo, Zoho, Yandex und andere IMAP- und SMTP-Postfächer. Die Nachricht wird über den eigenen Anbieter dieses Postfachs gesendet.

**Wie breche ich eine geplante E-Mail ab?**
Bitten Sie den Assistenten darum. Er sucht die Nachricht mit \`schedule_list\` heraus und bricht sie über ihre ID ab, was bis zu dem Moment funktioniert, in dem das Senden beginnt.

## Nächster Schritt

[Kostenlos starten](/signup), Postfach verbinden und Claude oder ChatGPT bitten, eine Test-E-Mail an Sie selbst einzuplanen, die in fünf Minuten gesendet wird. Die [Anleitung für Claude](/blog/connect-claude-to-email) und die [Anleitung für ChatGPT](/blog/connect-chatgpt-to-email) behandeln die Verbindung, und die [Tool-Referenz](/docs#tools) listet jedes Argument fürs Planen auf.`,
};

export default translation;
