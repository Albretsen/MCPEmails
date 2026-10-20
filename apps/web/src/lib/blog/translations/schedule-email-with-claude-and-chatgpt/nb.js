const translation = {
  title: 'Slik planlegger du e-post med Claude eller ChatGPT (send senere)',
  description:
    'Planlegg en e-post fra Claude eller ChatGPT som sendes senere fra din egen Gmail, Outlook, iCloud eller IMAP-postkasse: oppsett, tidssoner, avbryting og begrensninger.',
  coverAlt:
    'Claude og ChatGPT planlegger en e-post som sendes senere fra en tilkoblet postkasse med MCPEmails',
  content: `For å planlegge en e-post med Claude eller ChatGPT trenger assistenten et e-postverktøy som kan holde på en melding og sende den senere. MCPEmails har et slikt verktøy. Koble til postkassen din, legg til MCPEmails som kobling, og si når: «Send dette til Dana mandag kl. 09.00, norsk tid.» Meldingen venter i en kø på MCPEmails-serveren og går ut fra din egen adresse på det tidspunktet, uansett om samtalen, appen eller datamaskinen din fortsatt er åpen.

Det fungerer likt i Claude, i ChatGPT og i andre MCP-klienter, og med Gmail og Google Workspace, Outlook og Microsoft 365, iCloud, Fastmail, Yahoo, Zoho og alle postkasser som snakker IMAP og SMTP.

**Hopp til:** [Innebygde koblinger](#hva-de-innebygde-e-postkoblingene-gjør) · [Oppsett](#slik-planlegger-du-en-e-post-med-claude-eller-chatgpt) · [Tidssoner](#tidssoner) · [Avbryt eller endre](#sjekk-avbryt-eller-endre-en-planlagt-e-post) · [Vanlige spørsmål](#vanlige-spørsmål)

## Hva de innebygde e-postkoblingene gjør

Begge assistentene har sine egne e-postkoblinger. Slik så det ut 20. oktober 2026:

- **Claude.** Anthropics hjelpeartikkel om Gmail-koblingen lister opp søk, lesing, utkast, sending, svar og videresending. Å planlegge en melding til senere står ikke på listen.
- **ChatGPT.** OpenAIs hjelpeside for Outlook Email-appen dekker søk og lesing av meldinger, handlinger for personer og kontakter, og sending av ren tekst fra delte eller delegerte postkasser. Siden med vanlige spørsmål om Google-appen dekker databruk og oppgaver som utløses av Gmail. Ingen av dem beskriver planlagt sending.

ChatGPT har riktignok **planlagte oppgaver**, som kjører en prompt på et tidspunkt du velger. Det er ikke det samme som en e-post i kø. Meldingen skrives når oppgaven kjører, ikke når du godkjenner ordlyden, og OpenAI skriver at handlinger som krever godkjenningen din, kan sette oppgaven på pause.

En planlagt sending gjennom MCPEmails er en ferdig melding: du leser den nøyaktige teksten nå, og det er den teksten som går ut på det fastsatte tidspunktet.

## Slik planlegger du en e-post med Claude eller ChatGPT

1. **Koble postkassen din til MCPEmails.** I dashbordet åpner du **Innbokser**, deretter **Koble til innboks**, og velger leverandøren din. Det finnes en side per leverandør under [connect](/connect).
2. **Legg til MCPEmails i assistenten din.** I Claude åpner du **Settings**, deretter **Connectors**, velger **Add custom connector** og limer inn \`https://mcpemails.com/api/mcp\`. [Claude-guiden](/blog/connect-claude-to-email) har alle stegene. I ChatGPT legges MCPEmails til som en egendefinert MCP-kobling. Hvilke planer som tilbyr det, og hvor menyen ligger, har endret seg flere ganger i år, så følg de gjeldende stegene i [oppsettsguiden for ChatGPT](/docs/chatgpt).
3. **Gi tilgang til planlegging når du godkjenner.** Samtykkeskjermen til MCPEmails tilbyr ulike tilgangsnivåer. Velg **Full tilgang**, eller **Tilpasset** med planlegging krysset av. **Standard** utelater planlegging, så en forespørsel om å planlegge blir avvist.
4. **Be om e-posten og tidspunktet.** Oppgi mottakerne, hva som skal stå i meldingen, dato og klokkeslett, og tidssonen din.

I bakgrunnen kaller assistenten verktøyet \`schedule\` med handlingen \`create\` og sender med mottakere, emne, brødtekst og sendetidspunkt. MCPEmails sjekker adressene, emnet og brødteksten med en gang, så en ugyldig adresse eller en tom brødtekst blir avvist nå i stedet for å feile mandag morgen. Men den kan ikke se forskjell på en gyldig adresse du mente og en du ikke mente, og derfor ber promptene nedenfor om å få se mottakeren først. Svaret inneholder det planlagte tidspunktet og en id som assistenten senere kan bruke til å avbryte.

På sendetidspunktet sender en sendejobb på MCPEmails-serveren, som sjekker køen hvert minutt, meldingen gjennom postkassens egen leverandør: Gmail, Microsoft eller postkassens SMTP-server. Den går ut fra adressen din, med [signaturen](/blog/email-signatures-for-claude) din lagt til i det øyeblikket. Regn med at den går innen omtrent ett minutt etter tidspunktet du satte. Den er ikke laget for å treffe på sekundet.

Hvis e-postserveren avviser meldingen før den har tatt imot noe av den, prøver sendejobben igjen hvert minutt i opptil 15 minutter etter sendetidspunktet. Hvis postkassen er koblet fra i mellomtiden, blir meldingen ikke sendt i det hele tatt.

## Prompter som planlegger uten overraskelser

> Skriv en kort takk til dana@example.com for samtalen i dag, og planlegg den til mandag kl. 09.00, Europe/Oslo. Vis meg teksten og sendetidspunktet før du planlegger den.

> Planlegg betalingspåminnelsen nedenfor fra regnskap@ til de tre adressene i den, den 1. neste måned kl. 08.30 New York-tid.

> Hvilke e-poster har jeg planlagt? List opp mottaker, emne og sendetidspunkt i min tidssone.

> Avbryt den planlagte e-posten til Dana.

Å be om å se teksten og tidspunktet først koster én melding ekstra og fanger opp de to tingene som oftest går galt: feil mottaker og feil klokkeslett. Har du flere postkasser, sier du hvilken det skal sendes fra («fra regnskap@»). [Flere e-postkontoer i Claude og ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) forklarer hvordan assistenten skiller dem fra hverandre.

## Tidssoner

Verktøyet \`schedule\` tar imot sendetidspunktet som et tidsstempel med tidssoneforskyvning, for eksempel \`2026-11-02T09:00:00+01:00\`. Assistenten gjør om «mandag kl. 9» til det formatet, så den må vite hvilken tidssone du er i. Nevn en by eller en sone i prompten («norsk tid», «Europe/Oslo», «US Eastern»). Uten det må modellen gjette.

Det er sommertiden som får gjetningene til å bomme. Oslo er på +02:00 frem til siste søndag i oktober og på +01:00 etterpå, så kl. 09.00 norsk tid 2. november 2026 er \`+01:00\`. Når du nevner byen, kan assistenten velge riktig forskyvning for den datoen.

Bekreftelsen oppgir tidspunktet i UTC. Be assistenten lese det opp igjen i din lokale tid før du stoler på det. Et tidspunkt som allerede har passert, blir avvist.

## Sjekk, avbryt eller endre en planlagt e-post

- **Se hva som ligger i kø.** \`schedule_list\` returnerer meldingene som venter, den tidligste først, med mottakere, emne, sendetidspunkt og status. Be om alle postkassene eller én.
- **Avbryt.** Verktøyet \`schedule\` med handlingen \`cancel\` stopper en melding så lenge den fortsatt venter. Når sendejobben har begynt å sende den, kan den ikke lenger avbrytes.
- **Endre.** Det finnes ingen redigering. Be assistenten avbryte meldingen og planlegge den rettede versjonen. Den kan gjøre begge deler i samme runde.
- **Endringer i signaturen blir med.** Signaturen legges til ved sending, så en endring du gjør etter at du planla meldingen, er den som går ut.

## Hva planlagt sending ikke gjør

- **Svarer inne i en tråd.** En planlagt e-post er en ny melding med eget emne, så den havner ikke i tråden som et svar. Skal svaret høre til i samtalen, ber du assistenten lagre et svarutkast (\`draft\` med handlingen \`reply\`) og sender det selv når tiden er inne.
- **Peker på et vedlegg i en annen e-post.** Filen må være med i selve forespørselen, maks 10 MB totalt. Når du sender med en gang, kan du legge ved en fil direkte fra en melding i postkassen. Det kan du ikke når du planlegger.
- **Gjentar seg.** Hver planlagte e-post sendes én gang. En ukentlig påminnelse betyr at hver enkelt må planlegges.
- **Treffer på sekundet.** Køen sjekkes én gang i minuttet.

En forespørsel om planlegging kan ha en idempotensnøkkel. Hvis assistenten prøver på nytt med samme nøkkel etter at forbindelsen falt ut, legger MCPEmails meldingen i kø én gang, ikke to. [Slik unngår du doble e-poster fra AI-agenter](/blog/prevent-duplicate-ai-agent-email-sends) forklarer hvordan.

## Hvor meldingen venter

Det meste MCPEmails gjør, skjer direkte: e-post hentes fra leverandøren din ved hver forespørsel og lagres ikke. En planlagt e-post kan ikke fungere slik, fordi den må finnes et sted frem til sendetidspunktet. MCPEmails lagrer den kryptert (AES-256-GCM) i databasen sin i Stockholm, og dekrypterer den bare for å sende den eller for å vise mottakere og emne når du lister opp de planlagte sendingene dine. En avbrutt melding blir aldri sendt. [Sikkerhetssiden](/security) har detaljene.

## Vanlige spørsmål

**Kan Claude planlegge en e-post som sendes senere?**
Ja, gjennom en MCP-server med et verktøy for planlagt sending. Koble postkassen din til MCPEmails, legg den til i Claude som en egendefinert kobling, gi tilgang til planlegging, og be Claude sende meldingen på en bestemt dato, et bestemt klokkeslett og i en bestemt tidssone. Anthropics egen Gmail-kobling lister ikke opp planlegging.

**Kan ChatGPT planlegge en e-post?**
Ja, på samme måte: legg til MCPEmails som en egendefinert MCP-kobling ([oppsett](/docs/chatgpt)) og spør. ChatGPTs planlagte oppgaver kjører en prompt senere, og det er noe annet enn å legge en ferdig melding i kø.

**Må Claude eller ChatGPT være åpen til e-posten er sendt?**
Nei. Meldingen ligger i kø på MCPEmails-serveren og sendes derfra. Du kan lukke samtalen, appen og datamaskinen.

**Hvilke e-postleverandører kan planlegge sending?**
Alle postkasser MCPEmails kan sende fra: Gmail og Google Workspace, Outlook og Microsoft 365, iCloud, Fastmail, Yahoo, Zoho, Yandex og andre IMAP- og SMTP-postkasser. Meldingen sendes gjennom postkassens egen leverandør.

**Hvordan avbryter jeg en planlagt e-post?**
Be assistenten avbryte den. Den finner meldingen med \`schedule_list\` og avbryter den via id-en, og det fungerer helt til sendingen starter.

## Neste steg

[Start gratis](/signup), koble til postkassen din, og be Claude eller ChatGPT planlegge en test-e-post til deg selv fem minutter frem i tid. [Claude-guiden](/blog/connect-claude-to-email) og [ChatGPT-guiden](/blog/connect-chatgpt-to-email) dekker tilkoblingen, og [verktøyoversikten](/docs#tools) lister opp alle argumentene for planlegging.`,
};

export default translation;
