const translation = {
  title: 'So verbinden Sie jedes E-Mail-Konto mit Claude oder ChatGPT (Yahoo, IMAP, eigene Domain, mehrere Postfächer)',
  description:
    'Alle Wege, Claude oder ChatGPT ein echtes Postfach zu geben, Stand November 2026: was die integrierten Konnektoren für Gmail, Outlook und iCloud abdecken, wo sie enden, und wie Sie Yahoo, eine eigene Domain, GMX oder mehrere Postfächer über einen MCP-Server, eine Desktop-App oder ein Automatisierungstool verbinden.',
  coverAlt: 'Yahoo, IMAP, eigene Domain und mehrere weitere Postfächer mit Claude und ChatGPT verbunden',
  content: `Claude und ChatGPT bringen beide eigene E-Mail-Konnektoren mit, und beide hören bei den großen Anbietern auf. Liegt Ihre Post bei Yahoo, AOL, GMX, auf einer Firmendomain bei IONOS, OVH oder einem cPanel-Hoster, oder verteilt über mehrere Konten, brauchen Sie etwas anderes. Diese Anleitung listet jede Option mit Stand November 2026: die integrierten Konnektoren und genau die Stelle, an der sie enden, die gehosteten MCP-Dienste, die die Lücke füllen (MCPEmails ist einer davon, und wir nennen die anderen), die lokalen und selbst betriebenen Wege und die Automatisierungsplattformen. Jede Aussage über ein anderes Produkt wurde am 11. November 2026 auf dessen eigener Seite gelesen; die Quellen stehen am Ende.

**Direkt zu:** [Integrierte Konnektoren](#was-die-integrierten-konnektoren-abdecken) · [Was offen bleibt](#was-die-integrierten-konnektoren-auslassen) · [Gehostete MCP-Dienste](#gehostete-mcp-dienste) · [Desktop und Self-Hosting](#desktop-apps-und-selbst-betriebene-server) · [Automatisierungstools](#automatisierungsplattformen) · [Vergleichstabelle](#die-optionen-im-vergleich) · [Einrichtung mit MCPEmails](#so-geht-es-mit-mcpemails) · [FAQ](#faq)

## Was die integrierten Konnektoren abdecken

Fangen Sie hier an, denn wenn Ihr einziges Postfach Gmail, ein geschäftliches Microsoft 365-Konto oder iCloud ist, brauchen Sie vielleicht gar nichts weiter.

**Claude: Gmail.** Der Gmail-Konnektor im Verzeichnis von Claude stammt von Google. Er liest und durchsucht E-Mails, schreibt Entwürfe, sendet, antwortet, leitet weiter, verwaltet Labels und verschiebt Nachrichten in den Papierkorb, und standardmäßig fragt Claude vor jeder dieser Aktionen nach Ihrer Freigabe. Das Hilfezentrum von Anthropic beschreibt ihn so, dass er "the Google account you've connected" erreicht: ein Google-Konto pro Verbindung. Anhänge kommen nur als Metadaten durch. Er steht allen Claude-Nutzern zur Verfügung; bei Team und Enterprise schaltet ihn zuerst ein Owner frei.

**Claude: Microsoft 365 und privates Outlook.com.** Zwei Fälle. Ein Geschäfts- oder Schulkonto braucht einen Microsoft Entra-Tenant, eine einmalige Zustimmung eines Global Administrator, und ist nur lesend, bis die Organisation Schreibwerkzeuge aktiviert. Ein privates Microsoft-Konto (Outlook.com, Hotmail, Live oder MSN) verbindet sich in den Tarifen Free, Pro, Max und Ultra ohne Administrator, mit Schreibwerkzeugen inklusive, sodass Claude Entwürfe schreiben, senden und E-Mails ordnen kann und vorher fragt; diese Option wird bei Team und Enterprise nicht angezeigt, und die Schreibwerkzeuge können keine Anhänge verarbeiten.

**Claude: Spark.** Der Konnektor von Spark Mail steht im Verzeichnis von Claude und ist der eine integrierte Weg zu Yahoo oder IMAP in Claude, mit einem Haken: Er liest die Konten, die Sie in der Spark-Desktop-App hinzugefügt haben, und die Werkzeuge sind nur da, solange Spark Desktop auf Ihrem Mac oder PC läuft. Mehr dazu unter [Desktop-Apps](#desktop-apps-und-selbst-betriebene-server).

**ChatGPT: Gmail und Outlook.** Beide sind Apps unter **Einstellungen**, dann **Plugins**. Seit Juni 2026 kann ChatGPT aus einem verbundenen Gmail- oder Outlook-Konto Entwürfe schreiben und senden, im Web, für Plus, Pro, Business und Enterprise. Seit August 2026 kann das Gmail-Plugin mehrere Google-Konten halten, und OpenAI hat mehrere Konten später auf andere Plugins in allen Tarifen ausgeweitet. Die App Outlook Email ist für geschäftliche Microsoft-Konten dokumentiert: Was sie darf, hängt von der Microsoft Entra-Zustimmung und den Einstellungen des Arbeitsbereichs ab, und sie kann aus einem freigegebenen oder delegierten Postfach, auf das Sie bereits Zugriff haben, lesen, verschieben und Klartext senden. Die Seite von OpenAI beschreibt private Outlook.com-Konten nicht; [ChatGPT mit Outlook.com und Hotmail verbinden](/blog/connect-chatgpt-to-outlook-com-hotmail) behandelt, was Nutzer dabei erleben.

**ChatGPT: iCloud Mail.** Am 27. Oktober 2026 hinzugefügt und im Rollout für jeden ChatGPT-Tarif im Web, in der Desktop-App und unter iOS. Es meldet sich mit einem App-spezifischen Passwort von Apple an und nimmt eine Adresse, die auf @icloud.com, @me.com oder @mac.com endet, sodass ein Gmail- oder Yahoo-Konto, das in Apple Mail neben iCloud liegt, nicht dazugehört. Die Kontaktsuche ist nur lesend. Details in [Das iCloud-Mail-Plugin von ChatGPT](/blog/chatgpt-icloud-mail-plugin).

**Der eigene MCP-Server Ihres Anbieters.** Fastmail betreibt einen unter \`api.fastmail.com/mcp\`, mit getrenntem Lese-, Schreib- und Sendezugriff, ohne Zugriff auf Anhänge und mit einem Fastmail-Konto pro Verbindung in Claude. Zoho Mail betreibt ebenfalls einen, kostenlos in kostenlosen und bezahlten Zoho-Tarifen, mit Senden, Antworten, Labels, Markierungen und Ordnern, und er kann Werkzeuge anderer Zoho-Dienste mittragen. Jeder bedient die Postfächer, die dieser Anbieter hält, und jeder wird Claude oder ChatGPT als benutzerdefinierter Konnektor hinzugefügt.

## Was die integrierten Konnektoren auslassen

Setzt man die Liste oben zusammen, bleiben diese Postfächer in beiden Assistenten ohne integrierten Weg:

- **Yahoo Mail und AOL.** Kein Konnektor in Claude, kein Plugin in ChatGPT.
- **Eine eigene Domain bei einem Webhoster oder Mail-Hoster.** cPanel und Shared Hosting, IONOS, OVH, Namecheap, GoDaddy, Hostinger, STRATO, one.com, Migadu und der Rest. Das sind IMAP- und SMTP-Postfächer, und keiner der Assistenten spricht IMAP.
- **Regionale Anbieter.** GMX, web.de, T-Online, Orange, Libero, Seznam, Yandex, mail.ru und ähnliche.
- **Mehrere Postfächer in einer Verbindung.** Das Gmail-Plugin von ChatGPT kann mehrere Google-Konten halten, und ChatGPT lässt Sie mehrere Apps nebeneinander verbinden. Keiner der Assistenten hat einen integrierten Weg, ein Gmail, ein Yahoo und ein IMAP-Firmenpostfach über eine Verbindung zu erreichen, die weiß, welches welches ist.
- **Privates Outlook.com in ChatGPT.** Für Claude in den privaten Tarifen dokumentiert; auf der Outlook-Seite von OpenAI nicht beschrieben.
- **Andere Clients als Claude und ChatGPT.** Cursor, Codex, Gemini CLI, VS Code, Zed und andere MCP-Clients haben keinen eigenen E-Mail-Konnektor. Alles, was ein Standard-MCP-Server ist, funktioniert dort; ein Konnektor, der in einem Assistenten wohnt, nicht.

Der Rest dieser Anleitung dreht sich darum, diese Liste abzudecken.

## Gehostete MCP-Dienste

Ein gehosteter MCP-E-Mail-Server meldet sich für Sie bei Ihrem Postfach an, über IMAP und SMTP oder die eigene API des Anbieters, und stellt das Postfach jedem MCP-Client über eine URL bereit. Diese URL fügen Sie Claude als benutzerdefinierten Konnektor und ChatGPT als benutzerdefinierten MCP-Server hinzu. Die Dienste unten tun das alle; sie unterscheiden sich bei Anbietern, Hosting und Preis. Unser bewerteter und datierter Vergleich, mit den Schwächen jedes Einzelnen, ist [die besten MCP-Server für E-Mail](/best-email-mcp-servers).

- **MCPEmails** (diese Website). Gmail und Google Workspace mit einem Google-App-Passwort, Outlook.com und Microsoft 365 mit Anmelden mit Microsoft, iCloud, Fastmail, Yahoo, AOL, Zoho, Yandex und jeder IMAP- und SMTP-Host mit App-Passwort oder Postfachpasswort. Mehrere Postfächer in beliebiger Mischung hinter einer URL, jedes sendet von seiner eigenen Adresse. Funktioniert in Claude, ChatGPT, Cursor, Codex und den anderen [unterstützten Clients](/docs/clients). Eine Sperre pro Postfach kann jeden Versand auf Ihre Freigabe warten lassen. E-Mails werden live abgerufen und nicht gespeichert.
- **Mailbox MCP** (mailbox-mcp.com). Microsoft 365 und Outlook.com über eine Microsoft-Anmeldung, Gmail mit App-Passwort, iCloud und jeder IMAP-Host, mit Einrichtungsanleitungen für Yahoo und GMX/WEB.DE. Funktioniert in Claude, ChatGPT, Grok, Cursor, VS Code, Zed, Windsurf, Cline und anderen. Zugriffsstufen pro Verbindung von nur lesen bis senden und löschen. Mehrere Postfächer, jedes in seinem eigenen Tarif. Bringt Kalender- und Adressbuchwerkzeuge mit.
- **MailMCP** (mailmcp.io). Jeder Anbieter, der IMAP und SMTP unterstützt, mit erkannten Servereinstellungen für die gängigen. Funktioniert in Claude, ChatGPT, Cursor, VS Code, Windsurf, n8n und LibreChat. Sendet und kann einen Versand planen. Mehrere Konten aus einem Dashboard, jedes mit eigenen Zugangsdaten. Daten in Frankreich gehostet.
- **Mailopoly** (mailopoly.com). Eine E-Mail-App mit vereinheitlichtem Posteingang für Gmail, Outlook, iCloud, Yahoo und IMAP, deren MCP-Server mit der App kommt. In den Verzeichnissen von Claude und ChatGPT gelistet, und jeder Client für entfernte MCP-Server funktioniert. Das Senden liegt hinter einer Berechtigung und ist als bestätigen-zuerst markiert. Eine Verbindung deckt alle Konten ab, die Sie besitzen.

Alle vier setzen einen Dritten zwischen den Assistenten und Ihr Postfach, lesen Sie also vor der Wahl, wie jeder mit Zugangsdaten und Nachrichteninhalten umgeht. [Ist es sicher, einem KI-Agenten Zugriff auf E-Mails zu geben?](/blog/is-it-safe-to-give-ai-agent-email-access) ist unsere Sicht darauf, worauf Sie achten sollten.

## Desktop-Apps und selbst betriebene Server

Wenn Sie die Post lieber auf Ihrem eigenen Rechner behalten, gibt es drei Wege.

- **Eine Desktop-Mail-App mit MCP-Konnektor.** Der Spark-Konnektor für Claude (Spark Mail Limited, Anthropic verified) stellt "any Spark email account, including Gmail, Outlook, Exchange, iCloud, Yahoo, and IMAP" bereit, mit einer Stufe pro Konto (nur lesen, Triage oder senden), die unter **Spark Desktop, Einstellungen, AI Agents** gesetzt wird. Er kann antworten, weiterleiten und planen. Die Einschränkung liegt im Aufbau: Die Werkzeuge erscheinen nur, solange Spark Desktop läuft, er passt also zu Claude am Rechner, an dem Sie arbeiten, nicht zu einer geplanten Aufgabe oder einem Telefon. Es ist ein Claude-Konnektor, kein Server, den andere Clients nutzen können.
- **Ein Open-Source-IMAP-Server, den Sie selbst betreiben.** Wh1isper/mcp-email-server ist ein IMAP- und SMTP-Server für mehrere Konten, BSD-3-Clause, gestartet mit \`uvx\` oder einem Container und über eine lokale Oberfläche konfiguriert. Ihre Zugangsdaten und Ihre Post verlassen den Rechner nie. Claude Desktop und die meisten Coding-Tools können einen lokalen Server ausführen; Claude im Web und ChatGPT verbinden sich nur mit entfernten Servern, dieser Weg ist also für den Desktop.
- **Selbst betriebenes MCPEmails.** Derselbe Server, der mcpemails.com betreibt, ist Open Source unter AGPL-3.0. [Betreiben Sie ihn selbst](/self-hosting) mit eigener Datenbank und eigenem Verschlüsselungsschlüssel, mit eingegrenzten API-Schlüsseln pro Client. Claude und ChatGPT erreichen ihn nur, wenn er eine öffentliche HTTPS-Adresse hat.

## Automatisierungsplattformen

Zapier und Make stellen ihre App-Kataloge inzwischen MCP-Clients bereit, womit Claude oder ChatGPT über einen Workflow statt über eine Postfachverbindung auf ein Postfach einwirken kann.

- **Zapier MCP** funktioniert mit Claude, ChatGPT, Cursor "and any other AI client", über 9.000+ Apps hinweg. Gmail gehört dazu, und die Microsoft-Outlook-App listet Send Email, Find Emails und Create Draft Email als MCP-Werkzeuge. Es ist in jedem Zapier-Tarif enthalten, und jeder Werkzeugaufruf verbraucht zwei Tasks aus Ihrem Kontingent. Die Seite, die wir gelesen haben, listet Apps namentlich und beschreibt kein generisches IMAP-Postfach.
- **Make MCP** funktioniert mit ChatGPT, Claude, Cursor und jedem MCP-Agenten. Sie bauen ein Szenario in Make (eine Gmail- oder Outlook-Suche, einen Versand), und das Szenario wird zu einem Werkzeug, das der Assistent aufrufen kann. Es ist in allen Make-Tarifen enthalten, auch im kostenlosen, und Sie zahlen für die Operationen, die die Szenarien verbrauchen.

Diese passen, wenn E-Mail ein Schritt in einer größeren Automatisierung ist, die Sie bereits in Zapier oder Make betreiben. Für ein Gespräch über Ihren Posteingang ("Was braucht heute eine Antwort?") ist eine Postfachverbindung das bessere Werkzeug, weil der Assistent suchen, lesen und nachfassen kann, ohne ein Szenario für jede Frage.

## Die Optionen im Vergleich

| Option | Welche Postfächer | Welche KI-Apps | Sendet | Mehrere Postfächer |
| --- | --- | --- | --- | --- |
| Gmail-Konnektor von Claude | Ein Google-Konto | Claude | Ja, fragt vorher | Nein |
| Microsoft 365-Konnektor von Claude | Geschäftliche Entra-Konten; privates Outlook.com, Hotmail, Live, MSN in Free, Pro, Max, Ultra | Claude | Geschäftlich: wenn der Admin Schreibwerkzeuge aktiviert. Privat: ja | Nein |
| Gmail- und Outlook-Apps von ChatGPT | Google-Konten; geschäftliche Microsoft-Konten, freigegebene und delegierte Postfächer | ChatGPT | Ja, im Web, ab Plus | Gmail: mehrere Google-Konten |
| iCloud-Mail-Plugin von ChatGPT | iCloud (@icloud.com, @me.com, @mac.com) | ChatGPT | Ja | Nicht angegeben |
| MCP-Server von Fastmail oder Zoho | Die Postfächer dieses Anbieters | Jeder MCP-Client | Ja | Fastmail in Claude: ein Konto. Zoho: wenn der Client mehrere Verbindungen zulässt |
| Spark-Konnektor | Jedes Konto in Spark Desktop, auch Yahoo und IMAP, solange die App läuft | Claude | Ja, Stufe pro Konto | Ja |
| MCPEmails | Gmail, Outlook und Microsoft 365, iCloud, Fastmail, Yahoo, AOL, Zoho, Yandex, jedes IMAP | Claude, ChatGPT, Cursor, Codex, jeder MCP-Client | Ja, optionale Sperre zur Freigabe | Ja, eine URL |
| Mailbox MCP | Microsoft 365 und Outlook.com, Gmail, iCloud, jedes IMAP | Claude, ChatGPT, Grok, Cursor, VS Code, Zed, Windsurf, Cline | Ja, Stufe pro Verbindung | Ja, pro Postfach |
| MailMCP | Jeder IMAP- und SMTP-Anbieter | Claude, ChatGPT, Cursor, VS Code, Windsurf, n8n, LibreChat | Ja, auch geplant | Ja |
| Mailopoly | Gmail, Outlook, iCloud, Yahoo, IMAP | Claude, ChatGPT, jeder Client für entfernte MCP-Server | Ja, hinter einer Berechtigung | Ja |
| Wh1isper/mcp-email-server (selbst betrieben) | Jeder IMAP- und SMTP-Anbieter | Lokale MCP-Clients | Ja | Ja |
| Zapier MCP, Make MCP | Die Apps ihrer Kataloge, darunter Gmail und Outlook | Claude, ChatGPT, Cursor, jeder MCP-Client | Ja, über eine Aktion oder ein Szenario | Pro App-Verbindung |

"Nicht angegeben" heißt, dass die gelesene Seite dazu nichts gesagt hat. Tarife und Preise fehlen absichtlich: Sie ändern sich, und die Preisseite des jeweiligen Anbieters ist der Ort, sie nachzulesen.

## So geht es mit MCPEmails

Drei Schritte, etwa fünf Minuten, und das Ergebnis funktioniert in Claude und ChatGPT gleichzeitig.

1. **Postfach verbinden.** [Erstellen Sie ein kostenloses Konto](/signup), öffnen Sie **Postfächer**, klicken Sie auf **Postfach verbinden** und wählen Sie den Anbieter. [Yahoo Mail](/connect/yahoo) und [AOL](/connect/aol) nehmen ein App-Passwort von der Seite Account Security. Eine Firmenadresse bei einem Webhoster kommt als [IMAP](/connect/imap) hinein: Adresse eintippen, und die Servereinstellungen werden für die meisten Hoster ausgefüllt, mit eigener Seite für [cPanel](/connect/cpanel), [IONOS](/connect/ionos), [OVH](/connect/ovh), [Namecheap](/connect/namecheap) und [GoDaddy](/connect/godaddy). Für den deutschen Markt gibt es [GMX](/connect/gmx), [web.de](/connect/web-de) und [T-Online](/connect/t-online). Jede Seite unter [connect](/connect) listet die Hoster, die wir kennen. Wiederholen Sie das für jedes Postfach; der Tarif entscheidet, wie viele hineinpassen.
2. **Konnektor zur KI-App hinzufügen.** In Claude öffnen Sie **Anpassen**, dann **Konnektoren**, klicken auf **+ Hinzufügen**, wählen **Benutzerdefinierten Konnektor hinzufügen** und fügen \`https://mcpemails.com/api/mcp\` ein. In ChatGPT, auf chatgpt.com im Browser mit einem bezahlten Tarif, öffnen Sie **Plugins**, klicken auf das Plus, wählen **Benutzerdefinierten MCP-Server hinzufügen**, fügen dieselbe URL ein und wählen OAuth; die Hilfeseite von OpenAI nennt die aktuellen Tarifregeln. Die Seiten pro Client ([Claude](/docs/claude), [ChatGPT](/docs/chatgpt), [Cursor](/docs/cursor), [Codex](/docs/codex) und [die übrigen](/docs/clients)) haben Screenshots und die üblichen Fehler.
3. **Fragen.** "Zeig mir meine ungelesenen Yahoo-Mails von heute" oder "durchsuche vertrieb@ und info@ nach allem aus dieser Woche, das niemand beantwortet hat". Der Assistent ruft zuerst \`inbox_list\` auf, weiß also, welches Postfach welches ist, und jede Antwort geht aus dem Postfach hinaus, zu dem sie gehört.

Schalten Sie **Vor dem Senden prüfen** (Review before sending) für ein Postfach ein, und jeder Versand daraus wartet im Dashboard auf Ihre Freigabe. Das ist in jedem Tarif enthalten.

## FAQ

### Kann ich Yahoo Mail mit Claude oder ChatGPT verbinden?

Nicht mit den integrierten Konnektoren: Stand November 2026 decken die E-Mail-Konnektoren von Claude Gmail und Microsoft-Konten ab, die Plugins von ChatGPT Gmail, Outlook und iCloud Mail. Yahoo verbindet sich über einen MCP-Server wie MCPEmails, mit einem Yahoo-App-Passwort, oder über den Spark-Konnektor in Claude, solange Spark Desktop läuft. [Yahoo Mail in ChatGPT und Claude](/blog/connect-yahoo-mail-to-chatgpt-and-claude) hat die Schritte.

### Wie verbinde ich ein Postfach auf eigener Domain bei cPanel, IONOS oder OVH mit Claude?

Über IMAP. Weder Claude noch ChatGPT sprechen selbst IMAP, also verbinden Sie das Postfach mit einem MCP-Server, der das tut (MCPEmails, Mailbox MCP, MailMCP oder ein Server, den Sie selbst betreiben), und fügen diesen Server Claude als benutzerdefinierten Konnektor hinzu. Bei MCPEmails tippen Sie die Adresse ein, die Einstellungen des Hosters werden ausgefüllt, und die Seiten zu [cPanel](/connect/cpanel), [IONOS](/connect/ionos) und [OVH](/connect/ovh) behandeln, was jeder Hoster verlangt.

### Können Claude oder ChatGPT mehrere E-Mail-Konten gleichzeitig lesen?

Das Gmail-Plugin von ChatGPT kann mehrere Google-Konten halten. Für eine Mischung aus Anbietern, oder für Claude, brauchen Sie einen MCP-Server, der jedes Postfach hält: MCPEmails, Mailbox MCP, MailMCP, Mailopoly und die selbst betriebenen Server tun das alle, und der Assistent nennt bei jedem Aufruf das Postfach. [Mehrere E-Mail-Konten in Claude und ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) zeigt, wie der Assistent sie auseinanderhält.

### Funktioniert Claude mit einem privaten Outlook.com- oder Hotmail-Konto?

Ja, Stand November 2026. Das Hilfezentrum von Anthropic sagt, dass sich ein privates Microsoft-Konto (Outlook.com, Hotmail, Live oder MSN) in den Tarifen Free, Pro, Max und Ultra ohne Administrator verbindet, mit Schreibwerkzeugen inklusive. Die Option wird bei Team und Enterprise nicht angezeigt. Ein MCP-Server wie MCPEmails verbindet Outlook.com ebenfalls mit Anmelden mit Microsoft, und dann funktioniert dasselbe Postfach auch in ChatGPT und anderen Clients.

### Brauche ich mein E-Mail-Passwort?

Meist nicht das Hauptpasswort. Yahoo, AOL, iCloud, Gmail, Fastmail und Zoho geben ein App-Passwort für andere Apps aus, und ein Postfach bei einem Webhoster nutzt das eigene Passwort des Postfachs. Die KI-App sieht es nie: Der MCP-Server hält es verschlüsselt, und Ihre KI-App meldet sich beim Server mit OAuth an. [Was ist ein App-Passwort?](/blog/what-is-an-app-password) erklärt, wo jeder Anbieter es versteckt.

### Kann ich dasselbe Postfach in Cursor, Codex oder einem anderen MCP-Client nutzen?

Ja, wenn das Postfach hinter einem Standard-MCP-Server liegt. Eine URL von MCPEmails, Mailbox MCP oder MailMCP funktioniert in Claude, ChatGPT, Cursor, Codex, VS Code und den übrigen. Ein Konnektor, der in einem Assistenten wohnt, wie der Gmail-Konnektor von Claude oder das iCloud-Plugin von ChatGPT, bleibt in diesem Assistenten.

### Speichert der MCP-Server meine E-Mails?

Das hängt vom Dienst ab, lesen Sie also die Datenschutzseite jedes Anbieters. MCPEmails ruft jede Nachricht live bei Ihrem Anbieter ab, wenn der Assistent fragt, und speichert sie nicht; nur die verschlüsselten Zugangsdaten werden behalten, plus eine Nachricht, die Sie planen oder zur Freigabe zurückhalten, bis sie gesendet ist. Mailopoly ist eine E-Mail-App, Ihre Konten werden also hinein synchronisiert. Die selbst betriebenen Optionen behalten alles auf Ihrem Rechner.

## Quellen

Gelesen am 11. November 2026: die Hilfeartikel von Anthropic zu den [Google-Workspace-Konnektoren](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors), zum [Microsoft 365-Konnektor für Organisationen](https://support.claude.com/en/articles/12542951-enabling-and-using-the-microsoft-365-connector) und zur [Verbindung mit Microsoft 365](https://support.claude.com/en/articles/15183774-connect-to-microsoft-365); die Einträge für [Gmail](https://claude.com/connectors/gmail) und [Spark](https://claude.com/connectors/spark) im Verzeichnis von Claude; die Seiten von OpenAI zu [verbundenen Apps](https://help.openai.com/en/articles/11487775-connected-apps-in-chatgpt), zu den [Apps Outlook Email und Calendar](https://help.openai.com/en/articles/12512241-outlook-email-and-calendar-apps-in-chatgpt), zu [benutzerdefinierten MCP-Servern](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt) und die [Versionshinweise](https://help.openai.com/en/articles/6825453-chatgpt-release-notes); der [MCP-Artikel von Fastmail](https://www.fastmail.help/hc/en-us/articles/15869557281295); [Zoho Mail MCP](https://www.zoho.com/mail/help/mcp/getting-started.html); [Mailbox MCP](https://mailbox-mcp.com/), [MailMCP](https://mailmcp.io/en/features) und [Mailopoly](https://www.mailopoly.com/mcp/); [Wh1isper/mcp-email-server](https://github.com/Wh1isper/mcp-email-server); [Zapier MCP](https://zapier.com/mcp) und dessen [Outlook-App](https://zapier.com/apps/mcp-client-by-zapier/integrations/microsoft-outlook); [Make MCP](https://www.make.com/en/mcp). Hat sich etwas davon seitdem geändert, [sagen Sie es uns](/help), und wir aktualisieren die Seite.

## Nächster Schritt

[Kostenlos starten](/signup), das Postfach verbinden, das die integrierten Konnektoren nicht genommen haben, und eine URL in Claude oder ChatGPT einfügen. Der Vergleich [integrierte Konnektoren und MCP-Server](/native-connectors-vs-mcp) geht tiefer auf die Abwägung ein.`,
};

export default translation;
