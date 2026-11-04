const translation = {
  title: 'Claude Custom Connectors erklärt: Tarife, Einrichtung, OAuth und Sicherheit',
  description:
    'Was benutzerdefinierte Konnektoren in Claude sind, welche Tarife und Apps sie unterstützen, wie Sie einen Remote-MCP-Server per URL hinzufügen, Anmeldeoptionen, Admin-Einstellungen und Sicherheitstipps.',
  coverAlt: 'Claude Custom Connectors erklärt: ein Remote-MCP-Server, der Claude per URL hinzugefügt wird',
  content: `Mit **benutzerdefinierten Konnektoren in Claude** (englisch Custom Connectors) fügen Sie Claude einen beliebigen Remote-Server des [Model Context Protocol](https://modelcontextprotocol.io) hinzu, indem Sie seine URL einfügen. Danach kann Claude die Tools dieses Servers in Ihren Chats aufrufen: eine Datenbank abfragen, ein Ticket anlegen oder, wie im Praxisbeispiel am Ende dieser Anleitung, Ihre E-Mails lesen und senden.

Die Angaben zu Tarifen und Menüs stammen aus den Hilfeseiten von Anthropic, geprüft am 26. Oktober 2026. Die Oberfläche von Claude ändert sich häufig. Weicht eine Bezeichnung ab, gilt Anthropics [Anleitung zu benutzerdefinierten Konnektoren](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

## Was ist ein benutzerdefinierter Konnektor in Claude?

Ein benutzerdefinierter Konnektor ist ein Remote-MCP-Server, den Sie Claude über seine URL hinzufügen, statt ihn aus dem Konnektor-Verzeichnis auszuwählen. Der Server läuft im Internet, stellt eine Reihe von Tools bereit und verlangt meist eine Anmeldung per OAuth. Claude ruft diese Tools dann in Ihrem Auftrag auf, im Rahmen der Berechtigungen, die Sie genehmigt haben.

Drei Punkte sollten Sie vorab kennen:

- **Anthropic prüft benutzerdefinierte Konnektoren nicht.** Einträge im Verzeichnis tragen die Kennzeichnung Verified oder Community. Ein Konnektor, den Sie per URL hinzufügen, verbindet Claude mit einem Dienst, den Anthropic nicht geprüft hat. Sie vertrauen also dem Betreiber des Servers.
- **Die Verbindung wird aus der Cloud von Anthropic aufgebaut, nicht von Ihrem Computer.** Laut Anthropic gilt das in jedem Claude-Client, also in claude.ai, Claude Desktop, Cowork und den mobilen Apps. Der Server muss über das öffentliche Internet erreichbar sein. Ein Server in einem privaten Netzwerk oder hinter einem VPN lässt sich nur verbinden, wenn seine Firewall die IP-Bereiche von Anthropic zulässt oder er über einen sogenannten MCP-Tunnel erreicht wird.
- **Sie fügen ihn einmal pro Konto hinzu, nicht einmal pro Gerät.**

Wenn MCP für Sie neu ist, erklärt [was ein MCP-E-Mail-Server ist](/blog/what-is-an-mcp-email-server) das Protokoll am Beispiel E-Mail.

## Wie sich benutzerdefinierte Konnektoren von Verzeichnis-Konnektoren und Desktop-Erweiterungen unterscheiden

Claude kann externe Tools auf drei Wegen erreichen:

- **Verzeichnis-Konnektoren** stehen im Konnektor-Verzeichnis von Claude. Sie finden sie unter **Anpassen → Konnektoren** und klicken auf **Verbinden**. Die Konnektoren von Claude für Gmail und Microsoft 365 gehören zu dieser Gruppe.
- **Benutzerdefinierte Konnektoren** sind Remote-MCP-Server, die Sie per URL hinzufügen. Um sie geht es in dieser Anleitung.
- **Desktop-Erweiterungen** sind lokale MCP-Server, verpackt als \`.mcpb\`-Dateien und in der Desktop-App von Claude unter **Einstellungen → Erweiterungen** installiert. Sie laufen auf Ihrem eigenen Computer. Lokale Server, die in \`claude_desktop_config.json\` eingetragen sind, bilden wiederum einen eigenen Mechanismus und stehen in claude.ai und Cowork nicht zur Verfügung.

In Claude Code fügen Sie dieselbe Art von Remote-Server über das Terminal hinzu; die [Einrichtungsseite für Claude Code](/docs/claude-code) zeigt den Befehl für MCPEmails. Wie sich ein allgemeiner MCP-Server und ein eingebauter Konnektor für einen einzelnen Anbieter im Verhalten unterscheiden, lesen Sie unter [native Konnektoren und MCP im Vergleich](/native-connectors-vs-mcp).

## Welche Claude-Tarife und Apps benutzerdefinierte Konnektoren unterstützen

Laut Hilfecenter von Anthropic, Stand Oktober 2026:

- **Tarife:** Benutzerdefinierte Konnektoren gibt es in den Tarifen Free, Pro, Max, Team und Enterprise. Der Free-Tarif ist auf einen benutzerdefinierten Konnektor begrenzt, Pro und Max haben keine Begrenzung.
- **Apps, in denen Sie sie hinzufügen:** claude.ai im Browser, Claude Desktop und Cowork.
- **Mobil:** Ein Konnektor, den Sie im Web oder in Claude Desktop verbinden, steht in Claude für iOS und Android zur Verfügung, sobald Sie sich dort das nächste Mal anmelden. Anthropic bezeichnet die Installation von Konnektoren auf Mobilgeräten als Beta und nennt Web und Desktop-App den primären Weg für benutzerdefinierte Konnektoren. Richten Sie ihn also zuerst am Computer ein.
- **Wer ihn in einem Business-Tarif hinzufügen darf:** Im Team-Tarif nur Besitzer und Hauptbesitzer. Im Enterprise-Tarif Besitzer, Hauptbesitzer und Personen mit einer benutzerdefinierten Rolle, die die Verwaltung der Bibliotheken der Organisation umfasst.

## So fügen Sie in Free, Pro oder Max einen benutzerdefinierten Konnektor hinzu

1. Öffnen Sie in claude.ai oder Claude Desktop **Anpassen → Konnektoren**.
2. Klicken Sie auf **+ Hinzufügen** und dann auf **Benutzerdefinierten Konnektor hinzufügen**.
3. Geben Sie einen Namen und die URL des Servers ein und klicken Sie auf **Weiter**.
4. Prüfen Sie die Anmeldeeinstellungen, die Claude erkannt hat. Die Standardwerte passen meist, und der nächste Abschnitt erklärt die Auswahl.
5. Klicken Sie auf **Hinzufügen** und melden Sie sich dann beim Dienst an.

Die Authentifizierungseinstellungen eines Konnektors lassen sich nach dem Hinzufügen nicht mehr ändern. Um sie zu ändern, entfernen Sie den Konnektor und fügen ihn neu hinzu. Zum Entfernen öffnen Sie **Anpassen → Konnektoren** und wählen **Entfernen** oder das Drei-Punkte-Menü daneben.

## So fügen Organisationen in Team und Enterprise benutzerdefinierte Konnektoren hinzu

In den Tarifen Team und Enterprise sind Hinzufügen und Verbinden zwei getrennte Schritte:

1. **Ein Besitzer fügt ihn für die Organisation hinzu.** Öffnen Sie **Organisationseinstellungen → Konnektoren**, klicken Sie auf **Hinzufügen**, wählen Sie **Benutzerdefiniert** und dann **Web**, falls Claude nach einem Typ fragt. Geben Sie Namen und URL ein und gehen Sie dieselben Authentifizierungsbildschirme durch.
2. **Jedes Mitglied verbindet sich mit dem eigenen Konto.** Mitglieder öffnen **Anpassen → Konnektoren**, suchen den Konnektor, der meist die Kennzeichnung **Benutzerdefiniert** trägt, und klicken auf **Verbinden**.

Da sich jede Person einzeln anmeldet, erreicht Claude nur das, worauf diese Person im verbundenen Dienst Zugriff hat. Die Ausnahme ist ein Konnektor mit gemeinsamen Zugangsdaten wie einem API-Schlüssel: Alle, die ihn nutzen, erhalten den Zugriff, den diese Zugangsdaten gewähren.

Besitzer können außerdem festlegen, was ein Konnektor in der gesamten Organisation tun darf. Jedes Tool lässt sich auf **Immer zulassen**, **Genehmigung erforderlich** oder **Blockiert** setzen, und einzelne Nutzer können die Einstellung der Organisation nicht überschreiben. Anthropics eigenes Beispiel liegt nah am E-Mail-Fall weiter unten: Claude darf E-Mails durchsuchen und zusammenfassen, aber keine Nachrichten senden.

Mitglieder, die selbst keinen Konnektor hinzufügen können, brauchen dafür einen Besitzer. Die Schaltfläche **Anfordern**, die Claude anbietet, gilt für Einträge im Verzeichnis. Bei einer benutzerdefinierten URL schicken Sie die URL also direkt an Ihren Besitzer.

## Anmeldeoptionen: OAuth, automatische Registrierung oder keine Anmeldung

Beim Hinzufügen eines Konnektors zeigt Claude bis zu drei Gruppen von Einstellungen. Die erkannten Werte stimmen in der Regel.

**Authentifizierung** legt fest, wann sich Nutzer anmelden:

- **Jetzt anmelden:** Jeder Nutzer durchläuft die OAuth-Anmeldung des Servers, bevor er den Konnektor nutzt. Das ist die richtige Wahl für einen Server mit persönlichen Daten.
- **Bei Bedarf anmelden:** Claude verbindet sich ohne Zugangsdaten und bittet Nutzer um eine Anmeldung, sobald der Server sie verlangt.
- **Keine Anmeldung:** Alle, die die URL kennen, können den Konnektor nutzen. Das gilt auch für Server, die einen festen API-Schlüssel erwarten, den Sie dann als Anforderungsheader eintragen.

**OAuth-Client** legt fest, wie sich Claude gegenüber dem Anmeldesystem des Servers ausweist. Bei Keine Anmeldung ist dieser Bereich ausgeblendet:

- **Claude-Identität verwenden** empfiehlt Anthropic. Der Server liest die Angaben zu Claude aus einem Client ID Metadata Document, das Anthropic bereitstellt. Sie müssen also nichts einrichten, sofern der Server dieses Verfahren unterstützt.
- **Automatisch registrieren** nutzt OAuth Dynamic Client Registration, das die meisten MCP-Server unterstützen.
- **Eigenen OAuth-Client verwenden** ist für eine Client-ID gedacht, die Sie selbst beim Server registriert haben.

**Anforderungsheader** enthalten feste Zugangsdaten wie einen API-Schlüssel oder ein Bearer-Token. Claude speichert sie sicher, zeigt sie nach dem Speichern nicht wieder an und sendet sie bei jeder Anfrage mit, bis zu vier Header pro Konnektor. Anthropic kennzeichnet Anforderungsheader als Beta für eine begrenzte Zahl von Organisationen, daher sehen Sie diesen Bereich möglicherweise nicht.

Der praktische Unterschied: Mit OAuth meldet sich jede Person selbst an, genehmigt bestimmte Berechtigungen und kann den Zugriff widerrufen, ohne dass jemand ein Passwort oder einen Schlüssel weitergeben muss. Mit einem festen Schlüssel erhalten alle, die den Konnektor nutzen, mit denselben Zugangsdaten auch denselben Zugriff. [OAuth oder API-Schlüssel für den E-Mail-Zugriff durch KI](/blog/oauth-vs-api-keys-ai-email-access) geht genauer auf diese Abwägung ein.

## Einen Konnektor im Chat einschalten

Ein hinzugefügter Konnektor wird nicht automatisch in jedem Chat genutzt. Klicken Sie im Chat unten links auf **+**, öffnen Sie **Konnektoren** und schalten Sie jeden Konnektor für diesen Chat ein oder aus. Claude kann eine verbundene App auch von sich aus vorschlagen, wenn sie zur Anfrage passt.

Um einzelne Tools zu steuern, öffnen Sie **Anpassen → Konnektoren**, wählen den Konnektor und setzen jedes Tool oder jede Gruppe von Lese- und Schreibtools auf **Immer zulassen**, **Genehmigung erforderlich** oder **Blockiert**. Wenn Claude fragt, ob es ein Tool ausführen darf, wählen Sie **Immer zulassen** nur für Server und Tools, denen Sie unbeaufsichtigtes Arbeiten zutrauen.

## Sicherheits-Checkliste vor dem Verbinden

Anthropics Empfehlungen lassen sich in fünf Punkten zusammenfassen:

- **Verbinden Sie nur Server von Organisationen, denen Sie vertrauen.** Der Server bestimmt, was seine Tools tun, und kann das später ändern.
- **Lesen Sie die Berechtigungen auf dem Anmeldebildschirm.** Gewähren Sie den kleinsten Umfang, der für die Aufgabe reicht, und lehnen Sie alles ab, was unnötig wirkt.
- **Behandeln Sie Tool-Ausgaben als nicht vertrauenswürdig.** Eine Webseite, ein Ticket oder eine E-Mail kann Text enthalten, der Claude gezielt lenken soll. Laut Anthropic hat Claude eingebaute Schutzmechanismen gegen Prompt Injection, Sie sollten aber trotzdem im Blick behalten, was hinein- und hinausgeht.
- **Blockieren Sie Schreibaktionen, die Sie nicht brauchen, oder machen Sie sie genehmigungspflichtig.** Beim Senden, Löschen und Verschieben werden Fehler für andere sichtbar.
- **Vorsicht mit Research.** Anthropic weist darauf hin, dass Research die Tools von Konnektoren automatisch aufrufen kann, ohne jedes Mal nachzufragen. Schalten Sie Schreibtools also aus, bevor Sie Research mit einem Konnektor nutzen.

## Praxisbeispiel: E-Mail in Claude über MCPEmails

An E-Mail zeigt sich all das besonders deutlich: Ein Postfach enthält private Daten, und Senden hat echte Folgen. MCPEmails ist ein gehosteter MCP-Server, der Gmail, Outlook und Microsoft 365, iCloud, Fastmail, Yahoo, Zoho, Yandex und andere IMAP-Postfächer verbindet und sie Claude als einen benutzerdefinierten Konnektor bereitstellt.

**1. Postfach mit MCPEmails verbinden.** [Erstellen Sie ein Konto](/signup) und öffnen Sie dann **Dashboard → Postfächer → Postfach verbinden**. Outlook und Microsoft 365 nutzen „Mit Microsoft anmelden“, die meisten anderen Anbieter ein app-spezifisches Passwort, und die [Anbieterseiten](/connect) führen die Einstellungen für jeden Anbieter auf. Die [Einrichtungsseite für Claude](/docs/claude) enthält die Kurzfassung der Schritte 1 und 2.

**2. Konnektor in Claude hinzufügen.** Klicken Sie unter **Anpassen → Konnektoren** auf **+ Hinzufügen** und dann auf **Benutzerdefinierten Konnektor hinzufügen**, nennen Sie ihn MCPEmails, geben Sie die folgende URL ein und klicken Sie auf **Weiter**:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

**3. Anmeldeeinstellungen wählen.** Wählen Sie **Jetzt anmelden**. Beim OAuth-Client funktioniert jede der ersten beiden Optionen: MCPEmails unterstützt die Claude-Identität und die automatische Registrierung. Lassen Sie die Anforderungsheader leer, denn OAuth braucht keinen API-Schlüssel.

**4. Anmelden und Zugriff festlegen.** Klicken Sie auf **Hinzufügen**, melden Sie sich bei MCPEmails an und genehmigen Sie die Berechtigungen auf dem Zustimmungsbildschirm. Claude fragt zunächst nur nach \`read:email\`. Wenn Sie schon ein Postfach verbunden haben, ist auf dem Bildschirm die passende Nur-Lesen-Option bereits ausgewählt. Richten Sie MCPEmails direkt in Claude ein, öffnet er stattdessen mit **Standard** (Lesen, Entwürfe und Senden), damit der erste Entwurf keine zweite Freigabe braucht; wählen Sie **Nur-Lese-Zugriff**, wenn Sie weniger erlauben möchten. Fügen Sie \`send:email\`, \`manage:drafts\`, \`manage:folders\` oder \`delete:email\` erst hinzu, wenn ein Workflow sie braucht. Ein Token ohne \`send:email\` kann nicht senden, egal worum Claude gebeten wird. Braucht eine spätere Anfrage eine Berechtigung, die Sie nicht erteilt haben, antwortet MCPEmails mit einem \`insufficient_scope\`-Fehler, der die fehlende Berechtigung nennt. Setzen Sie beim erneuten Verbinden auf dem Zustimmungsbildschirm den Haken bei dieser Berechtigung. Die [Seite zum Nur-Lese-Zugriff](/docs/read-only-access) zeigt genau, was eine reine Leseberechtigung kann und was nicht.

**5. Tool-Berechtigungen in Claude festlegen.** MCPEmails trennt Lesen und Schreiben in eigene Tools. \`email_read\`, \`inbox_list\`, \`folder_list\` und \`draft_list\` lesen nur, während \`email_compose\` sendet, antwortet und weiterleitet und \`email_delete\` löscht. Dank dieser Trennung können Sie \`email_compose\` auf **Genehmigung erforderlich** und \`email_delete\` auf **Blockiert** setzen, während das Lesen auf **Immer zulassen** bleibt. Die [Tool-Referenz](/docs#tools) listet alle Tools auf.

**6. Mit einer reinen Leseaufgabe beginnen.** Schalten Sie den Konnektor in einem neuen Chat ein und bitten Sie Claude, Ihre Postfächer aufzulisten und Ihre fünf neuesten ungelesenen E-Mails zusammenzufassen, ohne etwas zu senden, zu verschieben oder zu löschen. Weitere Prompts für den Einstieg finden Sie in der [Anleitung zur Verbindung von Claude mit E-Mail](/blog/connect-claude-to-email).

Ein Konnektor deckt jedes Postfach ab, das Sie verbinden, und so landen [mehrere E-Mail-Konten in einem Chat mit Claude](/blog/multiple-email-accounts-in-claude-and-chatgpt). Welche Postfächer die integrierten Konnektoren von Claude ohne einen solchen erreichen, lesen Sie unter [Kann Claude meine E-Mails lesen?](/blog/can-claude-read-my-email)

In einem Team fügt der Besitzer dieselbe URL einmal unter **Organisationseinstellungen → Konnektoren** hinzu, und jedes Mitglied klickt auf **Verbinden** und meldet sich mit dem eigenen MCPEmails-Konto an. Jede Person sieht nur die Postfächer, die ihr eigenes Konto erreicht. Soll ausgehende Post unabhängig von Claudes Entscheidung auf einen Menschen warten, kann der Inhaber eines Postfachs im Dashboard von MCPEmails die Sendefreigabe aktivieren: Jedes Senden, Antworten, Weiterleiten, jeder Entwurfsversand und jeder geplante Versand wird dann zurückgehalten, bis jemand ihn freigibt, und eine Anfrage, über die niemand entscheidet, verfällt nach 24 Stunden. [E-Mail-Versand von KI-Agenten freigeben](/blog/approve-ai-agent-email-sends) führt durch die Einrichtung.

Zu den Daten: MCPEmails ruft E-Mails bei jeder Anfrage live von Ihrem Anbieter ab und speichert keine Nachrichteninhalte. Es behält nur das verschlüsselte OAuth-Token oder App-Passwort, das es für den Zugriff auf das Postfach braucht. Ergebnisse mit Postfachtext werden als nicht vertrauenswürdige Inhalte gekennzeichnet. Claude erfährt so, dass eine E-Mail, die zum Weiterleiten oder Löschen auffordert, als Daten gilt, über die es berichtet, und nicht als Anweisung. Die [Sicherheitsübersicht](/security) und [ist es sicher, einem KI-Agenten E-Mail-Zugriff zu geben?](/blog/is-it-safe-to-give-ai-agent-email-access) behandeln das Bedrohungsmodell.

## Fehlerbehebung bei benutzerdefinierten Konnektoren

- **Es gibt keine Schaltfläche „Benutzerdefinierten Konnektor hinzufügen“.** In den Tarifen Team und Enterprise können Mitglieder keine benutzerdefinierten Konnektoren hinzufügen. Bitten Sie einen Besitzer, die URL unter **Organisationseinstellungen → Konnektoren** einzutragen.
- **Im Free-Tarif lässt sich kein zweiter Konnektor hinzufügen.** Der Free-Tarif erlaubt einen benutzerdefinierten Konnektor. Entfernen Sie den, den Sie nicht mehr nutzen, oder wechseln Sie zu einem kostenpflichtigen Claude-Tarif.
- **Die Verbindung läuft in eine Zeitüberschreitung oder schlägt fehl.** Claude verbindet sich aus der Cloud von Anthropic, daher muss der Server aus dem öffentlichen Internet erreichbar sein. Bei der gehosteten URL von MCPEmails ist das der Fall. Ein Server, den Sie selbst betreiben, etwa der [selbst gehostete Stack](/self-hosting), braucht eine öffentliche HTTPS-Adresse oder eine Firewall, die die IP-Bereiche von Anthropic zulässt. Der selbst gehostete Stack meldet sich mit einem API-Schlüssel statt mit OAuth an. Claude kann ihn daher nur dort nutzen, wo der Bereich Anforderungsheader verfügbar ist.
- **Sie haben die falschen Anmeldeeinstellungen gewählt.** Authentifizierungseinstellungen lassen sich nicht bearbeiten. Entfernen Sie den Konnektor und fügen Sie ihn neu hinzu; die Mitglieder verbinden sich danach erneut.
- **Der Konnektor ist verbunden, aber Claude nutzt ihn nicht.** Öffnen Sie in diesem Chat **+ → Konnektoren** und prüfen Sie, ob der Schalter aktiv ist und das benötigte Tool nicht auf **Blockiert** steht.
- **Er erscheint nicht auf Ihrem Smartphone.** Verbinden Sie ihn zuerst im Web oder in Claude Desktop und melden Sie sich dann in der mobilen App erneut an.
- **Eine E-Mail-Aktion wird verweigert.** Dem Token fehlt eine Berechtigung. Verbinden Sie den Konnektor neu und genehmigen Sie die Berechtigung, die diese Aktion braucht, oder widerrufen Sie die alte Freigabe im Dashboard von MCPEmails unter **API-Schlüssel**, wo die Verbindung von Claude als \`OAuth:\` gefolgt vom Client-Namen erscheint. Die [Einrichtungsseite für Claude](/docs/claude) nennt die übrigen Lösungen speziell für Claude.

## FAQ

**Was sind benutzerdefinierte Konnektoren in Claude?**  
Es sind Remote-MCP-Server, die Sie Claude per URL hinzufügen. Claude ruft die Tools des Servers in Ihren Chats auf, nachdem Sie sich angemeldet und Berechtigungen genehmigt haben. Sie stehen in den Tarifen Free, Pro, Max, Team und Enterprise zur Verfügung, und der Free-Tarif erlaubt einen.

**Funktionieren benutzerdefinierte Konnektoren in Claude Desktop und auf dem Smartphone?**  
Ja. Sie fügen sie in claude.ai, Claude Desktop oder Cowork hinzu, und ein dort verbundener Konnektor steht in den Apps für iOS und Android zur Verfügung, sobald Sie sich dort das nächste Mal anmelden.

**Wer darf in einem Team- oder Enterprise-Tarif einen benutzerdefinierten Konnektor hinzufügen?**  
Im Team-Tarif Besitzer und Hauptbesitzer. Im Enterprise-Tarif zusätzlich Personen mit einer benutzerdefinierten Rolle, die die Verwaltung der Bibliotheken der Organisation umfasst. Die Mitglieder verbinden sich danach einzeln.

**Ist ein benutzerdefinierter Konnektor sicher?**  
Er ist so sicher wie der Server dahinter und die Berechtigungen, die Sie erteilen. Anthropic prüft benutzerdefinierte Konnektoren nicht. Verbinden Sie daher nur Server, denen Sie vertrauen, genehmigen Sie so wenige Berechtigungen wie möglich und machen Sie Schreibaktionen genehmigungspflichtig oder blockieren Sie sie.

**Brauche ich einen API-Schlüssel, um MCPEmails als benutzerdefinierten Konnektor in Claude zu nutzen?**  
Nein. Claude meldet sich per OAuth bei MCPEmails an. API-Schlüssel sind für MCP-Clients ohne OAuth-Ablauf gedacht, zum Beispiel Skripte.

## Nächster Schritt

[Erstellen Sie ein kostenloses MCPEmails-Konto](/signup), verbinden Sie ein Postfach und fügen Sie \`https://mcpemails.com/api/mcp\` in Claude als benutzerdefinierten Konnektor hinzu. Nutzt Ihr Postfach IMAP und gibt es dafür keine benannte Vorlage, erklärt die [Anleitung zum Claude IMAP-Konnektor](/blog/claude-imap-connector) die Servereinstellungen.`,
};

export default translation;
