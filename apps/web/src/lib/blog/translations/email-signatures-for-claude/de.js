const translation = {
  title: 'E-Mail-Signaturen für Claude: automatisch signiert, jedes Mal',
  description:
    'Legen Sie pro Postfach einmal eine Signatur fest, und Claude signiert jede E-Mail, die es sendet, automatisch: bei Gmail, Outlook, Fastmail, iCloud und jedem IMAP-Konto.',
  coverAlt:
    'E-Mail-Signaturen für Claude: einmal pro Postfach festlegen, und Claude signiert jede gesendete Nachricht, bei jedem Anbieter',
  content: `Wenn Claude eine E-Mail für Sie sendet, soll sie aussehen, als hätten Sie sie gesendet. Dazu gehört der Abschluss: Ihr Name, Ihre Funktion, die Firmenzeile, der Link zu Ihrem Terminkalender. Bisher haben Sie Ihre Signatur entweder in jeden Prompt getippt oder E-Mails akzeptiert, die etwas abrupt endeten. Das ändert sich jetzt: **MCPEmails fügt Ihre Signatur automatisch an jede Nachricht an, die Claude sendet.**

Signaturen gelten **pro Postfach**. Jedes verbundene Postfach hat seine eigene, also kommt die Geschäftsführer-Signatur auf die Arbeitsadresse und ein schlichtes „Viele Grüße, Sam“ auf die private. Einmal festgelegt, müssen Sie nie wieder daran denken.

## Was signiert wird

Einmal festlegen, und die Signatur wird automatisch an alles angehängt, was Claude aus diesem Postfach sendet:

- **Neue E-Mails** über \`email_compose\` (Aktion \`send\`).
- **Antworten und Weiterleitungen** über \`email_compose\` (Aktionen \`reply\` und \`forward\`).
- **Entwürfe** über \`draft\`, sodass das, was Sie prüfen, Ihren Abschluss bereits enthält.
- **Geplante Sendungen** über \`schedule\`, sodass eine Nachricht, die für Montagmorgen eingeplant ist, signiert rausgeht.

Im Prompt müssen Sie nichts dazu sagen. „Antworten Sie Dana und sagen Sie ihr, dass die Präsentation angehängt ist“ ergibt eine vollständige, signierte E-Mail.

## Antworten und Weiterleitungen sitzen richtig

Das Knifflige an Signaturen ist die Platzierung, und genau daran scheitern die meisten Tools. Bei einer Antwort oder Weiterleitung setzt MCPEmails Ihre Signatur **nach Ihrem neuen Text und vor den zitierten Verlauf**, genau dorthin, wo ein Mensch sie setzen würde, statt sie ganz unten unter seitenlange Historie zu verbannen.

Auch beim Hin und Her denkt es mit. Es gibt einen **Antwortmodus**, damit die Signatur nicht jedes Mal wiederholt wird, wenn Claude im selben Verlauf antwortet. Die erste Antwort wird signiert; die schnellen Folgeantworten in dieser Unterhaltung stapeln keine doppelten Abschlüsse. Sie bekommen saubere Verläufe, keine Wand aus wiederholten Namen.

## Funktioniert bei jedem Anbieter

Das ist keine Annehmlichkeit nur für Gmail. Signaturen gelten bei **allen** verbundenen Anbietern: Gmail, Outlook, Fastmail, iCloud, GMX, web.de und jedem anderen IMAP-Konto. Weil MCPEmails die ausgehende Nachricht selbst zusammensetzt, ist das Verhalten identisch, egal wo das Postfach liegt. Verbinden Sie ein neues Postfach beliebiger Art, und Signaturen funktionieren einfach.

## Zwei Wege zur Einrichtung

**1. Der Signatur-Editor im Dashboard.** Öffnen Sie ein Postfach im Dashboard von MCPEmails und bearbeiten Sie seine Signatur direkt dort. Jedes Postfach hat seine eigene, sodass jede Adresse den passenden Ton bekommt.

**2. Einfach Claude bitten.** Mit dem Tool \`signature_set\` legen Sie Ihre Signatur in normaler Sprache fest oder ändern sie, ohne den Chat zu verlassen:

> „Setzen Sie die Signatur für mein Arbeitspostfach auf: Sam Rivera, Gründerin, Acme, calendly.com/sam“

Claude schreibt sie für dieses Postfach, und ab dann ist jede Sendung signiert. Bitten Sie es später um eine Änderung, passiert dasselbe. Mit \`signature_get\` liest Claude die aktuelle Signatur aus.

## Wenn Sie eine Nachricht ohne Signatur wollen

Manchmal stört eine Signatur: Ein knappes „Danke!“ braucht keine drei Zeilen Kontaktdaten darunter. Für solche Einzelfälle gibt es die Option **\`include_signature\`**: Sagen Sie Claude, es soll die Signatur bei einer einzelnen Nachricht weglassen, und es sendet die kurze Version. Ihre gespeicherte Signatur bleibt für alles danach erhalten.

> „Antworten Sie mit ‚Bin unterwegs‘ auf die letzte Nachricht aus dem Büro, ohne Signatur.“

## Wie es in den übrigen Workflow passt

Signaturen fügen sich in die Tools ein, die Sie bereits nutzen. Wenn Claude Ihre morgendliche Triage erledigt und Antworten verschickt, trägt jetzt jede davon Ihren Abschluss, ohne dass Sie ihn erwähnen. Dasselbe gilt für die [Muster für automatische Antworten](/blog/build-email-auto-responder-mcp-agent) und das [Playbook zur Posteingangs-Triage](/blog/ai-agent-triage-summarize-inbox): Alles, was mit einem Versand endet, endet jetzt signiert.

Und am Datenschutzmodell ändert sich nichts: Ihre E-Mails werden weiterhin [nie gespeichert](/blog/why-email-never-stored-matters). Die Signatur ist ein kleines Stück Konfiguration pro Postfach; Ihre Nachrichten werden weiterhin live abgerufen und verworfen, sobald Claude sie hat.

## FAQ

**Gelten Signaturen pro Postfach oder pro Konto?**
Pro Postfach. Jedes verbundene Postfach hat seine eigene Signatur, sodass Sie Arbeits- und Privatadresse unterschiedlich signieren können.

**Landet die Signatur bei Antworten und Weiterleitungen an der richtigen Stelle?**
Ja. Sie steht nach Ihrem neuen Text und vor dem zitierten Verlauf, und der Antwortmodus verhindert, dass sie sich in einem Hin und Her im selben Verlauf wiederholt.

**Welche Anbieter unterstützen Signaturen?**
Alle: Gmail, Outlook, Fastmail, iCloud und jedes andere IMAP-Konto. MCPEmails setzt die ausgehende Nachricht zusammen, deshalb ist das Verhalten überall gleich.

**Kann ich eine Nachricht ohne meine Signatur senden?**
Ja. Nutzen Sie die Option \`include_signature\` (sagen Sie Claude einfach, es soll die Signatur weglassen) für eine einzelne kurze Nachricht. Ihre gespeicherte Signatur bleibt für alles andere bestehen.

**Wie lege ich meine Signatur fest?**
Auf zwei Wegen: pro Postfach im Dashboard bearbeiten, oder Claude bitten, zum Beispiel „Setzen Sie meine Signatur auf …“, über das Tool \`signature_set\`.

## Fazit

Legen Sie Ihre Signatur einmal pro Postfach fest, und jede E-Mail, die Claude aus diesem Postfach sendet (neu, Antwort, Weiterleitung, Entwurf oder geplant), geht signiert raus, als hätten Sie sie geschrieben. Es funktioniert bei jedem Anbieter, sitzt in Verläufen an der richtigen Stelle und tritt mit \`include_signature\` beiseite, wenn Sie eine Antwort ohne Signatur wollen.

[Öffnen Sie Ihr Dashboard](/dashboard), um eine Signatur festzulegen, oder sagen Sie Claude einfach, wie Ihre lauten soll. Noch nicht verbunden? [Kostenlos starten](/signup) und ein Postfach in etwa zwei Minuten verbinden. Die [Anleitung, Claude mit Ihrem Postfach zu verbinden](/blog/connect-claude-to-email), führt durch jeden Schritt.`,
};

export default translation;
