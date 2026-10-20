const translation = {
  title: 'Claude IMAP-Konnektor: jedes IMAP-Postfach mit Claude verbinden',
  description:
    'Einen IMAP-Konnektor für Claude einrichten, für jedes Postfach mit IMAP/SMTP: Servereinstellungen, App-Passwörter, TLS-Ports, Sicherheitshinweise, Grenzen und Fehlerbehebung.',
  coverAlt: 'Claude über MCP Emails mit einem IMAP- und SMTP-Postfach verbunden',
  content: `Ein **Claude IMAP-Konnektor** lässt Claude mit Postfächern arbeiten, für die es keine native Claude-Integration gibt: Fastmail, iCloud Mail, Yahoo, Zoho, Yandex, ein Postfach auf Ihrer eigenen Domain oder fast jeder Anbieter, der IMAP und SMTP bereitstellt.

Claude meldet sich nicht selbst am Mailserver an und bekommt Ihr Postfach-Passwort nicht direkt in die Hand. MCP Emails sitzt dazwischen. Es verbindet sich mit dem Anbieter über IMAP für eingehende und SMTP für ausgehende E-Mails und stellt Claude einheitliche Tools des [Model Context Protocol](https://modelcontextprotocol.io) bereit. Dieser Unterschied ist wichtig: IMAP und SMTP kümmern sich um das Postfach, MCP gibt Claude sichere, strukturierte Aktionen wie Lesen, Suchen, Antworten und Verschieben.

Diese Anleitung behandelt den allgemeinen Konnektor und die Einrichtung auf der Claude-Seite. Wenn Sie iCloud oder Fastmail nutzen und die genauen Bildschirme für App-Passwörter und Servernamen brauchen, halten Sie die [Anleitung für iCloud, Fastmail und IMAP](/blog/connect-icloud-fastmail-imap-to-claude) daneben offen.

## Was der Claude IMAP-Konnektor tatsächlich macht

Die Verbindung hat drei Teile:

1. **Ihr E-Mail-Anbieter** stellt IMAP zum Lesen und Organisieren von Nachrichten bereit, dazu SMTP zum Senden.
2. **MCP Emails** hält die Zugangsdaten verschlüsselt, spricht mit diesen Servern und macht aus deren Antworten berechenbare E-Mail-Tools.
3. **Claude** verbindet sich mit dem MCP-Endpunkt und ruft nur die Tools auf, die die von Ihnen genehmigten Berechtigungen erlauben.

Claude braucht also keine IMAP-Bibliothek, keine SMTP-Konfiguration und kein Passwort im Prompt. Nach der Verbindung findet es mit \`inbox_list\` das Postfach, mit \`email_read\` listet, liest und durchsucht es Nachrichten oder ruft Anhänge ab, mit \`email_compose\` sendet, beantwortet und leitet es weiter, und mit \`email_organize\` verschiebt, kopiert, markiert oder archiviert es Nachrichten. Eigene Tools decken Ordner, Entwürfe, Planung, Kontakte und Löschen ab; die vollständige Liste steht in der [Tool-Referenz](/docs#tools).

## Was Sie vor der Einrichtung brauchen

Sammeln Sie diese Angaben von der Hilfeseite Ihres E-Mail-Anbieters oder von Ihrem Administrator:

- **E-Mail-Adresse:** zum Beispiel \`you@example.com\`. Diese Adresse wird beim verbundenen Postfach angezeigt.
- **Benutzername für die Anmeldung:** meist die vollständige E-Mail-Adresse. Manche Hoster für eigene Domains vergeben einen abweichenden IMAP/SMTP-Benutzernamen.
- **IMAP-Host und Port:** zum Beispiel \`imap.example.com\` auf Port \`993\` für IMAP über implizites TLS. Diese Verbindung übernimmt Lesen, Suchen, Ordner und Aktionen an Nachrichten.
- **SMTP-Host und Port:** zum Beispiel \`smtp.example.com\` auf Port \`465\` oder \`587\`. Port \`465\` nutzt implizites TLS, \`587\` wechselt per STARTTLS zu einer verschlüsselten Verbindung. Diese Verbindung übernimmt Senden, Antworten und Weiterleiten.
- **Passwort:** am besten ein widerrufbares App-Passwort, das für den Zugriff durch E-Mail-Programme erstellt wurde.

Raten Sie die Servernamen nicht aus der Domain, wenn Ihr Anbieter Einstellungen veröffentlicht. E-Mail-Hosting ist oft vom Webhosting getrennt, und eine Adresse auf einer eigenen Domain kann eine anbieterspezifische Anmeldung nutzen, die von der sichtbaren Adresse abweicht.

Verwenden Sie ein **App-Passwort**, wann immer der Anbieter eines anbietet. Es ist von Ihrem Hauptpasswort getrennt und lässt sich widerrufen, ohne das Passwort zu ändern, mit dem Sie sich anmelden. Anbieter verlangen oft die Zwei-Faktor-Authentifizierung, bevor Sie eines erstellen können. Manche verlangen außerdem, dass Sie zuerst den IMAP-Zugriff in den E-Mail-Einstellungen aktivieren.

MCP Emails enthält Vorlagen für iCloud, Yahoo, Zoho und Yandex sowie einen eigenen Ablauf für Fastmail-App-Passwörter. Diese Auswahl füllt die bekannten Hosts und Ports für Sie aus. Wählen Sie **Generic IMAP** für einen anderen Anbieter oder Ihren eigenen Mailserver und geben Sie die Werte selbst ein.

## Schritt 1: das IMAP/SMTP-Postfach verbinden

1. [Erstellen Sie Ihr MCP-Emails-Konto oder melden Sie sich an](/signup) und öffnen Sie dann **Dashboard → Postfächer → Postfach verbinden**.
2. Wählen Sie den Anbieter mit Namen, wenn es ihn in der Liste gibt. Sonst wählen Sie **IMAP / SMTP**.
3. Geben Sie E-Mail-Adresse und App-Passwort ein. Beim allgemeinen Konnektor tragen Sie außerdem IMAP-Host und Port, SMTP-Host und Port sowie einen abweichenden Benutzernamen ein, falls Ihr Hoster Ihnen einen gegeben hat.
4. Speichern Sie die Verbindung. MCP Emails prüft die Zugangsdaten gegen den IMAP-Server, bevor das Postfach gespeichert wird. Eine abgelehnte Anmeldung oder ein nicht erreichbarer TLS-Endpunkt fällt also hier auf und nicht erst später in Claude.

Die üblichen sicheren Standardwerte sind IMAP \`993\`, dazu SMTP \`465\` oder \`587\`. Sie sind nicht austauschbar: Verwenden Sie den Port und den Sicherheitsmodus, die Ihr Anbieter dokumentiert. MCP Emails behandelt SMTP-Port \`587\` als STARTTLS und alle anderen eingetragenen SMTP-Ports als implizites TLS. Verbindungen ohne TLS-Unterstützung werden abgelehnt.

## Schritt 2: MCP Emails als Claude-Konnektor hinzufügen

Wenn das Postfach verbunden ist, richten Sie Claude auf MCP Emails aus:

1. Öffnen Sie in claude.ai **Anpassen → Konnektoren**.
2. Wählen Sie **Konnektor hinzufügen** und geben Sie \`https://www.mcpemails.com/api/mcp\` ein.
3. Wählen Sie **Verbinden**, melden Sie sich bei MCP Emails an und genehmigen Sie nur die Berechtigungen, die der Workflow braucht.

Ein Zusammenfassungs-Workflow braucht zum Beispiel Lese- und Suchzugriff, aber keinen Sende- oder Löschzugriff. Ein Antwort-Workflow braucht Sendezugriff. Ordnerverwaltung und endgültiges Löschen haben eigene Berechtigungen, sodass destruktive Aktionen gesperrt bleiben, bis Sie sie wirklich brauchen. Der Ablauf auf der Client-Seite steht ausführlicher in der [Anleitung zur Verbindung von Claude mit E-Mail](/blog/connect-claude-to-email).

Machen Sie dann einen kleinen Funktionstest:

\`\`\`
Suchen Sie mit inbox_list mein IMAP-Postfach. Listen Sie meine fünf neuesten ungelesenen Nachrichten auf und fassen Sie sie zusammen. Senden, verschieben oder löschen Sie nichts.
\`\`\`

Wenn Claude mit \`inbox_list\` beginnt, erhält es die richtige \`inbox_id\`, statt sich auf eine kopierte UUID zu verlassen.

## Was Claude über IMAP kann

Sobald die Verbindung steht, kann Claude:

- Nachrichten auflisten und lesen, die live vom Anbieter abgerufen werden.
- Nach Absender, Empfänger, Betreff, Textinhalt, Lesestatus, Markierung und Datum suchen.
- Unterstützte Anhänge innerhalb der dokumentierten Größen- und Formatgrenzen herunterladen oder auslesen.
- Neue Nachrichten über SMTP senden oder antworten und weiterleiten, wobei der relevante Nachrichtenkontext erhalten bleibt.
- E-Mails in IMAP-Ordnern verschieben, kopieren, markieren, archivieren und organisieren.
- Entwürfe erstellen und verwalten, Nachrichten planen und Kontakte durchsuchen, wo das Tool den Vorgang unterstützt.
- E-Mails in den Papierkorb verschieben oder, mit ausdrücklicher Löschberechtigung und \`permanent: true\`, über IMAP endgültig entfernen.

Mit dieser letzten Fähigkeit sollten Sie vorsichtig sein. Endgültiges Löschen über IMAP umgeht den Papierkorb und lässt sich unter Umständen nicht rückgängig machen. MCP Emails stellt das Löschen als eigenes destruktives Tool bereit, und der MCP-Client steuert das Bestätigungsverhalten. Gewähren Sie \`delete:email\` trotzdem nur Workflows, die es brauchen.

## Wichtige Grenzen von IMAP

Ein IMAP-Konnektor deckt viel ab, macht aber nicht jeden Anbieter gleich.

- **Kein Push bei eingehenden E-Mails:** MCP Emails arbeitet nur nach dem Anfrage-Antwort-Prinzip. Es sendet keine Webhooks und stößt Claude nicht an, wenn eine Nachricht eintrifft. Ein automatisierter Workflow muss in festen Abständen abfragen, zum Beispiel indem er ungelesene E-Mails auflistet.
- **Die Suche hängt vom Übertragungsweg ab:** Strukturierte Filter für Absender, Betreff, Text und Datum funktionieren bei allen Anbietern, aber allgemeines IMAP unterstützt den Suchfilter \`has_attachment\` nicht. Die eigene Suchsyntax eines Anbieters lässt sich nicht übertragen.
- **Ordner sind keine Gmail-Labels:** IMAP verschiebt eine Nachricht zwischen Ordnern, während Gmail einer Nachricht mehrere Labels geben kann. Den praktischen Unterschied erklärt [Gmail-Labels und IMAP-Ordner](/blog/gmail-labels-vs-imap-folders-ai-agents).
- **Zum Senden ist SMTP nötig:** Eine funktionierende IMAP-Anmeldung beweist, dass Claude eingehende E-Mails erreicht, nicht dass SMTP-Host, Port oder Sendeberechtigung stimmen. Testen Sie eine harmlose ausgehende Nachricht, bevor Sie sich auf einen Antwort-Workflow verlassen.
- **Die Regeln des Anbieters gelten weiter:** Speicherkontingente, Sendelimits, Grenzen für gleichzeitige Verbindungen, Spamfilter und Einschränkungen durch Administratoren bleiben bestehen.

## Fehlerbehebung bei einer Claude-IMAP-Verbindung

### „Authentication failed“ beim Verbinden des Postfachs

Verwenden Sie ein App-Passwort, nicht das Passwort für die Website des Anbieters. Prüfen Sie, ob Zwei-Faktor-Authentifizierung und IMAP-Zugriff aktiviert sind, falls der Anbieter das verlangt. Kopieren Sie das erzeugte Passwort erneut, ohne Leerzeichen am Anfang oder Ende. Liegt die Adresse auf einer eigenen Domain, prüfen Sie, ob der Benutzername die vollständige E-Mail-Adresse oder ein separater Kontoname ist.

### Der Server antwortet nicht oder TLS schlägt fehl

Prüfen Sie die Schreibweise des Hosts und verwenden Sie die sicheren Ports, die Ihr Anbieter dokumentiert. Beginnen Sie mit IMAP \`993\`; für SMTP nehmen Sie den dokumentierten Port \`465\` oder \`587\`. Ein Website-Hostname, der Hostname eines Kundenportals oder die reine Domain ist nicht unbedingt ein Mailserver. Bei einem eigenen Server prüfen Sie außerdem, ob die Firewall Verbindungen von außerhalb Ihres Netzwerks annimmt und ob das TLS-Zertifikat zum Mail-Hostnamen passt.

### Claude kann lesen, aber nicht senden

Die IMAP-Einstellungen funktionieren, aber SMTP ist davon getrennt. Prüfen Sie SMTP-Hostname und Port erneut, stellen Sie sicher, dass die Zugangsdaten SMTP- oder „Mail“-Zugriff haben, und prüfen Sie, ob der Anbieter authentifiziertes Senden für die Absenderadresse erlaubt. Fastmail-App-Passwörter sollten zum Beispiel mit Zugriff **Mail (IMAP/SMTP)** erstellt werden, nicht mit reinem Lesezugriff.

### Claude findet das Postfach nicht

Bitten Sie Claude, \`inbox_list\` erneut aufzurufen. Erscheint das Postfach nicht, prüfen Sie seinen Status im Dashboard von MCP Emails und verbinden Sie es neu, falls das App-Passwort widerrufen oder ausgetauscht wurde. Erscheint das Postfach, wird eine Aktion aber verweigert, verbinden Sie den Claude-Konnektor neu oder ergänzen Sie den API-Schlüssel um die nötige Berechtigung.

### Die Suchergebnisse sind enger als erwartet

Beginnen Sie mit strukturierten Feldern wie \`from\`, \`subject\`, \`text\`, \`since\` und \`before\`, und geben Sie bei Bedarf an, welche Ordner durchsucht werden sollen. Kopieren Sie keine Gmail-Operatoren in eine allgemeine IMAP-Suche und erwarten Sie dasselbe Verhalten. Denken Sie daran, dass der Filter auf vorhandene Anhänge bei allgemeinem IMAP ignoriert wird.

## Sicherheit: Zugangsdaten bleiben außerhalb von Claude

MCP Emails speichert das OAuth-Token oder IMAP-App-Passwort, das für künftige Aufrufe nötig ist, im Ruhezustand verschlüsselt mit AES-256-GCM. Gewöhnliche Postfachinhalte werden live abgerufen, wenn ein Tool läuft, und zwischen den Aufrufen nicht gespeichert. Der Datenverkehr nutzt TLS, und Sie können ein App-Passwort beim Anbieter widerrufen oder das Postfach im Dashboard trennen.

Diese klare Grenze ist der Hauptgrund, eine MCP-Brücke zu nutzen, statt Zugangsdaten in einen Chat oder eine lokale Konfiguration einzufügen: Claude erhält eingeschränkte E-Mail-Fähigkeiten, nicht die Schlüssel zum Postfach. Details zu Speicherung und Bedrohungsmodell finden Sie unter [warum „E-Mails werden nie gespeichert“ zählt](/blog/why-email-never-stored-matters) und in der [Sicherheitsübersicht](/security).

## Kurz zusammengefasst

Ein Claude IMAP-Konnektor ist eine IMAP/SMTP-Verbindung zu einem Postfach, die Claude als MCP-Tools angeboten wird. Sammeln Sie die sicheren Servereinstellungen, erstellen Sie ein widerrufbares App-Passwort, verbinden Sie das Postfach in MCP Emails und fügen Sie \`https://www.mcpemails.com/api/mcp\` in Claude hinzu. Testen Sie zuerst den Lesezugriff, fügen Sie Sende- oder destruktive Berechtigungen bewusst hinzu, und nutzen Sie die Checkliste zur Fehlerbehebung oben, wenn der Anbieter die Verbindung ablehnt.

Bereit für einen Versuch? [Verbinden Sie ein IMAP-Postfach](/signup) oder nutzen Sie die [Anleitung für einzelne Anbieter](/blog/connect-icloud-fastmail-imap-to-claude) für Details zu iCloud und Fastmail.`,
};

export default translation;
