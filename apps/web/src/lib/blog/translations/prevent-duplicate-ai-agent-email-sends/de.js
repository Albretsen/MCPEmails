const translation = {
  title: 'Doppelte E-Mail-Sendungen von KI-Agenten verhindern',
  description:
    'Wiederholungen passieren. So verhindern Idempotenzschlüssel in MCPEmails, dass ein KI-Agent eine E-Mail, Antwort, Weiterleitung, einen Entwurf oder eine geplante Sendung doppelt verschickt.',
  coverAlt: 'Doppelte E-Mail-Sendungen von KI-Agenten verhindern, mit MCPEmails',
  content: `Ein Timeout bedeutet nicht immer, dass eine E-Mail nicht gesendet wurde. Manchmal hat der Anbieter die Nachricht angenommen, kurz bevor die Verbindung abbrach. Wenn ein Agent dann blind wiederholt, bekommt ein Kunde dieselbe E-Mail zweimal: peinlich in jedem Ablauf und ernst bei Akquise, Support oder Rechnungen.

MCPEmails unterstützt Idempotenzschlüssel für ausgehende Operationen. Geben Sie einem logischen Sendeversuch einen eindeutigen Schlüssel, und eine Wiederholung mit demselben Schlüssel wird als dieselbe Anfrage erkannt statt als Erlaubnis, noch einmal zu senden.

## Was Idempotenz in normaler Sprache bedeutet

Idempotenz ist schlicht Sicherheit bei Wiederholungen. Sie hängen einen kurzen eindeutigen Wert an eine Nachricht, die Sie senden wollen. Muss Ihr Client genau diese Operation wiederholen, schickt er denselben Wert noch einmal. MCPEmails kann dann „bitte wiederhole das Senden, das ich schon begonnen habe“ von „sende eine weitere E-Mail“ unterscheiden.

Das gilt für neue E-Mails, Antworten, Weiterleitungen, das Senden eines gespeicherten Entwurfs und das Anlegen einer geplanten Sendung. Besonders wertvoll ist es, wenn ein Agent in einer Umgebung läuft, in der Anfragen in ein Timeout laufen, neu starten oder mehr als einmal zugestellt werden können.

## Das richtige Muster für einen Agenten-Workflow

Erzeugen Sie einen Idempotenzschlüssel pro für den Nutzer sichtbarer Aktion, nicht pro Netzwerkversuch. Zum Beispiel:

1. Ein Agent bereitet eine Antwort auf ein bestimmtes Support-Ticket vor.
2. Der Workflow gibt dieser Antwort einen eindeutigen Idempotenzschlüssel.
3. Läuft die erste Anfrage normal durch, ist das Senden erledigt.
4. Muss der Client wiederholen, weil er kein eindeutiges Ergebnis erhalten hat, wiederholt er mit demselben Schlüssel und unveränderten Nachrichtendetails.

Verwenden Sie den Schlüssel nicht für eine überarbeitete Nachricht wieder. Betreff, Text, Empfänger oder ein anderes wesentliches Detail geändert? Behandeln Sie das als neue logische Aktion mit einem neuen Schlüssel. So bleiben Wiederholungen sicher, ohne dass es unmöglich wird, absichtlich eine aktualisierte Nachricht zu senden.

## Was bei Wiederholungen passiert

MCPEmails merkt sich den Zustand einer ausgehenden Anfrage 24 Stunden lang, mit geschützten Prüfsummen statt des E-Mail-Inhalts im Idempotenz-Eintrag. Eine wiederholte Anfrage mit demselben Schlüssel und denselben Details kann als bereits abgeschlossen oder noch in Bearbeitung erkannt werden.

Trifft derselbe Schlüssel auf andere Nachrichtendetails, gibt MCPEmails einen Konflikt zurück, statt zu raten, welche Version Sie meinten. Und wenn das Ergebnis beim Anbieter wirklich ungewiss ist, bleibt das Produkt vorsichtig: Es macht aus Ungewissheit kein zweites Senden.

Das ist die richtige Abwägung. Ein Workflow kann bei Bedarf eine menschliche Entscheidung einholen; er sollte Ungewissheit nicht „lösen“, indem er jemandem zweimal schreibt.

## Idempotenz und menschliche Freigabe arbeiten zusammen

Idempotenz verhindert versehentliche Dopplungen. Die Freigabe steuert, ob eine sensible Nachricht das Postfach überhaupt verlassen darf. Sie lösen verschiedene Probleme und ergänzen sich gut.

Ein Vertriebsassistent kann zum Beispiel ein Follow-up entwerfen, es zur [menschlichen Freigabe](/blog/approve-ai-agent-email-sends) einreichen und dabei dieselbe wiederholungssichere Identität behalten, während die Anfrage bearbeitet wird. Die prüfende Person sieht eine vorgeschlagene Nachricht, keine Sammlung doppelter Versuche.

## Zuverlässigkeit für den Empfänger unsichtbar halten

Empfänger sollten nie merken müssen, dass Ihr Agent eine Anfrage wiederholt hat. Sie sollten eine durchdachte Nachricht sehen, im richtigen Verlauf, zur richtigen Zeit. MCPEmails hält außerdem die Verkettung von Antworten aufrecht, sodass eine Antwort in der ursprünglichen Unterhaltung bleibt, statt eine parallele E-Mail-Kette zu eröffnen.

Das ist ein kleines Produktdetail mit großer Wirkung auf das Vertrauen. Es erlaubt Ihnen, einen KI-Agenten für echte Postfacharbeit einzusetzen, ohne für jeden kurzen Netzwerkaussetzer eine neue betriebliche Last aufzubauen.

Wenn Sie Ihren ersten Sende-Workflow bauen, beginnen Sie mit Entwürfen und einem Prüfschritt. Schalten Sie dann für das Postfach die Freigabepflicht beim Senden ein, wenn bei den Nachrichten viel auf dem Spiel steht. Die Sicherheit bei Wiederholungen ist schon da, wenn der Workflow sie braucht; Sie brauchen keine separate Sammlung von Tools gegen Duplikate.`,
};

export default translation;
