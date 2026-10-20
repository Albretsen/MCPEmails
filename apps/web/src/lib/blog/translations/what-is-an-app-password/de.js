const translation = {
  title: 'Was ist ein App-Passwort? So erstellen Sie es bei jedem E-Mail-Anbieter',
  description:
    'Was ein App-Passwort ist, warum E-Mail-Programme und KI-Konnektoren eines brauchen, wo Sie es bei Gmail, iCloud, Yahoo, AOL, Fastmail und Zoho erstellen und wie Sie es widerrufen.',
  coverAlt: 'Ein App-Passwort verbindet über MCPEmails ein E-Mail-Postfach mit einem KI-Agenten',
  content: `Ein **App-Passwort** ist ein eigenes Passwort, das Ihr E-Mail-Anbieter für eine einzelne App erzeugt. Damit meldet sich diese App an Ihrem Postfach an, ohne Ihr eigentliches Kontopasswort zu kennen. Sie erstellen es in den Sicherheitseinstellungen Ihres Kontos, fügen es einmal in das E-Mail-Programm oder den Konnektor ein und löschen es, sobald diese eine App keinen Zugriff mehr haben soll. Ihr normales Passwort und alle anderen Apps funktionieren weiter.

Wenn Sie ein Postfach mit Thunderbird, Apple Mail oder über einen MCP-Server wie MCPEmails mit einem KI-Agenten verbinden, ist ein fehlendes oder falsches App-Passwort der häufigste Grund, warum die Anmeldung scheitert. Diese Anleitung erklärt, was ein App-Passwort ist, warum IMAP-Programme eines brauchen, wo jeder große Anbieter es erzeugt und wie Sie es widerrufen.

**Direkt zu:** [App-Passwort erstellen](#wo-sie-ein-app-passwort-bei-jedem-anbieter-erstellen) · [App-Passwort widerrufen](#so-widerrufen-sie-ein-app-passwort) · [Sicherheitshinweise](#sicherheitshinweise) · [FAQ](#faq)

## Was ist ein App-Passwort?

Ein App-Passwort ist eine lange, zufällig erzeugte Zugangsberechtigung, die zu Ihrem E-Mail-Konto gehört, aber nur für eine einzige Anwendung ausgestellt wird. Drei Dinge unterscheiden es von dem Passwort, das Sie im Webmail eingeben:

- **Der Anbieter erzeugt es.** Sie wählen es nicht selbst. Google erzeugt einen 16-stelligen Code, bei Apple hat es das Format \`abcd-efgh-ijkl-mnop\`, und die meisten Anbieter zeigen es genau einmal.
- **Es ersetzt Ihr Passwort dort, wo kein zweiter Faktor abgefragt werden kann.** E-Mail-Programme verbinden sich über IMAP (Lesen) und SMTP (Senden), und diese Protokolle können keine Zwei-Faktor-Abfrage anzeigen. Über ein App-Passwort lässt der Anbieter ein solches Programm zu, ohne die Anmeldung im Web zu schwächen.
- **Es lässt sich einzeln widerrufen.** Löschen Sie es, verliert nur die App, die es benutzt hat, den Zugriff. Sonst ändert sich nichts am Konto.

Google beschreibt es als 16-stelligen Sicherheitscode, der einer App oder einem Gerät die Berechtigung gibt, auf Ihr Google-Konto zuzugreifen (in der Praxis besteht der Code aus 16 Buchstaben). Apple spricht von einem **app-spezifischen Passwort**, Zoho **application-specific password**, GMX und WEB.DE **App-Passwort**. Gemeint ist immer dasselbe.

## Warum IMAP-Programme und KI-Konnektoren eines brauchen

Viele E-Mail-Anbieter akzeptieren Ihr normales Passwort nicht mehr von einem fremden E-Mail-Programm, vor allem nicht, sobald die Zwei-Faktor-Authentifizierung aktiv ist. Ein Desktop-E-Mail-Programm, die eingebaute Mail-App des Smartphones oder ein Server, der in Ihrem Auftrag E-Mails liest, sprechen alle IMAP und SMTP, und bei Google, Apple, Yahoo, AOL, Fastmail und Yandex ist die Zugangsberechtigung, die diese Protokolle akzeptieren, ein App-Passwort.

Ein KI-Konnektor ist in genau derselben Lage. Wenn Claude oder ChatGPT über [einen MCP-E-Mail-Server](/blog/what-is-an-mcp-email-server) mit Ihrem Postfach arbeitet, meldet sich nicht die KI selbst am Postfach an. Das übernimmt der MCP-Server, über IMAP und SMTP, genau wie Thunderbird. Für iCloud, Yahoo, AOL, Fastmail, Gmail und ähnliche Anbieter braucht der Server also ein App-Passwort, und der KI-Client bekommt nur ein Token mit begrenzten Berechtigungen für den Server. Die [Anleitung zu OAuth und API-Schlüsseln für den E-Mail-Zugriff](/blog/oauth-vs-api-keys-ai-email-access) behandelt diese zweite Ebene.

Der typische Fehler: Man fügt das Passwort ein, mit dem man sich auf der Website des Anbieters anmeldet. Das ist der häufigste Grund, warum sich eine Mail-App oder ein KI-Connector nicht anmelden kann. Erzeugte App-Passwörter haben eine erkennbare Form. Deshalb prüft das Verbindungsformular von MCPEmails bei Gmail, iCloud, Yahoo, Yandex und Fastmail, was Sie einfügen, und warnt Sie, bevor der Versuch beim Anbieter ankommt, der ihn sonst als fehlgeschlagene Anmeldung zählen würde. Wenn Sie sicher sind, dass der Wert stimmt, klicken Sie erneut auf **Verbinden**, und er wird trotzdem gesendet.

## Wo Sie ein App-Passwort bei jedem Anbieter erstellen

Jeder Eintrag nennt, wo das App-Passwort erzeugt wird und was vorher eingeschaltet sein muss. Die verlinkte Einrichtungsseite des jeweiligen Anbieters enthält die IMAP- und SMTP-Einstellungen und alle Schritte.

- **Gmail und Google Workspace:** Aktivieren Sie die **Bestätigung in zwei Schritten** und erstellen Sie dann unter \`myaccount.google.com/apppasswords\` ein App-Passwort. Der Code besteht aus 16 Buchstaben in vier Gruppen; Leerzeichen spielen keine Rolle. Google nennt drei Fälle, in denen die Option fehlt: manche Konten von Arbeitgebern, Schulen oder anderen Organisationen (bei Workspace ist das eine Einstellung Ihres Administrators), aktivierte erweiterte Sicherheit und eine Bestätigung in zwei Schritten, die nur mit Sicherheitsschlüsseln eingerichtet ist. Einrichtung: [Gmail](/connect/gmail), [Google Workspace](/connect/google-workspace).
- **iCloud Mail:** Die Zwei-Faktor-Authentifizierung ist Pflicht. Öffnen Sie unter \`account.apple.com\` den Bereich **Anmelden und Sicherheit**, dann **App-spezifische Passwörter**, und erzeugen Sie eines. Bis zu 25 können gleichzeitig aktiv sein. Einrichtung: [iCloud Mail](/connect/icloud).
- **Yahoo Mail:** Wählen Sie auf der Yahoo-Seite **Account Security** unter **External connections** die Option **Create app password**, vergeben Sie einen Namen und erzeugen Sie es. Einrichtung: [Yahoo Mail](/connect/yahoo).
- **AOL Mail:** Wählen Sie auf der AOL-Seite **Account Security** die Option **Generate app password** (bei manchen Konten **Generate and manage app passwords**), dann **Get Started**, vergeben Sie einen Namen und erzeugen Sie es. AOL verlangt, dass Sie das in einem Browser tun, mit dem Sie sich schon seit mehreren Tagen bei AOL Mail anmelden, und nicht in einem privaten Fenster. Ein Yahoo-App-Passwort öffnet kein AOL-Postfach, auch wenn beide auf derselben Plattform laufen. Einrichtung: [AOL Mail](/connect/aol).
- **verizon.net:** Verizon hat seinen E-Mail-Dienst eingestellt, und die verbliebenen verizon.net-Postfächer sind heute AOL-Konten. Sie erstellen also ein **AOL**-App-Passwort und melden sich mit Ihrer vollständigen verizon.net-Adresse an. Einrichtung: [verizon.net](/connect/verizon).
- **Fastmail:** Gehen Sie zu **Settings**, **Privacy & Security**, **Connected apps & API tokens**, **Manage app passwords and access**, **New app password**. Behalten Sie die Standard-Zugriffsstufe **Mail, Contacts & Calendars** bei; ein Passwort nur für Files kann sich nicht bei Mail anmelden. Fastmail verbindet sich ausschließlich mit einem App-Passwort, und im Basic-Tarif von Fastmail lässt sich keines erstellen. Einrichtung: [Fastmail](/connect/fastmail).
- **Zoho Mail:** Aktivieren Sie zuerst in Zoho Mail unter **Settings**, **Mail Accounts** den **IMAP Access**. Ohne Zwei-Faktor-Authentifizierung funktioniert Ihr Zoho-Passwort; mit Zwei-Faktor-Authentifizierung, föderierter Anmeldung (zum Beispiel über Google) oder SAML erstellen Sie in Ihrem Zoho-Konto ein application-specific password und verwenden dieses. Einrichtung: [Zoho Mail](/connect/zoho).
- **Yandex Mail:** Aktivieren Sie IMAP unter **Mail clients** in den Einstellungen von Yandex Mail und öffnen Sie dann auf der Sicherheitsseite unter \`id.yandex.com\` den Bereich **App passwords**, um eines für ein E-Mail-Programm zu erstellen. Yandex zeigt es einmal an. Einrichtung: [Yandex Mail](/connect/yandex).
- **GMX:** Schalten Sie zuerst in den E-Mail-Einstellungen den Zugriff per **POP3/IMAP** ein. Ohne Zwei-Faktor-Authentifizierung funktioniert Ihr normales GMX-Passwort; mit ihr erstellen Sie ein App-Passwort unter **Account verwalten**, **Login & Sicherheit**, **App-Passwörter (für externe Apps)**, **Neues App-Passwort erstellen**. GMX zeigt es einmal an. Einrichtung: [GMX](/connect/gmx).
- **WEB.DE:** Wie bei GMX: Aktivieren Sie den Zugriff per **POP3/IMAP** und erstellen Sie an derselben Stelle ein App-Passwort, wenn die Zwei-Faktor-Authentifizierung aktiv ist. Einrichtung: [WEB.DE](/connect/web-de).
- **Outlook.com, Hotmail und Live:** kein App-Passwort. Laut Microsoft ist die Standardauthentifizierung (Basic Authentication), also die Passwort-Anmeldung, auf der App-Passwörter beruhen, seit dem 16. September 2024 für kein Outlook-Konto mehr verfügbar. Ein App-Passwort öffnet das Postfach daher nicht. MCPEmails verbindet diese Konten stattdessen mit **Mit Microsoft anmelden** über Microsoft Graph. Einrichtung: [Outlook.com](/connect/outlook); Geschäftskonten behandelt die [Anleitung zu Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

Alles andere, etwa ein Postfach bei Ihrem Webhoster oder auf Ihrer eigenen Domain, folgt demselben Muster: Erzeugen Sie ein App-Passwort, wenn der Anbieter eines anbietet, sonst nehmen Sie das Postfach-Passwort, und tragen Sie die Servereinstellungen von Hand ein. Die [Seite für allgemeines IMAP](/connect/imap) und die [vollständige Anbieterliste](/connect) decken diese Fälle ab.

## So erstellen Sie eines und verbinden Ihr Postfach

Die Schritte sind überall gleich, nur die Menünamen unterscheiden sich:

1. Aktivieren Sie die Zwei-Faktor-Authentifizierung für das E-Mail-Konto, falls der Anbieter sie verlangt.
2. Öffnen Sie die oben genannte Seite für App-Passwörter, benennen Sie das Passwort nach der App (zum Beispiel \`MCPEmails\`) und erzeugen Sie es.
3. Kopieren Sie es sofort. Die meisten Anbieter zeigen es nicht noch einmal an.
4. Öffnen Sie in MCPEmails **Postfächer**, dann **Postfach verbinden**, wählen Sie Ihren Anbieter und fügen Sie Ihre vollständige E-Mail-Adresse und das App-Passwort ein.
5. Fügen Sie \`https://mcpemails.com/api/mcp\` zu Ihrem KI-Client hinzu. Die [Anleitung für Claude](/blog/connect-claude-to-email) und die [Anleitung für ChatGPT](/blog/connect-chatgpt-to-email) führen durch diesen Teil.

Wird die Anmeldung weiterhin abgelehnt, nennt die [Anleitung zum IMAP-Konnektor](/blog/claude-imap-connector) die anderen üblichen Ursachen: IMAP ist ausgeschaltet, der regionale Server ist falsch oder der Benutzername ist nicht die vollständige Adresse.

## So widerrufen Sie ein App-Passwort

Mit dem Widerruf beenden Sie den Zugriff einer einzelnen App, ohne etwas anderes zu verändern. Löschen Sie das Passwort an derselben Stelle, an der Sie es erstellt haben:

- **Google:** \`myaccount.google.com/apppasswords\`, dann **Entfernen** neben dem Eintrag. Wenn Sie das Passwort Ihres Google-Kontos ändern, werden außerdem alle App-Passwörter widerrufen.
- **Apple:** **Anmelden und Sicherheit**, **App-spezifische Passwörter**, dann eines entfernen oder **Alle widerrufen** wählen. Wenn Sie das Passwort Ihres Apple Accounts ändern oder zurücksetzen, werden alle automatisch widerrufen.
- **Yahoo und AOL:** die Seite **Account Security** (bei Yahoo **External connections**, bei AOL **Generate and manage app passwords**), dann **Delete** neben dem App-Passwort. Eine Änderung des Hauptpassworts widerruft App-Passwörter hier **nicht**. Den Eintrag zu löschen ist also der einzige Weg, ein Programm auszusperren.
- **Fastmail, Zoho, Yandex, GMX, WEB.DE:** Entfernen Sie es aus derselben Liste der App-Passwörter, in der Sie es erstellt haben. Bei Yandex setzt das Abmelden auf allen Geräten außerdem alle App-Passwörter zurück.

Auf der Seite von MCPEmails löscht **Postfach trennen** im Dashboard das gespeicherte App-Passwort zusammen mit der Verbindung. Beides zu tun ist der saubere Weg, eine Integration stillzulegen: Der Anbieter akzeptiert das Passwort nicht mehr, und MCPEmails speichert es nicht mehr.

## Sicherheitshinweise

- **Erstellen Sie eines pro App.** Mit einem eigenen, benannten App-Passwort für jedes Programm können Sie eines widerrufen, ohne die anderen zu stören, und die Liste in Ihrem Konto zeigt, wer noch Zugriff hat.
- **Behandeln Sie es wie ein Passwort.** Ein App-Passwort meldet sich an, ohne nach Ihrem zweiten Faktor zu fragen. Genau dafür ist es da. Fügen Sie es nicht in einen Chat mit einer KI, ein geteiltes Dokument oder ein Support-Ticket ein. Bei MCPEmails gehört es nur in das Verbindungsformular.
- **Meist bedeutet es vollen E-Mail-Zugriff.** Bei den meisten Anbietern kann ein App-Passwort E-Mails lesen, senden und löschen, nicht nur einen Teil davon. Schränken Sie stattdessen am Konnektor ein, was Ihre KI darf: Bei MCPEmails können Sie \`read:email\` ohne \`send:email\` genehmigen, und die [Anleitung zur Sicherheit beim E-Mail-Zugriff](/blog/is-it-safe-to-give-ai-agent-email-access) erklärt, wie Sie Sendevorgänge prüfen.
- **Wissen Sie, wo es gespeichert ist.** MCPEmails speichert das App-Passwort mit AES-256-GCM verschlüsselt, entschlüsselt es nur auf dem Server, um Ihren Anbieter zu erreichen, und gibt es nie an den KI-Client weiter. Ihre Nachrichten werden live abgerufen und nicht gespeichert. [Warum das wichtig ist](/blog/why-email-never-stored-matters).
- **Google empfiehlt „Über Google anmelden“, wo eine App das anbietet.** Laut Google sind App-Passwörter nicht empfehlenswert und in den meisten Fällen unnötig. Es gibt sie für Apps, die diese Anmeldung nicht nutzen können, darunter IMAP-Programme, die nur ein Passwort annehmen.

## FAQ

**Was ist ein App-Passwort?**
Ein App-Passwort ist ein zufällig erzeugtes Passwort, das Ihr E-Mail-Anbieter für eine einzelne App oder ein Gerät ausstellt, etwa ein E-Mail-Programm oder einen KI-E-Mail-Konnektor. Damit meldet sich diese App über IMAP und SMTP ohne Ihr Hauptpasswort an, und Sie können es jederzeit löschen, um nur dieser App den Zugriff zu entziehen.

**Ist ein App-Passwort dasselbe wie mein E-Mail-Passwort?**
Nein. Ihr E-Mail-Passwort haben Sie selbst gewählt und geben es im Webmail ein. Ein App-Passwort erzeugt der Anbieter, nur eine App benutzt es, und bei den meisten Anbietern funktioniert Ihr normales Passwort an seiner Stelle nicht.

**Warum brauche ich ein App-Passwort, um E-Mail mit einem KI-Agenten zu verbinden?**
Weil sich der MCP-Server, der der KI den Zugriff gibt, wie jedes E-Mail-Programm über IMAP und SMTP an Ihrem Postfach anmeldet, und die meisten Anbieter dort nur ein App-Passwort akzeptieren. Die wichtigste Ausnahme ist Outlook.com: Es verbindet sich mit „Mit Microsoft anmelden“.

**Läuft ein App-Passwort ab?**
Es funktioniert nicht mehr, sobald Sie es löschen. Google und Apple widerrufen außerdem alle App-Passwörter, wenn Sie das Hauptpasswort des Kontos ändern, während sie bei Yahoo und AOL nach einer Passwortänderung gültig bleiben, bis Sie sie löschen.

**Ich habe mein App-Passwort verloren. Kann ich es noch einmal ansehen?**
Nein. Die meisten Anbieter zeigen es nur einmal an. Löschen Sie das alte, erzeugen Sie ein neues und fügen Sie das neue in die App ein. Öffnen Sie dazu in MCPEmails das Postfach und wählen Sie **Neu verbinden**.

## Nächster Schritt

[Erstellen Sie ein kostenloses MCPEmails-Konto](/signup), erzeugen Sie ein App-Passwort bei Ihrem Anbieter und verbinden Sie das Postfach. Die [Anbieterübersicht](/docs/providers) zeigt, was jeder Anbieter nach der Verbindung unterstützt.`,
};

export default translation;
