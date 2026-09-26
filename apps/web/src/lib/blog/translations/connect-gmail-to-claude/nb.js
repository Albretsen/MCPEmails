const translation = {
  title: 'Slik kobler du Gmail til Claude (på 2 minutter, uten kode)',
  description:
    'Koble Gmail til Claude over MCP på cirka to minutter: et Google-apppassord (eller Logg inn med Google), én endepunkt-URL, ingen API-nøkkel, ingen kode. Claude leser, søker og sender e-posten din live, og e-posten din lagres aldri.',
  coverAlt: 'Slik kobler du Gmail til Claude på to minutter over MCP: et Google-apppassord, én endepunkt-URL, ingen e-post lagret',
  content: `For å koble Gmail til Claude gjør du to ting: koble til Gmail-innboksen din én gang i MCP Emails-dashbordet med et Google-apppassord, lim deretter inn én enkelt endepunkt-URL i Claudes connector-innstillinger og godkjenn en innlogging. Det er hele jobben: ingen kode, ingen SDK, ingen API-nøkkel. Det tar cirka to minutter, og Claude lagrer aldri e-posten din: hver lesing og sending går live til Gmail og forkastes i det øyeblikket Claude har den.

Dette er den fokuserte gjennomgangen kun for Gmail. Hvis du kjører flere postkasser eller en annen leverandør enn Gmail, dekker guiden [koble til hvilken som helst e-post på under to minutter](/blog/connect-email-to-ai-agent-under-2-minutes) også Outlook, iCloud, Fastmail og IMAP.

## Hva du trenger

- En **Gmail- eller Google Workspace**-konto.
- En versjon av **Claude som støtter egendefinerte connectors**: claude.ai på et betalt abonnement, eller Claude Desktop. (Connectors er måten Claude snakker med MCP-servere på.)
- En gratis **MCP Emails**-konto. Ingen kredittkort, én tilkoblet innboks for alltid. [Start gratis](/signup) og hold denne fanen åpen.

MCP Emails er broen i midten: den snakker Model Context Protocol til Claude på den ene siden og snakker med Gmail på den andre, over IMAP som standard eller gjennom Gmail API-et hvis du logger inn med Google. Hvis du vil ha bakgrunnen for hva det betyr, se [hva en MCP-e-postserver faktisk er](/blog/what-is-an-mcp-email-server).

## Steg 1: Koble til Gmail-innboksen din

I MCP Emails-dashbordet åpner du **Inboxes → Connect Inbox** og velger **Gmail**. Gmail kobles til med et Google-apppassord som standard:

1. Slå på totrinnsbekreftelse i Google-kontoen din hvis den ikke allerede er på. Google tilbyr bare apppassord på kontoer som har det.
2. Gå til **myaccount.google.com/apppasswords** og lag et. Det er 16 små bokstaver i fire grupper, og mellomrommene spiller ingen rolle.
3. Tilbake i MCP Emails skriver du inn hele Gmail-adressen din, limer inn apppassordet og klikker **Koble til innboks**. Tilkoblingen testes mot Gmail før den lagres. Ferdig.

Det vanlige Google-passordet ditt brukes aldri. Apppassordet er en egen legitimasjon, MCP Emails krypterer det med AES-256-GCM, og du kan tilbakekalle det fra den samme Google-siden når som helst. Under panseret kobles innboksen til over IMAP og SMTP (\`imap.gmail.com\`).

### Vil du heller logge inn med Google?

Tilkoblingsvinduet tilbyr også en annen vei: åpne **Vil du heller logge inn med Google?** og klikk **Koble til med Google**. Du velger kontoen din på Googles egen side og godkjenner lese- og sendetilgang. Google viser først en advarselsskjerm, fordi Google ikke har verifisert appen. For å fortsette klikker du **Advanced**, deretter **Go to mcpemails.com**.

### Hvilken vei du bør velge

Begge veiene fortsetter å virke, og valget avgjør hva Claude kan gjøre etterpå:

- **Apppassord (IMAP):** Gmail-etiketter vises som mapper, søk bruker IMAP-tekstsøk, og Claude kan kopiere meldinger og slette dem permanent.
- **Logg inn med Google (Gmail API):** Claude jobber med ekte Gmail-etiketter og kan søke med Gmail-operatorer som \`from:\`, \`is:unread\` og \`after:\`. Sletting flytter e-posten til papirkurven.

På en Google Workspace-konto kan en administrator slå av apppassord for hele domenet, eller blokkere tredjepartsapper på Google-innloggingsveien. Hvis én vei er blokkert, prøv den andre, eller spør administratoren din.

## Steg 2: Legg til MCP Emails i Claude

Nå peker du Claude mot det samme endepunktet. Fordi Claude er en OAuth-klient, trenger du ikke en API-nøkkel i det hele tatt: du limer inn én URL og godkjenner en innlogging.

1. I **claude.ai eller Claude Desktop** åpner du **Settings → Connectors**.
2. Klikk **Add custom connector**.
3. Lim inn dette som connector-URL, og klikk deretter **Add**:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Klikk **Connect**, logg inn med MCP Emails-kontoen din, og godkjenn scopene du ønsker: \`read:email\`, \`send:email\`, eller begge.

Det er hele klientsiden. Tilkoblingen er begrenset til nøyaktig det du godkjente, og du kan tilbakekalle den fra dashbordet med ett klikk. Hvis du heller vil forstå API-nøkkel-veien (for klienter uten innebygd OAuth, som Cline eller et egendefinert skript), les [OAuth vs. API-nøkler for AI-e-posttilgang](/blog/oauth-vs-api-keys-ai-email-access).

## Steg 3: Be Claude om din første prompt

Test det med noe lite. Be Claude:

> «Oppsummer mine tre nyeste uleste e-poster.»

Bak kulissene kaller Claude \`inbox_list\` for å oppdage den tilkoblede Gmailen din, deretter \`email_read\` for å liste og lese meldingene. Hvis den svarer, er tilkoblingen din live. Derfra kan du prøve:

- «Finn fakturaen fra Stripe forrige måned og fortell meg beløpet.»
- «Skriv et høflig svar til den siste e-posten fra utleieren min, men ikke send det ennå.»
- «Arkiver hvert nyhetsbrev i innboksen min fra denne uken.»
- «Hva gikk jeg med på i e-posttråden min med Acme?»

For et dypere sett med mønstre (daglig triage, automatiske oppsummeringer og opprydningsrutiner), se [de beste måtene å la Claude håndtere innboksen din på](/blog/best-ways-to-let-claude-manage-your-inbox) og [triage-og-oppsummer-spilleboken](/blog/ai-agent-triage-summarize-inbox).

## Hva Claude kan gjøre med Gmailen din

Når den er tilkoblet, jobber Claude gjennom et lite sett med konsoliderte verktøy, slik at den kan gjøre langt mer enn å lese:

- **Lese og søke:** \`email_read\` (liste, lese, fulltekstsøk, med Gmail-operatorer hvis du koblet til med Logg inn med Google).
- **Sende og svare:** \`email_compose\` (sende, svare, videresende). Meldinger sendes ut gjennom Gmail som vanlig post fra din egen adresse, slik at domenets omdømme forblir ditt.
- **Organisere:** \`email_organize\` (flytte, flagge, arkivere, og etiketter på Google-innloggingsveien).
- **Utkast, mapper, planlegging, kontakter:** \`draft\`, \`folder\`, \`schedule\` og \`contact_search\` fullfører settet.

Én ting å forvente på forhånd: MCP Emails er poll-basert. Det finnes ingen push-webhooks, så Claude reagerer på ny post når du ber den sjekke, ikke i det øyeblikket en melding kommer inn. For nesten alle assistent-arbeidsflyter er det akkurat den riktige modellen.

## Er det trygt å koble Gmail til Claude?

Kortversjonen: ja, og designet er bygget rundt det.

- **E-posten din lagres aldri.** Innhold, emner og vedlegg hentes live ved hvert kall, overleveres til Claude og slippes umiddelbart. Det eneste som lagres per innboks, er den krypterte legitimasjonen: apppassordet ditt, eller OAuth-tokenet hvis du logget inn med Google. Her er [hvorfor «e-post lagres aldri» faktisk betyr noe](/blog/why-email-never-stored-matters).
- **Du kontrollerer scope.** Godkjenn kun lesing, og Claude kan bokstavelig talt ikke sende. Godkjenn begge, og du kan fortsatt tilbakekalle hvilken som helst av dem når som helst.
- **Ingen passorddeling.** Det vanlige Google-passordet ditt når aldri MCP Emails. Et apppassord er en egen legitimasjon du kan tilbakekalle på myaccount.google.com/apppasswords, Logg inn med Google bruker OAuth, og uansett kan du koble fra innboksen i dashbordet.

Hele trusselmodellen (hva som er kryptert, hva en angriper ville og ikke ville se) er beskrevet i [er det trygt å gi en AI-agent e-posttilgang?](/blog/is-it-safe-to-give-ai-agent-email-access)

## FAQ

**Trenger jeg en API-nøkkel for å koble Gmail til Claude?**
Nei. Claude støtter OAuth, så du limer inn endepunkt-URL-en og godkjenner en innlogging. API-nøkler er bare for klienter uten innebygd OAuth.

**Lagrer Claude Gmail-meldingene mine?**
Nei. E-post hentes live fra Gmail ved hver forespørsel og forkastes rett etter at Claude har lest den. Ingenting beholdes bortsett fra den krypterte legitimasjonen din (apppassordet, eller tilgangstokenet hvis du logget inn med Google).

**Kan Claude sende e-post fra Gmailen min?**
Ja, hvis du gir \`send:email\`-scopet. Sendinger går ut gjennom Gmail som vanlige meldinger fra din egen konto. Gi kun lesetilgang hvis du heller vil at Claude aldri skal sende.

**Fungerer dette med det gratis Claude-abonnementet?**
Egendefinerte connectors krever et Claude-abonnement som støtter dem (betalt claude.ai eller Claude Desktop). MCP Emails-siden er gratis uten kort.

**Vil MCP Emails se Google-passordet mitt?**
Nei. Du limer inn et apppassord, en egen legitimasjon som Google genererer og som du kan tilbakekalle, eller du logger inn med Google via OAuth. Det vanlige Google-passordet ditt skrives aldri inn noe sted i MCP Emails.

## Oppsummering

Det er hele greia: ett Google-apppassord, én endepunkt-URL, og Claude kan lese, søke og sende den ekte posten din, uten noensinne å lagre den. Gratisnivået koster ingenting, krever ikke kort og kobler til én innboks; Personal koster $5 per måned for opptil tre, og Pro kobler til alle postkassene du eier (se [priser](/pricing)).

Klar? [Koble til Gmailen din gratis](/signup), lim inn endepunktet i Claude, og be den oppsummere den uleste posten din.`,
};

export default translation;
