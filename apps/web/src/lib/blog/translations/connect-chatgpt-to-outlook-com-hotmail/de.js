const translation = {
  title: 'ChatGPT mit Hotmail und Outlook.com verbinden (private Microsoft-Konten)',
  description:
    'Das Outlook-Plugin von ChatGPT ist für Arbeits- und Schulkonten gebaut. So verbinden Sie ein privates Postfach bei Hotmail, Outlook.com, Live oder MSN mit ChatGPT: Anmeldung bei Microsoft und eine URL für einen benutzerdefinierten MCP-Server.',
  coverAlt: 'ChatGPT über MCPEmails mit einem privaten Postfach bei Outlook.com oder Hotmail verbunden',
  content: `Um ChatGPT mit einer privaten Adresse bei Outlook.com, Hotmail, Live oder MSN zu verbinden, fügen Sie das Postfach mit **Mit Microsoft verbinden** zu MCPEmails hinzu und tragen dann eine URL als benutzerdefinierten MCP-Server in ChatGPT ein. Das eigene Outlook-Plugin von ChatGPT ist um Arbeits- und Schulkonten bei Microsoft herum gebaut, und wer es mit einer privaten Adresse versucht, berichtet von der Meldung, dass sich nur Geschäfts- oder Bildungskonten verbinden lassen. Ein benutzerdefinierter MCP-Server hat diese Grenze nicht.

Diese Anleitung gilt für private Microsoft-Konten in ChatGPT. Für Claude lesen Sie [Claude mit Hotmail und Outlook.com verbinden](/blog/connect-claude-to-outlook-com-hotmail). Für Arbeits- oder Schulkonten bei Microsoft 365 lesen Sie die [Anleitung für Outlook und Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

## Was das Outlook-Plugin von ChatGPT unterstützt

ChatGPT hat Plugins für Outlook E-Mail und Outlook Kalender. Die [Hilfeseite von OpenAI](https://help.openai.com/en/articles/12512241) dazu ist für Organisationen geschrieben: Manche Aktionen brauchen Microsoft-Berechtigungen, die ein Microsoft Entra-Administrator für die Organisation genehmigen muss, und Workspace-Admins legen fest, welche Aktionen eingeschaltet sind. Ob private Microsoft-Konten unterstützt werden, sagt die Seite nicht.

Nutzer, die es versucht haben, sagen nein. In einem [Thread bei Microsoft Q&A](https://learn.microsoft.com/en-gb/answers/questions/5558072/cant-connect-outlook-to-chatgpt) vom September 2025 wurde ein Hotmail-Nutzer beim Anmeldeschritt für Outlook mit der Meldung gestoppt, dass sich nur Geschäfts- oder Bildungskonten verbinden lassen. Eine Antwort vom April 2026 sagt, dass private Konten bei Hotmail und Outlook.com sich weiterhin nicht verbinden konnten. OpenAI hat seitdem keine Änderung dokumentiert. Probieren Sie also zuerst das Plugin, wenn Sie möchten: Akzeptiert es Ihre Adresse, brauchen Sie vielleicht nichts weiter.

Lehnt es Sie ab, liegt es am Kontotyp. Hinter einem privaten Microsoft-Konto stehen weder eine Organisation noch ein Administrator. Es gibt auf Ihrer Seite keine Einstellung, die das ändert.

## Was Sie brauchen

- Ein privates Microsoft-Konto mit Outlook-Postfach: outlook.com, hotmail.com, live.com oder msn.com, auch Länderversionen wie hotmail.de oder outlook.de.
- **ChatGPT Go oder ein kostenpflichtiger Tarif, auf chatgpt.com im Browser.** OpenAI erlaubt diesen Tarifen, einen benutzerdefinierten MCP-Server hinzuzufügen. Free kann das nicht, und in der Mobil-App lässt sich keiner hinzufügen.
- Ein MCPEmails-Konto. [Kostenlos starten](/signup); der kostenlose Tarif verbindet ein Postfach.

MCPEmails spricht auf der einen Seite über das Model Context Protocol mit ChatGPT und auf der anderen über Microsoft Graph mit Ihrem Postfach.

## Schritt 1: Postfach bei Outlook.com oder Hotmail verbinden

1. Öffnen Sie im Dashboard von MCPEmails **Postfächer** und klicken Sie auf **Postfach verbinden**.
2. Wählen Sie **Outlook** und klicken Sie auf **Mit Microsoft verbinden**.
3. Melden Sie sich auf der Seite von Microsoft mit Ihrer Adresse bei Outlook.com, Hotmail, Live oder MSN an und schließen Sie die Bestätigung in zwei Schritten ab, falls Ihr Konto sie nutzt.
4. Genehmigen Sie die Berechtigungen. Microsoft fragt, ob MCPEmails Ihre E-Mails lesen und ändern, E-Mails in Ihrem Namen senden, diesen Zugriff behalten sowie Ihr Basisprofil und Ihre E-Mail-Adresse sehen darf.

Danach landen Sie wieder im Dashboard, und das Postfach ist verbunden. Bei einem privaten Konto ist kein Administrator beteiligt, und Sie geben Ihr Microsoft-Passwort nie in MCPEmails ein.

### IMAP und App-Passwörter überspringen

Ältere Anleitungen raten, ein App-Passwort zu erstellen und die IMAP-Einstellungen von Outlook einzutragen. Microsoft hat die [Anmeldung per Passwort für Outlook-Konten in E-Mail-Apps anderer Hersteller](https://support.microsoft.com/en-us/office/modern-authentication-methods-now-needed-to-continue-syncing-outlook-email-in-non-microsoft-email-apps-c5d65390-9676-4763-b41f-d7986499a90d) am 16. September 2024 beendet, dieser Weg meldet sich also nicht mehr an. Wenn Sie **IMAP / SMTP** wählen und eine Adresse bei Hotmail oder Outlook.com eingeben, verweist das Dashboard Sie zurück auf **Mit Microsoft anmelden**. Die [Seite mit den Einstellungen für Outlook.com](/connect/outlook) hat die Details an einem Ort.

## Schritt 2: MCPEmails zu ChatGPT hinzufügen

1. Öffnen Sie auf chatgpt.com **Plugins**, dann **Personal**, und klicken Sie oben rechts auf **Add**.
2. Wählen Sie **Add custom MCP server** und nennen Sie ihn MCPEmails.
3. Fügen Sie unter **Connection** diese URL ein:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Wählen Sie **OAuth**, setzen Sie das Häkchen bei **I understand and want to continue** und klicken Sie auf **Create as a plugin**.
5. Melden Sie sich bei MCPEmails an und genehmigen Sie den Zugriff, den ChatGPT haben soll, zum Beispiel zunächst nur Lesen.
6. Tippen Sie in einem Chat **@** und wählen Sie MCPEmails. Die Auswahl gilt für diese Nachricht, erwähnen Sie MCPEmails also erneut mit @, wenn eine Folgefrage Ihre E-Mails braucht.

Wählen Sie OAuth, nicht „keine Authentifizierung“. Ein Konnektor ohne Authentifizierung sieht bei der Einrichtung gut aus und scheitert dann beim ersten Aufruf. In einem Business- oder Enterprise-Workspace muss unter Umständen ein Admin den Server für Sie hinzufügen. OpenAI verschiebt diese Menüs hin und wieder; die [Einrichtungsseite für ChatGPT](/docs/chatgpt) zeigt den aktuellen Weg.

## Schritt 3: ChatGPT etwas Kleines fragen

Beginnen Sie nur mit Lesen:

> Fassen Sie meine fünf neuesten ungelesenen E-Mails in meinem Hotmail-Postfach zusammen und sagen Sie mir, welche eine Antwort brauchen.

Wenn es antwortet, funktioniert die Verbindung. Dann probieren Sie:

- „Finden Sie die Bestellbestätigung von letzter Woche und nennen Sie mir das Lieferdatum.“
- „Entwerfen Sie eine Antwort auf die letzte E-Mail meines Vermieters, aber senden Sie sie nicht.“
- „Verschieben Sie alle Newsletter dieses Monats in einen Ordner namens Lesestoff.“

Wenn Sie außerdem Gmail, iCloud, Yahoo, GMX oder ein Arbeitspostfach haben, verbinden Sie auch diese mit MCPEmails, und ChatGPT sieht alle über denselben Server. [Mehrere E-Mail-Konten in Claude und ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) erklärt, wie es sie auseinanderhält.

## Was ChatGPT mit einem Postfach bei Outlook.com kann

- E-Mails lesen und durchsuchen.
- Von Ihrer eigenen Adresse senden, antworten und weiterleiten, auch mit Anhängen.
- Entwürfe anlegen und bearbeiten und einen Versand für später planen.
- Ordner anlegen, auch verschachtelte, und Nachrichten verschieben, kopieren und archivieren.
- Nachrichten kennzeichnen und als gelesen oder ungelesen markieren.
- Nachrichten in „Gelöschte Elemente“ verschieben oder endgültig löschen.
- Die Signatur, die Sie für das Postfach festgelegt haben, an jede gesendete Nachricht anfügen.

Outlook.com arbeitet mit Ordnern, nicht mit Labels, ChatGPT legt E-Mails also durch Verschieben ab. Eine Grenze von Microsoft Graph sollten Sie kennen: Eine Textsuche lässt sich nicht mit den Filtern für ungelesen, Anhang, gekennzeichnet oder Datum kombinieren. Enthält eine Suche Text, fallen diese Filter weg, und das Ergebnis nennt, welche. Fragen Sie zuerst nach dem Text und lassen Sie ChatGPT die Treffer dann eingrenzen.

MCPEmails schickt neue E-Mails nicht von sich aus an ChatGPT. Es prüft, wenn Sie danach fragen.

## Werden meine E-Mails von Outlook.com irgendwo gespeichert?

Nein. Jedes Mal, wenn ChatGPT nach einer Nachricht fragt, ruft MCPEmails sie live von Microsoft ab, reicht sie weiter und verwirft sie. Aufbewahrt wird für das Postfach das OAuth-Token aus Ihrer Anmeldung bei Microsoft, verschlüsselt im Ruhezustand, plus die wenigen Angaben, die eine von Ihnen eingeschaltete Funktion braucht, etwa eine geplante Nachricht, die auf ihren Versand wartet. Zum Trennen löschen Sie das Postfach in MCPEmails oder entfernen MCPEmails aus den Apps, die Zugriff auf Ihr Microsoft-Konto haben. [Warum es wichtig ist, dass E-Mails nie gespeichert werden](/blog/why-email-never-stored-matters), erklärt das Modell.

## FAQ

**Kann ich ChatGPT mit Hotmail oder Outlook.com verbinden?**
Ja, mit einem benutzerdefinierten MCP-Server. Verbinden Sie die Adresse über „Mit Microsoft verbinden“ mit MCPEmails, fügen Sie \`https://mcpemails.com/api/mcp\` in ChatGPT unter Plugins hinzu, und ChatGPT kann Ihre E-Mails bei Outlook.com, Hotmail, Live oder MSN lesen, durchsuchen, senden und ordnen. Für einen benutzerdefinierten MCP-Server braucht es ChatGPT Go oder einen kostenpflichtigen Tarif.

**Funktioniert das Outlook-Plugin von ChatGPT mit einem privaten Konto?**
Die Hilfeseite von OpenAI sagt es nicht, und Nutzer berichten, bei der Anmeldung die Meldung zu bekommen, dass sich nur Geschäfts- oder Bildungskonten verbinden lassen. Die dokumentierte Einrichtung setzt auf den Microsoft Entra-Administrator einer Organisation, den ein privates Konto nicht hat.

**Brauche ich ein App-Passwort oder IMAP-Einstellungen?**
Nein. Private Microsoft-Konten verbinden sich über „Mit Microsoft anmelden“ und Microsoft Graph. Microsoft akzeptiert bei diesen Konten keine Anmeldung per Passwort aus E-Mail-Apps anderer Hersteller mehr.

**Funktioniert es mit einer alten Hotmail-Adresse?**
Ja. Adressen bei Hotmail, Live, MSN und Outlook.com gehören zum selben E-Mail-Dienst von Microsoft für Privatkunden und verbinden sich auf dieselbe Weise.

**Funktioniert dieselbe Einrichtung in Claude?**
Ja, mit derselben URL. [Claude mit Hotmail und Outlook.com verbinden](/blog/connect-claude-to-outlook-com-hotmail) führt durch die Claude-Seite und funktioniert in jedem Claude-Tarif, auch in Free.

## Nächster Schritt

[Kostenlos starten](/signup), Ihr Postfach bei Outlook.com oder Hotmail mit Microsoft verbinden, die URL in ChatGPT einfügen und es bitten, Ihre ungelesenen E-Mails zusammenzufassen. Für andere Anbieter behandelt [ChatGPT mit E-Mail verbinden](/blog/connect-chatgpt-to-email) Gmail, iCloud und IMAP.`,
};

export default translation;
