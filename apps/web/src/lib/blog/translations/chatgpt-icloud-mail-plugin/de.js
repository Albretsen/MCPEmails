const translation = {
  title: 'iCloud Mail mit ChatGPT verbinden: Plugin, Grenzen und andere Konten',
  description:
    'So verbinden Sie iCloud Mail über das neue Plugin von OpenAI mit ChatGPT, was es erreicht und was nicht, warum Ihre anderen Apple-Mail-Konten fehlen und wie Sie iCloud auch in Claude nutzen.',
  coverAlt: 'iCloud Mail mit ChatGPT und Claude verbunden',
  content: `Am 27. Oktober 2026 hat OpenAI ChatGPT um ein Plugin für iCloud Mail und eines für iCloud Kalender erweitert. Mit dem Mail-Plugin kann ChatGPT in einem iCloud-Postfach suchen, lesen, Entwürfe schreiben und senden, mit einem App-spezifischen Passwort von Apple. Es deckt nur iCloud ab: Gmail-, Outlook- oder Arbeitskonten, die Sie in der Mail-App auf iPhone oder Mac hinzugefügt haben, bleiben außen vor, und Claude hat gar keine eigene iCloud-Option.

Diese Anleitung zeigt, wie Sie das Plugin einrichten, was es kann, welche Probleme auftreten und was Sie nutzen, wenn Sie iCloud in Claude oder mehrere Postfächer an einem Ort brauchen.

**Direkt zu:** [Einrichtung](#icloud-mail-mit-chatgpt-verbinden) · [Was es kann](#was-das-icloud-mail-plugin-kann) · [Funktioniert nicht?](#icloud-plugin-funktioniert-nicht) · [Andere Konten](#warum-ihre-anderen-apple-mail-konten-fehlen) · [Claude](#icloud-mail-in-claude) · [FAQ](#faq)

## iCloud Mail mit ChatGPT verbinden

Laut der [Hilfeseite zu verbundenen Apps](https://help.openai.com/en/articles/11487775-connectors-in-chatgpt) von OpenAI werden die Plugins für jeden ChatGPT-Tarif ausgerollt, auch für Free, im Web, in der Desktop-App und unter iOS. Mail und Kalender sind getrennte Plugins; wer das eine verbindet, hat das andere nicht automatisch.

1. **Aktivieren Sie die Zwei-Faktor-Authentifizierung** für Ihren Apple Account, falls sie aus ist. Apple [stellt App-spezifische Passwörter nur](https://support.apple.com/de-de/102654) für Accounts aus, die damit geschützt sind.
2. **Erstellen Sie ein App-spezifisches Passwort.** Melden Sie sich auf account.apple.com an, öffnen Sie **Anmelden und Sicherheit**, wählen Sie **App-spezifische Passwörter** und erzeugen Sie eines. Nennen Sie es ChatGPT, damit Sie es später wiederfinden.
3. **Öffnen Sie das Plugin in ChatGPT.** Gehen Sie zu **Einstellungen**, dann **Plugins**, und wählen Sie **iCloud Mail**.
4. **Geben Sie Ihre iCloud-Adresse und das App-spezifische Passwort ein.** OpenAI verlangt eine Adresse, die auf @icloud.com, @me.com oder @mac.com endet.

Ihr normales Apple-Account-Passwort funktioniert hier nicht. Apple bietet Apps anderer Entwickler zwei Wege an: Eine unterstützte App kann direkt mit dem Apple Account autorisiert werden, jede andere bekommt ein App-spezifisches Passwort. Das Plugin von OpenAI geht den zweiten Weg, mit derselben Art Passwort, die auch ein E-Mail-Programm eines anderen Herstellers verwendet.

## Was das iCloud-Mail-Plugin kann

Laut der Hilfeseite von OpenAI und der Berichterstattung zum Start durch [9to5Mac](https://9to5mac.com/2026/10/27/icloud-mail-and-calendar-plugins-now-work-with-chatgpt/) und andere kann das Mail-Plugin:

- Ihre iCloud-E-Mails durchsuchen und Nachrichten lesen.
- Zusammenfassen, was eingegangen ist, zum Beispiel ungelesene E-Mails von heute.
- Antworten entwerfen und E-Mails senden.
- Ihre iCloud-Kontakte nachschlagen. Die Kontaktsuche ist nur lesend, und ein eigenes Plugin für Kontakte oder Erinnerungen gibt es in diesem Start nicht.

Weder die Seite von OpenAI noch die Berichte zum Start sagen, dass das Plugin Nachrichten in Ordner verschieben oder löschen kann. Verlassen Sie sich also nicht auf das Aufräumen des Postfachs, bis OpenAI es dokumentiert. Konten, die von einer Firma oder Schule verwaltet werden, können durch die App-Einstellungen des Workspace blockiert sein.

Das Plugin in ChatGPT zu trennen löscht das App-spezifische Passwort bei Apple nicht. Um den Zugriff endgültig zu beenden, entfernen Sie das Passwort auf account.apple.com unter **Anmelden und Sicherheit**, **App-spezifische Passwörter**.

## iCloud-Plugin funktioniert nicht?

Die häufigsten Ursachen, ungefähr in der Reihenfolge, in der man auf sie stößt:

- **Ihr Apple-Passwort wird abgelehnt.** Verwenden Sie ein App-spezifisches Passwort. Fehlt **App-spezifische Passwörter** auf account.apple.com, ist die Zwei-Faktor-Authentifizierung aus.
- **Das Plugin wird nicht aufgeführt.** OpenAI rollt es noch aus, es hat Ihr Konto also vielleicht noch nicht erreicht. In einem Business- oder Enterprise-Workspace kann ein Admin das Plugin auch abgeschaltet haben.
- **Ihre Adresse wird abgelehnt.** Das Mail-Plugin verlangt eine Adresse bei @icloud.com, @me.com oder @mac.com. Wenn Sie über iCloud+ nur eine eigene Domain nutzen, geben Sie die iCloud-Adresse desselben Apple Accounts ein.
- **Sie haben das Passwort Ihres Apple Accounts geändert.** Apple widerruft beim Ändern oder Zurücksetzen jedes App-spezifische Passwort, und dasselbe passiert bei **Alle widerrufen**. Erstellen Sie ein neues App-spezifisches Passwort und verbinden Sie neu.
- **Eine Nachricht liegt in Gmail oder Outlook, nicht in iCloud.** Siehe den nächsten Abschnitt.

## Warum Ihre anderen Apple-Mail-Konten fehlen

Die Mail-App auf iPhone oder Mac zeigt jedes Konto, das Sie ihr hinzugefügt haben, in einer Liste. ChatGPT liest die Mail-App nicht. Das Plugin meldet sich direkt bei Apples iCloud-Mailservern an, es sieht also das iCloud-Postfach und sonst nichts. Ein Gmail-, Outlook.com-, Yahoo-, GMX- oder Arbeitskonto, das in Apple Mail neben iCloud liegt, ist für das Plugin unsichtbar.

Für Gmail und Outlook hat ChatGPT eigene Plugins, die Sie zusätzlich verbinden können. Zwei Haken:

- **Yahoo, AOL, Fastmail, Zoho, GMX, web.de und Firmenpostfächer per IMAP haben kein ChatGPT-Plugin.** [Yahoo Mail mit ChatGPT und Claude](/blog/connect-yahoo-mail-to-chatgpt-and-claude) behandelt diesen Fall.
- **Eine private Adresse bei Outlook.com oder Hotmail** kann vom Outlook-Plugin von ChatGPT abgelehnt werden. [ChatGPT mit Outlook.com und Hotmail verbinden](/blog/connect-chatgpt-to-outlook-com-hotmail) erklärt, warum, und was stattdessen funktioniert.

Jedes Plugin ist eine eigene Verbindung mit eigener Anmeldung, und ChatGPT muss gesagt bekommen, welches es nutzen soll.

## iCloud Mail in Claude

Claude hat zwei eigene E-Mail-Konnektoren, einen für Gmail und einen für geschäftliche Microsoft 365-Konten. Eine iCloud-Option gibt es in Claude nicht. Apple erlaubt zwar, dass eine unterstützte App eines anderen Entwicklers iCloud Mail mit dem Apple Account statt mit einem App-spezifischen Passwort autorisiert, aber Claude hat keinen solchen Konnektor, und MCPEmails verbindet iCloud mit einem App-spezifischen Passwort über IMAP. [Kann Claude meine E-Mails lesen?](/blog/can-claude-read-my-email) geht die Optionen von Claude Postfach für Postfach durch.

Um iCloud in Claude zu nutzen, fügen Sie einen MCP-Server hinzu, der die iCloud-Verbindung hält, und genau das ist MCPEmails. Es verbindet sich mit iCloud auf dieselbe Weise wie das Plugin von OpenAI, mit einem App-spezifischen Passwort über IMAP, und stellt das Postfach dann jeder App bereit, die das Model Context Protocol spricht: Claude, ChatGPT, Cursor und den anderen [unterstützten Clients](/docs/clients).

1. [Erstellen Sie ein kostenloses MCPEmails-Konto](/signup). Der kostenlose Tarif verbindet ein Postfach.
2. Öffnen Sie im Dashboard **Postfächer**, klicken Sie auf **Postfach verbinden**, wählen Sie **iCloud Mail** und fügen Sie Ihre iCloud-Adresse mit einem neuen App-spezifischen Passwort ein. Die [Seite mit den iCloud-Einstellungen](/connect/icloud) enthält die Serverdaten und Apples Eigenheiten beim Benutzernamen.
3. Öffnen Sie in Claude **Anpassen**, dann **Konnektoren**, klicken Sie auf **+ Hinzufügen**, wählen Sie **Benutzerdefinierten Konnektor hinzufügen** und fügen Sie \`https://mcpemails.com/api/mcp\` ein. Die [Einrichtungsseite für Claude](/docs/claude) zeigt den vollständigen Klickpfad.

Claude kann Ihre iCloud-E-Mails dann lesen, durchsuchen, senden, beantworten, planen und ordnen, einschließlich des Verschiebens zwischen Ordnern.

## Wann das Plugin reicht, und wann nicht

Nutzen Sie das Plugin von OpenAI, wenn iCloud Ihr einziges Postfach und ChatGPT Ihre einzige KI-App ist. Es ist in jedem Tarif kostenlos und in zwei Minuten eingerichtet.

MCPEmails lohnt einen Blick, wenn:

- **Sie Claude nutzen** oder zwischen Claude, ChatGPT und einem Coding-Tool wechseln und dasselbe Postfach in jedem haben wollen.
- **Sie mehr als ein Postfach haben.** Verbinden Sie iCloud, Gmail, Yahoo, Outlook.com, GMX und Firmenpostfächer per IMAP mit einem Konto, und jeder Client sieht alle über eine URL. [Mehrere E-Mail-Konten in Claude und ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) zeigt, wie der Agent sie auseinanderhält.
- **Sie E-Mails ablegen und aufräumen wollen**, nicht nur lesen: Ordner, Verschieben, Archivieren, geplante Sendungen und feste Regeln.

In ChatGPT wird MCPEmails als benutzerdefinierter MCP-Server hinzugefügt, was OpenAI auf chatgpt.com in Go und den kostenpflichtigen Tarifen erlaubt, nicht in Free. Die [Einrichtungsseite für ChatGPT](/docs/chatgpt) enthält die Schritte.

Ihre E-Mails werden von MCPEmails nie gespeichert. Jede Nachricht wird live von Apple abgerufen, wenn der Agent danach fragt, und nur das verschlüsselte App-spezifische Passwort wird aufbewahrt. Widerrufen Sie dieses Passwort bei Apple, ist das Postfach sofort getrennt.

## FAQ

**Kann ChatGPT meine iCloud-E-Mails lesen?**
Ja. Verbinden Sie das iCloud-Mail-Plugin unter Einstellungen, Plugins, mit Ihrer iCloud-Adresse und einem App-spezifischen Passwort von Apple. Laut OpenAI wird es für alle ChatGPT-Tarife im Web, auf dem Desktop und unter iOS ausgerollt.

**Sieht das iCloud-Plugin von ChatGPT meine Gmail- oder Outlook-Konten in Apple Mail?**
Nein. Es meldet sich bei den Mailservern von iCloud an, nicht bei der Mail-App, und sieht deshalb nur E-Mails, die in iCloud liegen. Verbinden Sie andere Konten mit ihrem eigenen Plugin oder über einen MCP-Server wie MCPEmails.

**Warum lehnt ChatGPT mein Apple-Passwort ab?**
Weil das Plugin ein App-spezifisches Passwort erwartet, nicht Ihr normales Passwort. Apple lässt zwar [unterstützte Drittanbieter-Apps](https://support.apple.com/de-de/102654) direkt mit dem Apple Account auf iCloud Mail zugreifen, alle anderen bekommen ein App-spezifisches Passwort; so verbindet auch MCPEmails iCloud, über IMAP. Erstellen Sie eines auf account.apple.com unter Anmelden und Sicherheit, App-spezifische Passwörter. Die Zwei-Faktor-Authentifizierung muss aktiv sein.

**Hat Claude einen iCloud-Konnektor?**
Nein. Die eigenen E-Mail-Konnektoren von Claude decken Gmail und geschäftliche Microsoft 365-Konten ab. Fügen Sie iCloud über einen MCP-Server als benutzerdefinierten Konnektor zu Claude hinzu: Verbinden Sie das Postfach mit einem App-spezifischen Passwort mit MCPEmails und fügen Sie \`https://mcpemails.com/api/mcp\` in Claude ein.

**Wie trenne ich iCloud vollständig von ChatGPT?**
Trennen Sie das Plugin in den Einstellungen von ChatGPT und entfernen Sie dann das App-spezifische Passwort auf account.apple.com. Nur in ChatGPT zu trennen lässt das Passwort bei Apple gültig.

## Nächster Schritt

Wenn iCloud in ChatGPT alles ist, was Sie brauchen, reicht das Plugin. Um dasselbe iCloud-Postfach in Claude oder neben Ihren anderen Postfächern zu haben, [starten Sie kostenlos](/signup), verbinden iCloud mit einem App-spezifischen Passwort und fügen eine URL in Ihre KI-App ein. Die [Anleitung für iCloud, Fastmail und IMAP](/blog/connect-icloud-fastmail-imap-to-claude) beschreibt den Passwort-Schritt genauer.`,
};

export default translation;
