const translation = {
  title: 'Claude mit Hotmail und Outlook.com verbinden (private Microsoft-Konten)',
  description:
    'Der Microsoft 365-Konnektor von Claude nimmt in den Tarifen Free, Pro, Max und Ultra jetzt auch ein privates Microsoft-Konto an. Wann das reicht, und wie Sie Hotmail, Outlook.com, Live oder MSN mit Anhängen, mehreren Postfächern oder im Team-Tarif über eine einzige URL für einen benutzerdefinierten Konnektor mit Claude verbinden.',
  coverAlt: 'Claude über MCPEmails mit einem privaten Postfach bei Outlook.com oder Hotmail verbunden',
  content: `Es gibt zwei Wege, Claude mit einer privaten Adresse bei Outlook.com, Hotmail, Live oder MSN zu verbinden. Der eigene Microsoft 365-Konnektor von Claude nimmt in den Tarifen Free, Pro, Max und Ultra ein privates Microsoft-Konto an, ganz ohne Administrator. Der andere Weg ist MCPEmails: Sie fügen das Postfach mit **Mit Microsoft verbinden** hinzu und tragen dann eine einzige URL als benutzerdefinierten Konnektor in Claude ein. Der zweite Weg deckt ab, was der eingebaute Konnektor auslässt: Anhänge, mehrere Postfächer hinter einer Verbindung, die Tarife Team und Enterprise sowie dasselbe Postfach in ChatGPT oder jedem anderen MCP-Client. Eine alte hotmail.com-Adresse funktioniert auf beiden Wegen genauso wie eine neue outlook.com-Adresse. Alle Einstellungen auf einen Blick finden Sie auf der Seite [Outlook mit Claude verbinden](/connect/outlook).

Diese Anleitung gilt für private Microsoft-Konten in Claude. Wenn Ihre E-Mails in einem Arbeits- oder Schulkonto bei Microsoft 365 liegen, lesen Sie stattdessen die [Anleitung für Outlook und Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

## Was der Microsoft 365-Konnektor von Claude mit einem privaten Konto kann

Der Artikel [Connect to Microsoft 365](https://support.claude.com/en/articles/15183774-connect-to-microsoft-365) von Anthropic deckt jetzt auch private Konten ab. In den Tarifen Free, Pro, Max und Ultra verbinden Sie ein Konto bei Outlook.com, Hotmail, Live oder MSN selbst; ein Administrator ist nicht nötig. Der Konnektor erreicht Outlook und OneDrive, und seine Schreib-Tools sind enthalten. Claude kann also E-Mails entwerfen und senden und Kalendereinträge verwalten, nachdem es Sie vorher gefragt hat.

Drei Grenzen aus demselben Artikel sind für E-Mail wichtig:

- **Keine Anhänge in den Schreib-Tools.** Claude kann darüber keine E-Mail mit Anhang senden, weiterleiten oder entwerfen.
- **Nicht in Team und Enterprise.** Diese Tarife bekommen die Option für private Konten nicht angezeigt. Eine private Hotmail-Adresse neben einem Arbeitstarif hat also keinen eingebauten Weg.
- **Nur in Claude, nur für das Konto, mit dem Sie sich anmelden.** Gmail hat einen eigenen Konnektor; Postfächer bei iCloud, Yahoo und IMAP haben keinen, und nichts davon lässt sich in ChatGPT oder einen anderen MCP-Client mitnehmen.

Arbeits- oder Schulkonten sind ein anderer Fall: Dort muss weiterhin ein Globaler Administrator in Microsoft Entra zustimmen, bevor sich jemand in der Organisation verbinden kann. Die [Anleitung für Outlook und Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp) und die [Seite zur Admin-Zustimmung](/docs/microsoft-365-admin-consent) behandeln das.

Wenn Ihnen ein privates Outlook.com-Postfach in Claude ohne Anhänge reicht, erledigt das der eingebaute Konnektor. Der Rest dieser Anleitung ist der Weg für alles andere.

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
5. Klicken Sie auf **Verbinden**, melden Sie sich bei Ihrem MCPEmails-Konto an und legen Sie auf dem Zustimmungsbildschirm fest, wie viel Zugriff Claude bekommt: **Nur-Lese-Zugriff**, **Standard** (zusätzlich Senden und Entwürfe) oder **Vollzugriff**.

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
Ja, auf zwei Wegen. In Free, Pro, Max oder Ultra nimmt der eingebaute Microsoft 365-Konnektor von Claude ein privates Microsoft-Konto direkt an, allerdings ohne Anhänge. Für Anhänge, mehrere Postfächer, einen Team- oder Enterprise-Tarif oder dasselbe Postfach in ChatGPT verbinden Sie die Adresse mit „Mit Microsoft verbinden“ bei MCPEmails, fügen Sie \`https://mcpemails.com/api/mcp\` in Claude unter Anpassen → Konnektoren hinzu, und Claude kann Ihre E-Mails bei Outlook.com, Hotmail, Live oder MSN lesen, durchsuchen, senden und organisieren.

**Warum lehnt der Microsoft 365-Konnektor von Claude meine Hotmail-Adresse ab?**
Prüfen Sie den Tarif. Laut Anthropic verbinden sich private Microsoft-Konten in Free, Pro, Max und Ultra, und die Tarife Team und Enterprise bekommen diese Option nicht angezeigt. Eine Arbeits- oder Schuladresse ist etwas anderes: Dort muss zuerst ein Globaler Administrator im Microsoft Entra-Mandanten zustimmen. In einem Team- oder Enterprise-Tarif ist MCPEmails als benutzerdefinierter Konnektor der Weg für eine private Adresse.

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
