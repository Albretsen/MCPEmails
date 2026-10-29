const translation = {
  title: 'Daglig e-postoppsummering med Claude og ChatGPT: oversikt over innboksen etter en fast plan',
  description:
    'Tre måter å få en daglig oppsummering av innboksen på: en planlagt oppgave i Claude, en planlagt oppgave i ChatGPT, eller en morgenoversikt som MCPEmails legger i innboksen din uten at en chat er åpen. Oppsett, prompter og begrensninger.',
  coverAlt:
    'En daglig e-postoppsummering fra Claude og ChatGPT som oppsummerer ny e-post på tvers av tilkoblede innbokser',
  content: `**Du kan få en daglig e-postoppsummering fra Claude eller ChatGPT ved å gi assistenten to ting: tilgang til postkassen din og en tidsplan.** Begge assistentene kjører nå planlagte oppgaver. Claude kan kjøre en prompt hver time, hver dag, hver uke eller på hverdager, og ChatGPT kjører oppgaver på et fast tidspunkt på alle abonnementer. La oppgaven lese postkassen din gjennom en kobling, så venter oppsummeringen på deg hver morgen.

Det finnes også en tredje vei som ikke trenger noen chat i det hele tatt: MCPEmails kan legge en morgenoversikt rett i innboksen din på det klokkeslettet du velger. Denne guiden tar for seg alle tre, med prompter du kan bruke og hva hver av dem ikke kan gjøre.

**Hopp til:** [Claude](#en-daglig-e-postoppsummering-med-claude) · [ChatGPT](#en-planlagt-innboksoppsummering-i-chatgpt) · [Morgenoversikt](#morgenoversikten-ingen-chat-nødvendig) · [Hva du bør velge](#hva-du-bør-velge) · [Prompter](#prompter-for-en-nyttig-oppsummering) · [Vanlige spørsmål](#vanlige-spørsmål)

## Først: gi assistenten tilgang til postkassen din

En planlagt oppgave kan bare oppsummere e-post den når. Claudes egen Gmail-kobling når én Google-konto, og Microsoft 365-koblingen når jobbkontoer når en administrator har godkjent den. ChatGPT har sin egen Gmail-app. For alt annet, eller for flere postkasser i samme oppsummering, kobler du dem til gjennom en MCP-server.

MCPEmails er en driftet MCP-server. Du kobler til hver postkasse én gang, og legger deretter til én koblings-URL i Claude eller ChatGPT:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

Den fungerer med Gmail og Google Workspace, Outlook og Microsoft 365, iCloud, Yahoo, Fastmail, Zoho og alle postkasser som støtter IMAP og SMTP. Hver tilkoblet postkasse dukker opp i assistenten med navn, så én oppsummering kan dekke din egen adresse, post@ og en privat Gmail samtidig. [Flere e-postkontoer i Claude og ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) forklarer det oppsettet.

En oppsummering leser bare, så velg **Skrivebeskyttet** tilgang når samtykkevinduet spør. En oppgave som kjører mens du er borte, kan da ikke sende, flytte eller slette noe, uansett hva e-posten den leser sier. [Skrivebeskyttet tilgang](/docs/read-only-access) viser nøyaktig hva den tilkoblingen kan gjøre.

## En daglig e-postoppsummering med Claude

Claudes planlagte oppgaver er en del av Cowork i Claude-appen, på alle betalte abonnementer (Pro, Max, Team og Enterprise). Ifølge [Anthropics hjelpeartikkel](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-cowork) kan en oppgave kjøre hver time, hver dag, hver uke, på hverdager eller bare når du starter den selv, og den bruker de samme koblingene som de andre oppgavene dine. Oppgavene kjører eksternt, så de holder tidsplanen mens datamaskinen sover eller appen er lukket, med mindre oppgaven trenger lokale filer eller apper.

1. **Legg til MCPEmails i Claude.** Åpne **Customize → Connectors**, klikk **+ Add** og deretter **Add custom connector**. Kall den MCPEmails, skriv inn \`https://mcpemails.com/api/mcp\`, klikk **Continue**, behold innloggingsinnstillingene Claude fant, og klikk **Add**. Logg på MCPEmails og velg **Skrivebeskyttet**. [Guiden for oppsett i Claude](/blog/connect-claude-to-email) viser hvert skjermbilde.
2. **Lag oppgaven.** Klikk **Scheduled** i sidefeltet, deretter **New task**, og velg **Create with Claude** eller **Set up manually**. Du kan også beskrive oppgaven i en samtale («hver hverdag kl. 7, oppsummer innboksen min»), så foreslår Claude et navn, en tidsplan og instruksjoner som du bekrefter med **Schedule**.
3. **Lim inn prompten for oppsummeringen** fra [delen om prompter](#prompter-for-en-nyttig-oppsummering), og velg **Weekdays** eller **Daily**.
4. **Kjør den én gang manuelt** for å sjekke resultatet før den første planlagte kjøringen.

Hvert koblingsverktøy kan settes til **Always allow**, **Needs approval** eller **Blocked** i Claude. For en oppsummering blokkerer du MCPEmails-verktøyene for sending og organisering, eller beholder tilkoblingen skrivebeskyttet, slik at oppgaven forblir en oppsummering.

## En planlagt innboksoppsummering i ChatGPT

[OpenAIs hjelpeartikkel om oppgaver](https://help.openai.com/en/articles/10291617-tasks-in-chatgpt) sier at planlagte oppgaver finnes på alle abonnementer, også Free og Go. Free kjører en oppgave høyst én gang om dagen, i et løst tidsvindu som «morgen». Betalte abonnementer kan kjøre oppgaver opptil hver time, på et nøyaktig klokkeslett. Hvert abonnement har en grense for aktive oppgaver, fra 3 på Free til 15 på Pro og Enterprise. Du lager en oppgave fra **Scheduled**-siden eller ved å be om det i en chat, og ChatGPT kan varsle deg med pushvarsel eller e-post når den er ferdig.

Oppgaver kan bruke støttede apper, og OpenAI nevner Gmail, Slack og GitHub. Ligger e-posten din i én Gmail-konto, er ChatGPTs egen Gmail-app den enkleste kilden for oppgaven.

OpenAIs artikkel sier ikke om en MCP-server du har lagt til selv, er tilgjengelig i en oppgave. For å bruke MCPEmails legger du den til slik [oppsettsguiden for ChatGPT](/docs/chatgpt) beskriver, planlegger oppgaven noen minutter frem i tid og sjekker at den første kjøringen leser e-posten din før du stoler på den. OpenAI skriver også at en handling som sender en melding eller endrer data, kan kreve godkjenningen din og setter oppgaven på pause. Det er én grunn til å holde en oppsummering skrivebeskyttet.

## Morgenoversikten: ingen chat nødvendig

Pro- og Business-abonnementene i MCPEmails har en **morgenoversikt**: en daglig oppsummering som MCPEmails lager på sine egne servere og legger rett i en av innboksene dine på klokkeslettet du velger. Ingen assistent, chat eller åpen app er involvert, så den kommer også de dagene du aldri åpner Claude eller ChatGPT.

Hver oversikt dekker din lokale dag:

- **VIP-avsendere først.** Ny e-post fra adressene eller domenene du lister opp, på tvers av innboksene dine.
- **Ny e-post per innboks** siden forrige oversikt: hvor mange meldinger, og de nyeste avsenderne og emnene.
- **Oppfølginger som forfaller.** Påminnelser som KI-en din har satt for e-post som ikke har fått svar.
- **Utsatt e-post** som kommer tilbake senere i dag.
- **Planlagte sendinger** som går ut senere i dag.

Den dekker opptil 10 tilkoblede innbokser. Dager uten noe nytt hoppes over i stedet for å bli sendt tomme. Oversikten legges rett i innboksen, så ingenting sendes og ingenting forlater postkassen din. Den bygges med regler, uten at noen KI-modell leser e-posten din.

For å slå den på åpner du **Innstillinger** i dashbordet, finner **Morgenoversikt** under innstillingene for arbeidsområdet, krysser av for **Legg en morgenoversikt i innboksen min hver dag**, og velger klokkeslett, tidssonen din, innboksen den skal til og eventuelle VIP-avsendere. Bare eiere og administratorer av arbeidsområdet kan endre den.

Oppfølgingene og de utsatte e-postene i oversikten kommer fra KI-en din, og de er en del av de samme abonnementene. Be Claude eller ChatGPT om «minn meg på det hvis Dana ikke har svart innen fredag» eller «utsett denne til mandag morgen», så følger MCPEmails det opp på sine servere, også etter at chatten er lukket.

## Hva du bør velge

- **Du vil ha oppsummeringen skrevet på vanlig språk, med en vurdering av hva som er viktig:** en planlagt oppgave i Claude eller ChatGPT. Modellen leser e-posten og bestemmer hva den skal trekke frem.
- **Du vil ha den hver dag uten å være avhengig av en chatapp eller grensene for oppgaver der:** morgenoversikten. Den kommer i innboksen din på det valgte klokkeslettet, og den improviserer aldri.
- **Du vil ha begge:** de fungerer sammen. Oversikten gir deg den faste listen hver morgen, og du spør assistenten om alt i den.

Vil du heller ha e-posten sortert enn oppsummert, kan [automatiske regler for sortering av e-post](/blog/automated-email-triage-rules) flytte, merke og flagge ny e-post etter en tidsplan, uten en modell.

## Prompter for en nyttig oppsummering

Be om et kort, fast format. En oppsummering du kan lese på et minutt, er en du fortsetter å lese.

> Bruk MCPEmails og gi meg morgenoversikten for alle tilkoblede innbokser: hva som har kommet inn siden samme tid i går, hva som trenger svar fra meg i dag, og alt med en frist denne uken. Grupper etter innboks, høyst 10 linjer. Ikke send, flytt eller endre noe.

> Bruk MCPEmails og list opp ulest e-post fra de siste 24 timene i salg@ og post@ som er fra en kunde eller en mulig kunde. For hver av dem: avsender, en oppsummering på én linje, og om den trenger svar i dag. Hopp over nyhetsbrev og varsler. Bare les.

> Bruk MCPEmails og sjekk innboksen min for fakturaer, kontrakter og alt som nevner en betaling eller en forfallsdato, som har kommet inn den siste uken. Én linje for hver, med beløp og dato hvis det står. Bare les.

Det er en god vane å skrive «bare les» i prompten, men den pålitelige sperren er selve tilkoblingen: en skrivebeskyttet tilkobling kan ikke sende, selv om en melding ber modellen om det. E-post skrives av andre, og noe av den er skrevet for å styre KI-assistenter. [Er det trygt å gi en KI-agent tilgang til e-post?](/blog/is-it-safe-to-give-ai-agent-email-access) forklarer hvorfor.

Flere prompter for sortering finner du i [KI-agenter som sorterer og oppsummerer innboksen](/blog/ai-agent-triage-summarize-inbox). Vil du skrive et svar etter en tidsplan i stedet for å lese, tar [planlegg en e-post med Claude eller ChatGPT](/blog/schedule-email-with-claude-and-chatgpt) for seg sendinger i kø.

## Vanlige spørsmål

**Kan Claude oppsummere e-posten min hver dag?**
Ja. Lag en planlagt oppgave i Claude (Pro, Max, Team eller Enterprise) som kjører daglig eller på hverdager, med en kobling til postkassen din. Claudes Gmail-kobling dekker én Google-konto; MCPEmails dekker alle leverandører og flere postkasser samtidig.

**Kan ChatGPT oppsummere innboksen min etter en tidsplan?**
Ja. ChatGPTs planlagte oppgaver kan bruke Gmail-appen på alle abonnementer, men Free er begrenset til én gang om dagen. OpenAI sier ikke om en egendefinert MCP-server fungerer i en oppgave, så test én kjøring før du stoler på den.

**Kjører oppgaven når datamaskinen min er slått av?**
Claudes planlagte oppgaver kjører eksternt, med mindre de trenger lokale filer eller apper. ChatGPTs oppgaver kjører hos OpenAI. Morgenoversikten fra MCPEmails kjører på våre servere og havner i innboksen din uansett.

**Lagres e-posten min for oppsummeringen?**
Ikke av MCPEmails. E-posten hentes direkte fra leverandøren din for hver forespørsel og forkastes når svaret er sendt. Morgenoversikten skrives inn i din egen postkasse og lagres ikke hos oss. Se [sikkerhet](/security).

**Hvilket abonnement har morgenoversikten?**
Pro og Business. En planlagt oppgave i Claude eller ChatGPT kan lese gjennom MCPEmails på alle MCPEmails-abonnementer, også Free med én innboks. Gjeldende abonnementer står på [prissiden](/pricing).

## Neste steg

[Start gratis](/signup), koble til den travleste postkassen din med skrivebeskyttet tilgang, legg til MCPEmails i Claude eller ChatGPT, og kjør prompten for oppsummeringen én gang manuelt. Når resultatet er slik du vil ha det, setter du den på en tidsplan.`,
};

export default translation;
