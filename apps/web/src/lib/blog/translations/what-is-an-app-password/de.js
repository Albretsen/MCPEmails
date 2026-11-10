const translation = {
  title: 'Was ist ein App-Passwort? So erstellen Sie es bei GMX, WEB.DE, T-Online, iCloud und Gmail',
  description:
    'App-Passwort erklärt: warum Mailprogramme und KI-Konnektoren eines brauchen, wo Sie es bei GMX, WEB.DE, T-Online, iCloud, Gmail, Yahoo, Fastmail und Zoho erstellen, und wie Sie es wieder löschen.',
  coverAlt: 'Ein App-Passwort verbindet über MCPEmails ein E-Mail-Postfach mit einem KI-Agenten',
  content: `Ein **App-Passwort** ist ein zweites Passwort, das Ihr E-Mail-Anbieter für genau eine App erzeugt. Mit ihm meldet sich diese App an Ihrem Postfach an, ohne Ihr eigentliches Kontopasswort zu kennen. Sie erstellen es in den Sicherheitseinstellungen Ihres Kontos, tragen es einmal in das Mailprogramm oder den Konnektor ein und löschen es, sobald diese eine App keinen Zugriff mehr haben soll. Ihr normales Passwort und alle anderen Apps laufen unverändert weiter.

Wer ein Postfach mit Thunderbird, Apple Mail oder über einen MCP-Server wie MCPEmails mit Claude oder ChatGPT verbindet, scheitert am häufigsten an genau dieser Stelle: Es wurde das normale Passwort eingetragen, wo der Anbieter ein App-Passwort erwartet. Bei GMX und WEB.DE kommt hinzu, dass der Abruf per IMAP erst eingeschaltet werden muss, und die Telekom nennt ihr App-Passwort gar nicht so. Diese Anleitung erklärt, was ein App-Passwort ist, warum IMAP-Programme eines brauchen, wo jeder große Anbieter es erzeugt und wie Sie es wieder löschen.

**Direkt zu:** [App-Passwort erstellen](#wo-sie-ein-app-passwort-bei-jedem-anbieter-erstellen) · [App-Passwort widerrufen](#so-widerrufen-sie-ein-app-passwort) · [Sicherheitshinweise](#sicherheitshinweise) · [FAQ](#faq)

## Was ist ein App-Passwort?

Ein App-Passwort ist eine lange, zufällig erzeugte Zugangsberechtigung, die zu Ihrem E-Mail-Konto gehört, aber nur für eine einzige Anwendung ausgestellt wird. Drei Dinge unterscheiden es von dem Passwort, das Sie im Webmail eingeben:

- **Der Anbieter erzeugt es.** Sie wählen es nicht selbst. Google erzeugt einen Code aus 16 Buchstaben, bei Apple hat es das Format \`abcd-efgh-ijkl-mnop\`, GMX und WEB.DE zeigen es einmal in einem Dialog an, und fast alle Anbieter zeigen es nur dieses eine Mal.
- **Es ersetzt Ihr Passwort dort, wo kein zweiter Faktor abgefragt werden kann.** Mailprogramme verbinden sich über IMAP (Lesen) und SMTP (Senden), und diese Protokolle können keine Zwei-Faktor-Abfrage anzeigen. Über ein App-Passwort lässt der Anbieter ein solches Programm herein, ohne die Anmeldung im Web zu schwächen.
- **Es lässt sich einzeln widerrufen.** Löschen Sie es, verliert nur die App den Zugriff, die es benutzt hat. Am Konto ändert sich sonst nichts.

Die Namen sind uneinheitlich, gemeint ist immer dasselbe. GMX, WEB.DE und mail.com sagen **App-Passwort**, in der Hilfe auch **anwendungsspezifisches Passwort**. Apple spricht vom **App-spezifischen Passwort**, Zoho vom **application-specific password**. Google nennt es App-Passwort und beschreibt es als 16-stelligen Code, der einer App oder einem Gerät den Zugriff auf Ihr Google-Konto erlaubt. Die Telekom vergibt für T-Online-Postfächer ein **Passwort für E-Mail-Programme**, das genau diese Rolle spielt, aber nirgends App-Passwort heißt.

## Warum IMAP-Programme und KI-Konnektoren eines brauchen

Viele E-Mail-Anbieter akzeptieren Ihr normales Passwort nicht mehr von einem fremden Mailprogramm, spätestens sobald die Zwei-Faktor-Authentifizierung aktiv ist. Ein Mailprogramm auf dem Rechner, die Mail-App des Smartphones oder ein Server, der in Ihrem Auftrag E-Mails liest, sprechen alle IMAP und SMTP. Und bei Google, Apple, Yahoo, AOL, Fastmail und Yandex ist die Zugangsberechtigung, die diese Protokolle annehmen, ein App-Passwort. Bei GMX und WEB.DE gilt das, sobald die Zwei-Faktor-Authentifizierung eingeschaltet ist.

Ein KI-Konnektor ist in genau derselben Lage. Wenn Claude oder ChatGPT über [einen MCP-E-Mail-Server](/blog/what-is-an-mcp-email-server) mit Ihrem Postfach arbeitet, meldet sich nicht die KI am Postfach an. Das übernimmt der MCP-Server, über IMAP und SMTP, genau wie Thunderbird. Für iCloud, Yahoo, AOL, Fastmail, Gmail und vergleichbare Anbieter braucht der Server also ein App-Passwort, und der KI-Client bekommt nur ein Token mit begrenzten Rechten für den Server. Die [Anleitung zu OAuth und API-Schlüsseln für den E-Mail-Zugriff](/blog/oauth-vs-api-keys-ai-email-access) behandelt diese zweite Ebene.

Der typische Fehler: Man trägt das Passwort ein, mit dem man sich auf der Website des Anbieters anmeldet. Das ist der häufigste Grund, warum sich eine Mail-App oder ein KI-Konnektor nicht anmelden kann. Erzeugte App-Passwörter haben eine erkennbare Form. Deshalb prüft das Verbindungsformular von MCPEmails bei Gmail, iCloud, Yahoo, Yandex und Fastmail, was Sie einfügen, und warnt Sie, bevor der Versuch beim Anbieter ankommt, der ihn sonst als fehlgeschlagene Anmeldung zählen würde. Sind Sie sicher, dass der Wert stimmt, klicken Sie erneut auf **Verbinden**, und er wird trotzdem gesendet.

## Wo Sie ein App-Passwort bei jedem Anbieter erstellen

Jeder Eintrag nennt, wo das App-Passwort erzeugt wird und was vorher eingeschaltet sein muss. Die verlinkte Einrichtungsseite des Anbieters enthält die IMAP- und SMTP-Einstellungen und alle Schritte.

- **GMX:** Schalten Sie zuerst den Abruf ein: im Browser auf das Symbol mit Ihren Initialen, **E-Mail-Einstellungen**, unter **E-Mail empfangen** den Punkt **POP3/IMAP**, Schieberegler auf **POP3- und IMAP-Zugriff erlauben**. Ohne Zwei-Faktor-Authentifizierung funktioniert danach Ihr normales GMX-Passwort. Mit ihr erstellen Sie ein App-Passwort unter **Account verwalten**, **Login & Sicherheit**, **App-Passwörter (für externe Apps)**, **Neues App-Passwort erstellen**. GMX zeigt es einmal an. Einrichtung: [GMX](/connect/gmx).
- **WEB.DE:** Genau wie bei GMX: Aktivieren Sie unter **E-Mail-Einstellungen**, **E-Mail empfangen**, **POP3/IMAP** den Abruf und erstellen Sie unter **Account verwalten**, **Login & Sicherheit**, **App-Passwörter (für externe Apps)** ein App-Passwort, sobald die Zwei-Faktor-Authentifizierung aktiv ist. Beide Anbieter schalten den Abruf nach längerer Pause wieder ab; prüfen Sie den Schieberegler, bevor Sie am Passwort zweifeln. Einrichtung: [WEB.DE](/connect/web-de).
- **T-Online und magenta.de:** Die Telekom nennt es nicht App-Passwort, aber es ist eines: das **Passwort für E-Mail-Programme**, getrennt vom Telekom Login. Sie legen es im E-Mail Center unter dem Zahnrad (**Einstellungen**), **Alle Einstellungen anzeigen**, **Passwörter**, **Passwort für E-Mail-Programme** an, alternativ im Kundencenter unter **Profil verwalten**, **Login-Daten**, **Weitere Passwörter**. Nur dieses Passwort meldet IMAP und SMTP an; das Telekom-Login-Passwort wird vom Mailserver immer abgelehnt. Einrichtung: [T-Online](/connect/t-online).
- **iCloud Mail:** Die Zwei-Faktor-Authentifizierung ist Pflicht. Öffnen Sie auf \`account.apple.com\` den Bereich **Anmelden und Sicherheit**, dann **App-spezifische Passwörter**, und klicken Sie auf **App-spezifisches Passwort erstellen**. Bis zu 25 können gleichzeitig aktiv sein. Das ist auch der Weg, wenn Sie das Postfach aus Apple Mail mit Claude verbinden möchten: Nicht Apple Mail wird verbunden, sondern das iCloud-Konto dahinter. Einrichtung: [iCloud Mail](/connect/icloud).
- **Gmail und Google Workspace:** Aktivieren Sie die **Bestätigung in zwei Schritten** und erstellen Sie dann unter \`myaccount.google.com/apppasswords\` ein App-Passwort. Der Code besteht aus 16 Buchstaben in vier Gruppen; Leerzeichen spielen keine Rolle. Google nennt drei Fälle, in denen die Option fehlt: manche Konten von Arbeitgebern, Schulen oder anderen Organisationen (bei Workspace ist das eine Einstellung Ihres Administrators), aktivierter erweiterter Schutz und eine Bestätigung in zwei Schritten, die nur mit Sicherheitsschlüsseln eingerichtet ist. Einrichtung: [Gmail](/connect/gmail), [Google Workspace](/connect/google-workspace).
- **Outlook.com, Hotmail und Live:** kein App-Passwort. Laut Microsoft ist die Standardauthentifizierung (Basic Authentication), also die Passwort-Anmeldung, auf der App-Passwörter beruhen, seit dem 16. September 2024 für kein Outlook-Konto mehr verfügbar. Ein App-Passwort öffnet das Postfach daher nicht. MCPEmails verbindet diese Konten stattdessen mit **Mit Microsoft anmelden** über Microsoft Graph. Einrichtung: [Outlook.com](/connect/outlook); Geschäftskonten behandelt die [Anleitung zu Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp).
- **Yahoo Mail:** Wählen Sie auf der Yahoo-Seite **Account Security** unter **External connections** die Option **Create app password**, vergeben Sie einen Namen und erzeugen Sie es. Einrichtung: [Yahoo Mail](/connect/yahoo).
- **AOL Mail:** Wählen Sie auf der AOL-Seite **Account Security** die Option **Generate app password** (bei manchen Konten **Generate and manage app passwords**), dann **Get Started**, vergeben Sie einen Namen und erzeugen Sie es. AOL verlangt, dass Sie das in einem Browser tun, mit dem Sie sich schon seit einigen Tagen bei AOL Mail anmelden, nicht in einem privaten Fenster. Ein Yahoo-App-Passwort öffnet kein AOL-Postfach, auch wenn beide auf derselben Plattform laufen. Einrichtung: [AOL Mail](/connect/aol).
- **verizon.net:** Verizon hat seinen E-Mail-Dienst eingestellt, die verbliebenen verizon.net-Postfächer sind heute AOL-Konten. Sie erstellen also ein **AOL**-App-Passwort und melden sich mit Ihrer vollständigen verizon.net-Adresse an. Einrichtung: [verizon.net](/connect/verizon).
- **Fastmail:** Gehen Sie zu **Settings**, **Privacy & Security**, **Connected apps & API tokens**, **Manage app passwords and access**, **New app password**. Behalten Sie die Standard-Zugriffsstufe **Mail, Contacts & Calendars** bei; ein Passwort nur für Files kann sich nicht bei Mail anmelden. Fastmail verbindet sich ausschließlich mit einem App-Passwort, und im Basic-Tarif von Fastmail lässt sich keines erstellen. Einrichtung: [Fastmail](/connect/fastmail).
- **Zoho Mail:** Aktivieren Sie zuerst in Zoho Mail unter **Settings**, **Mail Accounts** den **IMAP Access**. Ohne Zwei-Faktor-Authentifizierung funktioniert Ihr Zoho-Passwort; mit Zwei-Faktor-Authentifizierung, föderierter Anmeldung (zum Beispiel über Google) oder SAML erstellen Sie in Ihrem Zoho-Konto ein application-specific password und verwenden dieses. Einrichtung: [Zoho Mail](/connect/zoho).
- **Yandex Mail:** Aktivieren Sie IMAP unter **Mail clients** in den Einstellungen von Yandex Mail und öffnen Sie dann auf der Sicherheitsseite unter \`id.yandex.com\` den Bereich **App passwords**, um eines für ein Mailprogramm zu erstellen. Yandex zeigt es einmal an. Einrichtung: [Yandex Mail](/connect/yandex).
- **mailbox.org:** Ohne Zwei-Faktor-Authentifizierung meldet Ihr Postfach-Passwort IMAP und SMTP an. Mit ihr erstellen Sie in der Weboberfläche unter **Alle Einstellungen**, **Sicherheit** ein E-Mail-App-Passwort und wählen dabei die erlaubten Protokolle. Einrichtung: [mailbox.org](/connect/mailbox-org).
- **Posteo:** Standardmäßig reicht Ihr Posteo-Passwort. Haben Sie den zusätzlichen Postfachschutz aktiviert, funktionieren für IMAP, POP3 und SMTP nur noch App-Passwörter, die Sie in den Einstellungen anlegen. Einrichtung: [Posteo](/connect/posteo).
- **Infomaniak:** Das Manager-Passwort wird von IMAP und SMTP nie akzeptiert. Öffnen Sie im Manager die E-Mail-Adresse, dann den Tab **Geräte**, klicken Sie auf **Gerät hinzufügen** und kopieren Sie das erzeugte Passwort sofort; Infomaniak zeigt es nicht noch einmal. Ein unter den Kontoeinstellungen erzeugtes Anwendungspasswort ist etwas anderes und meldet kein Postfach an. Einrichtung: [Infomaniak](/connect/infomaniak).

Viele deutsche Hoster und Provider vergeben gar keine App-Passwörter: STRATO, IONOS, Hetzner, one.com, A1, Swisscom (Bluewin) und Vodafone arbeiten mit einem Postfach-Passwort, das Sie im Kundenbereich für die einzelne Adresse festlegen und das nicht Ihr Kundenlogin ist. Alles andere, etwa ein Postfach bei Ihrem Webhoster oder auf Ihrer eigenen Domain, folgt demselben Muster: Erzeugen Sie ein App-Passwort, wenn der Anbieter eines anbietet, sonst nehmen Sie das Postfach-Passwort, und tragen Sie die Servereinstellungen von Hand ein. Die [Seite für allgemeines IMAP](/connect/imap) und die [vollständige Anbieterliste](/connect) decken diese Fälle ab.

## So erstellen Sie eines und verbinden Ihr Postfach

Die Schritte sind überall gleich, nur die Menünamen unterscheiden sich:

1. Aktivieren Sie die Zwei-Faktor-Authentifizierung für das E-Mail-Konto, falls der Anbieter sie verlangt.
2. Öffnen Sie die oben genannte Seite für App-Passwörter, benennen Sie das Passwort nach der App (zum Beispiel \`MCPEmails\`) und erzeugen Sie es.
3. Kopieren Sie es sofort. Die meisten Anbieter zeigen es nicht noch einmal an.
4. Öffnen Sie in MCPEmails **Postfächer**, dann **Postfach verbinden**, wählen Sie Ihren Anbieter und tragen Sie Ihre vollständige E-Mail-Adresse und das App-Passwort ein.
5. Fügen Sie \`https://mcpemails.com/api/mcp\` in Ihren KI-Client ein. Die [Anleitung für Claude](/blog/connect-claude-to-email) und die [Anleitung für ChatGPT](/blog/connect-chatgpt-to-email) führen durch diesen Teil.

Wird die Anmeldung weiterhin abgelehnt, nennt die [Anleitung zum IMAP-Konnektor](/blog/claude-imap-connector) die anderen üblichen Ursachen: IMAP ist ausgeschaltet, der regionale Server ist falsch oder der Benutzername ist nicht die vollständige Adresse. Bei GMX und WEB.DE hilft außerdem der Rat des Anbieters selbst: im Browser am PC anmelden und lesen, ob nach dem Login eine Meldung erscheint, denn vorübergehende Sperren zeigt nur die Website, nie das Mailprogramm.

## So widerrufen Sie ein App-Passwort

Mit dem Widerruf beenden Sie den Zugriff einer einzelnen App, ohne etwas anderes zu verändern. Löschen Sie das Passwort an derselben Stelle, an der Sie es erstellt haben:

- **GMX und WEB.DE:** **Account verwalten**, **Login & Sicherheit**, **App-Passwörter (für externe Apps)**, dort den Eintrag löschen. Den Abruf per POP3/IMAP können Sie zusätzlich unter E-Mail-Einstellungen wieder ausschalten, dann kommt kein Programm mehr herein.
- **Telekom:** Im E-Mail Center unter **Passwörter** ein neues **Passwort für E-Mail-Programme** setzen. Damit verlieren alle Programme den Zugriff, die das alte benutzt haben; ein neues Telekom-Login-Passwort ändert das E-Mail-Passwort nicht mit.
- **Apple:** **Anmelden und Sicherheit**, **App-spezifische Passwörter**, dann eines entfernen oder **Alle widerrufen** wählen. Ändern oder setzen Sie das Passwort Ihres Apple Accounts zurück, werden alle automatisch widerrufen.
- **Google:** \`myaccount.google.com/apppasswords\`, dann **Entfernen** neben dem Eintrag. Ändern Sie das Passwort Ihres Google-Kontos, werden außerdem alle App-Passwörter widerrufen.
- **Yahoo und AOL:** die Seite **Account Security** (bei Yahoo **External connections**, bei AOL **Generate and manage app passwords**), dann **Delete** neben dem App-Passwort. Eine Änderung des Hauptpassworts widerruft App-Passwörter hier **nicht**. Den Eintrag zu löschen ist also der einzige Weg, ein Programm auszusperren.
- **Fastmail, Zoho, Yandex, mailbox.org, Posteo, Infomaniak:** Entfernen Sie es aus derselben Liste, in der Sie es erstellt haben. Bei Yandex setzt das Abmelden auf allen Geräten außerdem alle App-Passwörter zurück.

Auf der Seite von MCPEmails löscht **Postfach trennen** im Dashboard das gespeicherte App-Passwort zusammen mit der Verbindung. Beides zu tun ist der saubere Weg, eine Integration stillzulegen: Der Anbieter nimmt das Passwort nicht mehr an, und MCPEmails hat es nicht mehr.

## Sicherheitshinweise

- **Erstellen Sie eines pro App.** Mit einem eigenen, benannten App-Passwort für jedes Programm können Sie eines widerrufen, ohne die anderen zu stören, und die Liste in Ihrem Konto zeigt, wer noch Zugriff hat.
- **Behandeln Sie es wie ein Passwort.** Ein App-Passwort meldet sich an, ohne nach Ihrem zweiten Faktor zu fragen. Genau dafür ist es da. Fügen Sie es nicht in einen Chat mit einer KI, ein geteiltes Dokument oder ein Support-Ticket ein. Bei MCPEmails gehört es nur in das Verbindungsformular.
- **Meist bedeutet es vollen E-Mail-Zugriff.** Bei den meisten Anbietern kann ein App-Passwort E-Mails lesen, senden und löschen, nicht nur einen Teil davon. Schränken Sie stattdessen am Konnektor ein, was Ihre KI darf: Bei MCPEmails können Sie \`read:email\` ohne \`send:email\` genehmigen, und die [Anleitung zur Sicherheit beim E-Mail-Zugriff](/blog/is-it-safe-to-give-ai-agent-email-access) erklärt, wie Sie Sendevorgänge prüfen.
- **Wissen Sie, wo es gespeichert ist.** MCPEmails speichert das App-Passwort mit AES-256-GCM verschlüsselt, entschlüsselt es nur auf dem Server, um Ihren Anbieter zu erreichen, und gibt es nie an den KI-Client weiter. Ihre Nachrichten werden live abgerufen und nicht gespeichert. [Warum das wichtig ist](/blog/why-email-never-stored-matters).
- **Google empfiehlt „Über Google anmelden“, wo eine App das anbietet.** Laut Google sind App-Passwörter nicht empfehlenswert und in den meisten Fällen unnötig. Es gibt sie für Apps, die diese Anmeldung nicht nutzen können, darunter IMAP-Programme, die nur ein Passwort annehmen.

## FAQ

**Was ist ein App-Passwort?**
Ein App-Passwort ist ein zufällig erzeugtes Passwort, das Ihr E-Mail-Anbieter für eine einzelne App oder ein Gerät ausstellt, etwa ein Mailprogramm oder einen KI-E-Mail-Konnektor. Damit meldet sich diese App über IMAP und SMTP ohne Ihr Hauptpasswort an, und Sie können es jederzeit löschen, um nur dieser App den Zugriff zu entziehen.

**Ist ein App-Passwort dasselbe wie mein E-Mail-Passwort?**
Nein. Ihr E-Mail-Passwort haben Sie selbst gewählt und geben es im Webmail ein. Ein App-Passwort erzeugt der Anbieter, nur eine App benutzt es, und bei den meisten Anbietern funktioniert Ihr normales Passwort an seiner Stelle nicht.

**Brauche ich bei GMX oder WEB.DE ein App-Passwort?**
Nur wenn die Zwei-Faktor-Authentifizierung eingeschaltet ist. Ohne sie meldet Ihr normales Passwort Mailprogramme an, sobald Sie unter E-Mail-Einstellungen, E-Mail empfangen, POP3/IMAP den Abruf erlaubt haben. Wird Ihr Passwort trotzdem abgelehnt, ist fast immer dieser Schalter aus, nicht das Passwort falsch.

**Wo finde ich das App-Passwort bei T-Online?**
Bei der Telekom heißt es Passwort für E-Mail-Programme. Sie legen es im E-Mail Center unter dem Zahnrad, Alle Einstellungen anzeigen, Passwörter an. Das Telekom-Login-Passwort, mit dem Sie sich auf telekom.de anmelden, funktioniert in keinem Mailprogramm.

**Warum brauche ich ein App-Passwort, um E-Mail mit einem KI-Agenten zu verbinden?**
Weil sich der MCP-Server, der der KI den Zugriff gibt, wie jedes Mailprogramm über IMAP und SMTP an Ihrem Postfach anmeldet, und die meisten Anbieter dort nur ein App-Passwort akzeptieren. Die wichtigste Ausnahme ist Outlook.com: Es verbindet sich mit „Mit Microsoft anmelden“.

**Läuft ein App-Passwort ab?**
Es funktioniert nicht mehr, sobald Sie es löschen. Google und Apple widerrufen außerdem alle App-Passwörter, wenn Sie das Hauptpasswort des Kontos ändern. Bei Yahoo und AOL bleiben sie nach einer Passwortänderung gültig, bis Sie sie löschen.

**Ich habe mein App-Passwort verloren. Kann ich es noch einmal ansehen?**
Nein. Fast alle Anbieter zeigen es nur einmal an. Löschen Sie das alte, erzeugen Sie ein neues und tragen Sie es in der App ein. Öffnen Sie dazu in MCPEmails das Postfach und wählen Sie **Neu verbinden**.

## Nächster Schritt

[Erstellen Sie ein kostenloses MCPEmails-Konto](/signup), erzeugen Sie ein App-Passwort bei Ihrem Anbieter und verbinden Sie das Postfach. Die [Anbieterübersicht](/docs/providers) zeigt, was jeder Anbieter nach der Verbindung unterstützt.`,
};

export default translation;
