const translation = {
  title: 'Slik kobler du Gmail til Claude: innebygd kobling eller MCP',
  description:
    'Koble Gmail til Claude over MCP på cirka to minutter: et Google-apppassord, én endepunkt-URL, ingen API-nøkkel, ingen kode. Claude leser, søker og sender e-posten din live, og e-posten din lagres aldri.',
  coverAlt: 'Slik kobler du Gmail til Claude på to minutter over MCP: et Google-apppassord, én endepunkt-URL, ingen e-post lagret',
  content: `Claude har sin egen Gmail-kobling. Vil du bare ha én Gmail-konto inne i Claude, slår du den på i Claudes connector-innstillinger, og så er du ferdig. MCPEmails passer når du trenger mer: Outlook, iCloud, Yahoo eller en hvilken som helst IMAP-postkasse ved siden av Gmail, flere innbokser i samme samtale, eller den samme innboksen i ChatGPT, Cursor og andre MCP-apper. Resten av denne veiledningen setter det opp.

For å koble Gmail til Claude gjennom MCPEmails gjør du to ting: koble til Gmail-innboksen din én gang i MCPEmails-dashbordet med et Google-apppassord, lim deretter inn én enkelt endepunkt-URL i Claudes connector-innstillinger og godkjenn en innlogging. Det er hele jobben: ingen kode, ingen SDK, ingen API-nøkkel. Det tar cirka to minutter, og Claude lagrer aldri e-posten din: hver lesing og sending går live til Gmail og forkastes i det øyeblikket Claude har den.

Dette er den fokuserte gjennomgangen kun for Gmail. Hvis du kjører flere postkasser eller en annen leverandør enn Gmail, dekker guiden [koble til hvilken som helst e-post på under to minutter](/blog/connect-email-to-ai-agent-under-2-minutes) også Outlook, iCloud, Fastmail og IMAP.

## Hva du trenger

- En **Gmail- eller Google Workspace**-konto.
- **Claude** i nettleseren (claude.ai) eller i Claude Desktop. Alle Claude-abonnementer kan legge til egendefinerte connectors, som er måten Claude snakker med MCP-servere på. Free tillater én, Pro og Max har ingen grense.
- En gratis **MCPEmails**-konto. Ingen kredittkort, én tilkoblet innboks for alltid. [Start gratis](/signup) og hold denne fanen åpen.

MCPEmails er broen i midten: den snakker Model Context Protocol til Claude på den ene siden og snakker med Gmail på den andre over IMAP og SMTP. Hvis du vil ha bakgrunnen for hva det betyr, se [hva en MCP-e-postserver faktisk er](/blog/what-is-an-mcp-email-server).

## Steg 1: Koble til Gmail-innboksen din

I MCPEmails-dashbordet åpner du **Inboxes → Connect Inbox** og velger **Gmail**. Gmail kobles til med et Google-apppassord som standard:

1. Slå på totrinnsbekreftelse i Google-kontoen din hvis den ikke allerede er på. Google tilbyr bare apppassord på kontoer som har det.
2. Gå til **myaccount.google.com/apppasswords** og lag et. Det er 16 små bokstaver i fire grupper, og mellomrommene spiller ingen rolle.
3. Tilbake i MCPEmails skriver du inn hele Gmail-adressen din, limer inn apppassordet og klikker **Koble til innboks**. Tilkoblingen testes mot Gmail før den lagres. Ferdig.

Det vanlige Google-passordet ditt brukes aldri. Apppassordet er en egen legitimasjon, MCPEmails krypterer det med AES-256-GCM, og du kan tilbakekalle det fra den samme Google-siden når som helst. Under panseret kobles innboksen til over IMAP og SMTP (\`imap.gmail.com\`).

### På en Google Workspace-konto

En Google Workspace-administrator kan slå av apppassord for hele domenet. Hvis **myaccount.google.com/apppasswords** ikke er tilgjengelig for deg, be administratoren din om å slå dem på. Siden om [Gmail-innstillinger og begrensninger](/connect/gmail) samler de Gmail-spesifikke detaljene på ett sted.

## Steg 2: Legg til MCPEmails i Claude

Nå peker du Claude mot det samme endepunktet. Fordi Claude er en OAuth-klient, trenger du ikke en API-nøkkel i det hele tatt: du limer inn én URL og godkjenner en innlogging.

1. I **claude.ai eller Claude Desktop** åpner du **Customize → Connectors**.
2. Klikk **+ Add**, deretter **Add custom connector**.
3. Kall den MCPEmails og lim inn dette som connector-URL:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Klikk **Continue**, se over innloggingsinnstillingene Claude fant (standardvalgene holder), og klikk **Add**.
5. Logg inn med MCPEmails-kontoen din, og godkjenn scopene du ønsker: \`read:email\`, \`send:email\`, eller begge.
6. I en samtale klikker du **+** nede til venstre, velger **Connectors** og slår på MCPEmails.

På et Team- eller Enterprise-abonnement legger en Owner til connectoren én gang under **Organization settings → Connectors**. Medlemmene åpner deretter **Customize → Connectors**, finner MCPEmails og klikker **Connect**.

Det er hele klientsiden. Tilkoblingen er begrenset til nøyaktig det du godkjente, og du kan tilbakekalle den fra dashbordet med ett klikk. Hvis du heller vil forstå API-nøkkel-veien (for klienter uten innebygd OAuth, som Cline eller et egendefinert skript), les [OAuth vs. API-nøkler for AI-e-posttilgang](/blog/oauth-vs-api-keys-ai-email-access). Skal du koble til en annen innboks også? [Steg-for-steg-oppsettet for e-post i Claude](/blog/connect-claude-to-email) dekker Outlook, iCloud, Fastmail og IMAP.

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

- **Lese og søke:** \`email_read\` (liste, lese og søke etter avsender, mottaker, emne, ulest-status eller datoperiode).
- **Sende og svare:** \`email_compose\` (sende, svare, videresende). Meldinger sendes ut gjennom Gmail som vanlig post fra din egen adresse, slik at domenets omdømme forblir ditt.
- **Organisere:** \`email_organize\` (flytte, kopiere, flagge, arkivere). Gmail-etiketter vises som mapper, så en melding med flere etiketter ligger i flere mapper, flytting endrer etikettene, og arkivering fjerner den fra innboksen.
- **Utkast, mapper, planlegging, kontakter:** \`draft\`, \`folder\`, \`schedule\` og \`contact_search\` fullfører settet.

Claude har også en egen Gmail-kobling, og den kan også sende. [Kan Claude lese e-posten min og sende e-post?](/blog/can-claude-read-my-email) sammenligner den med MCPEmails, postkasse for postkasse.

Én ting å forvente på forhånd: MCPEmails er poll-basert. Det finnes ingen push-webhooks, så Claude reagerer på ny post når du ber den sjekke, ikke i det øyeblikket en melding kommer inn. For nesten alle assistent-arbeidsflyter er det akkurat den riktige modellen.

## Er det trygt å koble Gmail til Claude?

Kortversjonen: ja, og designet er bygget rundt det.

- **E-posten din lagres aldri.** Innhold, emner og vedlegg hentes live ved hvert kall, overleveres til Claude og slippes umiddelbart. Det som lagres per innboks, er den krypterte legitimasjonen, apppassordet ditt, pluss de få opplysningene en funksjon du slår på trenger, for eksempel en planlagt melding som venter på å bli sendt. Her er [hvorfor «e-post lagres aldri» faktisk betyr noe](/blog/why-email-never-stored-matters).
- **Du kontrollerer scope.** Godkjenn kun lesing, og Claude kan bokstavelig talt ikke sende. Godkjenn begge, og du kan fortsatt tilbakekalle hvilken som helst av dem når som helst.
- **Ingen passorddeling.** Det vanlige Google-passordet ditt når aldri MCPEmails. Et apppassord er en egen legitimasjon du kan tilbakekalle på myaccount.google.com/apppasswords når som helst, eller du kan slette innboksen i MCPEmails.

Hele trusselmodellen (hva som er kryptert, hva en angriper ville og ikke ville se) er beskrevet i [er det trygt å gi en AI-agent e-posttilgang?](/blog/is-it-safe-to-give-ai-agent-email-access)

## FAQ

**Trenger jeg en API-nøkkel for å koble Gmail til Claude?**
Nei. Claude støtter OAuth, så du limer inn endepunkt-URL-en og godkjenner en innlogging. API-nøkler er bare for klienter uten innebygd OAuth.

**Lagrer Claude Gmail-meldingene mine?**
Nei. E-post hentes live fra Gmail ved hver forespørsel og forkastes rett etter at Claude har lest den. Ingenting fra e-posten Claude leser, beholdes; det som lagres, er den krypterte legitimasjonen din (apppassordet).

**Kan Claude sende e-post fra Gmailen min?**
Ja, hvis du gir \`send:email\`-scopet. Sendinger går ut gjennom Gmail som vanlige meldinger fra din egen konto. Gi kun lesetilgang hvis du heller vil at Claude aldri skal sende.

**Fungerer dette med det gratis Claude-abonnementet?**
Ja. Claudes Free-abonnement kan legge til én egendefinert connector, og det holder for MCPEmails. Pro og Max har ingen grense. MCPEmails-siden er gratis uten kort.

**Vil MCPEmails se Google-passordet mitt?**
Nei. Du limer inn et apppassord, en egen legitimasjon som Google genererer og som du kan tilbakekalle når som helst. Det vanlige Google-passordet ditt skrives aldri inn noe sted i MCPEmails.

## Oppsummering

Det er hele greia: ett Google-apppassord, én endepunkt-URL, og Claude kan lese, søke og sende den ekte posten din, uten noensinne å lagre den. Gratisnivået koster ingenting, krever ikke kort og kobler til én innboks; Personal koster $9 per måned for opptil tre, og Pro kobler til opptil 10 (se [priser](/pricing)).

Klar? [Koble til Gmailen din gratis](/signup), lim inn endepunktet i Claude, og be den oppsummere den uleste posten din.`,
};

export default translation;
