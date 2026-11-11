const translation = {
  title: 'Mehrere E-Mail-Konten mit einem KI-Agenten verwalten',
  description:
    'Arbeits-, Privat- und Nebengeschäfts-Postfächer über einen KI-Agenten: wie er die Postfächer findet, wie Sie eine Anfrage eingrenzen, Absendernamen, die korrekt bleiben, und die Prüfung vor dem Senden pro Postfach.',
  coverAlt:
    'Ein KI-Agent, der mit MCPEmails mit Arbeits-, Privat- und Nebengeschäfts-E-Mail-Konten verbunden ist',
  content: `Fast niemand hat nur ein Postfach. Sie haben eine Arbeitsadresse, eine private Adresse und mindestens eine weitere für ein Nebengeschäft oder eine Domain, die Sie noch besitzen. Jede Frage, die zwei Konten berührt, wird zur manuellen Suche an zwei Orten.

Ein KI-Agent über alle Konten hinweg nimmt Ihnen das Umschalten ab, aber nur, wenn der Agent weiß, welches Postfach welches ist, und Antworten von der richtigen Adresse rausgehen.

**Direkt zu:** [Erkennung](#ihr-agent-findet-die-postfächer-selbst) · [Eine Anfrage eingrenzen](#eine-anfrage-auf-ein-postfach-eingrenzen) · [Tariflimits](#wo-die-tariflimits-liegen)

## Warum ein Agent besser ist als das Wechseln zwischen E-Mail-Programmen

Ein E-Mail-Programm zeigt Ihnen Konten. Es beantwortet keine Fragen. „In welchem meiner Konten ist die Quittung von Stripe gelandet?“ ist eine Suche über drei Postfächer plus eine Einschätzung. Ein Agent mit Zugriff auf jedes Postfach erledigt das in einer Anfrage, und Sie hören auf, der Verteiler zu sein. Der zweite Gewinn: ein Satz Gewohnheiten, weil hinter jedem Konto dieselben Tools stehen. [Mehrere E-Mail-Konten in Claude und ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) behandelt die Einrichtung des Konnektors in beiden Apps.

## Ihr Agent findet die Postfächer selbst

Sie fügen nie eine Postfach-ID in einen Prompt ein. Der Agent ruft \`inbox_list\` auf, das jedes Postfach zurückgibt, das Ihr Schlüssel nutzen darf, jeweils mit UUID, E-Mail-Adresse, Anzeigename, Anbieter, gegebenenfalls der Marke des Dienstes und einem Objekt mit den Fähigkeiten. Jedes andere Tool nimmt entweder \`inbox_id\` (eine UUID oder eine Adresse) oder \`inbox\` (eine Adresse), ausgefüllt aus diesem Ergebnis.

Zwei Details lohnen sich zu kennen:

- **Die Erkennung ist kostenlos.** \`inbox_list\` wird nie gezählt, ein Agent kann sich also jederzeit neu orientieren.
- **Widersprüchliche Angaben werden abgelehnt, nicht geraten.** Ein Aufruf mit einer \`inbox_id\` für ein Postfach und einer \`inbox\`-Adresse für ein anderes wird abgelehnt, und der Fehler nennt beide. Die übliche Ursache ist eine veraltete ID aus einem früheren Teil der Unterhaltung. Sagen Sie dem Agenten, er soll es allein mit der Adresse erneut versuchen.

## Eine Anfrage auf ein Postfach eingrenzen

Nennen Sie das Konto. Adressen funktionieren überall dort, wo eine ID funktioniert, normale Sprache reicht also:

> Nur in jane@acme.com: Listen Sie alles Ungelesene der letzten zwei Tage auf und sagen Sie mir, was heute eine Antwort braucht. Lassen Sie meine anderen Konten in Ruhe.

Sie können die Eingrenzung auch außerhalb des Prompts erzwingen. Im Dashboard hat jeder API-Schlüssel eine Einstellung **Postfachzugriff**: alle Postfächer oder eine ausdrückliche Liste. Ein Schlüssel, der auf Ihr Nebengeschäfts-Postfach beschränkt ist, kann die anderen beiden nicht lesen, egal was ein Prompt sagt.

## Fan-out heißt: Der Agent ruft einmal pro Postfach auf

Das ist der Teil, den viele falsch verstehen: **Ein Aufruf erreicht ein Postfach.** Auflisten, Lesen, Suchen, Verschieben und Löschen sind alle auf ein einzelnes Postfach begrenzt, und es gibt kein automatisches Fan-out. „Durchsuche alle meine Konten“ heißt also, dass der Agent die Suche einmal pro Postfach ausführt und die Ergebnisse selbst zusammenführt. Das funktioniert gut, mit drei Folgen:

- Lassen Sie ihn zuerst \`inbox_list\` aufrufen, oder sagen Sie, wie viele Konten Sie haben. Geht er von einem aus, berichtet er selbstbewusst über eines.
- Bitten Sie um eine zusammengeführte Antwort („eine kombinierte Liste, markiert mit dem Konto, aus dem jeder Eintrag stammt“), sonst bekommen Sie drei getrennte Berichte.
- Das Volumen wächst mit der Zahl der Postfächer. Eine Triage über drei Postfächer sind mindestens drei Aufrufe, nicht einer.

## Namen und Absenderidentität

Ein Feld erledigt drei Aufgaben. Jedes Postfach hat einen Anzeigenamen: Er ist die **Bezeichnung** in Ihrer Liste im Dashboard, der \`display_name\`, den der Agent aus \`inbox_list\` liest, und der Name, den Empfänger im From-Header vor der Adresse sehen.

„arbeit2“ ist deshalb gleich doppelt ein schlechter Name: Der Agent kann nicht erkennen, wofür das Postfach ist, und irgendein E-Mail-Programm zeigt „arbeit2“ neben Ihrer Adresse an. Verwenden Sie etwas, das ein Fremder lesen könnte, etwa „Jane Doe (Acme)“ oder „Studio Nordseite“. Setzen Sie ihn im Dashboard unter dem **Absendername** des Postfachs oder mit \`signature_set\`, und lesen Sie ihn mit \`signature_get\` zurück. Namen sind auf 100 Zeichen begrenzt.

Von einem Alias zu senden funktioniert, aber nur von Adressen, die Sie nachweislich besitzen:

- Ihre eigene verbundene Adresse funktioniert immer als From-Wert, bei jedem Anbieter.
- Bei einem IMAP-Postfach (iCloud, Yahoo, GMX, Gmail per App-Passwort, jeder SMTP-Host) funktioniert eine **andere** Adresse, sobald sie bestätigt ist. Fügen Sie sie in den Einstellungen dieses Postfachs im Dashboard hinzu und geben Sie dann den Code ein, den MCPEmails an diese Adresse schickt. Bestätigte Adressen stehen unter \`sender_identities\` im \`inbox_list\`-Eintrag dieses Postfachs.
- Outlook sendet von der verbundenen Adresse.
- Eine From-Adresse, die für das Postfach nicht bestätigt ist, wird abgelehnt statt stillschweigend umgeschrieben.

Signaturen gelten ebenfalls pro Postfach: eine förmliche auf der Arbeitsadresse, keine auf der privaten. Siehe [E-Mail-Signaturen für Claude](/blog/email-signatures-for-claude).

## Prüfung vor dem Senden pro Postfach

Die Prüfung wird pro Postfach eingestellt. Jedes Postfach hat eine Einstellung **Vor dem Senden prüfen** mit drei Optionen: sofort senden, eine Prüfkarte in der KI-Unterhaltung anzeigen oder nur im Dashboard prüfen.

Das macht eine gemischte Einrichtung bequem: Das Nebengeschäfts-Postfach bleibt auf sofortigem Senden, jede Sendung von der Arbeit wird zur Prüfung angehalten. In beiden Prüfmodi wird die E-Mail vorbereitet, aber nicht zugestellt, und die Freigabe passiert nur in einer angemeldeten Browser-Sitzung eines Inhabers oder Admins. Die Karte in der Unterhaltung ist eine Bequemlichkeit, keine Berechtigungsgrenze. [Menschliche Freigabe für E-Mail-Sendungen von KI-Agenten](/blog/approve-ai-agent-email-sends) geht tiefer.

## Drei kontoübergreifende Routinen zum Abschauen

**Eine Morgen-Triage über alles.** Bitten Sie um eine einzige sortierte Liste, nicht um eine Zusammenfassung pro Konto:

> Prüfen Sie alle meine verbundenen Postfächer. Geben Sie mir eine kombinierte Liste dessen, was heute eine Antwort braucht, neueste zuerst, markiert mit dem Konto, in dem es eingegangen ist. Verschieben, senden oder löschen Sie nichts.

Das [Playbook zur Posteingangs-Triage](/blog/ai-agent-triage-summarize-inbox) enthält Bewertungsregeln, die Sie in diesen Prompt einfügen können.

**Einen Verlauf finden, wenn Sie das Konto vergessen haben.**

> Finden Sie die Rechnung von Hetzner aus dem August. Durchsuchen Sie jedes verbundene Postfach und sagen Sie mir, in welchem Konto sie liegt und wie hoch der Betrag ist.

**Eine Unterhaltung zwischen Rollen verschieben.** Wenn aus einem privaten Kontakt ein Kunde wird, leiten Sie den Verlauf an das Geschäftspostfach weiter und lassen die Antwort von der Geschäftsadresse verfassen. Bitten Sie den Agenten, zuerst zu bestätigen, von welchem Postfach er sendet.

## Was sich ändert, wenn Sie Gmail, Outlook und IMAP mischen

Gemischte Einrichtungen sind der Normalfall, und die Anbieter sind sich nicht einig, was ein Ordner ist.

- **Gmail hat Labels.** Ein Verschieben fügt ein Label hinzu und entfernt die Nachricht aus dem Posteingang. Andere Labels bleiben, eine Nachricht kann also an mehreren Orten liegen.
- **IMAP hat Ordner.** Ein Verschieben ist ein Verschieben: Die Nachricht verlässt einen Ordner und landet in einem anderen.
- **Outlook hat verschachtelte Ordner.** Ein Verschieben ist ein Verschieben wie bei IMAP, und Ordner können in anderen Ordnern liegen. Outlook hat keine Labels, die Label-Aktion einer Automatisierung setzt also stattdessen eine Outlook-Kategorie.
- **Ordnernamen unterscheiden sich.** Archiv, Alle Nachrichten, Spam, Junk und übersetzte Namen variieren pro Anbieter. Lassen Sie den Agenten \`folder_list\` für das Postfach aufrufen, das er gleich anfasst.
- **Die Ordner-Eingrenzung gilt pro Postfach.** Eine Suche auf bestimmte Ordner zu beschränken gilt innerhalb eines Postfachs, eine ordnerbegrenzte Suche über Konten hinweg ist also weiterhin ein Aufruf pro Konto.

[Gmail-Labels oder IMAP-Ordner](/blog/gmail-labels-vs-imap-folders-ai-agents) erklärt, was „Archivieren“ auf jeder Seite wirklich bedeutet.

## Wo die Tariflimits liegen

Verbundene Postfächer sind das, wonach die Tarife bemessen sind:

- **Free** verbindet ein Postfach.
- **Personal** verbindet mehrere Postfächer für eine Person, mit höherem Burst-Ratenlimit und bevorzugtem Support per E-Mail.
- **Pro** verbindet noch mehr Postfächer für eine Person, die ein Unternehmen führt, mit noch höherem Burst-Ratenlimit, längerem Analyseverlauf und Webhooks für neue E-Mails.
- **Business** ist für ein Team und wird pro Person abgerechnet: Jede Person verbindet ihre eigenen Postfächer privat, gemeinsame Adressen gelten für das ganze Unternehmen (ein Kontingent inklusive, mit einem Preis pro weiterem Postfach), dazu Rollen, Admins, die angehaltene Sendungen freigeben, und ein eigener Workspace pro Kunde oder Unternehmen.

Eine kontoübergreifende Routine ist ein Aufruf pro Postfach, die Zahl Ihrer Postfächer bestimmt das Volumen also genauso wie Ihre Gewohnheiten. Die aktuellen Zahlen und Preise stehen auf der [Preisseite](/pricing).

## FAQ

**Woher weiß der Agent, welches Postfach ich meine?**
Aus \`inbox_list\`, das Adresse und Anzeigename jedes Postfachs zurückgibt, das er nutzen darf. Nennen Sie die Adresse in Ihrer Anfrage. Eine Postfach-ID und eine Adresse, die sich widersprechen, werden abgelehnt, nicht geraten.

**Gehen Antworten von der richtigen Adresse raus?**
Ja, wenn Sie aus dem Postfach senden, dem die Adresse gehört: Jedes Postfach sendet über seinen eigenen Anbieter, Anzeigenamen und seine eigene Signatur. Eine andere From-Adresse funktioniert bei einem IMAP-Postfach, sobald Sie sie mit einem Code bestätigt haben, der an diese Adresse geschickt wird. Outlook sendet von der verbundenen Adresse, und eine unbestätigte From-Adresse wird abgelehnt.

**Kann ich den Agenten aus einem Postfach frei senden lassen und ein anderes anhalten?**
Ja. „Vor dem Senden prüfen“ ist eine Einstellung pro Postfach, ein Postfach kann also sofort senden, während ein anderes in einem angemeldeten Browser auf Ihre Freigabe wartet.

**Werden meine E-Mails aus all diesen Konten irgendwo gespeichert?**
Nein. Nachrichteninhalte werden bei jeder Anfrage live von Ihrem Anbieter abgerufen und verworfen. Aufbewahrt wird nur die verschlüsselte Zugangsberechtigung für den Anbieter. Siehe [Sicherheit](/security).

## Nächster Schritt

[Kostenlos starten](/signup), das Postfach mit dem meisten Verkehr verbinden und Ihren Agenten fragen, was heute eine Antwort braucht. Fügen Sie das zweite und dritte Konto hinzu, wenn Sie eine Antwort statt drei wollen. Die [Dokumentation](/docs) enthält die vollständige Tool-Referenz, und die [Anbieterdetails](/docs/providers) zeigen, was jeder Postfachtyp unterstützt.`,
};

export default translation;
