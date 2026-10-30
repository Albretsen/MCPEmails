const translation = {
  title: 'Claude mit Hotmail und Outlook.com verbinden (private Microsoft-Konten)',
  description:
    'Der Microsoft 365-Konnektor von Claude akzeptiert keine privaten Microsoft-Konten. So verbinden Sie ein Postfach bei Hotmail, Outlook.com, Live oder MSN mit Claude: Anmeldung bei Microsoft und eine einzige URL für einen benutzerdefinierten Konnektor.',
  coverAlt: 'Claude über MCPEmails mit einem privaten Postfach bei Outlook.com oder Hotmail verbunden',
  content: `Um Claude mit einer privaten Adresse bei Outlook.com, Hotmail, Live oder MSN zu verbinden, fügen Sie das Postfach mit **Mit Microsoft verbinden** zu MCPEmails hinzu und tragen dann eine einzige URL als benutzerdefinierten Konnektor in Claude ein. Der eigene Microsoft 365-Konnektor von Claude setzt einen geschäftlichen Microsoft-Mandanten voraus, und laut Anthropic lassen sich private Microsoft-Konten damit nicht nutzen. Ein benutzerdefinierter Konnektor hat diese Voraussetzung nicht. Eine alte hotmail.com-Adresse funktioniert deshalb genauso wie eine neue outlook.com-Adresse. Alle Einstellungen auf einen Blick finden Sie auf der Seite [Outlook mit Claude verbinden](/connect/outlook).

Diese Anleitung gilt für private Microsoft-Konten in Claude. Wenn Ihre E-Mails in einem Arbeits- oder Schulkonto bei Microsoft 365 liegen, lesen Sie stattdessen die [Anleitung für Outlook und Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

## Warum der Microsoft 365-Konnektor von Claude private Konten ablehnt

Die [Hilfeseite von Anthropic zum Microsoft 365-Konnektor](https://support.claude.com/en/articles/12542951-enabling-and-using-the-microsoft-365-connector) nennt zwei Bedingungen, bevor sich jemand verbinden kann:

- Das Konto muss zu einem Microsoft Entra-Mandanten gehören, der an einen Microsoft Business-Tarif gebunden ist.
- Ein Globaler Administrator dieses Mandanten muss die Integration zuerst autorisieren.

Auf derselben Seite steht, dass private Microsoft-Konten, etwa Adressen mit @outlook.com oder @hotmail.com, nicht für die Verbindung verwendet werden können. Hinter einem privaten Konto stehen weder ein geschäftlicher Mandant noch ein Administrator. Es gibt also nichts zu genehmigen und keine Einstellung, mit der Sie das ändern könnten. Der Konnektor ist für Organisationen gedacht: Er durchsucht SharePoint, OneDrive, Outlook und Teams, und er hat nur Lesezugriff, bis ein Administrator die Schreib-Tools einschaltet.

An Ihrem Postfach liegt es nicht. Claude braucht nur einen anderen Weg dorthin.

## Was Sie brauchen

- Ein privates Microsoft-Konto mit Outlook-Postfach: eine Adresse bei outlook.com, hotmail.com, live.com oder msn.com, auch Länderversionen wie hotmail.de, hotmail.co.uk, outlook.de oder live.no.
- Claude im Web oder Claude Desktop. Anthropic bietet benutzerdefinierte Konnektoren in jedem Claude-Tarif an, auch im Free-Tarif, der einen benutzerdefinierten Konnektor erlaubt.
- Ein Konto bei MCPEmails. [Kostenlos starten](/signup) und den Tab geöffnet lassen.

MCPEmails sitzt dazwischen. Auf der einen Seite spricht es über das Model Context Protocol mit Claude, auf der anderen über Microsoft Graph mit Ihrem Postfach bei Outlook.com.

## Schritt 1: Postfach bei Outlook.com oder Hotmail verbinden

1. Öffnen Sie im Dashboard von MCPEmails **Postfächer** und klicken Sie auf **Postfach verbinden**.
2. Wählen Sie **Outlook** und klicken Sie auf **Mit Microsoft verbinden**.
3. Melden Sie sich auf der Seite von Microsoft mit Ihrer Adresse bei Outlook.com, Hotmail, Live oder MSN an und schließen Sie die Bestätigung in zwei Schritten ab, falls Ihr Konto sie nutzt.
4. Prüfen Sie die Berechtigungen und stimmen Sie zu. Microsoft fragt, ob MCPEmails Ihre E-Mails lesen und ändern, E-Mails in Ihrem Namen senden, diesen Zugriff beibehalten sowie Ihr Basisprofil und Ihre E-Mail-Adresse sehen darf.

Danach landen Sie wieder im Dashboard, und das Postfach ist verbunden. Bei einem privaten Konto ist kein Administrator beteiligt, und Sie geben Ihr Microsoft-Passwort nie in MCPEmails ein.

### Kein IMAP und kein App-Passwort verwenden

Viele ältere Anleitungen raten, ein App-Passwort zu erstellen und die IMAP-Einstellungen von Outlook einzutragen. Das funktioniert nicht mehr: Microsoft hat die [Anmeldung per Passwort für Outlook-Konten in E-Mail-Apps anderer Hersteller](https://support.microsoft.com/en-us/office/modern-authentication-methods-now-needed-to-continue-syncing-outlook-email-in-non-microsoft-email-apps-c5d65390-9676-4763-b41f-d7986499a90d) am 16. September 2024 beendet. Wenn Sie **IMAP / SMTP** wählen und eine Adresse bei Hotmail oder Outlook.com eingeben, zeigt das Dashboard einen Hinweis mit der Schaltfläche **Mit Microsoft anmelden**, die Sie zurück zur Outlook-Option bringt. Auf der [Seite mit den Einstellungen für Outlook.com](/connect/outlook) finden Sie die Details zum Anbieter an einem Ort.

## Schritt 2: MCPEmails als benutzerdefinierten Konnektor zu Claude hinzufügen

In claude.ai oder Claude Desktop:

1. Öffnen Sie **Anpassen → Konnektoren**.
2. Klicken Sie auf **+ Hinzufügen** und dann auf **Benutzerdefinierten Konnektor hinzufügen**.
3. Geben Sie einen Namen ein, zum Beispiel MCPEmails, und fügen Sie diese URL ein:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Klicken Sie auf **Weiter**, übernehmen Sie die Authentifizierungseinstellungen, die Claude erkennt, und klicken Sie auf **Hinzufügen**.
5. Klicken Sie auf **Verbinden**, melden Sie sich bei Ihrem MCPEmails-Konto an und genehmigen Sie die Berechtigungen, die Claude haben soll, zum Beispiel \`read:email\` zum Lesen und \`send:email\` zum Senden.

Um den Konnektor in einem Chat zu nutzen, klicken Sie unten links im Eingabefeld auf **+**, wählen **Konnektoren** und schalten MCPEmails ein. Sie müssen keinen API-Schlüssel erstellen und keine Konfigurationsdatei bearbeiten. Im Team- oder Enterprise-Tarif kann nur ein Inhaber einen benutzerdefinierten Konnektor hinzufügen; Mitglieder finden ihn dann unter **Anpassen → Konnektoren** und klicken auf **Verbinden**. Wenn Claude auf einem dieser Bildschirme hängen bleibt, hilft die [Einrichtungsseite für Claude](/docs/claude) bei den häufigsten Problemen.

## Schritt 3: Claude etwas Kleines fragen

Beginnen Sie mit einer Anfrage, die nur liest:

> „Fassen Sie die fünf neuesten ungelesenen E-Mails in meinem Hotmail-Posteingang zusammen und sagen Sie mir, welche eine Antwort brauchen.“

Claude nutzt das Tool \`email_read\`, um die Nachrichten aufzulisten und zu öffnen. Kommt eine Antwort, steht die Verbindung. Probieren Sie danach:

- „Finden Sie die Bestellbestätigung, die ich letzte Woche bekommen habe, und nennen Sie mir das Lieferdatum.“
- „Entwerfen Sie eine Antwort auf die letzte E-Mail meines Vermieters, aber senden Sie sie nicht.“
- „Verschieben Sie alle Newsletter aus diesem Monat in einen Ordner namens Lesen.“

Wenn Sie auch Gmail, iCloud oder ein Postfach von der Arbeit haben, verbinden Sie diese auf dieselbe Weise, und Claude sieht alle über denselben Konnektor. [Mehrere E-Mail-Konten in Claude und ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) erklärt, wie Claude sie auseinanderhält.

## Was Claude mit einem Postfach bei Outlook.com kann

Nach der Verbindung arbeitet Claude mit denselben E-Mail-Tools wie bei jedem anderen Anbieter:

- E-Mails lesen und durchsuchen.
- Von Ihrer eigenen Adresse senden, antworten und weiterleiten, auch mit Anhängen.
- Entwürfe erstellen und bearbeiten und den Versand für später planen.
- Ordner anlegen, auch verschachtelte, und Nachrichten verschieben, kopieren und archivieren.
- Nachrichten kennzeichnen und als gelesen oder ungelesen markieren.
- Nachrichten nach „Gelöschte Elemente“ verschieben oder endgültig löschen.
- Die Signatur, die Sie für dieses Postfach festgelegt haben, an jede gesendete Nachricht anhängen.

Outlook.com ordnet E-Mails in Ordnern, nicht mit Labels. Claude sortiert also, indem es Nachrichten in einen Ordner verschiebt. Eine Grenze von Microsoft Graph sollten Sie kennen: Eine Textsuche lässt sich nicht mit den Filtern für ungelesen, Anhang, gekennzeichnet oder Datum kombinieren. Enthält eine Suche Text, fallen diese Filter weg, und Claude erfährt im Ergebnis, welche. Suchen Sie zuerst nach dem Text und lassen Sie Claude die Treffer danach eingrenzen.

MCPEmails schickt neue E-Mails nicht von sich aus an Claude. Claude sieht nach, wenn Sie darum bitten. Das passt gut zum Sichten und Zusammenfassen.

## Werden meine E-Mails von Outlook.com irgendwo gespeichert?

Nein. Jedes Mal, wenn Claude eine Nachricht anfordert, ruft MCPEmails sie live bei Microsoft ab, übergibt sie an Claude und verwirft sie. Für das Postfach bleibt das OAuth-Token aus Ihrer Anmeldung bei Microsoft gespeichert, im Ruhezustand verschlüsselt, dazu die wenigen Angaben, die eine von Ihnen eingeschaltete Funktion braucht, etwa eine geplante Nachricht, die noch auf den Versand wartet. Zum Trennen löschen Sie das Postfach in MCPEmails oder entfernen MCPEmails aus den Apps, die Zugriff auf Ihr Microsoft-Konto haben. [Warum „E-Mails werden nie gespeichert“ wichtig ist](/blog/why-email-never-stored-matters) erklärt das Modell, und [Ist es sicher, einem KI-Agenten E-Mail-Zugriff zu geben?](/blog/is-it-safe-to-give-ai-agent-email-access) zeigt, worauf Sie achten sollten, etwa auf Anweisungen, die in einer E-Mail versteckt sind.

## FAQ

**Kann ich Claude mit Outlook.com oder Hotmail verbinden?**
Ja. Der eingebaute Microsoft 365-Konnektor von Claude unterstützt keine privaten Microsoft-Konten, ein benutzerdefinierter Konnektor aber schon. Verbinden Sie die Adresse mit „Mit Microsoft verbinden“ bei MCPEmails, fügen Sie \`https://mcpemails.com/api/mcp\` in Claude unter Anpassen → Konnektoren hinzu, und Claude kann Ihre E-Mails bei Outlook.com, Hotmail, Live oder MSN lesen, durchsuchen, senden und organisieren.

**Warum lehnt der Microsoft 365-Konnektor von Claude meine Hotmail-Adresse ab?**
Laut der Hilfeseite von Anthropic braucht dieser Konnektor einen Microsoft Entra-Mandanten, der an einen Microsoft Business-Tarif gebunden ist, und einen Globalen Administrator, der ihn autorisiert. Private Microsoft-Konten lassen sich damit nicht verwenden. Ein privates Konto hat weder Mandanten noch Administrator.

**Brauche ich ein App-Passwort oder IMAP-Einstellungen?**
Nein. Private Microsoft-Konten verbinden sich über die Anmeldung mit Microsoft und Microsoft Graph. Microsoft akzeptiert bei diesen Konten keine Anmeldung per Passwort aus E-Mail-Apps anderer Hersteller mehr, ein App-Passwort käme also ohnehin nicht durch.

**Funktioniert das mit einer alten Hotmail-Adresse?**
Ja. Adressen bei Hotmail, Live, MSN und Outlook.com gehören zum selben E-Mail-Dienst von Microsoft für Privatkunden und verbinden sich alle auf dieselbe Weise. Hat das Microsoft-Konto, mit dem Sie sich anmelden, kein Outlook-Postfach, lehnt MCPEmails die Verbindung ab und sagt Ihnen das.

**Funktioniert dieselbe Einrichtung in ChatGPT?**
Ja. Die Konnektor-URL ist dieselbe, und [ChatGPT mit Ihren E-Mails verbinden](/blog/connect-chatgpt-to-email) erklärt die Schritte in ChatGPT.

## Nächster Schritt

[Kostenlos starten](/signup), Ihr Postfach bei Outlook.com oder Hotmail mit Microsoft verbinden, die URL in Claude eintragen und Claude bitten, Ihre ungelesenen E-Mails zusammenzufassen. Für alle anderen Anbieter deckt die [Anleitung für E-Mail in Claude](/blog/connect-claude-to-email) Gmail, iCloud, Fastmail und IMAP ab.`,
};

export default translation;
